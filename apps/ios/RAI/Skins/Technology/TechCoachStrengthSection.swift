#if os(iOS)
import SwiftUI

struct TechCoachStrengthSection: View {
    let sessions: [MobileRunCoachResponse.StrengthSession]
    var body: some View {
        Group {
            if !sessions.isEmpty {
                TechPanel {
                    VStack(alignment: .leading, spacing: 10) {
                        TechSectionHeader(title: "力量训练", trailing: "补充")
                        ForEach(sessions) { session in
                            DisclosureGroup {
                                ForEach(session.exercises.indices, id: \.self) { index in
                                    HStack {
                                        Text(session.exercises[index].name)
                                        Spacer()
                                        Text(session.exercises[index].dose).foregroundStyle(TechColor.muted)
                                    }
                                    .font(.subheadline)
                                    .padding(.vertical, 5)
                                }
                            } label: {
                                HStack {
                                    Text(nativeDate(session.localDate))
                                    Spacer()
                                    Text("\(session.durationMinutes) 分钟")
                                        .font(.caption.monospacedDigit())
                                        .foregroundStyle(TechColor.muted)
                                }
                            }
                        }
                    }
                }
            }
        }
    }

}
#endif
