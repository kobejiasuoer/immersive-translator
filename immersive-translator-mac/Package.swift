// swift-tools-version: 5.9

import PackageDescription

let package = Package(
    name: "ImmersiveTranslator",
    platforms: [
        .macOS(.v13)
    ],
    products: [
        .executable(name: "ImmersiveTranslator", targets: ["ImmersiveTranslator"]),
        .library(name: "ReaderCore", targets: ["ReaderCore"])
    ],
    targets: [
        .executableTarget(
            name: "ImmersiveTranslator",
            dependencies: ["ProviderCore", "ReaderCore"],
            linkerSettings: [
                .linkedFramework("AppKit"),
                .linkedFramework("Carbon"),
                .linkedFramework("Security"),
                .linkedFramework("Vision"),
                .linkedFramework("SwiftUI"),
                .linkedFramework("AVFoundation"),
                .linkedFramework("ApplicationServices")
            ]
        ),
        .target(
            name: "ProviderCore",
            dependencies: []
        ),
        // 阅读室纯逻辑（数据契约 / 切句 / SRS / 判分 / 提示词与响应解析）。
        // 只依赖 Foundation，便于 XCTest 直接覆盖；UI 与 IO 在主可执行目标里。
        .target(
            name: "ReaderCore",
            dependencies: []
        ),
        .testTarget(
            name: "ProviderCoreTests",
            dependencies: ["ProviderCore"]
        ),
        .testTarget(
            name: "ReaderCoreTests",
            dependencies: ["ReaderCore"]
        )
    ]
)
