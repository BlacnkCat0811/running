#if os(iOS)
import SwiftUI

struct TechTrainingReminderView: View {
    @Environment(NativeAppModel.self) private var native
    @State private var reminders = TrainingReminders.shared
    @State private var hour = 8
    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            Text("训练提醒").font(.headline)
            Text("默认关闭。只为已读取的未来七天有效计划安排本地提醒，不催促漏课，不推送同步故障。22:00–07:00 不安排提醒。")
            Text("提醒时间使用课表时区；下一次同步到 Apple Watch 时也会使用这个开始时间。开启后离线期间的计划变化无法立即撤回通知，重新打开 App 会核对。")
                .font(.caption).foregroundStyle(TechColor.muted)
            Picker("提醒时间", selection: $hour) {
                ForEach(7...21, id: \.self) { Text("\($0):00").tag($0) }
            }
            Button(reminders.enabled ? "更新提醒时间" : "开启训练提醒") {
                Task { await configure(true) }
            }.disabled(reminders.busy)
            if reminders.enabled { Button("关闭训练提醒") { Task { await configure(false) } }.disabled(reminders.busy) }
            if reminders.denied {
                Link("打开系统通知设置", destination: URL(string: UIApplication.openSettingsURLString)!)
            }
            if let message = reminders.message { Text(message).font(.footnote) }
        }
        .onAppear { reminders.bind(scope: native.feedbackScope); hour = reminders.hour }
    }
    private func configure(_ value: Bool) async {
        let scope = native.feedbackScope
        await reminders.configure(enabled: value, hour: hour, scope: scope)
        guard scope == native.feedbackScope else { return }
        await reminders.reconcile(scope: scope, plan: native.currentWorkoutPlan, completed: native.completedWeekDates, available: native.canConfirmToday)
    }
}
#endif
