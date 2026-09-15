import XCTest

/// UI-only harness. Install RAI separately and run an isolated API on port 8792.
/// It never writes to a production API, imports Health data, or changes scoring.
final class VisualAcceptance: XCTestCase {
    let app = XCUIApplication(bundleIdentifier: "app.rai.running.debug")
    let server = "http://127.0.0.1:8792"

    override func setUpWithError() throws {
        continueAfterFailure = false
        launch()
    }

    func launch(connected: Bool = true, large: Bool = false) {
        app.launchArguments = ["-rai.appearance.skin", "technology", "-rai.serverURL", connected ? server : "",
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

    func scrollTo(_ element: XCUIElement, limit: Int = 12) {
        // isHittable alone includes content obscured by the custom bottom bar.
        // Center the actual target in the unobscured scrolling region before tapping.
        let bottom = app.buttons["tab.设置"].exists ? app.buttons["tab.设置"].frame.minY : app.windows.firstMatch.frame.height - 90
        for _ in 0..<limit {
            if element.exists {
                let frame = element.frame
                if frame.midY >= 115 && frame.midY < bottom - 25 { return }
                if frame.midY < 115 { dragContent(up: false); continue }
            }
            dragContent(up: true)
        }
        capture("unreachable-target")
        print(element.debugDescription)
        XCTFail("Expected fully visible target: \(element)")
    }

    // Drag the page gutter, not the map/charts, which legitimately own pan gestures.
    func dragContent(up: Bool) {
        let startY: CGFloat = app.keyboards.count > 0 ? 0.45 : (up ? 0.70 : 0.35)
        let endY: CGFloat = app.keyboards.count > 0 ? 0.20 : (up ? 0.40 : 0.65)
        let start = app.coordinate(withNormalizedOffset: CGVector(dx: 0.07, dy: startY))
        let end = app.coordinate(withNormalizedOffset: CGVector(dx: 0.07, dy: endY))
        start.press(forDuration: 0.05, thenDragTo: end)
    }

    func back() { app.navigationBars.buttons.element(boundBy: 0).tap() }
    func tab(_ title: String) { app.buttons["tab.\(title)"].tap() }

    func test01TodayAndBody() {
        capture("01-today")
        app.swipeUp(); capture("01-today-lower")
        scrollTo(app.buttons["today.week"])
        capture("01-today-links")
        app.buttons["today.week"].tap(); sleep(2)
        XCTAssertTrue(app.navigationBars["本周活动"].exists)
        capture("01-week")
        app.swipeUp(); capture("01-week-daily")
        back()
        scrollTo(app.buttons["today.body"])
        app.buttons["today.body"].tap()
        XCTAssertTrue(app.staticTexts["配速分区"].waitForExistence(timeout: 45))
        XCTAssertTrue(app.navigationBars["身体指标"].exists)
        capture("01-body")
        app.swipeUp(); capture("06-body-zones")
        app.swipeUp(); capture("06-body-predictions")
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
        XCTAssertTrue(app.buttons["全部训练指标"].waitForExistence(timeout: 45))
        XCTAssertTrue(app.navigationBars["训练详情"].exists)
        capture("02-detail")
        // Scroll the page gutter: a plain swipeUp() lands on the route map, which
        // legitimately owns pan gestures, and the fitted trace leaves the card.
        dragContent(up: true); capture("02-detail-route")
        let metrics = app.buttons["全部训练指标"]
        scrollTo(metrics); metrics.tap(); capture("02-detail-metrics")
        // Collapse after recording the metrics so all time-series remain easy to inspect.
        scrollTo(metrics); metrics.tap()
        scrollTo(app.staticTexts["训练时序"]); capture("02-detail-series")
        // The segments panel answers "did I run the session I was given" and sits
        // above the kilometre split; both are recorded.
        scrollTo(app.staticTexts["课表分段"]); capture("02-detail-segments")
        scrollTo(app.staticTexts["公里分段"]); capture("02-detail-splits")
        scrollTo(app.staticTexts["质量与模型"]); capture("02-detail-quality")
        scrollTo(app.staticTexts["训练负荷"]); capture("02-detail-load")
        scrollTo(app.buttons["负荷依据"]); app.buttons["负荷依据"].tap()
        capture("02-detail-load-evidence")
        scrollTo(app.staticTexts["区间暴露"])
        dragContent(up: true); capture("02-detail-zones")
    }

    func test03Plan() {
        app.buttons["打开训练计划"].tap(); sleep(2)
        capture("03-plan")
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
        app.buttons.matching(NSPredicate(format: "label CONTAINS '外观皮肤'")).firstMatch.tap()
        capture("05-skin-picker")
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

        app.launchArguments = ["-rai.appearance.skin", "technology", "-rai.serverURL", "http://127.0.0.1:8794",
                               "-AppleLanguages", "(zh-Hans)", "-AppleLocale", "zh_CN"]
        app.launch()
        XCTAssertTrue(app.buttons["tab.设置"].waitForExistence(timeout: 10))
        capture("06-cold-loading")
        app.terminate()
    }

    func test09AppearancePersistence() {
        app.launchArguments = ["-rai.serverURL", server, "-AppleLanguages", "(zh-Hans)", "-AppleLocale", "zh_CN"]
        app.launch()
        let techTab = app.buttons["tab.设置"]
        if techTab.exists {
            techTab.tap()
            app.buttons.matching(NSPredicate(format: "label CONTAINS '外观皮肤'")).firstMatch.tap()
        } else {
            app.buttons["设置"].tap()
        }
        capture("pixel-settings-before-switch")
        scrollTo(app.buttons["appearance.technology"])
        app.buttons["appearance.technology"].tap()
        XCTAssertTrue(app.buttons["tab.设置"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.buttons["tab.设置"].isSelected)
        app.terminate(); app.launch()
        XCTAssertTrue(app.buttons["tab.设置"].waitForExistence(timeout: 15))
        tab("设置")
        app.buttons.matching(NSPredicate(format: "label CONTAINS '外观皮肤'")).firstMatch.tap()
        app.buttons["appearance.pixel"].tap()
        XCTAssertFalse(app.buttons["tab.设置"].exists)
        XCTAssertFalse(app.navigationBars["外观皮肤"].exists)
        XCTAssertTrue(app.buttons["设置"].isSelected)
        capture("pixel-restored")
    }

    @MainActor
    func test10RevisionConflict() async throws {
        app.buttons["打开训练计划"].tap()
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
        app.launchArguments = ["-rai.appearance.skin", "technology", "-rai.serverURL", "http://127.0.0.1:8793",
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
