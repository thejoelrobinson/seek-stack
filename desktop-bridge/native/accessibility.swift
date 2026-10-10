import Foundation
import ApplicationServices

enum BridgeFailure: Error, CustomStringConvertible {
    case permission, unavailable, stale, focus(String)
    var description: String {
        switch self {
        case .permission: return "macOS has not granted Accessibility to Seek Desktop"
        case .unavailable: return "That control no longer supports this action"
        case .stale: return "The window changed; observe again"
        case .focus(let detail): return detail
        }
    }
}
var observedWindow: AXUIElement?
var observedWindowID = ""
var targets: [String: AXUIElement] = [:]
var identities: [String: String] = [:]
var observedCGWindow: CGWindowID?
let systemElement = AXUIElementCreateSystemWide()

func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
    var result: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, name as CFString, &result) == .success else { return nil }
    return result
}
// Screen-reader traversal: batch provider properties instead of one cross-process call per field.
func attributes(_ element: AXUIElement) -> [String: Any] {
    let names = ["AXRole", "AXSubrole", "AXTitle", "AXDescription", "AXPosition", "AXSize", "AXEnabled", "AXValue", "AXChildren", "AXHelp"]
    var values: CFArray?
    guard AXUIElementCopyMultipleAttributeValues(element, names as CFArray, [], &values) == .success, let list = values as? [Any] else { return [:] }
    return Dictionary(uniqueKeysWithValues: zip(names, list))
}
func rectFromAttributes(_ values: [String: Any]) -> CGRect? {
    guard let position = values["AXPosition"], let size = values["AXSize"], CFGetTypeID(position as CFTypeRef) == AXValueGetTypeID(), CFGetTypeID(size as CFTypeRef) == AXValueGetTypeID() else { return nil }
    var point = CGPoint.zero, dimensions = CGSize.zero
    guard AXValueGetValue(position as! AXValue, .cgPoint, &point), AXValueGetValue(size as! AXValue, .cgSize, &dimensions),
          point.x.isFinite, point.y.isFinite, dimensions.width.isFinite, dimensions.height.isFinite else { return nil }
    return CGRect(origin: point, size: dimensions)
}
func elementAttribute(_ element: AXUIElement, _ name: String) -> AXUIElement? {
    guard let result = attribute(element, name), CFGetTypeID(result) == AXUIElementGetTypeID() else { return nil }
    return (result as! AXUIElement)
}
func textAttribute(_ element: AXUIElement, _ name: String, limit: Int = 512) -> String {
    guard let value = attribute(element, name) as? String else { return "" }
    return String(value.prefix(limit))
}
// The system-wide AXFocusedApplication query can fail (kAXErrorCannotComplete) on recent macOS,
// so fall back to the owner of the frontmost normal-level window from the window server.
func focusedApplication() throws -> AXUIElement {
    var app: CFTypeRef?
    let error = AXUIElementCopyAttributeValue(systemElement, "AXFocusedApplication" as CFString, &app)
    if error == .success, let app, CFGetTypeID(app) == AXUIElementGetTypeID() { return (app as! AXUIElement) }
    let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
    guard let pid = windows.first(where: { ($0[kCGWindowLayer as String] as? Int) == 0 })?[kCGWindowOwnerPID as String] as? pid_t else {
        throw BridgeFailure.focus("No focused application (AXError \(error.rawValue)); no window is open")
    }
    return AXUIElementCreateApplication(pid)
}
func currentWindow() throws -> AXUIElement {
    guard AXIsProcessTrusted() else { throw BridgeFailure.permission }
    let app = try focusedApplication()
    var error = AXError.success
    for name in ["AXFocusedWindow", "AXMainWindow"] {
        var window: CFTypeRef?
        error = AXUIElementCopyAttributeValue(app, name as CFString, &window)
        if error == .success, let window, CFGetTypeID(window) == AXUIElementGetTypeID() { return (window as! AXUIElement) }
    }
    throw BridgeFailure.focus("The front app has no window Seek can read (AXError \(error.rawValue)). Open or click a window and try again.")
}
func focusedElement() -> AXUIElement? {
    return elementAttribute(systemElement, "AXFocusedUIElement") ?? (try? focusedApplication()).flatMap { elementAttribute($0, "AXFocusedUIElement") }
}
func rectOf(_ element: AXUIElement) -> CGRect? {
    guard let position = attribute(element, "AXPosition"), let size = attribute(element, "AXSize"),
          CFGetTypeID(position) == AXValueGetTypeID(), CFGetTypeID(size) == AXValueGetTypeID() else { return nil }
    var point = CGPoint.zero, dimensions = CGSize.zero
    guard AXValueGetValue(position as! AXValue, .cgPoint, &point),
          AXValueGetValue(size as! AXValue, .cgSize, &dimensions),
          point.x.isFinite, point.y.isFinite, dimensions.width.isFinite, dimensions.height.isFinite else { return nil }
    return CGRect(origin: point, size: dimensions)
}
func identityOf(_ element: AXUIElement) -> String {
    let role = textAttribute(element, "AXRole")
    return role + "\n" + textAttribute(element, "AXTitle") + "\n" + textAttribute(element, "AXDescription") + (role == "AXStaticText" ? "\n" + textAttribute(element, "AXValue") : "")
}
func supportsPress(_ element: AXUIElement) -> Bool {
    var names: CFArray?
    guard AXUIElementCopyActionNames(element, &names) == .success else { return false }
    return (names as? [String])?.contains("AXPress") ?? false
}
func supportsFill(_ element: AXUIElement) -> Bool {
    var settable = DarwinBoolean(false)
    return textAttribute(element, "AXSubrole") != "AXSecureTextField" &&
        AXUIElementIsAttributeSettable(element, "AXValue" as CFString, &settable) == .success && settable.boolValue &&
        ["AXTextField", "AXTextArea", "AXComboBox"].contains(textAttribute(element, "AXRole"))
}
func inspectAccessibility() throws -> [String: Any] {
    AXUIElementSetMessagingTimeout(systemElement, 0.2)
    ocrTargets.removeAll()
    let window: AXUIElement
    do { window = try currentWindow(); observedCGWindow = nil }
    catch {
        guard AXIsProcessTrusted() else { throw BridgeFailure.permission }
        let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
        guard let w = windows.first(where: { ($0[kCGWindowLayer as String] as? Int) == 0 }), let id = w[kCGWindowNumber as String] as? CGWindowID,
              let bounds = w[kCGWindowBounds as String] as? [String: Any] else { throw error }
        observedWindow = nil; observedCGWindow = id; observedWindowID = "cg:\(id)"; targets.removeAll(); identities.removeAll()
        return ["windowId": observedWindowID, "title": w[kCGWindowName as String] as? String ?? "", "elements": [], "bounds": bounds, "truncated": false]
    }
    if observedWindow == nil || !CFEqual(observedWindow!, window) { observedWindowID = UUID().uuidString }
    AXUIElementSetMessagingTimeout(window, 0.15)
    targets.removeAll(); identities.removeAll(); observedWindow = window
    let focused = focusedElement()
    let start = Date(); var nodes: [[String: Any]] = []; var truncated = false
    var visited: [CFHashCode: [AXUIElement]] = [:]
    func walk(_ element: AXUIElement, _ depth: Int, descend: Bool = true) {
        if nodes.count >= 500 || depth > 14 || Date().timeIntervalSince(start) > 2 { truncated = true; return }
        let hash = CFHash(element)
        if (visited[hash] ?? []).contains(where: { CFEqual($0, element) }) { return }; visited[hash, default: []].append(element)
        let values = attributes(element)
        let role = values["AXRole"] as? String ?? "", subrole = values["AXSubrole"] as? String ?? ""
        let password = subrole == "AXSecureTextField"
        if let rect = rectFromAttributes(values), rect.width > 0, rect.height > 0 {
            let id = "e\(nodes.count + 1)"; targets[id] = element; identities[id] = identityOf(element)
            let title = values["AXTitle"] as? String ?? "", description = values["AXDescription"] as? String ?? "", value = password ? "" : values["AXValue"] as? String ?? ""
            let name = title.isEmpty ? (description.isEmpty && role == "AXStaticText" ? value : description) : title
            var node: [String: Any] = ["id": id, "name": String(name.prefix(512)), "role": role,
                "x": rect.minX, "y": rect.minY, "width": rect.width, "height": rect.height,
                "enabled": (values["AXEnabled"] as? Bool) ?? true,
                "focused": focused.map { CFEqual($0, element) } ?? false, "password": password, "depth": depth,
                "canInvoke": supportsPress(element), "canFill": supportsFill(element)]
            if !password { node["value"] = String(value.prefix(4096)) }
            nodes.append(node)
        }
        if descend, let children = values["AXChildren"] as? [AXUIElement] {
            for child in children {
                if nodes.count >= 500 || Date().timeIntervalSince(start) > 2 { truncated = true; break }
                walk(child, depth + 1)
            }
        }
    }
    // Always show top-level menu names, just as a screen reader does, without expanding hidden menus.
    let app = try focusedApplication()
    if let bar = elementAttribute(app, "AXMenuBar") {
        for item in attribute(bar, "AXChildren") as? [AXUIElement] ?? [] { walk(item, 0, descend: false) }
    }
    walk(window, 0)
    guard CFEqual(try currentWindow(), window) else { throw BridgeFailure.stale }
    var result: [String: Any] = ["windowId": observedWindowID, "title": textAttribute(window, "AXTitle"), "app": textAttribute(app, "AXTitle"), "elements": nodes, "truncated": truncated]
    if let rect = rectOf(window) { result["bounds"] = ["X": rect.minX, "Y": rect.minY, "Width": rect.width, "Height": rect.height] }
    return result
}
func performAccessibility(_ command: [String: Any]) throws {
    guard let id = command["targetId"] as? String, let target = targets[id] else { throw BridgeFailure.stale }
    if command["kind"] as? String == "invoke" {
        guard supportsPress(target), AXUIElementPerformAction(target, "AXPress" as CFString) == .success else { throw BridgeFailure.unavailable }
    } else {
        guard supportsFill(target), let text = command["text"] as? String,
              AXUIElementSetAttributeValue(target, "AXValue" as CFString, text as CFString) == .success else { throw BridgeFailure.unavailable }
    }
}
func validateAccessibility(_ command: [String: Any]) throws {
    guard let windowID = command["windowId"] as? String else { return } // probe only has no authority
    guard windowID == observedWindowID else { throw BridgeFailure.stale }
    if let cg = observedCGWindow {
        let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
        guard windows.first(where: { ($0[kCGWindowLayer as String] as? Int) == 0 })?[kCGWindowNumber as String] as? CGWindowID == cg else { throw BridgeFailure.stale }
    } else { guard let previous = observedWindow, CFEqual(try currentWindow(), previous) else { throw BridgeFailure.stale } }
    if command["kind"] as? String == "shortcut" { return }
    if let id = command["targetId"] as? String, let rect = ocrTargets[id] {
        guard ["move", "click", "scroll"].contains(command["kind"] as? String ?? ""), let x = command["x"] as? Double, let y = command["y"] as? Double,
              abs(rect.midX - x) <= 2, abs(rect.midY - y) <= 2 else { throw BridgeFailure.stale }; return
    }
    guard
          let id = command["targetId"] as? String, let target = targets[id], identities[id] == identityOf(target),
          textAttribute(target, "AXSubrole") != "AXSecureTextField", (attribute(target, "AXEnabled") as? Bool) != false else { throw BridgeFailure.stale }
    if let focusID = command["focusId"] as? String {
        guard focusID == id, let focused = focusedElement(), CFEqual(focused, target) else { throw BridgeFailure.stale }
    }
    if let x = command["x"] as? Double, let y = command["y"] as? Double {
        guard let rect = rectOf(target), abs(rect.midX - x) <= 2, abs(rect.midY - y) <= 2 else { throw BridgeFailure.stale }
    }
}
