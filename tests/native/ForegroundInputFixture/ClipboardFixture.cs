using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

internal static class ClipboardFixture {
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern nint CreateWindowExW(uint style,string name,string text,uint flags,int x,int y,int width,int height,nint parent,nint menu,nint instance,nint parameter);
 [DllImport("user32.dll")] static extern bool DestroyWindow(nint window);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern nint SendMessageW(nint window,uint message,nint first,nint second);
 [DllImport("user32.dll")] static extern bool PostMessageW(nint window,uint message,nint first,nint second);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern bool SetWindowTextW(nint window,string text);
 [DllImport("user32.dll")] static extern bool OpenClipboard(nint owner);
 [DllImport("user32.dll")] static extern bool CloseClipboard();
 [DllImport("user32.dll")] static extern uint EnumClipboardFormats(uint format);
 [DllImport("user32.dll")] static extern bool IsClipboardFormatAvailable(uint format);
 [DllImport("user32.dll")] static extern nint GetClipboardData(uint format);
 [DllImport("kernel32.dll")] static extern nint GlobalLock(nint handle);
 [DllImport("kernel32.dll")] static extern bool GlobalUnlock(nint handle);
 [DllImport("kernel32.dll")] static extern nuint GlobalSize(nint handle);
 [DllImport("gdi32.dll")] static extern int GetObjectW(nint handle,int size,nint data);
 static void Open(nint owner) {
  for(var attempt=0;attempt<15;attempt++) {
   if(OpenClipboard(owner)) return;
   ClipboardInput.Wait(20);
  }
  throw new Exception("fixture_clipboard_busy");
 }
 internal static void VerifyRestoredBitmap() {
  Open(0);
  try {
   if(!IsClipboardFormatAvailable(2)) return;
   var data=Marshal.AllocHGlobal(128);
   try {
    if(GetObjectW(GetClipboardData(2),128,data)==0)
     throw new Exception("restored_bitmap_invalid_after_process_exit");
   } finally {Marshal.FreeHGlobal(data);}
  } finally {CloseClipboard();}
  Console.WriteLine("Restored clipboard bitmap remains readable after the transfer process exits.");
 }
 static string Fingerprint(nint owner) {
  Open(owner);
  try {
   var formats=new List<uint>();uint next=0;
   while((next=EnumClipboardFormats(next))!=0) formats.Add(next);
   var values=new List<string>();
   foreach(var format in formats) {
    var handle=GetClipboardData(format);
    if(format is 2 or 9 or 14 or 0x82 or 0x8e) {values.Add(format+":handle");continue;}
    var size=GlobalSize(handle);
    if(size==0) {Console.WriteLine("Clipboard fixture: non-memory format "+format);values.Add(format+":handle");continue;}
    var pointer=GlobalLock(handle);
    if(pointer==0) throw new Exception("fixture_clipboard_lock_failed");
    try {
     var bytes=new byte[(int)size];Marshal.Copy(pointer,bytes,0,bytes.Length);
     values.Add(format+":"+Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(bytes)));
    } finally {GlobalUnlock(handle);}
   }
   return string.Join("|",values.Order());
  } finally {CloseClipboard();}
 }
 internal static void Run(Action<bool,string> check) {
  nint editor=0;
  using var ready=new ManualResetEventSlim();
  using var stop=new ManualResetEventSlim();
  var ui=new Thread(()=>{
   editor=CreateWindowExW(0,"EDIT","",0x80000004,0,0,800,200,0,0,0,0);
   ready.Set();
   try {while(!stop.IsSet) ClipboardInput.Wait(10);}
   finally {if(editor!=0) DestroyWindow(editor);}
  }){IsBackground=true};
  ui.Start();
  if(!ready.Wait(5000) || editor==0) {stop.Set();throw new Exception("fixture_edit_window_failed");}
  try {
   Console.WriteLine("Clipboard fixture: snapshot original formats");
   var before=Fingerprint(editor);
   foreach(var expected in new[]{"宋总您好，Q 123！😀","你好呀，那个“小野猫”也太能折腾人了🤣","核验 𠮷 中文、ASCII and café。"}) {
    SetWindowTextW(editor,"");
    Console.WriteLine("Clipboard fixture: create guarded transfer");
    using(var transfer=new ClipboardInput()) {
     void Key(int key,bool control) {
      if(!control) throw new Exception("fixture_unexpected_key");
      if(key==0x56) SendMessageW(editor,0x302,0,0);
      else if(key==0x41) SendMessageW(editor,0xb1,0,-1);
      // Copy runs asynchronously on another UI thread, just like WeChat. Its
      // EmptyClipboard notification must be handled by the helper's owner.
      else if(key==0x43) {if(!PostMessageW(editor,0x301,0,0)) throw new Exception("fixture_copy_failed");}
      else if(key==0x23) SendMessageW(editor,0xb1,-1,-1);
      else throw new Exception("fixture_unexpected_key");
     }
     Console.WriteLine("Clipboard fixture: paste and read back");
     var actual=transfer.Paste(expected,Environment.ProcessId,Key,()=>{});
     check(actual==expected,"hidden EDIT Unicode paste/readback exact");
    }
    Console.WriteLine("Clipboard fixture: verify restored formats");
    check(Fingerprint(editor)==before,"all original clipboard formats and bytes restored");
   }
   using(var transfer=new ClipboardInput()) {
    var blocked=false;
    try {transfer.Paste("不可输入",Environment.ProcessId,(_,_)=>throw new Exception("unexpected input"),()=>throw new Exception("foreground_lost"));}
    catch(Exception error) when(error.Message=="foreground_lost") {blocked=true;}
    check(blocked,"guard aborts before clipboard and input mutation");
   }
   check(Fingerprint(editor)==before,"clipboard unchanged after pre-input rejection");
   var dib=new byte[40+4*4*4];
   BitConverter.GetBytes(40u).CopyTo(dib,0);BitConverter.GetBytes(4).CopyTo(dib,4);BitConverter.GetBytes(-4).CopyTo(dib,8);
   BitConverter.GetBytes((ushort)1).CopyTo(dib,12);BitConverter.GetBytes((ushort)32).CopyTo(dib,14);
   var pasteKeys=0;
   using(var transfer=new ClipboardInput()) {
    transfer.PasteImage(dib,(key,control)=>{check(key==0x56 && control,"image transfer only pastes, never sends");pasteKeys++;check(IsClipboardFormatAvailable(8),"validated DIB available at paste time");},()=>{});
   }
   check(pasteKeys==1,"one image paste only");check(Fingerprint(editor)==before,"image transfer restores original clipboard");
   var guardCalls=0;var cancelled=false;
   try {using(var transfer=new ClipboardInput()) {
    transfer.PasteImage(dib,(_,_)=>{},()=>{if(++guardCalls==3) throw new Exception("cancelled");});
   }} catch(Exception error) when(error.Message=="cancelled") {cancelled=true;}
   check(cancelled,"image transfer cancellation observed after paste");
   check(Fingerprint(editor)==before,"cancelled image transfer restores original clipboard");
   using(var transfer=new ClipboardInput()) {
    var rejected=false;
    try {transfer.PasteImage(new byte[60],(_,_)=>throw new Exception("unexpected input"),()=>{});} catch(Exception error) when(error.Message=="image_invalid") {rejected=true;}
    check(rejected,"invalid image rejected before paste");
   }
   check(Fingerprint(editor)==before,"invalid image leaves clipboard unchanged");
  } finally {stop.Set();if(!ui.Join(3000)) throw new Exception("fixture_ui_thread_failed");}
 }
}
