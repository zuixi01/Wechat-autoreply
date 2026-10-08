using System.Runtime.InteropServices;

// Windows x64 INPUT is 40 bytes: the union starts at offset 8 and KEYBDINPUT
// has its pointer-sized extra-info field at offset 16. Match the Win32 ABI.
[StructLayout(LayoutKind.Sequential)]
internal struct KeyboardInput {
 public ushort VirtualKey,Scan;
 public uint Flags,Time;
 public nuint ExtraInfo;
}
[StructLayout(LayoutKind.Explicit,Size=40)]
internal struct Input {
 [FieldOffset(0)] public uint Type;
 [FieldOffset(8)] public KeyboardInput Keyboard;
}
internal static class UnicodeInput {
 internal static void Validate(string? text) {
  if(text==null || text.Length is <1 or >4096) throw new Exception("text_invalid");
  for(var i=0;i<text.Length;i++) {
   var character=text[i];
   if(character<32 || character==127) throw new Exception("text_invalid");
   if(char.IsHighSurrogate(character)) {
    if(++i>=text.Length || !char.IsLowSurrogate(text[i])) throw new Exception("text_invalid");
   } else if(char.IsLowSurrogate(character)) throw new Exception("text_invalid");
  }
 }
 internal static Input[] Pair(char character)=>[
  new Input {Type=1,Keyboard=new KeyboardInput {Scan=character,Flags=4}},
  new Input {Type=1,Keyboard=new KeyboardInput {Scan=character,Flags=4|2}}
 ];
}
