import Foundation
import UserNotifications

func studyCalendarTrigger(hour: Int, minute: Int) -> UNCalendarNotificationTrigger {
  var components = DateComponents()
  components.calendar = Calendar(identifier: .gregorian)
  components.timeZone = TimeZone.autoupdatingCurrent
  components.hour = hour
  components.minute = minute
  components.second = 0
  // No year/month/day or end date: the OS keeps this single daily trigger alive.
  return UNCalendarNotificationTrigger(dateMatching: components, repeats: true)
}
