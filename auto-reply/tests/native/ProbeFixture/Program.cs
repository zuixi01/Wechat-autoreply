using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text.Json;
using System.Windows;
using System.Windows.Automation;
using System.Windows.Automation.Peers;
using System.Windows.Controls;
using System.Windows.Interop;
using WindowsAdapter;

internal static class Program
{
    [DllImport("user32.dll")] private static extern void NotifyWinEvent(uint kind, nint window, int objectId, int childId);
    private static readonly JsonSerializerOptions Json = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };
    [STAThread]
    private static int Main(string[] args)
    {
        if (args.Length != 1 || !Path.IsPathFullyQualified(args[0])) return 1;
        var reportFile = args[0];
        var application = new Application();
        var panel = new StackPanel();
        var editor = new TextBox { Text = "PRIVATE_FIXTURE_DRAFT", Width = 200 };
        AutomationProperties.SetAutomationId(editor, "fixture.editor");
        var button = new Button { Content = "PRIVATE_FIXTURE_BUTTON", Width = 200 };
        AutomationProperties.SetAutomationId(button, "fixture.button");
        var decoration = new FixtureDecoration { Width = 200, Height = 10 };
        AutomationProperties.SetAutomationId(decoration, "fixture.decoration");
        panel.Children.Add(editor); panel.Children.Add(button); panel.Children.Add(decoration);
        var window = new Window { Content = panel, Width = 300, Height = 240, Left = -30000, Top = -30000,
            Title = "PRIVATE_FIXTURE_WINDOW", ShowActivated = false, ShowInTaskbar = false,
            WindowStyle = WindowStyle.None };
        var checks = new List<string>();
        var reports = new Dictionary<string, ProbeReport>();
        var activityReports = new Dictionary<string, DesktopActivityReport>();
        var exit = 1;
        Thread? worker = null;
        window.ContentRendered += (_, _) =>
        {
            if (worker is not null) return;
            var handle = new WindowInteropHelper(window).Handle.ToInt64().ToString();
            using var own = Process.GetCurrentProcess();
            var binding = new WindowBinding(handle, own.Id, own.ProcessName, own.StartTime.ToUniversalTime().Ticks.ToString());
            void Check(bool passed, string code)
            {
                if (!passed) throw new Exception(code);
                checks.Add(code);
            }
            void Reject(WindowBinding input, string code, Func<string, bool>? allowed = null)
            {
                try { WindowProbe.Capture(input, allowed ?? (name => name == binding.ProcessName)); }
                catch (ProbeException e) when (e.Code == code) { checks.Add("reject_" + code); return; }
                throw new Exception("expected_" + code);
            }
            worker = new Thread(() =>
            {
                object result;
                try
                {
                    var captured = WindowProbe.Capture(binding, name => name == binding.ProcessName);
                    reports.Add("ordinary", captured);
                    Check(captured.Nodes.Any(n => n.AutomationId == "fixture.editor" && n.Patterns.Contains("ValuePatternIdentifiers.Pattern")), "real_value_pattern_metadata");
                    Check(captured.Nodes.Any(n => n.AutomationId == "fixture.button"), "real_button_metadata");
                    Check(captured.Nodes.All(n => n.RuntimeId is { Length: > 0 }), "opaque_runtime_ids_present");
                    Check(captured.Nodes.Select((n, i) => n.Index == i && (i == 0 ? n.ParentIndex is null && n.Depth == 0 :
                        n.ParentIndex is >= 0 && n.ParentIndex < i && captured.Nodes[n.ParentIndex.Value].Depth + 1 == n.Depth)).All(x => x), "real_parent_links");
                    Check(!JsonSerializer.Serialize(captured, Json).Contains("PRIVATE_FIXTURE_"), "names_values_text_not_serialized");
                    Check(!captured.BackgroundReadVerified && !captured.NonInterferingSendVerified && !captured.IdentityVerified, "no_platform_authority");
                    Check(captured.ForegroundChangedAtEnd == (captured.ForegroundBeforeHandle != captured.ForegroundAfterHandle), "endpoint_observation_only");
                    Check(captured.TreeView == "control" && captured.FormatVersion == 3, "control_view_is_explicit");
                    Check(captured.DesktopActivity.ForegroundHookInstalled && captured.DesktopActivity.FocusHookInstalled &&
                        captured.DesktopActivity.TimerInstalled && captured.DesktopActivity.ObserverStopped, "activity_observer_lifecycle_confirmed");
                    var sampleReads = 0;
                    using (var activity = new DesktopActivityProbe((uint)binding.ProcessId, () =>
                    {
                        var index = Interlocked.Increment(ref sampleReads);
                        return index == 2 ? new ActivitySample(1, 1, 0, 0) : new ActivitySample(0, 0, uint.MaxValue, uint.MaxValue);
                    }))
                    {
                        window.Dispatcher.Invoke(() =>
                        {
                            // Owned fixture notifications, not real focus switches or injected input.
                            NotifyWinEvent(3, (nint)long.Parse(binding.Handle), 0, 0);
                            NotifyWinEvent(3, (nint)long.Parse(binding.Handle), 0, 0);
                            NotifyWinEvent(0x8005, (nint)long.Parse(binding.Handle), 0, 0);
                        });
                        if (!SpinWait.SpinUntil(() => Volatile.Read(ref sampleReads) >= 4, 1000)) throw new Exception("activity_samples_missing");
                        var observed = activity.Finish(); activityReports.Add("ownedEventsAndSyntheticSamples", observed);
                        Check(observed.ForegroundEvents >= 2 && observed.FocusEvents >= 1 && observed.ObserverStopped, "transient_win_events_recorded");
                        Check(observed.CursorChangeSamples >= 2 && observed.ClipboardChangeSamples >= 2 && observed.InputChangeSamples >= 2,
                            "sample_excursion_and_wrap_detected");
                        var encoded = JsonSerializer.Serialize(observed, Json);
                        Check(!observed.NoInterferenceVerified && !encoded.Contains("cursorX") && !encoded.Contains("cursorY") &&
                            !encoded.Contains("clipboardSequence") && !encoded.Contains("lastInputTick"), "activity_keeps_no_input_content_or_authority");
                    }
                    using (var unavailable = new DesktopActivityProbe((uint)binding.ProcessId, () => throw new Exception("PRIVATE_FIXTURE_ERROR")))
                    {
                        var observed = unavailable.Finish(); activityReports.Add("unavailable", observed);
                        Check(!observed.Complete && observed.ObserverStopped && observed.IncompleteReasons.Contains("snapshot_unavailable"),
                            "unavailable_sampling_is_incomplete");
                    }
                    using (var release = new ManualResetEventSlim(false))
                    {
                        var stalled = new DesktopActivityProbe((uint)binding.ProcessId, () => { release.Wait(); return new ActivitySample(0,0,1,1); });
                        try
                        {
                            try { stalled.Finish(); throw new Exception("expected_activity_stop_unconfirmed"); }
                            catch (ProbeException e) when (e.Code == "activity_stop_unconfirmed") { checks.Add("unconfirmed_observer_stop_rejects_report"); }
                        }
                        finally { release.Set(); stalled.Dispose(); }
                    }
                    var raw = WindowProbe.Capture(binding, name => name == binding.ProcessName, treeView: "raw");
                    reports.Add("raw", raw);
                    Check(raw.TreeView == "raw" && raw.Nodes.Any(n => n.AutomationId == "fixture.decoration" && !n.IsControlElement && !n.IsContentElement), "raw_view_includes_filtered_metadata");
                    Check(!captured.Nodes.Any(n => n.AutomationId == "fixture.decoration"), "control_view_excludes_decoration");
                    Check(!JsonSerializer.Serialize(raw, Json).Contains("PRIVATE_FIXTURE_"), "raw_view_does_not_serialize_chat_text");
                    var rawLimited = WindowProbe.Capture(binding, name => name == binding.ProcessName, new ProbeLimits(Nodes: 1), "raw");
                    reports.Add("rawNodeLimit", rawLimited);
                    Check(rawLimited.Nodes.Count == 1 && rawLimited.Truncated && rawLimited.IncompleteReasons.Contains("node_limit"), "raw_node_limit_is_explicit");
                    try { WindowProbe.Capture(binding, name => name == binding.ProcessName, treeView: "all"); throw new Exception("expected_invalid_tree_view"); }
                    catch (ProbeException e) when (e.Code == "invalid_tree_view") { checks.Add("reject_invalid_tree_view"); }
                    var limited = WindowProbe.Capture(binding, name => name == binding.ProcessName, new ProbeLimits(Nodes: 1));
                    reports.Add("nodeLimit", limited);
                    Check(limited.Nodes.Count == 1 && limited.Truncated && limited.IncompleteReasons.Contains("node_limit"), "node_limit_is_explicit");
                    Reject(binding with { ProcessName = "different-process" }, "process_changed");
                    Reject(binding with { ProcessStartTicks = "638000000000000000" }, "process_changed");
                    Reject(binding with { ProcessId = binding.ProcessId + 1 }, "process_changed");
                    Reject(binding with { Handle = "000" + binding.Handle }, "invalid_binding");
                    Reject(binding, "process_changed", _ => false);
                    window.Dispatcher.Invoke(() =>
                    {
                        AutomationProperties.SetAutomationId(button, new string('a', 300));
                        panel.Children.Clear();
                        UIElement content = editor;
                        for (var i = 0; i < 12; i++) content = new GroupBox { Content = content };
                        panel.Children.Add(content); panel.Children.Add(button);
                        window.UpdateLayout();
                    });
                    var deep = WindowProbe.Capture(binding, name => name == binding.ProcessName);
                    reports.Add("deep", deep);
                    Check(deep.Nodes.All(n => n.Depth <= 8) && deep.Truncated && deep.IncompleteReasons.Contains("depth_limit"), "depth_limit_is_explicit");
                    Check(deep.IncompleteReasons.Contains("metadata_truncated") && deep.Nodes.Any(n => n.AutomationId.Length == 256), "metadata_limit_is_explicit");
                    var rawDeep = WindowProbe.Capture(binding, name => name == binding.ProcessName, treeView: "raw");
                    reports.Add("rawDeep", rawDeep);
                    Check(rawDeep.Nodes.All(n => n.Depth <= 8) && rawDeep.Truncated && rawDeep.IncompleteReasons.Contains("depth_limit"), "raw_depth_limit_is_explicit");
                    result = new { passed = true, fixtureOnly = true, checks, reports, activityReports, realChatWindowsRead = false, messagesSent = 0, modelCalls = 0 };
                    exit = 0;
                }
                catch (Exception e) { result = new { passed = false, fixtureOnly = true, failure = e.Message, checks, reports, activityReports }; }
                File.WriteAllText(reportFile, JsonSerializer.Serialize(result, Json));
                window.Dispatcher.Invoke(window.Close);
            });
            worker.SetApartmentState(ApartmentState.MTA); worker.Start();
        };
        application.Run(window);
        worker?.Join();
        return exit;
    }
}

// A real UIA provider element present only in the raw view; no input or invocation behavior.
internal sealed class FixtureDecoration : Control
{
    protected override AutomationPeer OnCreateAutomationPeer() => new FixtureDecorationPeer(this);
}
internal sealed class FixtureDecorationPeer(FixtureDecoration owner) : FrameworkElementAutomationPeer(owner)
{
    protected override string GetClassNameCore() => "FixtureDecoration";
    protected override AutomationControlType GetAutomationControlTypeCore() => AutomationControlType.Pane;
    protected override bool IsControlElementCore() => false;
    protected override bool IsContentElementCore() => false;
}
