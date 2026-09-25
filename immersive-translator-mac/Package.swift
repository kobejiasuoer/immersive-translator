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
            dependencies: ["ProviderCore", "ReaderCore", "XfyunCore"],
            resources: [
                // 内容进水口数据资产：内置文库（6 篇公版书）+ 考试大纲词表。
                .process("Resources")
            ],
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
        // 讯飞语音三服务（TTS 合成 / IAT 听写 / ISE 评测）的协议与解析层：
        // HMAC 鉴权、请求帧构造、结果解析、词对齐 DP。网络会话与凭据在应用层。
        .target(
            name: "XfyunCore",
            dependencies: []
        ),
        .testTarget(
            name: "ProviderCoreTests",
            dependencies: ["ProviderCore"]
        ),
        // 主可执行目标里的纯逻辑单测（用 @main 入口，SwiftPM 支持被测试目标导入）。
        .testTarget(
            name: "ImmersiveTranslatorTests",
            dependencies: ["ImmersiveTranslator", "XfyunCore"]
        ),
        .testTarget(
            name: "ReaderCoreTests",
            dependencies: ["ReaderCore"]
        ),
        .testTarget(
            name: "XfyunCoreTests",
            dependencies: ["XfyunCore"]
        )
    ]
)
