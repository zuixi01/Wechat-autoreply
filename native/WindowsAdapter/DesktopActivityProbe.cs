using System.Diagnostics;
using System.Runtime.InteropServices;

namespace WindowsAdapter;

internal sealed record ActivitySample(int CursorX, int CursorY, uint ClipboardSequence, uint LastInputTick);
internal sealed record DesktopActivityReport(string Scope, int PollIntervalMs, int ForegroundEvents, int FocusEvents,
    int CursorChangeSamples, int ClipboardChangeSamples, int InputChangeSamples, int Samples, long ObservedForMs, long MaximumSampleGapMs,
    bool ForegroundHookInstalled, bool FocusHookInstalled, bool TimerInstalled, bool ObserverStopped,
    bool Complete, IReadOnlyList<string> IncompleteReasons, bool NoInterferenceVerified);

// Read-only diagnostics. Counts are session activity, not attribution or a send authorization.
// No input hooks, typed keys, window titles, clipboard contents, focus setters or cursor setters.
internal sealed class DesktopActivityProbe : IDisposable
{
    internal const int PollIntervalMs = 10;
    private const int Maximum = 16384;
    private const uint ForegroundEvent = 3, FocusEvent = 0x8005, TimerMessage = 0x113, StopMessage = 0x8001;
    private readonly object gate = new();
    private readonly ManualResetEventSlim ready = new(false);
    private readonly Thread worker;
    private readonly Func<ActivitySample> readSample;
    private readonly uint eventProcess;
    private readonly HashSet<string> reasons = new(StringComparer.Ordinal);
    private readonly Stopwatch elapsed = Stopwatch.StartNew();
    private readonly WinEventCallback callback;
    private uint threadId;
    private bool stopRequested, foregroundInstalled, focusInstalled, timerInstalled, releaseFailed;
    private int foregroundEvents, focusEvents, cursorChanges, clipboardChanges, inputChanges, samples;
    private long previousSampleAt, maximumSampleGap;
    private ActivitySample? previous;
    private DesktopActivityReport? report;
    private bool disposed;

    // The test-only scope and sample source cannot be selected through production protocol.
    internal DesktopActivityProbe(uint eventProcess = 0, Func<ActivitySample>? sampleSource = null)
    {
        this.eventProcess = eventProcess;
        readSample = sampleSource ?? ReadDesktopSample;
        callback = OnEvent;
        worker = new Thread(Pump) { IsBackground = true, Name = "AutoReply passive desktop observer" };
        worker.SetApartmentState(ApartmentState.MTA);
        worker.Start();
        if (!ready.Wait(500)) AddReason("startup_unconfirmed");
    }
    private void AddReason(string reason) { lock (gate) reasons.Add(reason); }
    private void Increment(ref int counter)
    {
        if (counter < Maximum) counter++;
        else reasons.Add("event_limit");
    }
    private void OnEvent(nint hook, uint kind, nint window, int objectId, int childId, uint sourceThread, uint time)
    {
        lock (gate)
        {
            if (kind == ForegroundEvent) Increment(ref foregroundEvents);
            if (kind == FocusEvent) Increment(ref focusEvents);
        }
    }
    private void Sample()
    {
        try
        {
            var sample = readSample();
            lock (gate)
            {
                Increment(ref samples);
                var now = elapsed.ElapsedMilliseconds;
                maximumSampleGap = Math.Max(maximumSampleGap, now - previousSampleAt);
                previousSampleAt = now;
                if (previous is not null)
                {
                    if ((sample.CursorX, sample.CursorY) != (previous.CursorX, previous.CursorY)) Increment(ref cursorChanges);
                    if (sample.ClipboardSequence != previous.ClipboardSequence) Increment(ref clipboardChanges);
                    // Input timestamps can move backwards or wrap; equality is the only inference here.
                    if (sample.LastInputTick != previous.LastInputTick) Increment(ref inputChanges);
                }
                previous = sample;
            }
        }
        catch { AddReason("snapshot_unavailable"); }
    }
    private void Pump()
    {
        nint foreground = 0, focus = 0;
        nuint timer = 0;
        var rootedCallback = GCHandle.Alloc(callback);
        try
        {
            threadId = GetCurrentThreadId();
            PeekMessage(out _, 0, 0, 0, 0); // Create the thread queue before publishing readiness.
            foreground = SetWinEventHook(ForegroundEvent, ForegroundEvent, 0, callback, eventProcess, 0, 0);
            focus = SetWinEventHook(FocusEvent, FocusEvent, 0, callback, eventProcess, 0, 0);
            foregroundInstalled = foreground != 0; focusInstalled = focus != 0;
            if (!foregroundInstalled || !focusInstalled) AddReason("hook_unavailable");
            Sample();
            timer = SetTimer(0, 0, PollIntervalMs, 0); timerInstalled = timer != 0;
            if (!timerInstalled) AddReason("timer_unavailable");
            ready.Set();
            if (Volatile.Read(ref stopRequested)) return;
            while (true)
            {
                var result = GetMessage(out var message, 0, 0, 0);
                if (result <= 0) { AddReason("message_loop_failed"); break; }
                if (message.Code == StopMessage) break;
                if (message.Code == TimerMessage && message.WParam == timer) Sample();
                TranslateMessage(ref message); DispatchMessage(ref message);
            }
            Sample(); // Endpoint sampling complements events; it never proves the interval unchanged.
        }
        catch
        {
            AddReason("message_loop_failed");
            if (samples == 0) AddReason("snapshot_unavailable");
        }
        finally
        {
            if (!foregroundInstalled || !focusInstalled) AddReason("hook_unavailable");
            if (!timerInstalled) AddReason("timer_unavailable");
            if (timer != 0 && !KillTimer(0, timer)) releaseFailed = true;
            if (foreground != 0 && !UnhookWinEvent(foreground)) releaseFailed = true;
            if (focus != 0 && !UnhookWinEvent(focus)) releaseFailed = true;
            if (!releaseFailed) rootedCallback.Free(); // A failed release is fatal to the helper.
            ready.Set();
        }
    }
    internal DesktopActivityReport Finish()
    {
        if (report is not null) return report;
        Volatile.Write(ref stopRequested, true);
        if (worker.IsAlive && threadId != 0) PostThreadMessage(threadId, StopMessage, 0, 0);
        if (!worker.Join(500) || releaseFailed) throw new ProbeException("activity_stop_unconfirmed");
        elapsed.Stop();
        lock (gate)
        {
            report = new DesktopActivityReport(eventProcess == 0 ? "session" : "fixture-process", PollIntervalMs,
                foregroundEvents, focusEvents, cursorChanges, clipboardChanges, inputChanges, samples,
                elapsed.ElapsedMilliseconds, maximumSampleGap, foregroundInstalled, focusInstalled, timerInstalled, true,
                reasons.Count == 0, reasons.Order().ToArray(), false);
            return report;
        }
    }
    public void Dispose()
    {
        if (disposed) return;
        Finish(); ready.Dispose(); disposed = true;
    }
    private static ActivitySample ReadDesktopSample()
    {
        var input = new LastInput { Size = (uint)Marshal.SizeOf<LastInput>() };
        var clipboard = GetClipboardSequenceNumber();
        if (!GetCursorPos(out var point) || !GetLastInputInfo(ref input) || clipboard == 0)
            throw new InvalidOperationException("snapshot_unavailable");
        return new ActivitySample(point.X, point.Y, clipboard, input.Tick);
    }

    [StructLayout(LayoutKind.Sequential)] private struct Point { public int X, Y; }
    [StructLayout(LayoutKind.Sequential)] private struct LastInput { public uint Size, Tick; }
    [StructLayout(LayoutKind.Sequential)] private struct Message
    {
        public nint Window; public uint Code; public nuint WParam; public nint LParam;
        public uint Time; public Point Point; public uint Private;
    }
    private delegate void WinEventCallback(nint hook, uint kind, nint window, int objectId, int childId, uint thread, uint time);
    [DllImport("kernel32.dll")] private static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] private static extern nint SetWinEventHook(uint minimum, uint maximum, nint module, WinEventCallback callback, uint process, uint thread, uint flags);
    [DllImport("user32.dll")] private static extern bool UnhookWinEvent(nint hook);
    [DllImport("user32.dll")] private static extern bool GetCursorPos(out Point point);
    [DllImport("user32.dll")] private static extern uint GetClipboardSequenceNumber();
    [DllImport("user32.dll")] private static extern bool GetLastInputInfo(ref LastInput input);
    [DllImport("user32.dll")] private static extern bool PeekMessage(out Message message, nint window, uint minimum, uint maximum, uint remove);
    [DllImport("user32.dll")] private static extern int GetMessage(out Message message, nint window, uint minimum, uint maximum);
    [DllImport("user32.dll")] private static extern bool TranslateMessage(ref Message message);
    [DllImport("user32.dll")] private static extern nint DispatchMessage(ref Message message);
    [DllImport("user32.dll")] private static extern bool PostThreadMessage(uint thread, uint message, nuint wParam, nint lParam);
    [DllImport("user32.dll")] private static extern nuint SetTimer(nint window, nuint id, uint interval, nint callback);
    [DllImport("user32.dll")] private static extern bool KillTimer(nint window, nuint id);
}
