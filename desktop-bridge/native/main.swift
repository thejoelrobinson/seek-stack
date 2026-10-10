import Foundation
import CoreGraphics
import ApplicationServices

func execute(_ command: [String: Any]) throws {
  enum Failure: Error { case invalid }
  let kind=command["kind"] as? String ?? ""
  if kind == "probe" { return }
  guard AXIsProcessTrusted() else { throw BridgeFailure.permission }
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
  case "key":
    let keys: [String:CGKeyCode] = ["Enter":36,"Escape":53,"Tab":48,"Backspace":51,"Delete":117,"ArrowLeft":123,"ArrowRight":124,"ArrowUp":126,"ArrowDown":125]
    guard let key=keys[command["key"] as? String ?? ""] else {throw Failure.invalid}
    for down in [true,false] {guard let event=CGEvent(keyboardEventSource:nil,virtualKey:key,keyDown:down) else {throw Failure.invalid};event.post(tap:.cghidEventTap)}
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
