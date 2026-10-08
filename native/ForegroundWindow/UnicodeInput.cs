using System.Runtime.InteropServices;
using System.Text;

[StructLayout(LayoutKind.Sequential)]
internal struct CaretRect {
 public int Left,Top,Right,Bottom;
}
[StructLayout(LayoutKind.Sequential)]
internal struct GuiThreadInfo {
 public uint Size,Flags;
 public nint Active,Focus,Capture,MenuOwner,MoveSize,Caret;
 public CaretRect CaretBounds;
}
internal static class UnicodeInput {
 internal const int CharacterDelayMs=30;
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
 // UTF16 surrogate pairs stay adjacent, without a pacing delay between halves.
 internal static IEnumerable<char[]> Characters(string text) {
  Validate(text);
  foreach(var rune in text.EnumerateRunes())
   yield return rune.ToString().ToCharArray();
 }
}
