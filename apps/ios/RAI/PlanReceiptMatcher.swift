import Foundation

/// Which of the days we scheduled the watch actually holds.
///
/// Matched on the date a listed entry carries: `ScheduledWorkoutPlan.date` is the
/// `at` the bridge handed to `schedule(_:at:)`, so every listed workout names the
/// day it was scheduled for. Matching by content instead let two days with the
/// same prescription share one receipt, which reported a day the watch never saw
/// as synced. The rule lives here rather than in `WorkoutKitBridge` because that
/// file imports WorkoutKit and so cannot be reached by the off-device regression;
/// as plain Foundation it is pinned by `run-model-tests.sh`.
enum PlanReceiptMatcher {
    /// One day this sync tried to schedule.
    struct PendingDay: Equatable {
        /// The local date the day stands for; what a receipt is keyed by.
        let localDate: String
        /// The instant handed to `WorkoutScheduler.schedule(_:at:)`.
        let at: DateComponents
    }

    /// A calendar day, resolved in the plan's own timezone.
    private struct DayKey: Hashable {
        let year: Int
        let month: Int
        let day: Int
    }

    /// Consume-once, **by date**.
    ///
    /// Each listed day confirms at most one planned day, and only the planned day
    /// whose own date it is. Two days prescribing the same workout therefore stop
    /// sharing a receipt: if only one of them reached the watch, only that one is
    /// reported.
    ///
    /// A planned day is eligible only while the instant it was scheduled for still
    /// falls on the day it stands for. The scheduler only ever pushes a slot ahead
    /// inside its own day, so that holds by construction — and it is checked anyway,
    /// because a receipt naming the wrong day is worse than a missing one: if the
    /// two ever drift apart, the honest answer is "not confirmed".
    ///
    /// Returns `nil` when *not one* listed entry carries a readable date. The
    /// caller then has nothing to match on and falls back to its previous
    /// behaviour, which keeps this from being a regression if a future OS ever
    /// drops the field. (Today it is non-optional, so this is unreachable.)
    static func confirm(
        pending: [PendingDay],
        listed: [DateComponents],
        timeZone: TimeZone
    ) -> [String]? {
        var remaining: [DayKey: Int] = [:]
        var readable = 0
        for entry in listed {
            guard let key = dayKey(of: entry, in: timeZone) else { continue }
            remaining[key, default: 0] += 1
            readable += 1
        }
        guard readable > 0 else { return nil }

        var confirmed: [String] = []
        for day in pending {
            guard let key = dayKey(of: day.at, in: timeZone),
                  key == dayKey(ofLocalDate: day.localDate),
                  let count = remaining[key], count > 0 else { continue }
            remaining[key] = count - 1
            confirmed.append(day.localDate)
        }
        return confirmed
    }

    /// The wall-clock day `components` names, read in the plan's timezone.
    ///
    /// Two things matter here and both are easy to get wrong:
    ///
    /// * the fields must be present. `Calendar.date(from:)` does *not* return nil
    ///   for an empty `DateComponents` — it hands back the reference date — so an
    ///   unreadable listed entry would silently become 2001-01-01 and, worse,
    ///   count as "readable" and suppress the caller's fallback.
    /// * the instant is resolved in whatever zone the components carry, then read
    ///   back in the plan's zone. Resolving everything in the plan's zone instead
    ///   would be wrong when the system normalises `ScheduledWorkoutPlan.date` to
    ///   UTC: 23:00 UTC is already the next day in Berlin, and a scheduled slot
    ///   before 08:00 local would lose its receipt.
    private static func dayKey(of components: DateComponents, in timeZone: TimeZone) -> DayKey? {
        guard components.year != nil, components.month != nil, components.day != nil else { return nil }
        var source = Calendar(identifier: .gregorian)
        source.timeZone = components.timeZone ?? timeZone
        guard let date = source.date(from: components) else { return nil }
        var target = Calendar(identifier: .gregorian)
        target.timeZone = timeZone
        let parts = target.dateComponents([.year, .month, .day], from: date)
        guard let year = parts.year, let month = parts.month, let day = parts.day else { return nil }
        return DayKey(year: year, month: month, day: day)
    }

    /// The day a `localDate` (`YYYY-MM-DD`, computed by the server as a civil date
    /// in the plan's timezone) names. Read field by field on purpose: putting a
    /// `Calendar` back in the way would reintroduce a timezone to a value that has
    /// none.
    private static func dayKey(ofLocalDate localDate: String) -> DayKey? {
        let parts = localDate.split(separator: "-")
        guard parts.count == 3,
              let year = Int(parts[0]), let month = Int(parts[1]), let day = Int(parts[2]) else { return nil }
        return DayKey(year: year, month: month, day: day)
    }
}
