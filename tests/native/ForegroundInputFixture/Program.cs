using System.Runtime.InteropServices;

void Check(bool value,string name) {if(!value) throw new Exception(name);}
Check(nint.Size==8 && Marshal.SizeOf<Input>()==40,"Windows x64 INPUT layout");
Check(Marshal.OffsetOf<Input>(nameof(Input.Keyboard)).ToInt32()==8,"union alignment");
Check(Marshal.OffsetOf<KeyboardInput>(nameof(KeyboardInput.ExtraInfo)).ToInt32()==16,"pointer alignment");
var text="宋总您好，Q 123！😀";
UnicodeInput.Validate(text);
foreach(var character in text) {
 var pair=UnicodeInput.Pair(character);
 foreach(var input in pair) {
  var memory=Marshal.AllocHGlobal(40);
  try {
   Marshal.StructureToPtr(input,memory,false);
   Check(Marshal.ReadInt32(memory,0)==1,"INPUT_KEYBOARD");
   Check(Marshal.ReadInt16(memory,8)==0,"Unicode virtual key zero");
   Check((ushort)Marshal.ReadInt16(memory,10)==character,"UTF16 code unit preserved");
   Check(Marshal.ReadInt64(memory,24)==0,"extra info zero");
  } finally {Marshal.FreeHGlobal(memory);}
 }
 Check(pair.Length==2 && pair[0].Keyboard.Flags==4 && pair[1].Keyboard.Flags==6,"Unicode down then up");
}
foreach(var invalid in new[]{"","hello\nworld","\t","\u007f",new string('x',4097),"\ud800","\udc00"}) {
 var rejected=false;
 try {UnicodeInput.Validate(invalid);} catch(Exception e) when(e.Message=="text_invalid") {rejected=true;}
 Check(rejected,"invalid input rejected before keyboard access");
}
Console.WriteLine("Foreground Unicode ABI, Chinese/ASCII/emoji down-up pairs and invalid-input checks passed; no desktop input sent.");
