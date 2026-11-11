// Deterministic SwiftUI app for the macOS driver's tests and demo.
// Build: see src/drivers/macos-fixture.ts (swiftc + a minimal .app bundle).
import SwiftUI

let projects = [
  "Apollo", "Borealis", "Cascade", "Delta", "Ember", "Fjord", "Granite", "Harbor", "Iris", "Juniper",
  "Kestrel", "Lumen", "Meridian", "Nimbus", "Orchid", "Pioneer", "Quartz", "Ridge", "Sable", "Tundra",
  "Umber", "Vesper", "Willow", "Xenon", "Yarrow", "Zephyr", "Atlas", "Beacon", "Comet", "Dune",
]

// Navigation state shared with menu commands.
final class Store: ObservableObject {
  static let shared = Store()
  @Published var section = "Inbox"
  @Published var project: String?
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
  @State private var compact = false
  @State private var displayName = ""
  @State private var deleted = false
  @State private var theme: String? = "Light"
  @State private var markedRead = false
  @State private var query = ""
  @State private var searched = ""

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
        Toggle("Compact layout", isOn: $compact).accessibilityIdentifier("compact-toggle")
        TextField("Display name", text: $displayName).accessibilityIdentifier("display-name")
        Button("Delete all data") { deleted = true }.accessibilityIdentifier("delete-all")
        Text("Theme: \(theme ?? "none")").accessibilityIdentifier("theme-current")
        List(["Light", "Dark", "Solarized"], id: \.self, selection: $theme) { name in Text(name) }
          .frame(height: 110)
          .accessibilityLabel("Themes")
        if deleted { Text("All data deleted").accessibilityIdentifier("deleted-banner") }
      }
    } else {
      VStack(alignment: .leading, spacing: 12) {
        Text("Inbox").font(.title)
        Text("No new messages").accessibilityIdentifier("inbox-empty")
        // A button that only a real click activates (no AXPress), like web-view
        // buttons in Electron apps; exercised by syntheticInput tests.
        ClickOnlyButton(title: "Mark all read") { markedRead = true }
          .frame(width: 140, height: 28)
        if markedRead { Text("All marked read").accessibilityIdentifier("marked-read") }
        TextField("Search messages", text: $query)
          .accessibilityIdentifier("search-field")
          .onSubmit { searched = query }
        if !searched.isEmpty { Text("Searched: \(searched)").accessibilityIdentifier("searched") }
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
