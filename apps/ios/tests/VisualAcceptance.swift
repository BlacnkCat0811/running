import XCTest

/// UI-only harness. Install RAI separately and run an isolated API on port 8792.
/// It never writes to a production API, imports Health data, or changes scoring.
///
/// 2026-09-18：原生端只剩一套视觉（冰蓝科技），因此不再传 `-rai.appearance.skin`，
/// 也没有皮肤切换用例（原 `test09AppearancePersistence` 随像素皮肤一起删除）。
final class VisualAcceptance: XCTestCase {
    let app = XCUIApplication(bundleIdentifier: "app.rai.running.debug")
    let server = "http://127.0.0.1:8792"

    override func setUpWithError() throws {
        continueAfterFailure = false
        launch()
    }

    func launch(connected: Bool = true, large: Bool = false) {
        app.launchArguments = ["-rai.serverURL", connected ? server : "",
                               "-rai.privacy.amap.state", "declined",
                               "-AppleLanguages", "(zh-Hans)", "-AppleLocale", "zh_CN"]
        if large { app.launchArguments += ["-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXXXL"] }
        app.launch()
        if connected {
            XCTAssertTrue(app.buttons["tab.设置"].waitForExistence(timeout: 40))
            XCTAssertTrue(app.buttons["打开训练计划"].waitForExistence(timeout: 30))
            sleep(5)
        }
    }

    func capture(_ name: String) {
        // Navigation's visual transition may finish after XCTest reports idle.
        Thread.sleep(forTimeInterval: 0.8)
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = name; shot.lifetime = .keepAlways; add(shot)
        let tree = XCTAttachment(string: app.debugDescription)
        tree.name = name + "-accessibility"; tree.lifetime = .keepAlways; add(tree)
    }

    func scrollTo(_ element: XCUIElement, limit: Int = 30, horizontalOffset: CGFloat = 0.07) {
        // isHittable alone includes content obscured by the custom bottom bar.
        // Center the actual target in the unobscured scrolling region before tapping.
        let bottom = app.buttons["tab.设置"].exists ? app.buttons["tab.设置"].frame.minY : app.windows.firstMatch.frame.height - 90
        for _ in 0..<limit {
            if element.exists {
                let frame = element.frame
                if frame.midY >= 115 && frame.midY < bottom - 25 { return }
                if frame.midY < 115 { dragContent(up: false, horizontalOffset: horizontalOffset); continue }
            }
            dragContent(up: true, horizontalOffset: horizontalOffset)
        }
        capture("unreachable-target")
        print(element.debugDescription)
        XCTFail("Expected fully visible target: \(element)")
    }

    /// Scroll until the page stops moving. `scrollTo` returns as soon as its target is
    /// centred, which is not the same as the bottom of the content — and the claim under
    /// test ("the last card clears the bottom bar") only means anything at the real bottom.
    func scrollToBottom(_ anchor: XCUIElement, limit: Int = 30) {
        var previous = CGFloat.greatestFiniteMagnitude
        for _ in 0..<limit {
            dragContent(up: true)
            guard anchor.exists else { continue }
            let current = anchor.frame.minY
            if abs(current - previous) < 0.5 { return }
            previous = current
        }
        capture("bottom-never-settled")
        XCTFail("The page kept moving after \(limit) drags; the bottom never settled")
    }

    // Detail charts use the center to exercise scrolling directly over their plot.
    func dragContent(up: Bool, horizontalOffset: CGFloat = 0.07) {
        let startY: CGFloat = app.keyboards.count > 0 ? 0.45 : (up ? 0.70 : 0.35)
        let endY: CGFloat = app.keyboards.count > 0 ? 0.20 : (up ? 0.40 : 0.65)
        let start = app.coordinate(withNormalizedOffset: CGVector(dx: horizontalOffset, dy: startY))
        let end = app.coordinate(withNormalizedOffset: CGVector(dx: horizontalOffset, dy: endY))
        start.press(forDuration: 0.05, thenDragTo: end)
    }

    func back() { app.navigationBars.buttons.element(boundBy: 0).tap() }
    func tab(_ title: String) { app.buttons["tab.\(title)"].tap() }

    func test01TodayAndBody() {
        capture("01-today")
        XCTAssertTrue(app.buttons["today.week"].isHittable)
        XCTAssertTrue(app.buttons["today.body"].isHittable)
        capture("01-today-links")
        app.buttons["today.week"].tap(); sleep(2)
        XCTAssertTrue(app.navigationBars["本周活动"].exists)
        XCTAssertTrue(app.staticTexts["平均速度"].exists)
        XCTAssertTrue(app.staticTexts["平均心率"].exists)
        XCTAssertFalse(app.staticTexts["本周计划"].exists)
        capture("01-week")
        scrollTo(app.staticTexts["心率区间分布"])
        scrollTo(app.staticTexts["配速区间分布"])
        capture("01-week-daily")
        back()
        XCTAssertTrue(app.buttons["today.body"].isHittable)
        app.buttons["today.body"].tap()
        XCTAssertTrue(app.staticTexts["配速分区"].waitForExistence(timeout: 45))
        XCTAssertTrue(app.navigationBars["身体指标"].exists)
        capture("01-body")
        app.swipeUp(); capture("06-body-zones")
        app.swipeUp(); capture("06-body-predictions")
        back()
        scrollTo(app.buttons["today.ability"])
        capture("01-today-ability-card")
        app.buttons["today.ability"].tap()
        XCTAssertTrue(app.navigationBars["跑步能力"].waitForExistence(timeout: 45))
        capture("07-ability")
        // 五维分解必须真的渲染出来：标题常显，行则依赖服务端的 dimensions。
        // 隔离库里五维非空（efficiency/pace/cardio/stability/recovery 均有值），
        // 所以这里断言到行，能抓住"面板在、数据没接线"这类回归。
        XCTAssertTrue(app.staticTexts["能力分析"].waitForExistence(timeout: 20))
        // 行必须等：进入本页时 `.task` 会重新拉 `/v1/dashboard`，五维来自那次响应，
        // 而标题是静态的、立刻就在。用 `.exists` 会在慢响应下随机变红。
        XCTAssertTrue(app.staticTexts["效率"].waitForExistence(timeout: 20))
        app.swipeUp(); capture("07-ability-metrics")
        app.swipeUp(); capture("07-ability-trend")
        back()
        XCTAssertTrue(app.buttons["tab.今日"].exists)
    }

    @MainActor
    func test02Workouts() async throws {
        tab("训练"); sleep(5); capture("02-workouts")
        let (data, _) = try await URLSession.shared.data(from: URL(string: server + "/v1/workouts?limit=100")!)
        let payload = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        let rows = payload?["items"] as? [[String: Any]] ?? []
        guard let id = rows.first(where: { $0["hasRoute"] as? Bool == true })?["id"] as? String else {
            throw XCTSkip("The acceptance database has no route-bearing workout")
        }
        let first = app.buttons["workout." + id]
        scrollTo(first)
        first.tap()
        let summary = app.descendants(matching: .any)["workout.summary"].firstMatch
        let trainingEffect = app.descendants(matching: .any)["workout.training-effect"].firstMatch
        let route = app.descendants(matching: .any)["workout.route"].firstMatch
        let adjustedPace = app.descendants(matching: .any)["workout.summary.gradeAdjustedPace"]
        XCTAssertTrue(adjustedPace.waitForExistence(timeout: 45))
        XCTAssertTrue(trainingEffect.waitForExistence(timeout: 10), "训练详情必须展示训练效果卡片")
        XCTAssertTrue(route.waitForExistence(timeout: 30), "有路线的训练必须在首屏展示地图或离线轨迹")
        XCTAssertTrue(app.navigationBars["训练详情"].exists)
        XCTAssertLessThan(route.frame.minY, summary.frame.minY)
        XCTAssertTrue(adjustedPace.isHittable, "平均等强配速必须在首屏摘要中可见")
        XCTAssertLessThan(summary.frame.maxY, app.buttons["tab.设置"].frame.minY,
                          "地图和完整摘要必须同时容纳在默认字号的首屏")
        XCTAssertTrue(app.buttons["workout.feedback"].isHittable)
        XCTAssertTrue(app.buttons["workout.share"].isHittable)
        for field in ["date", "weather", "temperature", "humidity"] {
            XCTAssertTrue(app.descendants(matching: .any)["workout.summary." + field].firstMatch.exists)
        }
        XCTAssertFalse(app.descendants(matching: .any)["workout.summary.metrics"].firstMatch.exists)
        capture("02-detail")
        summary.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.04)).tap()
        XCTAssertTrue(app.descendants(matching: .any)["workout.summary.metrics"].firstMatch.waitForExistence(timeout: 5))
        capture("02-detail-metrics")
        summary.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.04)).tap()
        XCTAssertTrue(app.descendants(matching: .any)["workout.summary.metrics"].firstMatch.waitForNonExistence(timeout: 5))
        app.buttons["workout.share"].tap()
        XCTAssertTrue(app.staticTexts["请先在设置中启用高德地图。"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.images["workout.share.preview"].exists, "未授权高德地图不能生成组合分享卡片")
        XCTAssertFalse(app.buttons["workout.share.send"].exists, "未授权高德地图不能分享伪底图")
        capture("02-detail-share-map-required")
        app.buttons["关闭"].tap()
        // This path checks the offline trace; AMap gestures still need consent-bound acceptance.
        dragContent(up: true, horizontalOffset: 0.5); capture("02-detail-route")
        for (key, title) in [("pace", "配速"), ("heartRate", "心率"), ("cadence", "步频"),
                             ("strideLength", "步幅"), ("power", "跑步功率"), ("groundContactTime", "触地时间"),
                             ("verticalOscillation", "垂直振幅"), ("elevation", "海拔")] {
            scrollTo(app.staticTexts[title], horizontalOffset: 0.5)
            XCTAssertTrue(app.staticTexts[title].isHittable, "\(title)应直接纵向展示，不依赖切换")
            capture("02-detail-" + key)
        }
        let (seriesData, _) = try await URLSession.shared.data(from: URL(string: server + "/v1/workouts/" + id + "/series")!)
        let series = try JSONSerialization.jsonObject(with: seriesData) as? [String: Any]
        let hasSteps = series?["hasMeasuredWorkoutSteps"] as? Bool == true && !(series?["segments"] as? [[String: Any]] ?? []).isEmpty
        scrollTo(app.staticTexts[hasSteps ? "课表分段" : "公里分段"], horizontalOffset: 0.5)
        XCTAssertFalse(app.staticTexts[hasSteps ? "公里分段" : "课表分段"].exists)
        if !hasSteps {
            let splits = app.descendants(matching: .any)["workout.splits"].firstMatch
            XCTAssertEqual(splits.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "等强")).count, 0,
                           "逐公里分段不应展示等强配速")
        }
        capture("02-detail-segments")
        XCTAssertFalse(app.buttons["负荷依据"].exists)
        XCTAssertFalse(app.staticTexts["区间暴露"].exists)
        XCTAssertFalse(app.staticTexts["环境条件"].exists)
        XCTAssertFalse(app.buttons["全部训练指标"].exists)
        XCTAssertFalse(app.staticTexts["分享卡片"].exists)
        XCTAssertEqual(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@ OR label CONTAINS %@", "个有效样本", "个峰谷采样点")).count, 0)
        scrollTo(app.staticTexts["质量与模型"], horizontalOffset: 0.5); capture("02-detail-quality")
    }

    func test03Plan() {
        app.buttons["打开训练计划"].tap(); sleep(2)
        capture("03-plan")
        // The week strip and the watch panel sit above the editor button now, so
        // it no longer lands on the first screenful.
        scrollTo(app.buttons["编辑周计划"])
        app.buttons["编辑周计划"].tap(); capture("03-plan-editor")
        let field = app.textFields["plan.weeklyDistance"]
        XCTAssertTrue(field.exists)
        field.tap()
        field.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: 12) + "501")
        let save = app.buttons["保存计划"]
        scrollTo(save)
        XCTAssertFalse(save.isEnabled)
        capture("03-plan-invalid")
        app.buttons["取消"].tap()
        XCTAssertTrue(app.buttons["编辑周计划"].exists)
        capture("03-plan-cancelled")
        // Seven equal columns, each opening that day's prescription.
        let dayChips = app.buttons.matching(NSPredicate(format: "label CONTAINS '查看训练详情'"))
        XCTAssertGreaterThan(dayChips.count, 0, "本周至少应有一天可以点开训练详情")
        scrollTo(dayChips.element(boundBy: 0))
        dayChips.element(boundBy: 0).tap(); sleep(1)
        capture("03-plan-day-detail")
    }

    func test04Analysis() {
        tab("统计"); sleep(2); capture("04-statistics")
        app.swipeUp(); capture("04-statistics-bottom")
        tab("趋势"); sleep(2); capture("04-trends")
        scrollTo(app.buttons["analysis.ability"])
        capture("04-trends-insights")
        app.buttons["analysis.ability"].tap(); sleep(3)
        capture("04-ability")
        app.swipeUp(); capture("04-ability-zones")
        back()
        // Reselect via another tab to restore the segmented header at the top.
        tab("统计"); tab("趋势")
        app.buttons["纪录"].tap(); capture("04-records")
    }

    func test05Settings() {
        tab("设置"); capture("05-settings")
        app.buttons.matching(NSPredicate(format: "label CONTAINS 'Apple 健康'")).firstMatch.tap()
        capture("05-health")
        app.swipeUp(); capture("05-health-actions")
        back()
        app.buttons.matching(NSPredicate(format: "label CONTAINS '本地缓存'")).firstMatch.tap()
        capture("05-cache")
        app.buttons["清除本机页面缓存"].tap()
        XCTAssertTrue(app.staticTexts["清除本机缓存？"].waitForExistence(timeout: 5))
        capture("05-cache-confirm")
        app.buttons["取消"].tap()
        back()
    }

    func test06Setup() {
        launch(connected: false)
        let field = app.textFields["setup.url"]
        XCTAssertTrue(field.waitForExistence(timeout: 10))
        capture("05-setup")
    }

    func test07LargeText() {
        launch(large: true)
        capture("large-today")
        tab("训练"); capture("large-workouts")
        tab("统计"); capture("large-statistics")
        tab("设置"); capture("large-settings")
    }

    func test11NativeBackGestureAndSafeArea() {
        app.buttons["打开训练计划"].tap()
        XCTAssertTrue(app.navigationBars["训练计划"].waitForExistence(timeout: 10))
        let start = app.coordinate(withNormalizedOffset: CGVector(dx: 0.005, dy: 0.45))
        start.press(forDuration: 0.1, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.88, dy: 0.45)))
        XCTAssertTrue(app.buttons["打开训练计划"].waitForExistence(timeout: 10))
        XCTAssertFalse(app.navigationBars["训练计划"].exists, "Native edge-back must pop the destination")
        app.buttons["打开训练计划"].tap()
        XCTAssertTrue(app.navigationBars["训练计划"].waitForExistence(timeout: 10))
        capture("11-visible-back")
        start.press(forDuration: 0.1,
                    thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.13, dy: 0.45)),
                    withVelocity: XCUIGestureVelocity(rawValue: 50), thenHoldForDuration: 0.4)
        XCTAssertTrue(app.navigationBars["训练计划"].exists, "A short, slow edge gesture must be cancellable")
        app.buttons["navigation.back"].tap()
        XCTAssertTrue(app.buttons["打开训练计划"].waitForExistence(timeout: 10))
        // `15e8126` moved the weekly/body entries into the header and updated
        // `test01TodayAndBody` for it, but missed this call. `scrollTo` only returns once
        // the target's midY is in [115, bottom-25), and a header entry sits at ~93 no
        // matter how far the page scrolls — so the loop ran to its limit and failed on
        // every run since. Reaching them no longer needs scrolling, so hittability is
        // the whole check.
        XCTAssertTrue(app.buttons["today.body"].isHittable)
        // The claim is that the LAST content on 今日 clears the bottom bar. `raceSummary`
        // is that content and now carries `today.race`, so the assertion can name it
        // instead of a mid-page stand-in. Scrolling until the page stops moving — not
        // `scrollTo`, which returns once its target is merely centred — is what makes this
        // a bottom-of-page claim: the moment `TechTabBar` stops reserving layout space and
        // overlays the content instead, the last card sits under the bar and this is the
        // assertion that goes red.
        let lastCard = app.buttons["today.race"]
        XCTAssertTrue(lastCard.waitForExistence(timeout: 10))
        scrollToBottom(lastCard)
        XCTAssertLessThanOrEqual(lastCard.frame.maxY,
                                 app.buttons["tab.设置"].frame.minY,
                                 "The last card on 今日 must clear the bottom bar")
        capture("11-home-safe-area")
    }

    func test12LargeAbilityAndKeyboard() {
        launch(large: true)
        scrollTo(app.buttons["today.ability"], limit: 50)
        app.buttons["today.ability"].tap()
        XCTAssertTrue(app.navigationBars["跑步能力"].waitForExistence(timeout: 15))
        capture("12-large-ability-top")
        scrollTo(app.staticTexts["基础指标"], limit: 40)
        capture("12-large-ability-metrics")
        back()
        // Restore Today at the top without depending on a huge accessibility scroll.
        tab("训练"); tab("今日")
        app.buttons["打开训练计划"].tap()
        scrollTo(app.buttons["编辑周计划"], limit: 60)
        app.buttons["编辑周计划"].tap()
        let field = app.textFields["plan.weeklyDistance"]
        scrollTo(field, limit: 40)
        field.tap()
        XCTAssertTrue(app.buttons["keyboard.done"].waitForExistence(timeout: 5))
        capture("12-large-editor-keyboard")
        app.buttons["keyboard.done"].tap()
        XCTAssertTrue(app.keyboards.firstMatch.waitForNonExistence(timeout: 5))
        app.buttons["取消"].tap()
        capture("12-large-plan")
    }

    @MainActor
    func test13SeriesInteractionDoesNotStealScroll() async throws {
        tab("训练")
        let (data, _) = try await URLSession.shared.data(from: URL(string: server + "/v1/workouts?limit=100")!)
        let payload = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        let rows = payload?["items"] as? [[String: Any]] ?? []
        guard let id = rows.first(where: { $0["hasRoute"] as? Bool == true })?["id"] as? String else {
            throw XCTSkip("No route-bearing workout in acceptance fixture")
        }
        let row = app.buttons["workout." + id]
        scrollTo(row); row.tap()
        XCTAssertTrue(app.descendants(matching: .any)["workout.summary.gradeAdjustedPace"].waitForExistence(timeout: 45))
        let pace = app.descendants(matching: .any)["workout.series.pace"].firstMatch
        scrollTo(pace, horizontalOffset: 0.5)
        XCTAssertFalse(app.buttons["workout.series.pace.next"].exists)
        XCTAssertFalse(app.buttons["workout.series.pace.previous"].exists)
        pace.coordinate(withNormalizedOffset: CGVector(dx: 0.55, dy: 0.45)).tap()
        XCTAssertTrue(app.staticTexts["workout.series.pace.selection"].waitForExistence(timeout: 5))
        capture("13-series-inspection")
        let heartRate = app.descendants(matching: .any)["workout.series.heartRate"].firstMatch
        scrollTo(heartRate, horizontalOffset: 0.5)
        XCTAssertFalse(app.staticTexts["workout.series.heartRate.selection"].exists,
                       "配速图的选中点不得污染心率图")
        heartRate.coordinate(withNormalizedOffset: CGVector(dx: 0.55, dy: 0.45)).tap()
        XCTAssertTrue(app.staticTexts["workout.series.heartRate.selection"].waitForExistence(timeout: 5))
        capture("13-heartRate-inspection")
        scrollTo(app.staticTexts["质量与模型"], horizontalOffset: 0.5)
        XCTAssertTrue(app.staticTexts["质量与模型"].isHittable)
        capture("13-series-page-scroll")
    }

    func test14ScrollPerformanceBaseline() {
        let options = XCTMeasureOptions()
        options.iterationCount = 3
        measure(metrics: [XCTClockMetric(), XCTCPUMetric(application: app),
                          XCTMemoryMetric(application: app),
                          XCTOSSignpostMetric.scrollDecelerationMetric], options: options) {
            app.swipeUp()
            app.swipeUp()
            app.swipeDown()
            app.swipeDown()
        }
    }
    @MainActor
    func test08FaultStates() async throws {
        try await proxyMode("normal")
        launchProxy()
        XCTAssertTrue(app.buttons["打开训练计划"].waitForExistence(timeout: 30))
        sleep(10)
        try await proxyMode("offline")
        launchProxy()
        sleep(8)
        if app.buttons["知道了"].exists { app.buttons["知道了"].tap() }
        capture("06-offline")
        app.buttons["打开训练计划"].tap()
        XCTAssertFalse(app.buttons["编辑周计划"].isEnabled)
        capture("06-offline-plan")

        try await proxyMode("empty")
        launchProxy(); sleep(8); tab("训练")
        XCTAssertTrue(app.staticTexts["尚无训练记录"].waitForExistence(timeout: 20))
        capture("06-empty-workouts")

        try await proxyMode("handshake-error")
        tab("设置")
        app.buttons.matching(NSPredicate(format: "label CONTAINS 'Apple 健康'")).firstMatch.tap()
        scrollTo(app.buttons["health.sync"])
        XCTAssertTrue(app.buttons["health.sync"].isEnabled)
        app.buttons["health.sync"].tap()
        XCTAssertTrue(app.staticTexts["同步未完成"].waitForExistence(timeout: 15))
        // Return to the top of the same page, without reinitializing the actual sync error.
        dragContent(up: false); capture("06-sync-failed")
        try await proxyMode("handshake-delay")
        scrollTo(app.buttons["health.sync"])
        app.buttons["health.sync"].tap()
        capture("06-sync-busy")
        app.terminate() // Cancel before HealthKit authorization; no permissions are granted.

        try await proxyMode("lock-preview")
        launchProxy(); sleep(8)
        app.buttons["打开训练计划"].tap()
        scrollTo(app.buttons["锁定今日安排"])
        app.buttons["锁定今日安排"].tap()
        capture("03-lock-preview-fixture")
        app.buttons["暂不锁定"].tap()
        try await proxyMode("normal")

        app.launchArguments = ["-rai.serverURL", "http://127.0.0.1:8794",
                               "-rai.privacy.amap.state", "declined",
                               "-AppleLanguages", "(zh-Hans)", "-AppleLocale", "zh_CN"]
        app.launch()
        XCTAssertTrue(app.buttons["tab.设置"].waitForExistence(timeout: 10))
        capture("06-cold-loading")
        app.terminate()
    }

    @MainActor
    func test10RevisionConflict() async throws {
        app.buttons["打开训练计划"].tap()
        scrollTo(app.buttons["编辑周计划"])
        app.buttons["编辑周计划"].tap()
        let url = URL(string: server + "/v1/mobile/goals")!
        let (body, _) = try await URLSession.shared.data(from: url)
        let before = try XCTUnwrap(try JSONSerialization.jsonObject(with: body) as? [String: Any])
        let revision = try XCTUnwrap(before["revision"] as? Int)
        let weekly = try XCTUnwrap(before["weeklyDistanceKm"] as? Double)
        let changed = weekly >= 499.9 ? weekly - 0.1 : weekly + 0.1
        var request = URLRequest(url: url)
        request.httpMethod = "PUT"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: ["expectedRevision": revision, "weeklyDistanceKm": changed])
        let (_, response) = try await URLSession.shared.data(for: request)
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
        scrollTo(app.buttons["保存计划"])
        app.buttons["保存计划"].tap()
        XCTAssertTrue(app.staticTexts["计划已在其他设备更新"].waitForExistence(timeout: 15))
        capture("03-revision-conflict")
        app.buttons["加载最新计划"].tap()
        app.buttons["取消"].tap()
        capture("03-revision-reloaded")
    }

    private func launchProxy() {
        app.launchArguments = ["-rai.serverURL", "http://127.0.0.1:8793",
                               "-rai.privacy.amap.state", "declined",
                               "-AppleLanguages", "(zh-Hans)", "-AppleLocale", "zh_CN"]
        app.launch()
    }

    private func proxyMode(_ mode: String) async throws {
        var request = URLRequest(url: URL(string: "http://127.0.0.1:8793/__mode")!)
        request.httpMethod = "POST"
        request.httpBody = try JSONSerialization.data(withJSONObject: ["mode": mode])
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let (_, response) = try await URLSession.shared.data(for: request)
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
    }
}
