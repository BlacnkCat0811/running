#if os(iOS)
import Foundation
import Observation
import UserNotifications

/// Optional local reminders only. No remote push or new background execution mechanism.
@Observable @MainActor
final class TrainingReminders {
    static let shared = TrainingReminders()
    private let center = UNUserNotificationCenter.current()
    private var generation = UUID()
    private var activeScope = ""
    var message: String?
    private(set) var enabled = false
    private(set) var hour = 8
    private(set) var denied = false
    private(set) var busy = false
    private let prefix = "rai.training-reminder."

    func bind(scope: String) {
        guard scope != activeScope else { return }
        generation = UUID()
        activeScope = scope
        enabled = UserDefaults.standard.bool(forKey: prefix + scope + ".enabled")
        let stored = UserDefaults.standard.integer(forKey: prefix + scope + ".hour")
        hour = (7...21).contains(stored) ? stored : 8
        message = nil
    }

    func configure(enabled value: Bool, hour: Int, scope: String) async {
        bind(scope: scope)
        guard !busy else { return }
        busy = true
        defer { busy = false }
        let epoch = UUID(); generation = epoch
        if value {
            do {
                let allowed = try await center.requestAuthorization(options: [.alert, .sound])
                guard epoch == generation, scope == activeScope else { return }
                guard allowed else { denied = true; message = "提醒未开启。可在系统设置中允许通知，其他功能不受影响。"; return }
            } catch {
                guard epoch == generation else { return }
                message = "暂时无法开启通知，请稍后重试。"; return
            }
        }
        guard epoch == generation else { return }
        self.enabled = value
        self.hour = min(21, max(7, hour))
        UserDefaults.standard.set(value, forKey: prefix + scope + ".enabled")
        UserDefaults.standard.set(self.hour, forKey: prefix + scope + ".hour")
        message = value ? "仅提醒已读取的未来训练；系统可能延后通知。" : "训练提醒已关闭。"
        if !value { await reconcile(scope: scope, plan: nil, completed: [], available: false) }
    }

    func reconcile(scope: String, plan: MobileWorkoutPlanResponse?, completed: Set<String>, available: Bool) async {
        bind(scope: scope)
        let epoch = UUID(); generation = epoch
        let pending = await center.pendingNotificationRequests()
        guard epoch == generation, !Task.isCancelled else { return }
        center.removePendingNotificationRequests(withIdentifiers: pending.filter { $0.identifier.hasPrefix(prefix) }.map(\.identifier))
        let delivered = await center.deliveredNotifications()
        guard epoch == generation, !Task.isCancelled else { return }
        center.removeDeliveredNotifications(withIdentifiers: delivered.filter { $0.request.identifier.hasPrefix(prefix) }.map { $0.request.identifier })
        let settings = await center.notificationSettings()
        guard epoch == generation, !Task.isCancelled else { return }
        denied = settings.authorizationStatus == .denied
        guard enabled, available, settings.authorizationStatus == .authorized || settings.authorizationStatus == .provisional else { return }
        for slot in TrainingReminderPolicy.slots(plan: plan, completedDates: completed, hour: hour) {
            guard epoch == generation, !Task.isCancelled else { return }
            let content = UNMutableNotificationContent()
            content.title = "今天的训练安排"
            content.body = "打开 RAI 查看最新安排；如已完成或调整，可忽略此提醒。"
            content.sound = .default
            // Absolute date/time including the plan timezone: changing device zones cannot re-date a run.
            var calendar = Calendar(identifier: .gregorian)
            calendar.timeZone = TimeZone(identifier: plan?.timezone ?? "Asia/Shanghai") ?? .current
            var components = calendar.dateComponents([.year, .month, .day, .hour, .minute], from: slot.fireAt)
            components.timeZone = calendar.timeZone
            let id = prefix + epoch.uuidString + "." + slot.localDate
            do {
                try await center.add(UNNotificationRequest(identifier: id, content: content,
                    trigger: UNCalendarNotificationTrigger(dateMatching: components, repeats: false)))
                if epoch != generation || Task.isCancelled {
                    center.removePendingNotificationRequests(withIdentifiers: [id]); return
                }
            } catch {
                guard epoch == generation else { return }
                let current = await center.pendingNotificationRequests()
                center.removePendingNotificationRequests(withIdentifiers: current.filter { $0.identifier.hasPrefix(prefix + epoch.uuidString) }.map(\.identifier))
                message = "部分提醒未能安排，请重新开启提醒。"; return
            }
        }
    }
}
#endif
