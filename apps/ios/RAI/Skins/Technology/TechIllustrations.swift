#if os(iOS)
import SwiftUI

/// A smooth local illustration, independent of training samples.
struct TechShoeIllustration: View {
    var body: some View {
        Canvas { context, size in
            let scale = min(size.width / 240, size.height / 160)
            context.translateBy(x: (size.width - 200 * scale) / 2, y: (size.height - 120 * scale) / 2)
            context.scaleBy(x: scale, y: scale)
            let upper = Path { path in
                path.move(to: CGPoint(x: 18, y: 82))
                path.addQuadCurve(to: CGPoint(x: 25, y: 30), control: CGPoint(x: 14, y: 50))
                path.addQuadCurve(to: CGPoint(x: 48, y: 44), control: CGPoint(x: 29, y: 17))
                path.addQuadCurve(to: CGPoint(x: 82, y: 43), control: CGPoint(x: 66, y: 55))
                path.addCurve(to: CGPoint(x: 142, y: 72), control1: CGPoint(x: 100, y: 40), control2: CGPoint(x: 108, y: 67))
                path.addQuadCurve(to: CGPoint(x: 180, y: 91), control: CGPoint(x: 181, y: 76))
                path.addLine(to: CGPoint(x: 21, y: 91))
                path.closeSubpath()
            }
            context.fill(upper, with: .color(TechColor.action))
            context.stroke(upper, with: .color(TechColor.cyan), style: StrokeStyle(lineWidth: 3, lineJoin: .round))
            let sole = Path { path in
                path.move(to: CGPoint(x: 18, y: 86))
                path.addQuadCurve(to: CGPoint(x: 182, y: 87), control: CGPoint(x: 95, y: 96))
                path.addQuadCurve(to: CGPoint(x: 174, y: 104), control: CGPoint(x: 189, y: 103))
                path.addLine(to: CGPoint(x: 28, y: 104))
                path.addQuadCurve(to: CGPoint(x: 18, y: 86), control: CGPoint(x: 14, y: 103))
                path.closeSubpath()
            }
            context.fill(sole, with: .color(TechColor.paper))
            context.stroke(sole, with: .color(TechColor.cyan), style: StrokeStyle(lineWidth: 3, lineJoin: .round))
            let detail = Path { path in
                path.move(to: CGPoint(x: 55, y: 68))
                path.addQuadCurve(to: CGPoint(x: 114, y: 69), control: CGPoint(x: 72, y: 92))
            }
            context.stroke(detail, with: .color(TechColor.cyan.opacity(0.6)), style: StrokeStyle(lineWidth: 4, lineCap: .round))
            var laces = Path()
            for index in 0..<3 {
                let x = 84 + CGFloat(index) * 10
                let y = 51 + CGFloat(index) * 6
                laces.move(to: CGPoint(x: x, y: y))
                laces.addLine(to: CGPoint(x: x - 10, y: y + 9))
            }
            context.stroke(laces, with: .color(TechColor.paper), style: StrokeStyle(lineWidth: 4, lineCap: .round))
        }.frame(height: 150).accessibilityHidden(true)
    }
}

struct TechRaceLandscape: View {
    var body: some View {
        TechRunningLandscape(road: true).accessibilityHidden(true)
    }
}

/// A compact, labeled series drawn only from supplied observations.
struct TechSparkline: View {
    let values: [Double]
    var tint: Color = TechColor.cyan
    var body: some View {
        Canvas { context, size in
            let samples = values.filter(\.isFinite)
            guard samples.count > 1 else { return }
            let low = samples.min() ?? 0, high = samples.max() ?? 1
            let span = max(high - low, 1)
            let points = samples.enumerated().map { index, value in
                CGPoint(x: size.width * Double(index) / Double(samples.count - 1), y: size.height * (0.9 - 0.8 * (value - low) / span))
            }
            var line = Path(); line.addLines(points)
            var area = line
            area.addLine(to: CGPoint(x: size.width, y: size.height))
            area.addLine(to: CGPoint(x: 0, y: size.height)); area.closeSubpath()
            context.fill(area, with: .color(tint.opacity(0.08)))
            context.stroke(line, with: .color(tint), style: StrokeStyle(lineWidth: 1.5, lineCap: .round, lineJoin: .round))
        }.frame(height: 30).accessibilityHidden(true)
    }
}

/// Local curved scenery: decorative, offline, and independent of health data.
struct TechRunningLandscape: View {
    var road = false
    /// 当作**无边框页面背景**用时的柔化开关（今日首页头部，2026-10-05 用户反馈）。
    ///
    /// 不柔化时这块插画有四条直边：左、上两条是页底色与 paleCyan/dusk 的突跳，
    /// 下边则把山景水平切断。同机同数据量到的相邻像素落差是 左 27 / 上 8 / 下 62
    /// （255 制），夹在白色面板之间读起来就是"贴了一张长方形图片"。三处渐隐把边缘
    /// 融进页底色后，同样的剖面落差降到 上 0 / 左 ≤3 / 下 ≤3。
    ///
    /// 同时不再画跑者剪影：它固定在 (0.76w, 0.73h)，在头部正好落在快速入口的
    /// 「身体指标」标签上，变成两行文字中间穿一个半透明小人。
    var blendsIntoPage = false
    var body: some View {
        GeometryReader { geometry in
            ZStack {
                TechColor.background
                Canvas { context, size in
                    guard size.width > 0, size.height > 0 else { return }
                    let start = size.width * 0.46
                    let width = size.width - start
                    context.fill(Path(CGRect(x: start, y: 0, width: width, height: size.height)),
                                 with: .color(TechColor.paleCyan))
                    let fills = [TechColor.dusk, TechColor.landscape.opacity(0.65), TechColor.action.opacity(0.8)]
                    for layer in 0..<3 {
                        let offset = CGFloat(layer) * 0.12
                        let hills = Path { path in
                            path.move(to: CGPoint(x: start, y: size.height * (0.76 + offset)))
                            path.addCurve(to: CGPoint(x: start + width * 0.38, y: size.height * (0.70 + offset)),
                                          control1: CGPoint(x: start + width * 0.12, y: size.height * (0.40 + offset)),
                                          control2: CGPoint(x: start + width * 0.25, y: size.height * (0.55 + offset)))
                            path.addCurve(to: CGPoint(x: start + width * 0.72, y: size.height * (0.64 + offset)),
                                          control1: CGPoint(x: start + width * 0.50, y: size.height * (0.32 + offset)),
                                          control2: CGPoint(x: start + width * 0.57, y: size.height * (0.40 + offset)))
                            path.addQuadCurve(to: CGPoint(x: size.width, y: size.height * (0.50 + offset)),
                                              control: CGPoint(x: start + width * 0.88, y: size.height * (0.74 + offset)))
                            path.addLine(to: CGPoint(x: size.width, y: size.height))
                            path.addLine(to: CGPoint(x: start, y: size.height))
                            path.closeSubpath()
                        }
                        context.fill(hills, with: .color(fills[layer]))
                    }
                    if road {
                        let trail = Path { path in
                            path.move(to: CGPoint(x: size.width * 0.80, y: size.height * 0.60))
                            path.addCurve(to: CGPoint(x: size.width * 0.63, y: size.height),
                                          control1: CGPoint(x: size.width * 0.79, y: size.height * 0.76),
                                          control2: CGPoint(x: size.width * 0.68, y: size.height * 0.82))
                            path.addLine(to: CGPoint(x: size.width * 0.76, y: size.height))
                            path.addQuadCurve(to: CGPoint(x: size.width * 0.81, y: size.height * 0.60),
                                              control: CGPoint(x: size.width * 0.84, y: size.height * 0.77))
                            path.closeSubpath()
                        }
                        context.fill(trail, with: .color(TechColor.paleYellow))
                    }
                    if blendsIntoPage { blendEdgesIntoPage(&context, size: size, start: start) }
                }
                if !blendsIntoPage {
                    Image(systemName: "figure.run")
                        .font(.system(size: road ? 26 : 32, weight: .medium))
                        .foregroundStyle(TechColor.cyan.opacity(0.55))
                        .position(x: geometry.size.width * 0.76, y: geometry.size.height * 0.73)
                }
            }
        }.clipped().allowsHitTesting(false).accessibilityHidden(true)
    }

    /// 把左 / 上 / 下三条直边揉进页底色。
    ///
    /// 三块覆盖用的都是**页底色本身**、只是 alpha 从 1 走到 0，所以这里没有引入第二种
    /// 颜色，也没有把皮肤变回"渐变填充的表面"—— 它只负责藏掉接缝。渐变体是
    /// `TechColor.background`，与 `ZStack` 的底色、页底色、导航栏底色同一个值，
    /// 因此覆盖处既不偏色也不留痕。
    ///
    /// 参数是比例而不是常数：这块插画同时被 150pt 的固定尺寸插画和面板背景复用，
    /// 写死 pt 会在别的尺寸下重新露出硬边。
    private func blendEdgesIntoPage(_ context: inout GraphicsContext, size: CGSize, start: CGFloat) {
        let side = size.width * 0.22
        let seam = start / (start + side)
        context.fill(
            Path(CGRect(x: 0, y: 0, width: start + side, height: size.height)),
            with: .linearGradient(
                Gradient(stops: [.init(color: TechColor.background, location: 0),
                                 .init(color: TechColor.background, location: seam),
                                 .init(color: TechColor.background.opacity(0), location: 1)]),
                startPoint: CGPoint(x: 0, y: 0), endPoint: CGPoint(x: start + side, y: 0)))
        let top = size.height * 0.18
        context.fill(
            Path(CGRect(x: 0, y: 0, width: size.width, height: top)),
            with: .linearGradient(
                Gradient(stops: [.init(color: TechColor.background, location: 0),
                                 .init(color: TechColor.background.opacity(0), location: 1)]),
                startPoint: CGPoint(x: 0, y: 0), endPoint: CGPoint(x: 0, y: top)))
        let bottom = size.height * 0.24
        context.fill(
            Path(CGRect(x: 0, y: size.height - bottom, width: size.width, height: bottom)),
            with: .linearGradient(
                Gradient(stops: [.init(color: TechColor.background.opacity(0), location: 0),
                                 .init(color: TechColor.background, location: 1)]),
                startPoint: CGPoint(x: 0, y: size.height - bottom), endPoint: CGPoint(x: 0, y: size.height)))
    }
}

struct TechTodayHeader: View {
    let date: String
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            TechAdaptiveStack {
                VStack(alignment: .leading, spacing: 6) {
                    HStack(spacing: 8) {
                        Image(systemName: "mountain.2.fill").foregroundStyle(TechColor.energy)
                            .font(.system(size: 28, weight: .bold)).accessibilityHidden(true)
                        Text("RAI").techScaledFont(34, weight: .bold).accessibilityAddTraits(.isHeader)
                    }
                    Text(date).font(.caption).foregroundStyle(TechColor.muted)
                }
                Spacer(minLength: 0)
                TechHomeActions()
            }
            Text("坚持，让更好的你发生 💙").font(.caption).foregroundStyle(TechColor.muted)
        }
        .padding(.vertical, 8)
        // 这里原本还有 `.padding(.top, -25)`，想让山景伸到导航栏底下。它做不到：
        // 背景是 ScrollView 的直接内容，往上多出来的 25pt 永远落在 ScrollView 的裁切
        // 之外（实测上沿用 `-25` 时，渐隐被裁在 α≈0.5 处，反而留下一道 Δ4 的台阶）。
        // 去掉它，渐隐就从可见上沿的 α=1 起步，上沿不再有边。
        .background {
            TechRunningLandscape(blendsIntoPage: true)
                .padding(.horizontal, -TechMetrics.pageHorizontal)
        }
    }
}

/// The arc is the measured easy-running fraction, never a synthetic readiness score.
struct TechVerdictInstrument: View {
    let fraction: Double?
    let tone: Color
    let symbol: String
    var body: some View {
        ZStack {
            // Closed ring — `lineCap` is ignored on a closed subpath, so it is not passed.
            Circle().stroke(TechColor.grid.opacity(0.65), lineWidth: 9)
            if let fraction, fraction.isFinite {
                Circle().trim(from: 0, to: min(max(fraction, 0), 1))
                    .stroke(tone, style: StrokeStyle(lineWidth: 9, lineCap: .round))
                    .rotationEffect(.degrees(-90))
            }
            VStack(spacing: 5) {
                Image(systemName: symbol).font(.system(size: 25, weight: .medium)).foregroundStyle(tone)
                Text(nativePercent(fraction)).font(.subheadline.weight(.semibold)).monospacedDigit()
                Text("轻松跑占比").font(.system(size: 10)).foregroundStyle(TechColor.muted)
            }
        }.frame(width: 104, height: 104).padding(5)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("本周轻松跑时长占比 \(nativePercent(fraction))")
    }
}

#endif
