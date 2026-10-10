import Foundation
import CoreGraphics
import ApplicationServices

func execute(_ command: [String: Any]) throws {
  enum Failure: Error { case invalid }
  let kind=command["kind"] as? String ?? ""
  if kind == "probe" { return }
  guard AXIsProcessTrusted() else { throw BridgeFailure.permission }
  if ["apps", "windows", "open-app", "switch", "menu"].contains(kind) { return }
  try validateAccessibility(command)
  if kind == "invoke" || kind == "fill" { try performAccessibility(command); return }
  let point=CGPoint(x: (command["x"] as? Double) ?? 0, y: (command["y"] as? Double) ?? 0)
  func postMouse(_ type: CGEventType, _ button: CGMouseButton) throws {
    guard let event=CGEvent(mouseEventSource:nil,mouseType:type,mouseCursorPosition:point,mouseButton:button) else {throw Failure.invalid}
    event.post(tap:.cghidEventTap)
  }
  switch kind {
  case "move": try postMouse(.mouseMoved,.left)
  case "click":
    let right=command["button"] as? String == "right"
    try postMouse(right ? .rightMouseDown : .leftMouseDown,right ? .right : .left)
    try postMouse(right ? .rightMouseUp : .leftMouseUp,right ? .right : .left)
  case "scroll":
    try postMouse(.mouseMoved,.left)
    guard let event=CGEvent(scrollWheelEvent2Source:nil,units:.pixel,wheelCount:1,wheel1:Int32(command["delta"] as? Int ?? 0),wheel2:0,wheel3:0) else {throw Failure.invalid}
    event.post(tap:.cghidEventTap)
  case "key", "shortcut":
    let keys: [String:CGKeyCode] = ["Enter":36,"Escape":53,"Tab":48,"Backspace":51,"Delete":117,"ArrowLeft":123,"ArrowRight":124,"ArrowUp":126,"ArrowDown":125,"Home":115,"End":119,"PageUp":116,"PageDown":121,"Space":49,
      "A":0,"S":1,"D":2,"F":3,"H":4,"G":5,"Z":6,"X":7,"C":8,"V":9,"B":11,"Q":12,"W":13,"E":14,"R":15,"Y":16,"T":17,"1":18,"2":19,"3":20,"4":21,"6":22,"5":23,"9":25,"7":26,"8":28,"0":29,"O":31,"U":32,"I":34,"P":35,"L":37,"J":38,"K":40,"N":45,"M":46,"F1":122,"F2":120,"F3":99,"F4":118,"F5":96,"F6":97,"F7":98,"F8":100,"F9":101,"F10":109,"F11":103,"F12":111]
    guard let key=keys[command["key"] as? String ?? ""] else {throw Failure.invalid}
    var flags = CGEventFlags()
    for modifier in command["modifiers"] as? [String] ?? [] {
      switch modifier { case "Command": flags.insert(.maskCommand); case "Control": flags.insert(.maskControl); case "Alt": flags.insert(.maskAlternate); case "Shift": flags.insert(.maskShift); default: throw Failure.invalid }
    }
    for down in [true,false] {guard let event=CGEvent(keyboardEventSource:nil,virtualKey:key,keyDown:down) else {throw Failure.invalid};event.flags=flags;event.post(tap:.cghidEventTap)}
  case "type":
    guard let text=command["text"] as? String else {throw Failure.invalid}
    for character in text {
      let units=Array(String(character).utf16)
      for down in [true,false] {
        guard let event=CGEvent(keyboardEventSource:nil,virtualKey:0,keyDown:down) else {throw Failure.invalid}
        units.withUnsafeBufferPointer { buffer in event.keyboardSetUnicodeString(stringLength:buffer.count,unicodeString:buffer.baseAddress!) }
        event.post(tap:.cghidEventTap)
      }
    }
  default: throw Failure.invalid
  }
}
while let line=readLine() {
  do {
    guard let data=line.data(using:.utf8),let c=try JSONSerialization.jsonObject(with:data) as? [String:Any] else {throw NSError(domain:"Seek",code:1)}
    let result: [String:Any]
    if c["kind"] as? String == "inspect" { result = ["ok":true,"view":try inspectAccessibility()] }
    else if c["kind"] as? String == "ocr" { result = ["ok":true,"elements":try recognizeScreenText(c)] }
    else if c["kind"] as? String == "read" {
      try validateAccessibility(c)
      guard let id = c["targetId"] as? String, let target = targets[id] else { throw BridgeFailure.stale }
      let text = attribute(target, "AXValue") as? String ?? textAttribute(target, "AXTitle", limit: 16000)
      result = ["ok":true,"result":["text":String(text.prefix(16000)),"truncated":text.count > 16000]]
    }
    else if ["apps", "windows", "open-app", "switch", "menu"].contains(c["kind"] as? String ?? "") { result = ["ok":true,"result":try navigateMac(c)] }
    else if c["kind"] as? String == "probe" { result = ["ok":true,"accessibility":AXIsProcessTrusted()] }
    else {try execute(c);result=["ok":true]}
    let encoded=try JSONSerialization.data(withJSONObject:result);print(String(data:encoded,encoding:.utf8)!)
  }
  catch {
    // Report the specific failure; a generic permission message hides focus and timing problems.
    let message=(error as? BridgeFailure)?.description ?? "macOS input failed; check Accessibility permission"
    let encoded=(try? JSONSerialization.data(withJSONObject:["ok":false,"error":message])).flatMap{String(data:$0,encoding:.utf8)}
    print(encoded ?? "{\"ok\":false,\"error\":\"macOS input failed\"}")
  }
  fflush(stdout)
}
