#if os(iOS)
import SwiftUI

struct TechSetupView: View {
    @Environment(ServerSession.self) private var session
    @Environment(ServerDiscovery.self) private var discovery
    @State private var draftURL = ""
    @State private var draftToken = ""
    @State private var connecting = false
    @FocusState private var field: Field?
    private enum Field { case url, token }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                HStack(spacing: 14) {
                    Text("RAI").techScaledFont(32, weight: .bold).tracking(3).foregroundStyle(TechColor.cyan)
                    Text("RUNNING\nANALYTICS").font(.caption2.weight(.medium)).tracking(1.2)
                        .foregroundStyle(TechColor.muted)
                }.padding(.top, 8)
                TechOrbit()
                VStack(alignment: .leading, spacing: 9) {
                    Text("让每一次跑步都有依据").font(.title2.weight(.semibold)).foregroundStyle(TechColor.ink)
                    Text("连接 RAI 本地服务，获取专业的跑步数据分析与建议。")
                        .font(.footnote).foregroundStyle(TechColor.muted)
                }
                TechPanel {
                    HStack(spacing: 12) {
                        TechIconBox(systemName: "server.rack")
                        VStack(alignment: .leading, spacing: 5) {
                            Text("RAI 本地服务").font(.subheadline.weight(.semibold))
                            Text("在同一网络下发现并连接你的 RAI 服务。")
                                .font(.caption).foregroundStyle(TechColor.muted)
                        }
                    }
                    ForEach(discovery.candidates, id: \.absoluteString) { url in
                        Button {
                            draftURL = url.absoluteString
                            draftToken = Keychain.loadToken(for: draftURL)
                        } label: {
                            Label(url.absoluteString, systemImage: "server.rack")
                                .font(.footnote).foregroundStyle(TechColor.cyan).frame(minHeight: 44)
                        }
                    }
                    TechField("服务地址") {
                        TextField("http://192.168.1.8:5173", text: $draftURL)
                            .keyboardType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled()
                            .accessibilityIdentifier("setup.url")
                            .focused($field, equals: .url).submitLabel(.next)
                            .onSubmit { field = .token }
                            .onChange(of: draftURL) { _, value in draftToken = Keychain.loadToken(for: value) }
                    }
                    TechField("访问令牌（可选）") {
                        SecureField("可选", text: $draftToken).focused($field, equals: .token)
                            .submitLabel(.done).onSubmit { field = nil }
                    }
                    if !session.serverURLString.isEmpty, let error = session.lastError {
                        Label(error, systemImage: "exclamationmark.circle")
                            .font(.footnote).foregroundStyle(TechColor.coral)
                    }
                    if let storageError = session.credentialStorageError {
                        Label(storageError, systemImage: "key.slash")
                            .font(.footnote).foregroundStyle(TechColor.coral)
                    }
                    TechPrimaryButton(title: "连接服务", isBusy: connecting,
                                      isDisabled: draftURL.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                                      busyTitle: "正在检查连接…") {
                        field = nil
                        connecting = true
                        session.serverURLString = draftURL
                        session.apiToken = draftToken
                        Task { await session.probe(); connecting = false }
                    }
                    Button { discovery.start() } label: {
                        Text("重新发现").font(.subheadline.weight(.semibold))
                            .frame(maxWidth: .infinity, minHeight: 44)
                            .overlay(TechSurfaceShape().strokeBorder(TechColor.cyan.opacity(0.65), lineWidth: 1))
                    }.buttonStyle(TechPressStyle()).foregroundStyle(TechColor.cyan)
                }
                Label("手机与服务器在同一网络。", systemImage: "wifi")
                    .font(.caption).foregroundStyle(TechColor.muted).frame(maxWidth: .infinity)
            }.padding(20)
        }
        .background(TechColor.background).foregroundStyle(TechColor.ink)
        .toolbar(.hidden, for: .navigationBar)
        .modifier(TechKeyboardDismiss())
        .onAppear { draftURL = session.serverURLString; draftToken = session.apiToken }
    }
}
#endif
