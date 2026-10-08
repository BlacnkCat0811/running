#if os(iOS)
import SwiftUI
import UniformTypeIdentifiers

struct WorkoutCSVDocument: FileDocument {
    static var readableContentTypes: [UTType] { [.commaSeparatedText] }
    var text: String
    init(text: String) { self.text = text }
    init(configuration: ReadConfiguration) throws { text = String(decoding: configuration.file.regularFileContents ?? Data(), as: UTF8.self) }
    func fileWrapper(configuration: WriteConfiguration) throws -> FileWrapper { FileWrapper(regularFileWithContents: Data(text.utf8)) }
}

struct TechWorkoutExportView: View {
    @Environment(ServerSession.self) private var session
    @Environment(NativeAppModel.self) private var native
    @State private var from = Date().addingTimeInterval(-29 * 86400)
    @State private var through = Date()
    @State private var preview: NativeWorkoutExport?
    @State private var exporting = false
    @State private var busy = false
    @State private var message: String?
    private var identity: String { native.feedbackScope + session.apiToken }
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("导出训练摘要").font(.headline.weight(.bold))
            Text("仅包含已分析训练的开始时间、类型、距离、时长和配速。不含坐标、心率、备注、设备或身份标识。单次最多 366 天 / 2000 条。")
                .font(.footnote).foregroundStyle(TechColor.muted)
            DatePicker("开始日期", selection: $from, displayedComponents: .date)
                .environment(\.timeZone, TimeZone(identifier: "Asia/Shanghai")!)
            DatePicker("结束日期", selection: $through, displayedComponents: .date)
                .environment(\.timeZone, TimeZone(identifier: "Asia/Shanghai")!)
            Text("日期按 Asia/Shanghai 统计；未分析记录不在本次摘要范围。")
                .font(.caption).foregroundStyle(TechColor.muted)
            Button(busy ? "正在准备…" : "预览导出") { Task { await prepare() } }.disabled(busy || from > through)
                .font(.subheadline.weight(.bold))
                .foregroundStyle(busy || from > through ? TechColor.muted : TechColor.cyan)
            if let preview {
                Text("将导出 \(preview.count) 条训练，\(preview.from) 至 \(preview.through)。")
                Button("保存 CSV…") { exporting = true }.disabled(preview.count == 0)
                    .font(.subheadline.weight(.bold))
                    .foregroundStyle(preview.count == 0 ? TechColor.muted : TechColor.cyan)
            }
            if let message { Text(message).font(.footnote) }
        }
        .onChange(of: from) { _, _ in preview = nil }
        .onChange(of: through) { _, _ in preview = nil }
        .onChange(of: identity) { _, _ in preview = nil; exporting = false; message = nil }
        .fileExporter(isPresented: $exporting, document: WorkoutCSVDocument(text: preview?.csv ?? ""),
                      contentType: .commaSeparatedText, defaultFilename: "RAI-training-\(preview?.from ?? "summary")") { result in
            switch result {
            case .success: message = "摘要已导出。请只与信任的人分享。"
            case .failure: message = "导出未完成，可重新保存；数据仍保留在服务端。"
            }
        }
    }
    private func dateText(_ value: Date) -> String {
        let f = DateFormatter(); f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = TimeZone(identifier: "Asia/Shanghai"); f.dateFormat = "yyyy-MM-dd"
        return f.string(from: value)
    }
    private func prepare() async {
        guard let url = session.serverURL else { message = "请先连接服务。"; return }
        guard !session.apiToken.isEmpty else { message = "导出需要访问令牌，请先在服务端配置并在设置中连接。"; return }
        let scope = identity, start = dateText(from), end = dateText(through)
        busy = true; preview = nil; message = nil
        defer { busy = false }
        do {
            let result = try await RaiAPIClient().exportWorkouts(from: start, through: end, baseURL: url, token: session.apiToken)
            guard scope == identity, start == dateText(from), end == dateText(through), !Task.isCancelled else { return }
            preview = result
        } catch {
            guard scope == identity else { return }
            message = error.localizedDescription
        }
    }
}
#endif
