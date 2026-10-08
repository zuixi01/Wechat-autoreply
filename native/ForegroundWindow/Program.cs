using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;

internal record Bounds(int X,int Y,int Width,int Height);
internal record Binding(string Id,int Pid,string Path,string StartTicks,Bounds Bounds);
internal static class Program {
 delegate bool WindowCallback(nint window,nint parameter);
 [StructLayout(LayoutKind.Sequential)] struct Rect {public int Left,Top,Right,Bottom;}
 [DllImport("user32.dll")] static extern bool EnumWindows(WindowCallback callback,nint parameter);
 [DllImport("user32.dll")] static extern bool IsWindowVisible(nint window);
 [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(nint window,out uint pid);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetWindowText(nint window,StringBuilder text,int count);
 [DllImport("user32.dll")] static extern bool GetWindowRect(nint window,out Rect rect);
 [DllImport("user32.dll")] static extern nint GetForegroundWindow();
 [DllImport("user32.dll")] static extern bool SetForegroundWindow(nint window);
 [DllImport("user32.dll")] static extern bool ShowWindow(nint window,int command);
 [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(nint context);
 static readonly JsonSerializerOptions Json=new(){PropertyNamingPolicy=JsonNamingPolicy.CamelCase,UnmappedMemberHandling=System.Text.Json.Serialization.JsonUnmappedMemberHandling.Disallow};
 static string Foreground()=>GetForegroundWindow().ToInt64().ToString();
 static Binding[] Windows() {
  var list=new List<Binding>();
  EnumWindows((window,_)=>{
   try {
    if(!IsWindowVisible(window)) return true;
    GetWindowThreadProcessId(window,out var pid);using var p=Process.GetProcessById((int)pid);
    if(p.ProcessName is not ("Weixin" or "WeChat")) return true;
    var title=new StringBuilder(256);GetWindowText(window,title,title.Capacity);if(title.ToString()!="微信") return true;
    if(!GetWindowRect(window,out var rect)) return true;
    var path=p.MainModule?.FileName;if(path==null) return true;
    list.Add(new Binding(window.ToInt64().ToString(),p.Id,path,p.StartTime.ToUniversalTime().Ticks.ToString(),new Bounds(rect.Left,rect.Top,rect.Right-rect.Left,rect.Bottom-rect.Top)));
   } catch { } return true;
  },0); return list.Take(16).ToArray();
 }
 static void Main() {
  Console.InputEncoding=Encoding.UTF8;Console.OutputEncoding=new UTF8Encoding(false);SetProcessDpiAwarenessContext((nint)(-4));
  string? line;while((line=Console.ReadLine())!=null) {
   string? id=null;
   try {
    if(line.Length>8192) throw new Exception("request_invalid");
    using var document=JsonDocument.Parse(line);var root=document.RootElement;id=root.GetProperty("id").GetString();if(!Guid.TryParse(id,out _)) throw new Exception("request_invalid");
    var command=root.GetProperty("command").GetString();var windows=Windows();
    if(command=="focus") {
     var expected=JsonSerializer.Deserialize<Binding>(root.GetProperty("binding").GetRawText(),Json);
     var selected=windows.SingleOrDefault(w=>w==expected);if(selected==null) throw new Exception("window_changed");
     var handle=(nint)long.Parse(selected.Id);ShowWindow(handle,9);SetForegroundWindow(handle);
    } else if(command!="inspect") throw new Exception("request_invalid");
    Console.WriteLine(JsonSerializer.Serialize(new {id,ok=true,windows=Windows(),foreground=Foreground()},Json));
   } catch(Exception e) {var code=e.Message is "request_invalid" or "window_changed"?e.Message:"window_query_failed";Console.WriteLine(JsonSerializer.Serialize(new{id,ok=false,error=code},Json));}
   Console.Out.Flush();
  }
 }
}
