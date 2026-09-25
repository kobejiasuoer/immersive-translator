import Foundation
import ServiceManagement

/// 开机自启：封装 SMAppService.mainApp 登录项注册（对齐 Windows tauri-plugin-autostart 写 HKCU Run 键）。
/// 项目平台为 .macOS(.v13)，SMAppService 恰好可用；系统登录后自动拉起应用，
/// 菜单栏常驻与复习触点（App.applicationDidFinishLaunching → startReviewTouchpoints）随之生效，无需额外驻留代码。
enum LaunchAtLogin {
    /// 当前登录项注册状态。.requiresApproval 表示已注册但等系统设置里放行，对开关视为尚未生效。
    static func status() -> SMAppService.Status {
        SMAppService.mainApp.status
    }

    /// 是否已注册为登录项（对齐 Windows getLoginItemSettings 的布尔语义）。
    static var isEnabled: Bool {
        status() == .enabled
    }

    /// 注册登录项。失败（如 swift run 未打包的可执行文件、系统拒绝）抛 Error 给调用方回滚 Toggle 并提示。
    static func register() throws {
        try SMAppService.mainApp.register()
    }

    /// 注销登录项。
    static func unregister() throws {
        try SMAppService.mainApp.unregister()
    }
}
