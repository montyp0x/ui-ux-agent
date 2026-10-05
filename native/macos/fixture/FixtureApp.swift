// Deterministic SwiftUI app for the macOS driver's tests and demo.
// Build: see src/drivers/macos-fixture.ts (swiftc + a minimal .app bundle).
import SwiftUI

let projects = [
  "Apollo", "Borealis", "Cascade", "Delta", "Ember", "Fjord", "Granite", "Harbor", "Iris", "Juniper",
  "Kestrel", "Lumen", "Meridian", "Nimbus", "Orchid", "Pioneer", "Quartz", "Ridge", "Sable", "Tundra",
  "Umber", "Vesper", "Willow", "Xenon", "Yarrow", "Zephyr", "Atlas", "Beacon", "Comet", "Dune",
]

@main
struct FixtureApp: App {
  var body: some Scene {
    WindowGroup("UI Fixture") { ContentView() }
      .defaultSize(width: 900, height: 600)
  }
}

struct ContentView: View {
  @State private var section = "Inbox"
  @State private var project: String?
  @State private var compact = false
  @State private var displayName = ""
  @State private var deleted = false
  @State private var theme: String? = "Light"

  var body: some View {
    HStack(spacing: 0) {
      VStack(alignment: .leading, spacing: 8) {
        ForEach(["Inbox", "Projects", "Settings"], id: \.self) { name in
          Button(name) { section = name; project = nil }
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
        Button("Back to projects") { self.project = nil }.accessibilityIdentifier("project-back")
      }
    } else if section == "Projects" {
      VStack(alignment: .leading) {
        Text("Projects").font(.title)
        ScrollView {
          VStack(alignment: .leading, spacing: 10) {
            ForEach(projects, id: \.self) { name in
              Button(name) { project = name }.accessibilityIdentifier("project-\(name.lowercased())")
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
      }
    }
  }
}
