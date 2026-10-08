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
 [DllImport("user32.dll")] static extern bool IsIconic(nint window);
 [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(nint window,int attribute,out Rect rect,int size);
 [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(nint context);
 [DllImport("user32.dll",SetLastError=true)] static extern bool GetGUIThreadInfo(uint thread,ref GuiThreadInfo info);
 [DllImport("user32.dll")] static extern nint GetAncestor(nint window,uint flags);
 [DllImport("user32.dll")] static extern bool IsWindowUnicode(nint window);
 [DllImport("user32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern nint SendMessageTimeoutW(nint window,uint message,nuint character,nint parameter,uint flags,uint timeout,out nuint result);
 [DllImport("user32.dll")] static extern short GetAsyncKeyState(int key);
 static readonly JsonSerializerOptions Json=new(){PropertyNamingPolicy=JsonNamingPolicy.CamelCase,UnmappedMemberHandling=System.Text.Json.Serialization.JsonUnmappedMemberHandling.Disallow};
 static string Foreground()=>GetForegroundWindow().ToInt64().ToString();
 static nint Editor(nint handle,int pid) {
  if(GetForegroundWindow()!=handle) throw new Exception("foreground_lost");
  var thread=GetWindowThreadProcessId(handle,out var owner);
  var info=new GuiThreadInfo{Size=(uint)Marshal.SizeOf<GuiThreadInfo>()};
  if(owner!=pid || !GetGUIThreadInfo(thread,ref info) || info.Focus==0 ||
   GetAncestor(info.Focus,2)!=handle || !IsWindowUnicode(info.Focus)) throw new Exception("input_state_changed");
  GetWindowThreadProcessId(info.Focus,out var editorOwner);
  if(editorOwner!=pid) throw new Exception("input_state_changed");
  return info.Focus;
 }
 static Binding[] Windows() {
  var list=new List<Binding>();
  EnumWindows((window,_)=>{
   try {
    if(!IsWindowVisible(window)) return true;
    GetWindowThreadProcessId(window,out var pid);using var p=Process.GetProcessById((int)pid);
    if(p.ProcessName is not ("Weixin" or "WeChat")) return true;
    var title=new StringBuilder(256);GetWindowText(window,title,title.Capacity);if(title.ToString()!="微信") return true;
    if(!GetWindowRect(window,out var rect)) return true;
    // GetWindowRect includes invisible resize borders (often -9,-9 when
    // maximized). Capture the visible frame in physical pixels instead.
    if(DwmGetWindowAttribute(window,9,out var visible,Marshal.SizeOf<Rect>())==0 && visible.Right>visible.Left && visible.Bottom>visible.Top) rect=visible;
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
    if(line.Length>65536) throw new Exception("request_invalid");
    using var document=JsonDocument.Parse(line);var root=document.RootElement;id=root.GetProperty("id").GetString();if(!Guid.TryParse(id,out _)) throw new Exception("request_invalid");
    var command=root.GetProperty("command").GetString();var windows=Windows();
    if(command is "focus" or "type") {
     var expected=JsonSerializer.Deserialize<Binding>(root.GetProperty("binding").GetRawText(),Json);
     var selected=windows.SingleOrDefault(w=>w==expected);if(selected==null) throw new Exception("window_changed");
     var handle=(nint)long.Parse(selected.Id);
     if(command=="focus") {
      if(IsIconic(handle)) ShowWindow(handle,9);SetForegroundWindow(handle);
     } else {
      var text=root.GetProperty("text").GetString();UnicodeInput.Validate(text);
      if(nint.Size!=8 || Marshal.SizeOf<GuiThreadInfo>()!=72) throw new Exception("input_failed");
      var editor=Editor(handle,selected.Pid);
      // WM_CHAR supplies UTF16 directly, avoiding VK_PACKET/IME conversion of
      // fullwidth punctuation. Only the bound foreground editor is eligible.
      // https://learn.microsoft.com/windows/win32/inputdev/wm-char
      foreach(var characters in UnicodeInput.Characters(text!)) {
       if(Editor(handle,selected.Pid)!=editor) throw new Exception("input_state_changed");
       if(new[]{0x10,0x11,0x12,0x5B,0x5C}.Any(key=>(GetAsyncKeyState(key)&0x8000)!=0)) throw new Exception("input_state_changed");
       foreach(var character in characters) {
        if(Editor(handle,selected.Pid)!=editor) throw new Exception("input_state_changed");
        if(SendMessageTimeoutW(editor,0x0102,character,1,3,500,out _)==0) throw new Exception("input_failed");
       }
       Thread.Sleep(UnicodeInput.CharacterDelayMs);
      }
     }
    } else if(command!="inspect") throw new Exception("request_invalid");
    Console.WriteLine(JsonSerializer.Serialize(new {id,ok=true,windows=Windows(),foreground=Foreground()},Json));
   } catch(Exception e) {var code=e.Message is "request_invalid" or "window_changed" or "foreground_lost" or "text_invalid" or "input_failed" or "input_state_changed"?e.Message:"window_query_failed";Console.WriteLine(JsonSerializer.Serialize(new{id,ok=false,error=code},Json));}
   Console.Out.Flush();
  }
 }
}
