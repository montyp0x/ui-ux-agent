// Deterministic SwiftUI app for the macOS driver's tests and demo.
// Build: see src/drivers/macos-fixture.ts (swiftc + a minimal .app bundle).
import SwiftUI

let projects = [
  "Apollo", "Borealis", "Cascade", "Delta", "Ember", "Fjord", "Granite", "Harbor", "Iris", "Juniper",
  "Kestrel", "Lumen", "Meridian", "Nimbus", "Orchid", "Pioneer", "Quartz", "Ridge", "Sable", "Tundra",
  "Umber", "Vesper", "Willow", "Xenon", "Yarrow", "Zephyr", "Atlas", "Beacon", "Comet", "Dune",
]

// All view state, shared with menu commands. It lives here rather than in
// `@State`: the Command Line Tools ship no SwiftUIMacros plugin, and `@State`
// is a macro in recent SDKs, so a fixture using it only builds with Xcode.
final class Store: ObservableObject {
  static let shared = Store()
  @Published var section = "Inbox"
  @Published var project: String?
  @Published var compact = false
  @Published var displayName = ""
  @Published var deleted = false
  @Published var theme: String? = "Light"
  @Published var markedRead = false
}

@main
struct FixtureApp: App {
  var body: some Scene {
    WindowGroup("UI Fixture") { ContentView() }
      .defaultSize(width: 900, height: 600)
      .commands {
        CommandMenu("Navigate") {
          Button("Show Settings") { Store.shared.section = "Settings"; Store.shared.project = nil }
          Button("Open Library…") {}
          Divider()
          Button("Erase Everything") {}
        }
      }
  }
}

struct ContentView: View {
  @ObservedObject private var store = Store.shared
  private var section: String { store.section }
  private var project: String? { store.project }

  var body: some View {
    HStack(spacing: 0) {
      VStack(alignment: .leading, spacing: 8) {
        ForEach(["Inbox", "Projects", "Settings"], id: \.self) { name in
          Button(name) { store.section = name; store.project = nil }
            .accessibilityIdentifier("nav-\(name.lowercased())")
        }
        Spacer()
      }
      .padding(16)
      .frame(width: 160)
      Divider()
      detail.frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading).padding(20)
    }
    .navigationTitle(project.map { "Project \($0)" } ?? section)
  }

  @ViewBuilder var detail: some View {
    if let project {
      VStack(alignment: .leading, spacing: 12) {
        Text(project).font(.largeTitle).accessibilityIdentifier("project-title")
        Text("Owner: Design team").accessibilityIdentifier("project-owner")
        Button("Back to projects") { store.project = nil }.accessibilityIdentifier("project-back")
      }
    } else if section == "Projects" {
      VStack(alignment: .leading) {
        Text("Projects").font(.title)
        ScrollView {
          VStack(alignment: .leading, spacing: 10) {
            ForEach(projects, id: \.self) { name in
              Button(name) { store.project = name }.accessibilityIdentifier("project-\(name.lowercased())")
            }
          }
          .frame(maxWidth: .infinity, alignment: .leading)
        }
        .accessibilityLabel("Project list")
      }
    } else if section == "Settings" {
      VStack(alignment: .leading, spacing: 12) {
        Text("Settings").font(.title)
        Toggle("Compact layout", isOn: $store.compact).accessibilityIdentifier("compact-toggle")
        TextField("Display name", text: $store.displayName).accessibilityIdentifier("display-name")
        Button("Delete all data") { store.deleted = true }.accessibilityIdentifier("delete-all")
        Text("Theme: \(store.theme ?? "none")").accessibilityIdentifier("theme-current")
        List(["Light", "Dark", "Solarized"], id: \.self, selection: $store.theme) { name in Text(name) }
          .frame(height: 110)
          .accessibilityLabel("Themes")
        if store.deleted { Text("All data deleted").accessibilityIdentifier("deleted-banner") }
      }
    } else {
      VStack(alignment: .leading, spacing: 12) {
        Text("Inbox").font(.title)
        Text("No new messages").accessibilityIdentifier("inbox-empty")
        // A button that only a mouse click activates (no AXPress). The driver
        // sends no synthesized input, so it must never offer this control.
        ClickOnlyButton(title: "Mark all read") { store.markedRead = true }
          .frame(width: 140, height: 28)
        if store.markedRead { Text("All marked read").accessibilityIdentifier("marked-read") }
      }
    }
  }
}

// Accessible as a button but offers no AXPress: only a mouse click works.
struct ClickOnlyButton: NSViewRepresentable {
  let title: String
  let action: () -> Void
  func makeNSView(context: Context) -> ClickOnlyView {
    let view = ClickOnlyView()
    view.title = title
    view.action = action
    return view
  }
  func updateNSView(_ view: ClickOnlyView, context: Context) { view.action = action }
}

final class ClickOnlyView: NSView {
  var title = ""
  var action: () -> Void = {}
  override func draw(_ dirtyRect: NSRect) {
    NSColor.controlAccentColor.setFill()
    NSBezierPath(roundedRect: bounds, xRadius: 6, yRadius: 6).fill()
    let text = NSAttributedString(string: title, attributes: [.foregroundColor: NSColor.white, .font: NSFont.systemFont(ofSize: 13)])
    text.draw(at: NSPoint(x: 10, y: (bounds.height - text.size().height) / 2))
  }
  override func mouseDown(with event: NSEvent) { action() }
  override func isAccessibilityElement() -> Bool { true }
  override func accessibilityRole() -> NSAccessibility.Role? { .button }
  override func accessibilityLabel() -> String? { title }
  override func accessibilityIdentifier() -> String { "click-only" }
  override func accessibilityActionNames() -> [NSAccessibility.Action] { [] }
}
