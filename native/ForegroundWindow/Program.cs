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
 [DllImport("user32.dll")] static extern short GetAsyncKeyState(int key);
 [DllImport("user32.dll",SetLastError=true)] static extern uint SendInput(uint count,KeyboardInput[] inputs,int size);
 static void Shortcut(int key,bool control,Action guard) {
  guard();
  if(new[]{0x10,0x11,0x12,0x5B,0x5C}.Any(value=>(GetAsyncKeyState(value)&0x8000)!=0)) throw new Exception("input_state_changed");
  var keys=control?new[]{(0x11,false),(key,false),(key,true),(0x11,true)}:new[]{(key,false),(key,true)};
  var inputs=keys.Select(value=>new KeyboardInput{Type=1,Key=(ushort)value.Item1,Flags=value.Item2?2u:0u}).ToArray();
  if(SendInput((uint)inputs.Length,inputs,Marshal.SizeOf<KeyboardInput>())!=inputs.Length) throw new Exception("input_failed");
  ClipboardInput.Wait(25);guard();
 }
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
    string? editorText=null;
    if(command is "focus" or "type" or "read_editor") {
     var expected=JsonSerializer.Deserialize<Binding>(root.GetProperty("binding").GetRawText(),Json);
     var selected=windows.SingleOrDefault(w=>w==expected);if(selected==null) throw new Exception("window_changed");
     var handle=(nint)long.Parse(selected.Id);
     if(command=="focus") {
      if(IsIconic(handle)) ShowWindow(handle,9);SetForegroundWindow(handle);
     } else {
      var text=command=="type"?root.GetProperty("text").GetString():null;if(text!=null) UnicodeInput.Validate(text);
      if(nint.Size!=8 || Marshal.SizeOf<GuiThreadInfo>()!=72) throw new Exception("input_failed");
      var editor=Editor(handle,selected.Pid);
      void Guard() {
       if(!Windows().Any(value=>value==selected)) throw new Exception("window_changed");
       if(Editor(handle,selected.Pid)!=editor) throw new Exception("input_state_changed");
      }
      using var transfer=new ClipboardInput();
      editorText=command=="type"
       ?transfer.Paste(text!,selected.Pid,(key,control)=>Shortcut(key,control,Guard),Guard)
       :transfer.CopyEditor(selected.Pid,(key,control)=>Shortcut(key,control,Guard),Guard);
     }
    } else if(command!="inspect") throw new Exception("request_invalid");
    Console.WriteLine(JsonSerializer.Serialize(new {id,ok=true,windows=Windows(),foreground=Foreground(),editorText},Json));
   } catch(Exception e) {var code=e.Message is "request_invalid" or "window_changed" or "foreground_lost" or "text_invalid" or "input_failed" or "input_state_changed" or "clipboard_unavailable" or "clipboard_state_changed" or "editor_text_unavailable"?e.Message:"window_query_failed";Console.WriteLine(JsonSerializer.Serialize(new{id,ok=false,error=code},Json));}
   Console.Out.Flush();
  }
 }
}
