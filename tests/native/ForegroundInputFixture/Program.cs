using System.Runtime.InteropServices;

void Check(bool value,string name) {if(!value) throw new Exception(name);}
Check(nint.Size==8 && Marshal.SizeOf<GuiThreadInfo>()==72,"Windows x64 GUITHREADINFO layout");
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
Console.WriteLine("Foreground editor ABI, Chinese/ASCII/fullwidth punctuation/emoji UTF16 and invalid-input checks passed; no desktop input sent.");
