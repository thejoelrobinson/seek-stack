import AppKit
import ApplicationServices

var navigationWindows: [String: (pid_t, AXUIElement)] = [:]
func installedApps() -> [[String: String]] {
    var apps: [String: [String: String]] = [:]
    for root in ["/Applications", "/System/Applications", NSHomeDirectory() + "/Applications"] {
        guard let enumerator = FileManager.default.enumerator(at: URL(fileURLWithPath: root), includingPropertiesForKeys: nil, options: [.skipsHiddenFiles]) else { continue }
        for case let url as URL in enumerator {
            if url.pathExtension == "app" {
                enumerator.skipDescendants()
                if let bundle = Bundle(url: url) {
                    let id = bundle.bundleIdentifier ?? url.path
                    apps[id] = ["id": id, "name": bundle.object(forInfoDictionaryKey: "CFBundleDisplayName") as? String ?? url.deletingPathExtension().lastPathComponent, "path": url.path]
                }
            } else if enumerator.level > 2 { enumerator.skipDescendants() }
            if apps.count >= 500 { break }
        }
    }
    for app in NSWorkspace.shared.runningApplications {
        if app.activationPolicy == .regular, let url = app.bundleURL {
            let id = app.bundleIdentifier ?? url.path
            apps[id] = ["id": id, "name": app.localizedName ?? url.lastPathComponent, "path": url.path]
        }
    }
    return apps.values.sorted { ($0["name"] ?? "") < ($1["name"] ?? "") }
}
func listMacWindows() -> [[String: Any]] {
    navigationWindows.removeAll(); var result: [[String: Any]] = []; let start = Date()
    for app in NSWorkspace.shared.runningApplications where app.activationPolicy == .regular {
        if Date().timeIntervalSince(start) > 2 { break }
        let ax = AXUIElementCreateApplication(app.processIdentifier)
        AXUIElementSetMessagingTimeout(ax, 0.1)
        for window in attribute(ax, "AXWindows") as? [AXUIElement] ?? [] {
            let id = "\(app.processIdentifier):\(CFHash(window))"
            navigationWindows[id] = (app.processIdentifier, window)
            result.append(["id": id, "title": textAttribute(window, "AXTitle"), "app": app.localizedName ?? "", "pid": app.processIdentifier])
            if result.count >= 80 || Date().timeIntervalSince(start) > 2 { return result }
        }
    }
    return result
}
func navigateMac(_ command: [String: Any]) throws -> [String: Any] {
    guard AXIsProcessTrusted() else { throw BridgeFailure.permission }
    switch command["kind"] as? String ?? "" {
    case "apps": return ["apps": installedApps()]
    case "windows": return ["windows": listMacWindows()]
    case "open-app":
        guard let id = command["app"] as? String, let app = installedApps().first(where: { $0["id"] == id }), let path = app["path"] else { throw BridgeFailure.unavailable }
        _ = try NSWorkspace.shared.launchApplication(at: URL(fileURLWithPath: path), options: [], configuration: [:])
    case "switch":
        guard let id = command["windowId"] as? String, let (pid, window) = navigationWindows[id], let app = NSRunningApplication(processIdentifier: pid),
              (attribute(AXUIElementCreateApplication(pid), "AXWindows") as? [AXUIElement] ?? []).contains(where: { CFEqual($0, window) }) else { throw BridgeFailure.stale }
        guard app.activate(options: [.activateIgnoringOtherApps]), AXUIElementPerformAction(window, "AXRaise" as CFString) == .success else { throw BridgeFailure.unavailable }
        AXUIElementSetAttributeValue(window, "AXMain" as CFString, kCFBooleanTrue)
    case "menu":
        guard let path = command["path"] as? [String], !path.isEmpty, let bar = elementAttribute(try focusedApplication(), "AXMenuBar") else { throw BridgeFailure.unavailable }
        let app = try focusedApplication(); var parent = bar
        for title in path {
            guard CFEqual(try focusedApplication(), app) else { throw BridgeFailure.stale }
            var children = attribute(parent, "AXChildren") as? [AXUIElement] ?? []
            if children.count == 1, textAttribute(children[0], "AXRole") == "AXMenu" { children = attribute(children[0], "AXChildren") as? [AXUIElement] ?? [] }
            guard let item = children.first(where: { textAttribute($0, "AXTitle") == title }), AXUIElementPerformAction(item, "AXPress" as CFString) == .success else { throw BridgeFailure.unavailable }
            parent = item
        }
    default: throw BridgeFailure.unavailable
    }
    return [:]
}
