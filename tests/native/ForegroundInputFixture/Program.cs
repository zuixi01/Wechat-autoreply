using System.Runtime.InteropServices;

if(args.SequenceEqual(new[]{"--verify-restored-bitmap"})) {
 ClipboardFixture.VerifyRestoredBitmap();return;
}

void Check(bool value,string name) {if(!value) throw new Exception(name);}
Check(nint.Size==8 && Marshal.SizeOf<GuiThreadInfo>()==72,"Windows x64 GUITHREADINFO layout");
Check(Marshal.SizeOf<KeyboardInput>()==40 && Marshal.OffsetOf<KeyboardInput>(nameof(KeyboardInput.Key)).ToInt32()==8,"Windows x64 SendInput alignment");
Check(Marshal.SizeOf<ClipboardInput.Message>()==48,"Windows x64 clipboard message pump layout");
Check(Marshal.OffsetOf<GuiThreadInfo>(nameof(GuiThreadInfo.Focus)).ToInt32()==16,"focused editor handle alignment");
Check(Marshal.OffsetOf<GuiThreadInfo>(nameof(GuiThreadInfo.CaretBounds)).ToInt32()==56,"caret rectangle alignment");
var text="宋总您好，Q 123！😀";
Check(UnicodeInput.Characters(text).SelectMany(batch=>batch).SequenceEqual(text),"Chinese/ASCII/punctuation/emoji UTF16 preserved");
foreach(var invalid in new[]{"","hello\nworld","\t","\u007f",new string('x',4097),"\ud800","\udc00"}) {
 var rejected=false;
 try {UnicodeInput.Characters(invalid).ToArray();} catch(Exception e) when(e.Message=="text_invalid") {rejected=true;}
 Check(rejected,"invalid input rejected before editor access");
}
var characters=UnicodeInput.Characters("验，😀是").ToArray();
Check(characters.Length==4,"one batch per complete Unicode character");
Check(characters[2].SequenceEqual("😀"),"surrogate pair remains adjacent");
ClipboardFixture.Run(Check);
var main=new Bounds(0,0,1920,1140);
Check(SurfaceProbe.IsSearchPopup(123,123,main,new Bounds(75,99,460,625)),"owned left-side search popup allowed");
Check(!SurfaceProbe.IsSearchPopup(123,456,main,new Bounds(75,99,460,625)),"other process overlay rejected");
Check(!SurfaceProbe.IsSearchPopup(123,123,main,new Bounds(600,99,600,625)),"same-process dialog over chat rejected");
Check(!SurfaceProbe.IsSearchPopup(123,123,main,new Bounds(75,400,460,625)),"lower pane menu rejected");
Check(!SurfaceProbe.IsSearchPopup(123,123,main,new Bounds(-1,99,460,625)),"popup outside bound window rejected");
Check(!SurfaceProbe.IsSearchPopup(123,123,main,new Bounds(75,99,460,1200)),"popup exceeding window rejected");
Console.WriteLine("Foreground editor ABI, Unicode clipboard paste/readback, clipboard restoration and invalid-input checks passed; no desktop input sent.");
internal record Bounds(int X,int Y,int Width,int Height);
