import AppKit
import Foundation

// ---------------------------------------------------------------------------
// 单实例防护（对齐 Windows lib.rs:1336-1346 的 single-instance 插件红线：
// 官方要求「最先注册，先于任何窗口创建」）。
//
// 为什么必须有（Windows auth.rs 红线 2 的进程维度设防）：双开的两个实例会
// 各持同一旧 refreshToken 同时刷新，服务端判 token_reused → 该账号全部设备
// 强制下线。第二实例启动即退出，仅把已有实例的设置窗提前。
//
// macOS 落法：flock 排它锁 + NSDistributedNotificationCenter 激活通知。
// - flock（LOCK_EX | LOCK_NB）：锁属于打开文件描述，进程退出（含崩溃、
//   更新器先杀旧实例再拉起新版本）时内核自动释放——更新器安装重启路径
//   不会被误判为双开；也不存在需要清理的陈旧锁文件。
// - 第二实例：拿锁失败 → 广播激活通知 → 立即退出（返回 false，调用方
//   负责 exit）。
// - 首实例：启动时注册激活回调（聚焦设置窗，Windows 同款行为），并持有
//   锁直到进程结束。
//
// 接线（App.swift ImmersiveTranslatorMain.main，先于 app.run() 即先于一切窗口）：
//     let instanceGuard = SingleInstanceGuard()
//     AppDelegateHolder.instanceGuard = instanceGuard        // 保活
//     instanceGuard.observeActivation { delegate?.activateForSecondInstance() }
//     guard instanceGuard.claim() else { exit(0) }           // 第二实例退出
// ---------------------------------------------------------------------------

final class SingleInstanceGuard {
    /// 激活通知名（DistributedNotificationCenter 为登录会话全局命名空间，
    /// 用应用前缀避免撞名）。
    static let defaultActivationNotificationName = "local.immersive-translator.single-instance.activate"

    private(set) var lockFileURL: URL
    private(set) var activationNotificationName: String
    private var fileDescriptor: Int32 = -1
    private var observerToken: Any?

    init(
        lockFileURL: URL = SingleInstanceGuard.defaultLockFileURL(),
        activationNotificationName: String = SingleInstanceGuard.defaultActivationNotificationName
    ) {
        self.lockFileURL = lockFileURL
        self.activationNotificationName = activationNotificationName
    }

    deinit {
        release()
    }

    /// 锁文件落在应用数据目录（与 ReaderStore/ServerAuthConfiguration 同法）。
    /// 目录不存在则创建（创建失败退回 /tmp，锁语义不受影响）。
    static func defaultLockFileURL() -> URL {
        let directory = ServerAuthConfiguration.defaultAppSupportDirectory()
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            return directory.appendingPathComponent("single-instance.lock")
        } catch {
            return URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("immersive-translator-single-instance.lock")
        }
    }

    /// 进程存活探测（kill 0 探测；EPERM 表示进程存在但属他人，同样算活）。
    static func isProcessAlive(_ pid: pid_t) -> Bool {
        guard pid > 0 else { return false }
        let result = kill(pid, 0)
        if result == 0 { return true }
        return errno == EPERM
    }

    /// 注册激活回调（首实例；主线程回调）。重复调用只保留最后一个。
    /// Windows 聚焦的是设置窗——回调内容由调用方决定（波 2 传设置窗 show）。
    func observeActivation(_ handler: @escaping @MainActor () -> Void) {
        if let token = observerToken {
            DistributedNotificationCenter.default().removeObserver(token)
            observerToken = nil
        }
        observerToken = DistributedNotificationCenter.default().addObserver(
            forName: NSNotification.Name(activationNotificationName),
            object: nil,
            queue: .main
        ) { _ in
            // 队列已是 .main；经 Task 跳上 MainActor（macOS 13 目标无
            // assumeIsolated 的稳定可用性，用 Task { @MainActor in } 跳板）。
            Task { @MainActor in
                handler()
            }
        }
    }

    /// 尝试占用单实例锁。
    /// - 返回 true：本进程是唯一实例（已持锁，锁随进程存续）。
    /// - 返回 false：已有实例在跑——已广播激活通知请其前置设置窗，调用方
    ///   必须**立即退出进程**（不弹任何 UI、不初始化其余单例）。
    @discardableResult
    func claim() -> Bool {
        guard fileDescriptor < 0 else { return true } // 本实例已持锁（幂等）
        let fd = open(lockFileURL.path, O_RDWR | O_CREAT, 0o644)
        guard fd >= 0 else {
            // 打不开锁文件（如磁盘满）：宁可放行单实例，不阻断正常启动。
            DiagnosticLogger.log("singleInstance.open.failed errno=\(errno) path=\(lockFileURL.path)")
            return true
        }
        let lockResult = flock(fd, LOCK_EX | LOCK_NB)
        guard lockResult == 0 else {
            close(fd)
            requestExistingInstanceToActivate()
            return false
        }
        // 写入持有者 pid 便于诊断（仅诊断用途；存活判据是 flock 本身）。
        let pidText = "\(getpid())"
        _ = pidText.withCString { cString in
            pwrite(fd, cString, strlen(cString), 0)
        }
        _ = ftruncate(fd, off_t(pidText.utf8.count))
        fileDescriptor = fd
        return true
    }

    /// 主动释放（正常退出路径可选调用；进程退出时内核自动释放，不调也安全）。
    func release() {
        if let token = observerToken {
            DistributedNotificationCenter.default().removeObserver(token)
            observerToken = nil
        }
        if fileDescriptor >= 0 {
            flock(fileDescriptor, LOCK_UN)
            close(fileDescriptor)
            fileDescriptor = -1
        }
    }

    /// 第二实例通知已有实例激活（deliverImmediately 绕过合并立即投递）。
    private func requestExistingInstanceToActivate() {
        DistributedNotificationCenter.default().postNotificationName(
            NSNotification.Name(activationNotificationName),
            object: nil,
            userInfo: ["pid": NSNumber(value: getpid())],
            deliverImmediately: true
        )
    }
}
