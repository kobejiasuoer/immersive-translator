import Foundation
import Tauri
import UserNotifications

private let prefix = "ita-study-"
private let category = "ita-study-review"
private let pendingActionKey = "ita.study.pending-notification-action"

private struct StudyNotice: Decodable {
  let id: String
  let hour: Int
  let minute: Int
  let repeats: Bool
  let title: String
  let body: String
}
private struct ReplaceArgs: Decodable { let notifications: [StudyNotice] }
private struct ActionAck: Decodable { let id: String; let at: Double }

// A separate delegate owns only study reminders. In particular, it never needs the
// stock plugin's process-local notification map to handle a cold-launch tap.
final class StudyNotificationsPlugin: Plugin, UNUserNotificationCenterDelegate {
  private weak var forwardedDelegate: UNUserNotificationCenterDelegate?
  private let center = UNUserNotificationCenter.current()

  override init() {
    super.init()
    forwardedDelegate = center.delegate
    center.delegate = self
    let review = UNNotificationAction(identifier: "review", title: "开始复习", options: [.foreground])
    let studyCategory = UNNotificationCategory(identifier: category, actions: [review], intentIdentifiers: [], options: [])
    center.getNotificationCategories { categories in
      var all = categories.filter { $0.identifier != category }
      all.insert(studyCategory)
      self.center.setNotificationCategories(all)
    }
  }

  private func owned(_ id: String) -> Bool { id.hasPrefix(prefix) || id == "1001" }
  private func permission(_ settings: UNNotificationSettings) -> String {
    switch settings.authorizationStatus {
    case .authorized, .provisional, .ephemeral: return "granted"
    case .denied: return "denied"
    default: return "prompt"
    }
  }

  private func resolveStatus(_ invoke: Invoke) {
    center.getNotificationSettings { settings in
      self.center.getPendingNotificationRequests { requests in
        let study = requests.filter { $0.identifier.hasPrefix(prefix) && $0.identifier != prefix + "test" }
        var result: [String: Any] = ["supported": true, "permission": self.permission(settings), "scheduled": study.count]
        if let next = study.compactMap({ ($0.trigger as? UNCalendarNotificationTrigger)?.nextTriggerDate() }).min() {
          result["nextAt"] = ISO8601DateFormatter().string(from: next)
        }
        invoke.resolve(result)
      }
    }
  }

  @objc func status(_ invoke: Invoke) { resolveStatus(invoke) }

  @objc func request(_ invoke: Invoke) {
    center.requestAuthorization(options: [.alert, .sound, .badge]) { _, error in
      if let error = error { invoke.reject(error.localizedDescription); return }
      self.resolveStatus(invoke)
    }
  }

  @objc func replace(_ invoke: Invoke) throws {
    let notices = try invoke.parseArgs(ReplaceArgs.self).notifications
    guard notices.count <= 1 else { invoke.reject("每天只安排一次学习提醒"); return }
    var prepared: [UNNotificationRequest] = []
    for notice in notices {
      guard notice.id == prefix + "daily", notice.repeats, (0...23).contains(notice.hour), (0...59).contains(notice.minute) else {
        invoke.reject("提醒时间或标识无效"); return
      }
      let trigger = studyCalendarTrigger(hour: notice.hour, minute: notice.minute)
      guard let fire = trigger.nextTriggerDate(), fire > Date() else { continue }
      let content = UNMutableNotificationContent()
      content.title = notice.title; content.body = notice.body
      content.sound = .default
      content.categoryIdentifier = category
      content.threadIdentifier = category
      content.userInfo = ["route": "quick-review"]
      prepared.append(UNNotificationRequest(identifier: notice.id, content: content, trigger: trigger))
    }
    center.getNotificationSettings { settings in
      self.center.getPendingNotificationRequests { requests in
        // Remove the old fixed 1001 repeating schedule as well as this plugin's plans.
        let old = requests.map(\.identifier).filter(self.owned)
        self.center.removePendingNotificationRequests(withIdentifiers: old)
        self.center.getDeliveredNotifications { delivered in
          self.center.removeDeliveredNotifications(withIdentifiers: delivered.map { $0.request.identifier }.filter(self.owned))
        }
        guard self.permission(settings) == "granted", !prepared.isEmpty else {
          self.resolveStatus(invoke); return
        }
        let group = DispatchGroup(), lock = NSLock()
        var failure: String?
        for request in prepared {
          group.enter()
          self.center.add(request) { error in
            if let error = error { lock.lock(); failure = error.localizedDescription; lock.unlock() }
            group.leave()
          }
        }
        group.notify(queue: .main) {
          if let failure = failure {
            self.center.removePendingNotificationRequests(withIdentifiers: prepared.map(\.identifier))
            invoke.reject(failure)
          } else {
            self.resolveStatus(invoke)
          }
        }
      }
    }
  }

  @objc func test(_ invoke: Invoke) {
    center.getNotificationSettings { settings in
      guard self.permission(settings) == "granted" else { invoke.reject("请先允许系统通知"); return }
      let content = UNMutableNotificationContent()
      content.title = "学习提醒已准备好"
      content.body = "点这里开始复习；平时每天在选好的时间提醒。"
      content.sound = .default; content.categoryIdentifier = category
      let request = UNNotificationRequest(identifier: prefix + "test", content: content,
        trigger: UNTimeIntervalNotificationTrigger(timeInterval: 10, repeats: false))
      self.center.add(request) { error in
        if let error = error { invoke.reject(error.localizedDescription) }
        else { invoke.resolve() }
      }
    }
  }

  @objc func take_action(_ invoke: Invoke) {
    let action = UserDefaults.standard.dictionary(forKey: pendingActionKey)
    if let action = action { invoke.resolve(action) } else { invoke.resolve() }
  }

  @objc func ack_action(_ invoke: Invoke) throws {
    let ack = try invoke.parseArgs(ActionAck.self)
    let saved = UserDefaults.standard.dictionary(forKey: pendingActionKey)
    if saved?["id"] as? String == ack.id, (saved?["at"] as? NSNumber)?.doubleValue == ack.at {
      UserDefaults.standard.removeObject(forKey: pendingActionKey)
    }
    invoke.resolve()
  }

  func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
    withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
    if owned(notification.request.identifier) {
      // Already using the app: no learning banner, sound, badge, or modal interruption.
      completionHandler([])
    } else if let delegate = forwardedDelegate,
      delegate.responds(to: #selector(UNUserNotificationCenterDelegate.userNotificationCenter(_:willPresent:withCompletionHandler:))) {
      delegate.userNotificationCenter?(center, willPresent: notification, withCompletionHandler: completionHandler)
    } else { completionHandler([]) }
  }

  func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
    withCompletionHandler completionHandler: @escaping () -> Void) {
    if owned(response.notification.request.identifier) {
      if response.actionIdentifier != UNNotificationDismissActionIdentifier {
        // Persist before the WebView exists. Startup/foreground consumes this exactly once.
        UserDefaults.standard.set(["id": response.notification.request.identifier,
          "at": Date().timeIntervalSince1970 * 1000], forKey: pendingActionKey)
      }
      completionHandler()
    } else if let delegate = forwardedDelegate,
      delegate.responds(to: #selector(UNUserNotificationCenterDelegate.userNotificationCenter(_:didReceive:withCompletionHandler:))) {
      delegate.userNotificationCenter?(center, didReceive: response, withCompletionHandler: completionHandler)
    } else { completionHandler() }
  }
}

@_cdecl("init_plugin_study_notifications")
public func initPlugin() -> Plugin { StudyNotificationsPlugin() }
