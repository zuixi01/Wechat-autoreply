using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text.Json;
using System.Windows.Automation;

namespace WindowsAdapter;

// This build intentionally has no input, send, clipboard, focus or window-switch command.
// UIA metadata cannot establish an account/customer identity or unattended capability.
internal static class Program
{
    private static readonly JsonSerializerOptions Json = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        UnmappedMemberHandling = System.Text.Json.Serialization.JsonUnmappedMemberHandling.Disallow };
    private static readonly HashSet<string> ClientNames = new(StringComparer.OrdinalIgnoreCase)
        { "Weixin", "WeChat", "WXWork" };

    [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindowsProc callback, nint parameter);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(nint window, out uint processId);
    private delegate bool EnumWindowsProc(nint window, nint parameter);

    [MTAThread]
    private static int Main()
    {
        string? line;
        while ((line = Console.ReadLine()) is not null)
        {
            string? requestId = null;
            try
            {
                if (line.Length > 65536) throw new ProtocolException("request_too_large");
                using var doc = JsonDocument.Parse(line);
                var request = doc.RootElement;
                requestId = request.GetProperty("requestId").GetString();
                if (string.IsNullOrWhiteSpace(requestId) || requestId.Length > 128)
                    throw new ProtocolException("invalid_request_id");
                if (request.GetProperty("protocolVersion").GetInt32() != 1)
                    throw new ProtocolException("unsupported_protocol");
                var command = request.GetProperty("command").GetString();
                object result = command switch
                {
                    "info" => new { adapterVersion = WindowProbe.Version, commands = new[] { "info", "listWindows", "probe" },
                        probeViews = new[] { "control", "raw" },
                        desktopActivityObservation = true,
                        backgroundReadVerified = false, nonInterferingSendVerified = false, identityVerified = false },
                    "listWindows" => ListWindows(),
                    "probe" => Probe(request),
                    _ => throw new ProtocolException("unsupported_command")
                };
                Emit(new { requestId, protocolVersion = 1, ok = true, result });
            }
            catch (ProtocolException error) { Emit(new { requestId, protocolVersion = 1, ok = false, error = error.Code }); }
            catch (ProbeException error) {
                Emit(new { requestId, protocolVersion = 1, ok = false, error = error.Code });
                if (error.Code == "activity_stop_unconfirmed") return 1;
            }
            catch (ElementNotAvailableException) { Emit(new { requestId, protocolVersion = 1, ok = false, error = "element_unavailable" }); }
            catch { Emit(new { requestId, protocolVersion = 1, ok = false, error = "probe_failed" }); }
        }
        return 0;
    }

    private static void Emit(object response)
    {
        Console.WriteLine(JsonSerializer.Serialize(response, Json));
        Console.Out.Flush();
    }

    private static object ListWindows()
    {
        var windows = new List<object>();
        EnumWindows((window, _) =>
        {
            try
            {
                GetWindowThreadProcessId(window, out var pid);
                using var process = Process.GetProcessById(checked((int)pid));
                if (!ClientNames.Contains(process.ProcessName)) return true;
                windows.Add(new { handle = window.ToInt64().ToString(), processId = process.Id,
                    processName = ClientNames.Single(n => string.Equals(n, process.ProcessName, StringComparison.OrdinalIgnoreCase)),
                    processStartTicks = process.StartTime.ToUniversalTime().Ticks.ToString() });
            }
            catch { /* Exited, inaccessible or unrelated process; never infer its identity. */ }
            return true;
        }, 0);
        return new { windows, identityVerified = false };
    }

    private static ProbeReport Probe(JsonElement request)
    {
        var treeView = request.TryGetProperty("treeView", out var view) ? view.GetString() : "control";
        if (treeView is not ("control" or "raw")) throw new ProbeException("invalid_tree_view");
        return WindowProbe.Capture(
            JsonSerializer.Deserialize<WindowBinding>(request.GetProperty("binding").GetRawText(), Json)
                ?? throw new ProbeException("invalid_binding"), ClientNames.Contains, treeView: treeView);
    }

    private sealed class ProtocolException(string code) : Exception
    {
        public string Code { get; } = code;
    }
}
