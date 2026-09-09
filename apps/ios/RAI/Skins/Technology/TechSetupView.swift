#if os(iOS)
import SwiftUI

struct TechSetupView: View {
    @Environment(ServerSession.self) private var session
    @Environment(ServerDiscovery.self) private var discovery
    @State private var draftURL = ""
    @State private var draftToken = ""
    @State private var connecting = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                TechPageHeader(title: "RAI", eyebrow: "RUNNING INTELLIGENCE") { EmptyView() }
                TechOrbit()
                Text("让每一次跑步都有依据")
                    .font(.title2.weight(.semibold)).foregroundStyle(TechColor.ink)
                Text("连接 RAI 服务，获取你的跑步数据分析与训练建议。")
                    .font(.subheadline).foregroundStyle(TechColor.muted)
                TechPanel {
                    VStack(alignment: .leading, spacing: 16) {
                        TechSectionHeader(title: "RAI 服务", trailing: session.isReachable ? "已连接" : "待连接")
                        ForEach(discovery.candidates, id: \.absoluteString) { url in
                            Button {
                                draftURL = url.absoluteString
                                draftToken = Keychain.loadToken(for: draftURL)
                            } label: {
                                Label(url.absoluteString, systemImage: "server.rack")
                                    .font(.footnote).foregroundStyle(TechColor.cyan)
                                    .frame(minHeight: 44)
                            }
                        }
                        TechField("服务地址") {
                            TextField("http://192.168.1.8:5173", text: $draftURL)
                                .keyboardType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled()
                                .onChange(of: draftURL) { _, value in draftToken = Keychain.loadToken(for: value) }
                        }
                        TechField("访问令牌（可选）") { SecureField("可选", text: $draftToken) }
                        if let error = session.lastError {
                            Label(error, systemImage: "exclamationmark.circle")
                                .font(.footnote).foregroundStyle(TechColor.coral)
                        }
                    }
                }
                TechPrimaryButton(title: "连接服务", isBusy: connecting,
                                  isDisabled: draftURL.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty) {
                    connecting = true
                    session.serverURLString = draftURL
                    session.apiToken = draftToken
                    Task { await session.probe(); connecting = false }
                }
                Button { discovery.start() } label: {
                    Text("重新发现").font(.subheadline.weight(.semibold))
                        .frame(maxWidth: .infinity, minHeight: 48)
                        .overlay(Capsule().strokeBorder(TechColor.cyan.opacity(0.65), lineWidth: 1))
                }.buttonStyle(.plain).foregroundStyle(TechColor.cyan)
                Label("手机与本地服务需在同一网络", systemImage: "wifi")
                    .font(.caption).foregroundStyle(TechColor.muted).frame(maxWidth: .infinity)
                AppSkinPicker()
            }.padding(20)
        }
        .background(TechColor.background).toolbar(.hidden, for: .navigationBar)
        .scrollDismissesKeyboard(.interactively)
        .onAppear { draftURL = session.serverURLString; draftToken = session.apiToken }
    }
}
#endif
