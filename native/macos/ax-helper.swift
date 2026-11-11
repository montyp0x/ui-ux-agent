// ui-ux-agent macOS accessibility helper.
//
// Reads one JSON request per line on stdin and writes one JSON response per
// line on stdout. It only reads the accessibility tree of the requested
// process and performs the few actions the driver offers (press, set value,
// scroll a scroll bar, raise). It never synthesizes keyboard or mouse events.
import AppKit
import ApplicationServices
import Foundation

setvbuf(stdout, nil, _IOLBF, 0)

let maxElements = 1500
let maxDepth = 40
let maxText = 2000

// Elements from the most recent snapshot, addressed by ref. Holding the
// AXUIElement keeps identity: a later check reads the same element object.
var elements: [Int: AXUIElement] = [:]
// Menu items from the most recent menus listing, refs offset to stay distinct.
let menuRefBase = 1_000_000
var menuElements: [Int: AXUIElement] = [:]

func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
  var value: CFTypeRef?
  return AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success ? value : nil
}

func string(_ element: AXUIElement, _ name: String) -> String? {
  guard let value = attribute(element, name) else { return nil }
  if let text = value as? String { return String(text.prefix(maxText)) }
  if let number = value as? NSNumber { return number.stringValue }
  return nil
}

func bool(_ element: AXUIElement, _ name: String) -> Bool? {
  (attribute(element, name) as? NSNumber)?.boolValue
}

func frame(_ element: AXUIElement) -> [String: Double]? {
  guard let position = attribute(element, kAXPositionAttribute),
    let size = attribute(element, kAXSizeAttribute)
  else { return nil }
  var point = CGPoint.zero
  var extent = CGSize.zero
  AXValueGetValue(position as! AXValue, .cgPoint, &point)
  AXValueGetValue(size as! AXValue, .cgSize, &extent)
  return ["x": point.x, "y": point.y, "width": extent.width, "height": extent.height]
}

func actions(_ element: AXUIElement) -> [String] {
  var names: CFArray?
  guard AXUIElementCopyActionNames(element, &names) == .success, let list = names as? [String] else {
    return []
  }
  return list
}

func children(_ element: AXUIElement) -> [AXUIElement] {
  (attribute(element, kAXChildrenAttribute) as? [AXUIElement]) ?? []
}

func describe(_ element: AXUIElement) -> [String: Any] {
  var out: [String: Any] = [
    "role": string(element, kAXRoleAttribute) ?? "",
    "actions": actions(element),
  ]
  for (key, name) in [
    ("subrole", kAXSubroleAttribute), ("title", kAXTitleAttribute),
    ("description", kAXDescriptionAttribute), ("value", kAXValueAttribute),
    ("identifier", kAXIdentifierAttribute), ("help", kAXHelpAttribute),
    ("placeholder", kAXPlaceholderValueAttribute),
  ] {
    if let text = string(element, name), !text.isEmpty { out[key] = text }
  }
  if let enabled = bool(element, kAXEnabledAttribute) { out["enabled"] = enabled }
  if let focused = bool(element, kAXFocusedAttribute) { out["focused"] = focused }
  if let selected = bool(element, kAXSelectedAttribute) { out["selected"] = selected }
  if let box = frame(element) { out["frame"] = box }
  return out
}

// The CGWindowID for the app's accessible window, matched by position and size.
// Windows on another Space are not "on screen" but can still be captured, so
// all windows are searched, preferring on-screen ones.
func windowNumber(pid: pid_t, title: String?, box: [String: Double]?) -> Int? {
  guard let list = CGWindowListCopyWindowInfo([.optionAll, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]]
  else { return nil }
  let onScreen = Set(
    ((CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]]) ?? [])
      .compactMap { $0[kCGWindowNumber as String] as? Int })
  let owned = list.filter { ($0[kCGWindowOwnerPID as String] as? Int32) == pid && ($0[kCGWindowLayer as String] as? Int) == 0 }
  func fits(_ info: [String: Any]) -> Bool {
    guard let bounds = info[kCGWindowBounds as String] as? [String: Double], let box else { return false }
    return abs((bounds["X"] ?? 0) - (box["x"] ?? 0)) < 2 && abs((bounds["Y"] ?? 0) - (box["y"] ?? 0)) < 2
      && abs((bounds["Width"] ?? 0) - (box["width"] ?? 0)) < 2 && abs((bounds["Height"] ?? 0) - (box["height"] ?? 0)) < 2
  }
  let matching = owned.filter(fits)
  let match = matching.first { onScreen.contains($0[kCGWindowNumber as String] as? Int ?? -1) } ?? matching.first
  return match?[kCGWindowNumber as String] as? Int
}

func frontmost() -> [String: Any] {
  let app = NSWorkspace.shared.frontmostApplication
  return ["bundleId": app?.bundleIdentifier ?? "", "pid": Int(app?.processIdentifier ?? 0)]
}

func snapshot(pid: pid_t) -> [String: Any] {
  elements = [:]
  let app = AXUIElementCreateApplication(pid)
  guard let window = (attribute(app, kAXFocusedWindowAttribute) as! AXUIElement?)
    ?? (attribute(app, kAXWindowsAttribute) as? [AXUIElement])?.first
  else { return ["error": "The application has no accessible window"] }
  var nodes: [[String: Any]] = []
  var truncated = false
  func walk(_ element: AXUIElement, parent: Int?, depth: Int) {
    if nodes.count >= maxElements { truncated = true; return }
    let ref = nodes.count
    elements[ref] = element
    var node = describe(element)
    node["ref"] = ref
    node["depth"] = depth
    if let parent { node["parent"] = parent }
    nodes.append(node)
    if depth >= maxDepth { truncated = true; return }
    for child in children(element) { walk(child, parent: ref, depth: depth + 1) }
  }
  walk(window, parent: nil, depth: 0)
  let title = string(window, kAXTitleAttribute)
  let box = frame(window)
  return [
    "window": ["title": title ?? "", "frame": box ?? [:], "number": windowNumber(pid: pid, title: title, box: box) ?? 0],
    "elements": nodes,
    "truncated": truncated,
    "frontmost": frontmost(),
  ]
}

// Leaf items of the app's menu bar, read without opening any menu. The Apple
// menu (first bar item, system commands) is never listed.
func menus(pid: pid_t) -> [String: Any] {
  menuElements = [:]
  let app = AXUIElementCreateApplication(pid)
  guard let bar = attribute(app, kAXMenuBarAttribute) else { return ["items": []] }
  var items: [[String: Any]] = []
  func walk(_ element: AXUIElement, path: [String], depth: Int) {
    if depth > 4 || items.count >= 400 { return }
    for child in children(element) {
      let role = string(child, kAXRoleAttribute) ?? ""
      if role == "AXMenu" { walk(child, path: path, depth: depth + 1); continue }
      guard role == "AXMenuItem" || role == "AXMenuBarItem" else { continue }
      let title = string(child, kAXTitleAttribute) ?? ""
      if title.isEmpty { continue }
      let submenu = children(child).contains { (string($0, kAXRoleAttribute) ?? "") == "AXMenu" }
      if submenu || role == "AXMenuBarItem" {
        walk(child, path: path + [title], depth: depth + 1)
        continue
      }
      let ref = menuRefBase + items.count
      menuElements[ref] = child
      items.append([
        "ref": ref, "path": path + [title],
        "enabled": bool(child, kAXEnabledAttribute) ?? false,
        "actions": actions(child),
      ])
    }
  }
  let top = children(bar as! AXUIElement)
  for (index, item) in top.enumerated() where index > 0 {
    let title = string(item, kAXTitleAttribute) ?? ""
    if title.isEmpty { continue }
    walk(item, path: [title], depth: 1)
  }
  return ["items": items]
}

func element(_ request: [String: Any]) throws -> AXUIElement {
  guard let ref = request["ref"] as? Int, let found = elements[ref] ?? menuElements[ref] else {
    throw NSError(domain: "helper", code: 1, userInfo: [NSLocalizedDescriptionKey: "Unknown element ref"])
  }
  return found
}

func handle(_ request: [String: Any]) throws -> [String: Any] {
  switch request["cmd"] as? String {
  case "status":
    return ["accessibility": AXIsProcessTrusted(), "screenCapture": CGPreflightScreenCaptureAccess()]
  case "launch":
    let target: URL?
    if let path = request["path"] as? String { target = URL(fileURLWithPath: path) }
    else if let bundle = request["bundleId"] as? String {
      target = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundle)
    } else { target = nil }
    guard let target else { return ["error": "Application not found"] }
    let configuration = NSWorkspace.OpenConfiguration()
    configuration.activates = true
    let done = DispatchSemaphore(value: 0)
    var launched: NSRunningApplication?
    var failure: Error?
    NSWorkspace.shared.openApplication(at: target, configuration: configuration) { app, error in
      launched = app; failure = error; done.signal()
    }
    while done.wait(timeout: .now() + 0.05) == .timedOut {
      RunLoop.current.run(until: Date().addingTimeInterval(0.05))
    }
    if let failure { return ["error": failure.localizedDescription] }
    guard let launched else { return ["error": "Application did not launch"] }
    launched.activate()
    return ["pid": Int(launched.processIdentifier), "bundleId": launched.bundleIdentifier ?? ""]
  case "terminate":
    // Graceful quit only; an app that refuses (unsaved work) is reported.
    guard let bundle = request["bundleId"] as? String else { return ["error": "bundleId required"] }
    let running = NSRunningApplication.runningApplications(withBundleIdentifier: bundle)
    for app in running { app.terminate() }
    let deadline = Date().addingTimeInterval(request["timeoutSeconds"] as? Double ?? 5)
    while running.contains(where: { !$0.isTerminated }) && Date() < deadline {
      RunLoop.current.run(until: Date().addingTimeInterval(0.1))
    }
    return running.contains(where: { !$0.isTerminated })
      ? ["error": "The application did not quit; it may have unsaved work"]
      : ["ok": true, "terminated": running.count]
  case "activate":
    guard let pid = request["pid"] as? Int, let app = NSRunningApplication(processIdentifier: pid_t(pid)) else {
      return ["error": "Process not running"]
    }
    app.activate()
    return ["ok": true]
  case "alive":
    // Cheap scope probe: the process runs and still has an accessible window.
    guard let pid = request["pid"] as? Int, let app = NSRunningApplication(processIdentifier: pid_t(pid)),
      !app.isTerminated
    else { return ["alive": false, "running": false] }
    let element = AXUIElementCreateApplication(pid_t(pid))
    // The windows list intermittently comes back empty while the focused
    // window is still readable; an error from a running app means "unknown".
    var value: CFTypeRef?
    let result = AXUIElementCopyAttributeValue(element, kAXWindowsAttribute as CFString, &value)
    if result != .success && result != .noValue { return ["alive": true, "running": true, "uncertain": true] }
    let windows = (value as? [AXUIElement]) ?? []
    let focused = attribute(element, kAXFocusedWindowAttribute) != nil
    return ["alive": !windows.isEmpty || focused, "running": true]
  case "enableAccessibility":
    // Electron/Chromium apps build their tree only for assistive clients that ask.
    guard let pid = request["pid"] as? Int else { return ["error": "pid required"] }
    let app = AXUIElementCreateApplication(pid_t(pid))
    var out: [String: Any] = [:]
    let manual = AXUIElementSetAttributeValue(app, "AXManualAccessibility" as CFString, kCFBooleanTrue)
    out["manual"] = manual.rawValue
    if request["enhanced"] as? Bool == true {
      out["enhanced"] = AXUIElementSetAttributeValue(app, "AXEnhancedUserInterface" as CFString, kCFBooleanTrue).rawValue
    }
    out["ok"] = true
    return out
  case "frontmost":
    return frontmost()
  case "menus":
    guard let pid = request["pid"] as? Int else { return ["error": "pid required"] }
    return menus(pid: pid_t(pid))
  case "snapshot":
    guard let pid = request["pid"] as? Int else { return ["error": "pid required"] }
    return snapshot(pid: pid_t(pid))
  case "inspect":
    // Re-read the same element object; invalid once the UI destroyed it.
    let target = try element(request)
    var role: CFTypeRef?
    if AXUIElementCopyAttributeValue(target, kAXRoleAttribute as CFString, &role) == .invalidUIElement {
      return ["valid": false]
    }
    var out = describe(target)
    out["valid"] = true
    return out
  case "press":
    let result = AXUIElementPerformAction(try element(request), kAXPressAction as CFString)
    return result == .success ? ["ok": true] : ["error": "Press failed (\(result.rawValue))"]
  case "select":
    // Rows in lists, tables and outlines are selected, not pressed.
    let target = try element(request)
    let result = AXUIElementSetAttributeValue(target, kAXSelectedAttribute as CFString, kCFBooleanTrue)
    return result == .success ? ["ok": true] : ["error": "Select failed (\(result.rawValue))"]
  case "setValue":
    let target = try element(request)
    AXUIElementSetAttributeValue(target, kAXFocusedAttribute as CFString, kCFBooleanTrue)
    let result = AXUIElementSetAttributeValue(
      target, kAXValueAttribute as CFString, (request["value"] as? String ?? "") as CFString)
    return result == .success ? ["ok": true] : ["error": "Set value failed (\(result.rawValue))"]
  case "perform":
    // Only page scrolling; pressing has its own command.
    let name = request["action"] as? String ?? ""
    guard ["AXScrollDownByPage", "AXScrollUpByPage"].contains(name) else {
      return ["error": "Action not allowed"]
    }
    let result = AXUIElementPerformAction(try element(request), name as CFString)
    return result == .success ? ["ok": true] : ["error": "\(name) failed (\(result.rawValue))"]
  case "setScroll":
    // Fallback when page scrolling cannot complete: move a scroll bar (0...1).
    let target = try element(request)
    let value = max(0, min(1, request["value"] as? Double ?? 0))
    let result = AXUIElementSetAttributeValue(target, kAXValueAttribute as CFString, value as CFNumber)
    return result == .success ? ["ok": true] : ["error": "Scroll failed (\(result.rawValue))"]
  case "setWindowSize":
    // Suite viewports become window sizes; fixed-size windows report an error.
    guard let pid = request["pid"] as? Int else { return ["error": "pid required"] }
    let app = AXUIElementCreateApplication(pid_t(pid))
    guard let window = (attribute(app, kAXFocusedWindowAttribute) as! AXUIElement?)
      ?? (attribute(app, kAXWindowsAttribute) as? [AXUIElement])?.first
    else { return ["error": "The application has no accessible window"] }
    var size = CGSize(width: request["width"] as? Double ?? 0, height: request["height"] as? Double ?? 0)
    let value = AXValueCreate(.cgSize, &size)!
    let result = AXUIElementSetAttributeValue(window, kAXSizeAttribute as CFString, value)
    return result == .success ? ["ok": true, "frame": frame(window) ?? [:]] : ["error": "Resize failed (\(result.rawValue))"]
  default:
    return ["error": "Unknown command"]
  }
}

while let line = readLine() {
  var response: [String: Any]
  do {
    guard let data = line.data(using: .utf8),
      let request = try JSONSerialization.jsonObject(with: data) as? [String: Any]
    else { throw NSError(domain: "helper", code: 2, userInfo: [NSLocalizedDescriptionKey: "Invalid request"]) }
    response = try handle(request)
    if let id = request["id"] { response["id"] = id }
  } catch {
    response = ["error": error.localizedDescription]
  }
  let data = (try? JSONSerialization.data(withJSONObject: response)) ?? Data("{\"error\":\"encode\"}".utf8)
  FileHandle.standardOutput.write(data)
  FileHandle.standardOutput.write(Data("\n".utf8))
}
