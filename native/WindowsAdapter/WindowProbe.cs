using System.Diagnostics;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Windows.Automation;

namespace WindowsAdapter;

internal sealed record WindowBinding(string Handle, int ProcessId, string ProcessName, string ProcessStartTicks);
internal sealed record ProbeNode(int Index, int? ParentIndex, int Depth, int[]? RuntimeId,
    string ControlType, string ClassName, string AutomationId, bool Offscreen, bool Enabled, string[] Patterns,
    bool IsControlElement, bool IsContentElement);
internal sealed record ProbeReport(int FormatVersion, string AdapterVersion, string SnapshotId, WindowBinding Binding,
    long CapturedAt, string? ClientFileVersion, string WindowsVersion, IReadOnlyList<ProbeNode> Nodes,
    IReadOnlyList<string> IncompleteReasons, bool Truncated, long ElapsedMs,
    string ForegroundBeforeHandle, string ForegroundAfterHandle, bool ForegroundChangedAtEnd,
    bool BackgroundReadVerified, bool NonInterferingSendVerified, bool IdentityVerified, string Conclusion,
    string TreeView, DesktopActivityReport DesktopActivity);
internal sealed record ProbeLimits(int Nodes = 300, int Depth = 8, int BudgetMs = 3000);
internal sealed class ProbeException(string code) : Exception { internal string Code { get; } = code; }

// Metadata reader shared with the isolated fixture. The production entrypoint fixes its own allowlist.
internal static class WindowProbe
{
    internal const string Version = "0.4.0";
    [DllImport("user32.dll")] private static extern bool IsWindow(nint window);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(nint window, out uint processId);
    [DllImport("user32.dll")] private static extern nint GetForegroundWindow();

    internal static ProbeReport Capture(WindowBinding binding, Func<string, bool> allowedProcess, ProbeLimits? limits = null,
        string treeView = "control")
    {
        limits ??= new ProbeLimits();
        if (treeView is not ("control" or "raw")) throw new ProbeException("invalid_tree_view");
        if (limits.Nodes is < 1 or > 300 || limits.Depth is < 0 or > 8 || limits.BudgetMs is < 1 or > 3000)
            throw new ProbeException("invalid_limits");
        if (binding.ProcessId <= 0 || !Numeric(binding.Handle, out var handle) ||
            !Numeric(binding.ProcessStartTicks, out _) || string.IsNullOrEmpty(binding.ProcessName))
            throw new ProbeException("invalid_binding");
        var window = (nint)handle;
        if (!IsWindow(window)) throw new ProbeException("window_changed");
        GetWindowThreadProcessId(window, out var pid);
        if (pid != binding.ProcessId) throw new ProbeException("process_changed");
        using var process = Process.GetProcessById(binding.ProcessId);
        Verify(window, process, binding, allowedProcess);
        var capturedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        var foregroundBefore = GetForegroundWindow().ToInt64().ToString(CultureInfo.InvariantCulture);
        var started = Stopwatch.StartNew();
        using var activityProbe = new DesktopActivityProbe();
        var nodes = new List<ProbeNode>();
        var reasons = new HashSet<string>(StringComparer.Ordinal);
        string? version = null;
        try
        {
            var file = process.MainModule?.FileName;
            version = file is null ? null : FileVersionInfo.GetVersionInfo(file).FileVersion;
            if (string.IsNullOrWhiteSpace(version)) version = null;
            if (version?.Length > 128) { version = version[..128]; reasons.Add("metadata_truncated"); }
        }
        catch { /* A missing version is an explicit evidence gap, not a guessed version. */ }
        if (version is null) reasons.Add("version_unavailable");
        var walker = treeView == "raw" ? TreeWalker.RawViewWalker : TreeWalker.ControlViewWalker;
        var visited = 0;
        bool Budget()
        {
            if (started.ElapsedMilliseconds > limits.BudgetMs) { reasons.Add("time_limit"); return false; }
            if (visited >= limits.Nodes) { reasons.Add("node_limit"); return false; }
            return true;
        }
        string Bounded(string value)
        {
            if (value.Length <= 256) return value;
            reasons.Add("metadata_truncated"); return value[..256];
        }
        void Visit(AutomationElement element, int? parent, int depth)
        {
            if (!Budget()) return;
            visited++;
            try
            {
                var current = element.Current;
                if (current.ProcessId != binding.ProcessId) { reasons.Add("foreign_process_element"); return; }
                int[]? runtime = null;
                try
                {
                    var id = element.GetRuntimeId();
                    if (id is { Length: > 0 and <= 64 }) runtime = id;
                }
                catch (ElementNotAvailableException) { reasons.Add("element_unavailable"); }
                catch { /* Runtime IDs are optional evidence, never inferred from names. */ }
                if (runtime is null) reasons.Add("runtime_id_unavailable");
                var patterns = element.GetSupportedPatterns().Select(p => p.ProgrammaticName).Distinct().Order().ToArray();
                if (patterns.Length > 32) { patterns = patterns[..32]; reasons.Add("metadata_truncated"); }
                var node = new ProbeNode(nodes.Count, parent, depth, runtime, current.ControlType.ProgrammaticName,
                    Bounded(current.ClassName), Bounded(current.AutomationId), current.IsOffscreen, current.IsEnabled, patterns,
                    current.IsControlElement, current.IsContentElement);
                nodes.Add(node);
                // Do not read Name, Value or Text. Neither view proves message history or identity.
                var child = walker.GetFirstChild(element);
                if (depth >= limits.Depth)
                {
                    if (child is not null) reasons.Add("depth_limit");
                    return;
                }
                while (child is not null)
                {
                    if (!Budget()) break;
                    Visit(child, node.Index, depth + 1);
                    child = walker.GetNextSibling(child);
                }
            }
            catch (ElementNotAvailableException) { reasons.Add("element_unavailable"); }
            catch { reasons.Add("metadata_unavailable"); }
        }
        Visit(AutomationElement.FromHandle(window), null, 0);
        Verify(window, process, binding, allowedProcess);
        var activity = activityProbe.Finish();
        Verify(window, process, binding, allowedProcess);
        var foregroundAfter = GetForegroundWindow().ToInt64().ToString(CultureInfo.InvariantCulture);
        if (!activity.Complete) reasons.Add("activity_unavailable");
        var elapsed = started.ElapsedMilliseconds;
        if (elapsed > limits.BudgetMs) reasons.Add("time_limit");
        return new ProbeReport(3, Version, Guid.NewGuid().ToString(), binding, capturedAt, version,
            Environment.OSVersion.Version.ToString(), nodes, reasons.Order().ToArray(), reasons.Count > 0, elapsed,
            foregroundBefore, foregroundAfter, foregroundBefore != foregroundAfter,
            false, false, false, "metadata_only_requires_platform_validation", treeView, activity);
    }

    private static bool Numeric(string text, out long number) =>
        long.TryParse(text, NumberStyles.None, CultureInfo.InvariantCulture, out number) && number > 0 &&
        text == number.ToString(CultureInfo.InvariantCulture);

    private static void Verify(nint window, Process process, WindowBinding binding, Func<string, bool> allowed)
    {
        if (!IsWindow(window)) throw new ProbeException("window_changed");
        GetWindowThreadProcessId(window, out var pid);
        if (pid != binding.ProcessId || process.HasExited || !allowed(process.ProcessName) ||
            !string.Equals(process.ProcessName, binding.ProcessName, StringComparison.OrdinalIgnoreCase) ||
            process.StartTime.ToUniversalTime().Ticks.ToString(CultureInfo.InvariantCulture) != binding.ProcessStartTicks)
            throw new ProbeException("process_changed");
    }
}
