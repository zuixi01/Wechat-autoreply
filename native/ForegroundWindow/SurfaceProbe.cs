using System.Runtime.InteropServices;

internal static class SurfaceProbe {
 [StructLayout(LayoutKind.Sequential)] struct Point {public int X,Y;}
 [DllImport("user32.dll")] static extern nint WindowFromPoint(Point point);
 [DllImport("user32.dll")] static extern nint GetAncestor(nint window,uint flags);
 [StructLayout(LayoutKind.Sequential)] struct Rect {public int Left,Top,Right,Bottom;}
 [DllImport("user32.dll")] static extern bool GetWindowRect(nint window,out Rect rect);
 [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(nint window,out uint pid);
 // Only search operations may admit WeChat's separate autocomplete surface.
 // Keep the allowance inside the left pane; reply editors never use it.
 internal static bool IsSearchPopup(uint mainPid,uint popupPid,Bounds main,Bounds popup) =>
  mainPid!=0 && mainPid==popupPid && popup.Width>0 && popup.Height>0 &&
  popup.X>=main.X && popup.Y>=main.Y &&
  (long)popup.X+popup.Width<=main.X+main.Width*0.55 &&
  (long)popup.Y+popup.Height<=main.Y+main.Height &&
  popup.Y<=main.Y+main.Height*0.25;
 // Inspect the visible chat and editor without activating or closing other apps.
 // Child controls belong to the same root; notifications and menus do not.
 internal static bool IsBlocked(nint window,Bounds bounds,bool search=false) {
  GetWindowThreadProcessId(window,out var mainPid);
  for(var y=0.1;y<=0.961;y+=0.086)
   for(var x=0.25;x<=0.961;x+=0.071) {
    var hit=WindowFromPoint(new Point{X=bounds.X+(int)(bounds.Width*x),Y=bounds.Y+(int)(bounds.Height*y)});
    if(hit==0) return true;
    var root=GetAncestor(hit,2);
    if(root==window) continue;
    if(!search || !GetWindowRect(root,out var rect)) return true;
    GetWindowThreadProcessId(root,out var popupPid);
    if(!IsSearchPopup(mainPid,popupPid,bounds,new Bounds(rect.Left,rect.Top,rect.Right-rect.Left,rect.Bottom-rect.Top))) return true;
   }
  return false;
 }
}
