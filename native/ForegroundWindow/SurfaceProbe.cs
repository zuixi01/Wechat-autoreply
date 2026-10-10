using System.Runtime.InteropServices;

internal static class SurfaceProbe {
 [StructLayout(LayoutKind.Sequential)] struct Point {public int X,Y;}
 [DllImport("user32.dll")] static extern nint WindowFromPoint(Point point);
 [DllImport("user32.dll")] static extern nint GetAncestor(nint window,uint flags);
 // Inspect the visible chat and editor without activating or closing other apps.
 // Child controls belong to the same root; notifications and menus do not.
 internal static bool IsBlocked(nint window,Bounds bounds) {
  for(var y=0.1;y<=0.961;y+=0.086)
   for(var x=0.25;x<=0.961;x+=0.071) {
    var hit=WindowFromPoint(new Point{X=bounds.X+(int)(bounds.Width*x),Y=bounds.Y+(int)(bounds.Height*y)});
    if(hit==0 || GetAncestor(hit,2)!=window) return true;
   }
  return false;
 }
}
