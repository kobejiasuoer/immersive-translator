// swift-tools-version:5.5
import PackageDescription
let package = Package(
  name: "tauri-plugin-study-notifications",
  platforms: [.iOS(.v13)],
  products: [.library(name: "tauri-plugin-study-notifications", type: .static, targets: ["tauri-plugin-study-notifications"])],
  dependencies: [.package(name: "Tauri", path: "../.tauri/tauri-api")],
  targets: [.target(name: "tauri-plugin-study-notifications", dependencies: [.byName(name: "Tauri")], path: "Sources")]
)
