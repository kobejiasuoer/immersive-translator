// swift-tools-version: 5.9

import PackageDescription

let package = Package(
    name: "ImmersiveTranslator",
    platforms: [
        .macOS(.v13)
    ],
    products: [
        .executable(name: "ImmersiveTranslator", targets: ["ImmersiveTranslator"])
    ],
    targets: [
        .executableTarget(
            name: "ImmersiveTranslator",
            dependencies: ["ProviderCore"],
            linkerSettings: [
                .linkedFramework("AppKit"),
                .linkedFramework("Carbon"),
                .linkedFramework("Security"),
                .linkedFramework("Vision"),
                .linkedFramework("SwiftUI")
            ]
        ),
        .target(
            name: "ProviderCore",
            dependencies: []
        ),
        .testTarget(
            name: "ProviderCoreTests",
            dependencies: ["ProviderCore"]
        )
    ]
)
