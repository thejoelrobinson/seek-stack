$ErrorActionPreference='Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type @'
using System;
using System.Runtime.InteropServices;
public class SeekInput {
 [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public UNION data; }
 [StructLayout(LayoutKind.Explicit)] public struct UNION {
  [FieldOffset(0)] public MOUSE mouse;
  [FieldOffset(0)] public KEYBOARD key;
 }
 [StructLayout(LayoutKind.Sequential)] public struct MOUSE {public int dx,dy;public uint mouseData,flags,time;public UIntPtr extra;}
 [StructLayout(LayoutKind.Sequential)] public struct KEYBOARD {public ushort vk,scan;public uint flags,time;public UIntPtr extra;}
 [DllImport("user32.dll",SetLastError=true)] static extern uint SendInput(uint count,INPUT[] input,int size);
 [DllImport("user32.dll",SetLastError=true)] public static extern bool SetCursorPos(int x,int y);
 [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
 public static void DPI(){try{SetThreadDpiAwarenessContext(new IntPtr(-4));}catch{}}
 static void Send(INPUT[] input){if(SendInput((uint)input.Length,input,Marshal.SizeOf(typeof(INPUT)))!=(uint)input.Length)throw new Exception("Input was blocked by Windows or another application");}
 static INPUT KeyEvent(ushort key,ushort scan,uint flags){return new INPUT{type=1,data=new UNION{key=new KEYBOARD{vk=key,scan=scan,flags=flags}}};}
 public static void Move(int x,int y){if(!SetCursorPos(x,y))throw new Exception("Pointer movement failed");}
 public static void Click(bool right){uint down=right?8u:2u;Send(new INPUT[]{new INPUT{type=0,data=new UNION{mouse=new MOUSE{flags=down}}},new INPUT{type=0,data=new UNION{mouse=new MOUSE{flags=down*2}}}});}
 public static void Scroll(int delta){Send(new INPUT[]{new INPUT{type=0,data=new UNION{mouse=new MOUSE{flags=0x800,mouseData=unchecked((uint)delta)}}}});}
 public static void Key(ushort key){Send(new INPUT[]{KeyEvent(key,0,0),KeyEvent(key,0,2)});}
 public static void Shortcut(ushort key,ushort[] modifiers){var pressed=new System.Collections.Generic.List<ushort>();try{foreach(var modifier in modifiers){Send(new INPUT[]{KeyEvent(modifier,0,0)});pressed.Add(modifier);}Key(key);}finally{pressed.Reverse();foreach(var modifier in pressed)Send(new INPUT[]{KeyEvent(modifier,0,2)});}}
 public static void Text(string text){foreach(char ch in text){if(ch=='\n'){Key(13);continue;}if(ch=='\r')continue;if(ch=='\t'){Key(9);continue;}Send(new INPUT[]{KeyEvent(0,ch,4),KeyEvent(0,ch,6)});}}
}
'@
[SeekInput]::DPI()
Add-Type -ReferencedAssemblies UIAutomationClient,UIAutomationTypes,WindowsBase @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Windows.Automation;
public class SeekAccessibility {
 static Dictionary<string,AutomationElement> targets=new Dictionary<string,AutomationElement>();
 static Dictionary<string,string> identities=new Dictionary<string,string>();
 static CacheRequest PropertyCache(){var cache=new CacheRequest();cache.TreeScope=TreeScope.Element;foreach(var p in new AutomationProperty[]{AutomationElement.NameProperty,AutomationElement.ControlTypeProperty,AutomationElement.BoundingRectangleProperty,AutomationElement.IsEnabledProperty,AutomationElement.HasKeyboardFocusProperty,AutomationElement.IsPasswordProperty,AutomationElement.IsOffscreenProperty,AutomationElement.ProcessIdProperty,AutomationElement.NativeWindowHandleProperty})cache.Add(p);cache.Add(InvokePattern.Pattern);cache.Add(ValuePattern.Pattern);cache.Add(ValuePattern.ValueProperty);cache.Add(ValuePattern.IsReadOnlyProperty);return cache;}
 [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll")] static extern bool IsWindow(IntPtr window);
 [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr window);
 [DllImport("user32.dll")] static extern bool IsIconic(IntPtr window);
 [DllImport("user32.dll")] static extern bool ShowWindowAsync(IntPtr window,int command);
 static string observedId;static int observedPid;
 public class Window {public string id,title;public int pid;}
 public static Window[] Windows(){var result=new List<Window>();var children=AutomationElement.RootElement.FindAll(TreeScope.Children,Condition.TrueCondition);foreach(AutomationElement e in children){try{var c=e.Current;if(c.NativeWindowHandle!=0&&!c.IsOffscreen&&!String.IsNullOrEmpty(c.Name)){result.Add(new Window{id=c.NativeWindowHandle.ToString(),title=c.Name.Length>512?c.Name.Substring(0,512):c.Name,pid=c.ProcessId});if(result.Count>=80)break;}}catch(ElementNotAvailableException){}}return result.ToArray();}
 public class Node {public string id,name,role,value;public double x,y,width,height;public bool enabled,focused,password,canInvoke,canFill;public int depth;}
 public class Bounds {public double X,Y,Width,Height;}
 public class View {public string windowId,title,app;public Node[] elements;public Bounds bounds;public bool truncated;}
 static Dictionary<string,Bounds> ocrTargets=new Dictionary<string,Bounds>();
 public static void SetOcr(string id,double x,double y,double width,double height){ocrTargets[id]=new Bounds{X=x,Y=y,Width=width,Height=height};}
 public static void Activate(string id){var handle=new IntPtr(long.Parse(id));if(!IsWindow(handle))throw new Exception("Window unavailable");if(IsIconic(handle))ShowWindowAsync(handle,9);if(!SetForegroundWindow(handle)||WindowId()!=id)throw new Exception("Windows blocked foreground activation; select the window locally");}
 public static void Menu(string[] path){var handle=GetForegroundWindow();var root=AutomationElement.FromHandle(handle);foreach(string title in path){if(GetForegroundWindow()!=handle)throw new Exception("Foreground changed");var matches=root.FindAll(TreeScope.Descendants,new AndCondition(new PropertyCondition(AutomationElement.NameProperty,title),new PropertyCondition(AutomationElement.ControlTypeProperty,ControlType.MenuItem)));AutomationElement match=null;foreach(AutomationElement e in matches){if(!e.Current.IsOffscreen){if(match!=null)throw new Exception("Menu title is ambiguous");match=e;}}if(match==null)throw new Exception("Menu item unavailable; use a keyboard shortcut");object pattern;if(match.TryGetCurrentPattern(ExpandCollapsePattern.Pattern,out pattern)&&title!=path[path.Length-1])((ExpandCollapsePattern)pattern).Expand();else if(match.TryGetCurrentPattern(InvokePattern.Pattern,out pattern))((InvokePattern)pattern).Invoke();else throw new Exception("Menu action unavailable");root=AutomationElement.FromHandle(handle);}}
 public static string WindowId(){return GetForegroundWindow().ToInt64().ToString();}
 public static void CheckWindow(string id,bool foreground){
  if(String.IsNullOrEmpty(id))return;
  var handle=new IntPtr(long.Parse(id));if(id!=observedId||!IsWindow(handle)||AutomationElement.FromHandle(handle).Current.ProcessId!=observedPid)throw new Exception("Target window changed");
  if(foreground&&id!=WindowId())throw new Exception("Foreground window changed");
 }
 public static void CheckFocus(string id){if(String.IsNullOrEmpty(id))return;var e=AutomationElement.FocusedElement;if(e==null||e.Current.IsPassword||String.Join(".",e.GetRuntimeId())!=id)throw new Exception("Focused element changed");}
 public static void CheckTarget(string id,double x,double y,bool pointer){
  if(String.IsNullOrEmpty(id))return;Bounds ocr;if(ocrTargets.TryGetValue(id,out ocr)){if(!pointer||Math.Abs(ocr.X+ocr.Width/2-x)>3||Math.Abs(ocr.Y+ocr.Height/2-y)>3)throw new Exception("Screen text target changed");return;}AutomationElement e;if(!targets.TryGetValue(id,out e))throw new Exception("Target expired");var c=e.Current;
  if(c.IsPassword||!c.IsEnabled||identities[id]!=c.ControlType.ProgrammaticName+"\n"+c.Name)throw new Exception("Target changed");
  if(pointer){var b=c.BoundingRectangle;if(Math.Abs(b.X+b.Width/2-x)>3||Math.Abs(b.Y+b.Height/2-y)>3)throw new Exception("Target moved");}
 }
 public static void Invoke(string id){((InvokePattern)targets[id].GetCurrentPattern(InvokePattern.Pattern)).Invoke();}
 public static void Fill(string id,string text){var e=targets[id];if(e.Current.IsPassword)throw new Exception("Protected field");((ValuePattern)e.GetCurrentPattern(ValuePattern.Pattern)).SetValue(text);}
 public class TextResult {public string text;public bool truncated;}
 public static TextResult Read(string id){var e=targets[id];if(e.Current.IsPassword)throw new Exception("Protected field");object pattern;string text;if(e.TryGetCurrentPattern(TextPattern.Pattern,out pattern))text=((TextPattern)pattern).DocumentRange.GetText(16001);else if(e.TryGetCurrentPattern(ValuePattern.Pattern,out pattern))text=((ValuePattern)pattern).Current.Value;else text=e.Current.Name;return new TextResult{text=text.Length>16000?text.Substring(0,16000):text,truncated=text.Length>16000};}
 public static View Inspect(string selectedWindow){
  targets.Clear();identities.Clear();ocrTargets.Clear();string windowId=String.IsNullOrEmpty(selectedWindow)?WindowId():selectedWindow;var handle=new IntPtr(long.Parse(windowId));if(!IsWindow(handle))throw new Exception("Target window unavailable");var root=AutomationElement.FromHandle(handle);observedId=windowId;observedPid=root.Current.ProcessId;var nodes=new List<Node>();var timer=Stopwatch.StartNew();bool truncated=false;
  var cache=PropertyCache();root=root.GetUpdatedCache(cache);Walk(root,0,nodes,timer,cache,ref truncated);
  var rect=root.Cached.BoundingRectangle;CheckWindow(windowId,String.IsNullOrEmpty(selectedWindow));return new View{windowId=windowId,title=root.Cached.Name,app=Process.GetProcessById(observedPid).ProcessName,elements=nodes.ToArray(),bounds=new Bounds{X=rect.X,Y=rect.Y,Width=rect.Width,Height=rect.Height},truncated=truncated};
 }
 static void Walk(AutomationElement e,int depth,List<Node> nodes,Stopwatch timer,CacheRequest cache,ref bool truncated){
  if(e==null)return;if(nodes.Count>=500||depth>14||timer.ElapsedMilliseconds>2000){truncated=true;return;}
  try{
   var c=e.Cached;var b=c.BoundingRectangle;
    if(!c.IsOffscreen&&!b.IsEmpty){
    string value=null;object pattern;bool canFill=false,canInvoke=e.TryGetCachedPattern(InvokePattern.Pattern,out pattern);if(!c.IsPassword&&e.TryGetCachedPattern(ValuePattern.Pattern,out pattern)){var vp=(ValuePattern)pattern;value=vp.Cached.Value;canFill=!vp.Cached.IsReadOnly;}
    if(value!=null&&value.Length>4096)value=value.Substring(0,4096);string name=c.Name;if(name.Length>512)name=name.Substring(0,512);
    string id=String.Join(".",e.GetRuntimeId());targets[id]=e;identities[id]=c.ControlType.ProgrammaticName+"\n"+c.Name;
    nodes.Add(new Node{id=id,name=name,role=c.ControlType.ProgrammaticName,value=value,x=b.X,y=b.Y,width=b.Width,height=b.Height,enabled=c.IsEnabled,focused=c.HasKeyboardFocus,password=c.IsPassword,canInvoke=canInvoke,canFill=canFill,depth=depth});
   }
   var walker=TreeWalker.ControlViewWalker;var child=walker.GetFirstChild(e,cache);
   while(child!=null){if(nodes.Count>=500||timer.ElapsedMilliseconds>2000){truncated=true;break;}Walk(child,depth+1,nodes,timer,cache,ref truncated);child=walker.GetNextSibling(child,cache);}
  }catch(ElementNotAvailableException){}catch(InvalidOperationException){}
 }
}
'@
while($null -ne ($line=[Console]::ReadLine())) {
 try {
  $c=$line|ConvertFrom-Json
  if($c.kind -eq 'apps'){$apps=@(Get-StartApps | Select-Object @{n='id';e={$_.AppID}},@{n='name';e={$_.Name}} | Select-Object -First 500);[Console]::WriteLine((@{ok=$true;result=@{apps=$apps}}|ConvertTo-Json -Depth 5 -Compress));continue}
  if($c.kind -eq 'open-app'){$app=Get-StartApps | Where-Object AppID -CEQ ([string]$c.app) | Select-Object -First 1;if(!$app){throw 'Unknown application'};$launcher=New-Object -ComObject Shell.Application;$item=$launcher.Namespace('shell:AppsFolder').ParseName($app.AppID);if(!$item){throw 'Application unavailable'};$item.InvokeVerb('open');[Console]::WriteLine('{"ok":true,"result":{}}');continue}
  if($c.kind -eq 'switch'){if(!(@([SeekAccessibility]::Windows()) | Where-Object id -EQ ([string]$c.windowId))){throw 'Unknown window'};[SeekAccessibility]::Activate([string]$c.windowId);[Console]::WriteLine('{"ok":true,"result":{}}');continue}
  if($c.kind -eq 'menu'){[SeekAccessibility]::Menu([string[]]$c.path);[Console]::WriteLine('{"ok":true,"result":{}}');continue}
  if($c.kind -eq 'ocr'){if(!(Get-Command Read-SeekScreenText -ErrorAction SilentlyContinue)){. (Join-Path $PSScriptRoot 'windows-ocr.ps1')};$elements=@(Read-SeekScreenText $c);[Console]::WriteLine((@{ok=$true;elements=$elements}|ConvertTo-Json -Depth 8 -Compress));continue}
  if($c.kind -eq 'windows'){[Console]::WriteLine((@{ok=$true;windows=@([SeekAccessibility]::Windows())}|ConvertTo-Json -Depth 5 -Compress));continue}
  if($c.kind -eq 'inspect'){$view=[SeekAccessibility]::Inspect([string]$c.selectedWindowId);[Console]::WriteLine((@{ok=$true;view=$view}|ConvertTo-Json -Depth 8 -Compress));continue}
  [SeekAccessibility]::CheckWindow([string]$c.windowId,($c.kind -notin @('fill','invoke','read')))
  [SeekAccessibility]::CheckFocus([string]$c.focusId)
  [SeekAccessibility]::CheckTarget([string]$c.targetId,[double]$c.x,[double]$c.y,($c.kind -in @('move','click','scroll')))
  if($c.kind -eq 'read'){[Console]::WriteLine((@{ok=$true;result=[SeekAccessibility]::Read([string]$c.targetId)}|ConvertTo-Json -Depth 3 -Compress));continue}
  switch($c.kind){
   'move' {[SeekInput]::Move([int]$c.x,[int]$c.y)}
   'click' {[SeekInput]::Move([int]$c.x,[int]$c.y);[SeekInput]::Click($c.button -eq 'right')}
   'scroll' {[SeekInput]::Move([int]$c.x,[int]$c.y);[SeekInput]::Scroll([int]$c.delta)}
   'key' {$keys=@{Enter=13;Escape=27;Tab=9;Backspace=8;Delete=46;ArrowLeft=37;ArrowUp=38;ArrowRight=39;ArrowDown=40};if(!$keys.ContainsKey([string]$c.key)){throw 'Unsupported key'};[SeekInput]::Key($keys[[string]$c.key])}
   'shortcut' {$keys=@{Enter=13;Escape=27;Tab=9;Backspace=8;Delete=46;ArrowLeft=37;ArrowUp=38;ArrowRight=39;ArrowDown=40;Home=36;End=35;PageUp=33;PageDown=34;Space=32};$vk=$keys[[string]$c.key];if(!$vk -and $c.key -cmatch '^[A-Z0-9]$'){$vk=[int][char]$c.key};if(!$vk -and $c.key -match '^F([1-9]|1[0-2])$'){$vk=111+[int]$Matches[1]};if(!$vk){throw 'Unsupported shortcut'};$mods=@();foreach($modifier in $c.modifiers){switch($modifier){Control{$mods+=17}Alt{$mods+=18}Shift{$mods+=16}Command{throw 'Command is a Mac modifier; use Control on Windows'}default{throw 'Unsupported modifier'}}};[SeekInput]::Shortcut([uint16]$vk,[uint16[]]$mods)}
   'type' {[SeekInput]::Text([string]$c.text)}
   'invoke' {[SeekAccessibility]::Invoke([string]$c.targetId)}
   'fill' {[SeekAccessibility]::Fill([string]$c.targetId,[string]$c.text)}
   'probe' {if([Runtime.InteropServices.Marshal]::SizeOf([type][SeekInput+INPUT]) -ne 40){throw 'Unexpected Windows input layout'}}
   default {throw 'Unsupported action'}
  }
  [Console]::WriteLine('{"ok":true}')
 }catch{
  [Console]::WriteLine((@{ok=$false;error=$_.Exception.Message}|ConvertTo-Json -Compress))
 }
}
