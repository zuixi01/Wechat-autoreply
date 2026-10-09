using System.Runtime.InteropServices;
using System.Text;

// One paste and one copy, never Enter. Keep every original clipboard format;
// refuse unsupported handles before changing anything. A newer user clipboard
// is never overwritten by restoration.
internal sealed class ClipboardInput : IDisposable {
 [StructLayout(LayoutKind.Sequential)] internal struct Message {
  public nint Window;
  public uint Kind;
  public nuint WParam;
  public nint LParam;
  public uint Time;
  public int X,Y;
  public uint Private;
 }
 [DllImport("user32.dll")] static extern bool PeekMessageW(out Message message,nint window,uint first,uint last,uint flags);
 [DllImport("user32.dll")] static extern nint DispatchMessageW(ref Message message);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern nint CreateWindowExW(uint style,string name,string text,uint flags,int x,int y,int width,int height,nint parent,nint menu,nint instance,nint parameter);
 [DllImport("user32.dll")] static extern bool DestroyWindow(nint window);
 [DllImport("user32.dll")] static extern bool OpenClipboard(nint window);
 [DllImport("user32.dll")] static extern bool CloseClipboard();
 [DllImport("user32.dll")] static extern bool EmptyClipboard();
 [DllImport("user32.dll")] static extern uint EnumClipboardFormats(uint format);
 [DllImport("user32.dll")] static extern nint GetClipboardData(uint format);
 [DllImport("user32.dll")] static extern nint SetClipboardData(uint format,nint data);
 [DllImport("user32.dll")] static extern uint GetClipboardSequenceNumber();
 [DllImport("user32.dll")] static extern nint GetClipboardOwner();
 [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(nint window,out uint pid);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern uint RegisterClipboardFormatW(string name);
 [DllImport("user32.dll")] static extern nint CopyImage(nint handle,uint type,int width,int height,uint flags);
 [DllImport("gdi32.dll",CharSet=CharSet.Unicode)] static extern nint CopyEnhMetaFileW(nint handle,string? file);
 [DllImport("gdi32.dll")] static extern bool DeleteEnhMetaFile(nint handle);
 [DllImport("gdi32.dll")] static extern bool DeleteObject(nint handle);
 [DllImport("kernel32.dll")] static extern nint GlobalAlloc(uint flags,nuint size);
 [DllImport("kernel32.dll")] static extern nint GlobalLock(nint handle);
 [DllImport("kernel32.dll")] static extern bool GlobalUnlock(nint handle);
 [DllImport("kernel32.dll")] static extern nuint GlobalSize(nint handle);
 [DllImport("kernel32.dll")] static extern nint GlobalFree(nint handle);
 internal record Entry(uint Format,nint Handle,int Kind);
 readonly nint owner;
 readonly List<Entry> original=new();
 uint sequence;
 bool changed;
 internal static void Wait(int milliseconds) {
  var deadline=Environment.TickCount64+milliseconds;
  do {
   // Qt's Ctrl+C waits for our clipboard owner to handle WM_DESTROYCLIPBOARD.
   // Pump the hidden owner's messages while waiting; sleeping alone deadlocks
   // the copying application against OpenClipboard on this thread.
   while(PeekMessageW(out var message,0,0,0,1)) DispatchMessageW(ref message);
   if(Environment.TickCount64>=deadline) break;
   Thread.Sleep(5);
  } while(true);
 }
 internal ClipboardInput() {
  owner=CreateWindowExW(0,"STATIC","",0,0,0,0,0,(nint)(-3),0,0,0);
  if(owner==0) throw new Exception("clipboard_unavailable");
  try {
   Open();
   try {
    sequence=GetClipboardSequenceNumber();
    var formats=new List<uint>();uint format=0;
    while((format=EnumClipboardFormats(format))!=0) {
     if(formats.Count>=64) throw new Exception("clipboard_unavailable");
     formats.Add(format);
    }
    nuint total=0;
    foreach(var value in formats) {
     // Windows synthesizes CF_BITMAP from CF_DIB/CF_DIBV5. Restore the complete
     // DIB bytes and let Windows own that conversion; a copied DIB-section
     // bitmap can become invalid after this helper process exits.
     if(value==2 && (formats.Contains(8) || formats.Contains(17))) continue;
     var handle=GetClipboardData(value);if(handle==0) throw new Exception("clipboard_unavailable");
     nint copy;int kind=0;
     if(value is 2 or 0x82) {copy=CopyImage(handle,0,0,0,0);kind=1;}
     else if(value is 14 or 0x8e) {copy=CopyEnhMetaFileW(handle,null);kind=2;}
     else {
      if(value is 3 or 9 or 0x80 or 0x83 || value is >=0x200 and <=0x3ff) throw new Exception("clipboard_unavailable");
      var size=GlobalSize(handle);total+=size;
      if(size==0 || total>128*1024*1024) throw new Exception("clipboard_unavailable");
      var source=GlobalLock(handle);if(source==0) throw new Exception("clipboard_unavailable");
      try {var bytes=new byte[checked((int)size)];Marshal.Copy(source,bytes,0,bytes.Length);copy=Allocate(bytes);}
      finally {GlobalUnlock(handle);}
     }
     if(copy==0) throw new Exception("clipboard_unavailable");
     original.Add(new Entry(value,copy,kind));
    }
    // Delayed rendering may advance the sequence while taking the snapshot.
    sequence=GetClipboardSequenceNumber();
   } finally {CloseClipboard();}
  } catch {Dispose();throw;}
 }
 void Open() {
  for(var attempt=0;attempt<15;attempt++) {if(OpenClipboard(owner)) return;Wait(20);}
  throw new Exception("clipboard_unavailable");
 }
 static nint Allocate(byte[] bytes) {
  var handle=GlobalAlloc(2,(nuint)bytes.Length);if(handle==0) throw new Exception("clipboard_unavailable");
  var target=GlobalLock(handle);
  if(target==0) {GlobalFree(handle);throw new Exception("clipboard_unavailable");}
  try {Marshal.Copy(bytes,0,target,bytes.Length);} finally {GlobalUnlock(handle);}
  return handle;
 }
 internal void SetText(string text) {
  var handle=Allocate(Encoding.Unicode.GetBytes(text+'\0'));
  try {
   Open();
   try {
    if(GetClipboardSequenceNumber()!=sequence) throw new Exception("clipboard_state_changed");
    if(!EmptyClipboard()) throw new Exception("clipboard_unavailable");
    changed=true;
    sequence=GetClipboardSequenceNumber();
    if(SetClipboardData(13,handle)==0) throw new Exception("clipboard_unavailable");
    handle=0;
    sequence=GetClipboardSequenceNumber();
    var marker=Allocate(BitConverter.GetBytes(0));
    if(SetClipboardData(RegisterClipboardFormatW("CanIncludeInClipboardHistory"),marker)==0) GlobalFree(marker);
    sequence=GetClipboardSequenceNumber();
   } finally {CloseClipboard();}
  } finally {if(handle!=0) GlobalFree(handle);}
 }
 internal string CopyEditor(int expectedPid,Action<int,bool> key,Action guard) {
  guard();key(0x41,true);guard();
  var before=GetClipboardSequenceNumber();key(0x43,true);
  for(var attempt=0;attempt<30 && GetClipboardSequenceNumber()==before;attempt++) {guard();Wait(20);}
  guard();
  if(GetClipboardSequenceNumber()==before) throw new Exception("editor_text_unavailable");
  Open();
  string text;
  try {
   GetWindowThreadProcessId(GetClipboardOwner(),out var pid);
   if(pid!=expectedPid) throw new Exception("clipboard_state_changed");
   sequence=GetClipboardSequenceNumber();changed=true;
   var handle=GetClipboardData(13);var size=GlobalSize(handle);
   if(handle==0 || size<2 || size>32768) throw new Exception("editor_text_unavailable");
   var pointer=GlobalLock(handle);if(pointer==0) throw new Exception("editor_text_unavailable");
   try {
    var bytes=new byte[(int)size];Marshal.Copy(pointer,bytes,0,bytes.Length);
    text=Encoding.Unicode.GetString(bytes).TrimEnd('\0');
    if(text.Length>4096) throw new Exception("editor_text_unavailable");
   } finally {GlobalUnlock(handle);}
   sequence=GetClipboardSequenceNumber();
  } finally {CloseClipboard();}
  guard();key(0x23,true);guard(); // Ctrl+End collapses our selection without editing.
  return text;
 }
 internal string Paste(string text,int expectedPid,Action<int,bool> key,Action guard) {
  UnicodeInput.Validate(text);guard();SetText(text);guard();
  key(0x56,true);Wait(80);guard();
  return CopyEditor(expectedPid,key,guard);
 }
 public void Dispose() {
  try {
   if(changed) {
    Open();
    try {
     if(GetClipboardSequenceNumber()==sequence) {
      if(!EmptyClipboard()) throw new Exception("clipboard_unavailable");
      for(var i=0;i<original.Count;i++) {
       var value=original[i];
       if(SetClipboardData(value.Format,value.Handle)==0) throw new Exception("clipboard_unavailable");
       original[i]=value with {Handle=0};
      }
     }
    } finally {CloseClipboard();}
   }
  } finally {
   foreach(var value in original) if(value.Handle!=0) {
    if(value.Kind==1) DeleteObject(value.Handle);else if(value.Kind==2) DeleteEnhMetaFile(value.Handle);else GlobalFree(value.Handle);
   }
   original.Clear();if(owner!=0) DestroyWindow(owner);
  }
 }
}
