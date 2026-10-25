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

    func scrollTo(_ element: XCUIElement, limit: Int = 30, horizontalOffset: CGFloat = 0.07, inSheet: Bool = false) {
        // isHittable alone includes content obscured by the custom bottom bar.
        // Center the actual target in the unobscured scrolling region before tapping.
        let bottom = inSheet ? app.windows.firstMatch.frame.height - 34 :
            (app.buttons["tab.设置"].exists ? app.buttons["tab.设置"].frame.minY : app.windows.firstMatch.frame.height - 90)
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
        app.buttons["关闭"].firstMatch.tap()
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
        app.buttons["手动课表"].tap(); sleep(1)
        capture("03-plan")
        // The week strip and the watch panel sit above the editor button now, so
        // it no longer lands on the first screenful.
        scrollTo(app.buttons["编辑周计划"])
        app.buttons["编辑周计划"].tap(); capture("03-plan-editor")
        XCTAssertFalse(app.textFields["plan.weeklyDistance"].exists)
        XCTAssertTrue(app.sliders.firstMatch.exists)
        XCTAssertTrue(app.steppers.firstMatch.exists)
        let save = app.buttons["保存计划"]
        scrollTo(save)
        XCTAssertTrue(save.isEnabled)
        capture("03-plan-controls")
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
        XCTAssertTrue(app.navigationBars["跑步教练"].waitForExistence(timeout: 10))
        let start = app.coordinate(withNormalizedOffset: CGVector(dx: 0.005, dy: 0.45))
        start.press(forDuration: 0.1, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.88, dy: 0.45)))
        XCTAssertTrue(app.buttons["打开训练计划"].waitForExistence(timeout: 10))
        XCTAssertFalse(app.navigationBars["跑步教练"].exists, "Native edge-back must pop the destination")
        app.buttons["打开训练计划"].tap()
        XCTAssertTrue(app.navigationBars["跑步教练"].waitForExistence(timeout: 10))
        capture("11-visible-back")
        start.press(forDuration: 0.1,
                    thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.13, dy: 0.45)),
                    withVelocity: XCUIGestureVelocity(rawValue: 50), thenHoldForDuration: 0.4)
        XCTAssertTrue(app.navigationBars["跑步教练"].exists, "A short, slow edge gesture must be cancellable")
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

    func test12LargeAbilityAndPlanEditor() {
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
        app.buttons["手动课表"].tap()
        scrollTo(app.buttons["编辑周计划"], limit: 60)
        app.buttons["编辑周计划"].tap()
        XCTAssertFalse(app.textFields["plan.weeklyDistance"].exists)
        scrollTo(app.steppers.firstMatch, limit: 40)
        XCTAssertTrue(app.steppers.firstMatch.isHittable)
        capture("12-large-editor-controls")
        scrollTo(app.buttons["保存计划"], limit: 40)
        XCTAssertTrue(app.buttons["保存计划"].isEnabled)
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
    func test15RunCoachLifecycleAndLargeText() async throws {
        let current = try await coachGoals()
        if let plan = current["runCoach"] as? [String: Any], plan["status"] as? String != "ended" {
            try await coachCommand("end", revision: try XCTUnwrap(current["revision"] as? Int))
        }
        launch()
        app.buttons["打开训练计划"].tap()
        XCTAssertTrue(app.buttons["coach.create"].waitForExistence(timeout: 15))
        scrollTo(app.buttons["coach.create"]); app.buttons["coach.create"].tap()
        XCTAssertTrue(app.navigationBars["创建教练计划"].waitForExistence(timeout: 10))
        capture("15-coach-setup")
        app.buttons["coach.setup.save"].tap()
        guard app.buttons["coach.preferences"].waitForExistence(timeout: 20) else {
            capture("15-coach-create-failed"); XCTFail("Coach creation did not finish"); return
        }
        XCTAssertTrue(app.staticTexts["改善跑步体能"].exists)
        capture("15-coach-active")

        app.buttons["coach.preferences"].tap()
        XCTAssertTrue(app.navigationBars["训练偏好"].waitForExistence(timeout: 10))
        scrollTo(app.buttons["心率"], limit: 30, inSheet: true)
        app.buttons["心率"].tap()
        let strength = app.switches["补充力量训练"]
        scrollTo(strength, inSheet: true)
        strength.switches.firstMatch.tap()
        XCTAssertEqual(strength.value as? String, "1", "Tap the switch control, not the enclosing form row")
        capture("15-coach-preferences")
        XCTAssertTrue(app.buttons["coach.setup.save"].isEnabled, "A newly opened preferences sheet must capture the current revision")
        app.buttons["coach.setup.save"].tap()
        XCTAssertTrue(app.buttons["coach.preferences"].waitForExistence(timeout: 20))
        let updated = try await coachGoals()
        let profile = try XCTUnwrap(updated["runCoach"] as? [String: Any])
        XCTAssertEqual(profile["targetType"] as? String, "heart_rate")
        XCTAssertEqual(profile["strengthTraining"] as? Bool, true)

        scrollTo(app.buttons["coach.pause-resume"])
        app.buttons["coach.pause-resume"].tap(); app.buttons["暂停教练计划？"].tap()
        XCTAssertTrue(app.staticTexts["已暂停"].waitForExistence(timeout: 15))
        capture("15-coach-paused")
        let (planData, _) = try await URLSession.shared.data(from: URL(string: server + "/v1/mobile/workout-plan")!)
        let planPayload = try XCTUnwrap(try JSONSerialization.jsonObject(with: planData) as? [String: Any])
        XCTAssertTrue((planPayload["days"] as? [[String: Any]] ?? []).allSatisfy { $0["executable"] as? Bool == false })
        app.buttons["coach.pause-resume"].tap(); app.buttons["按当前训练状态继续计划？"].tap()
        XCTAssertTrue(app.staticTexts["进行中"].waitForExistence(timeout: 15))

        launch(large: true)
        app.buttons["打开训练计划"].tap()
        XCTAssertTrue(app.buttons["coach.preferences"].waitForExistence(timeout: 15))
        XCTAssertLessThanOrEqual(app.staticTexts["改善跑步体能"].frame.maxX, app.staticTexts["进行中"].frame.minX)
        XCTAssertLessThanOrEqual(app.buttons["coach.preferences"].frame.maxX, app.buttons["coach.pause-resume"].frame.minX)
        capture("15-coach-large-overview")
        let (todayData, _) = try await URLSession.shared.data(from: URL(string: server + "/v1/mobile/today")!)
        let todayPayload = try XCTUnwrap(try JSONSerialization.jsonObject(with: todayData) as? [String: Any])
        let weekDays = try XCTUnwrap(todayPayload["weekPlan"] as? [[String: Any]])
        let firstDate = try XCTUnwrap(weekDays.first?["localDate"] as? String)
        let firstDay = app.buttons["coach.week-day." + firstDate]
        scrollTo(firstDay, limit: 70)
        XCTAssertTrue(firstDay.isHittable)
        XCTAssertGreaterThan(firstDay.frame.height, 140, "Accessibility day cards must grow to fit all of their content")
        capture("15-coach-large-week-days")
        scrollTo(app.buttons["coach.end"], limit: 70)
        XCTAssertTrue(app.buttons["coach.end"].isHittable)
        capture("15-coach-large-calendar")
        app.buttons["coach.end"].tap(); app.buttons["结束当前教练计划？"].tap()
        XCTAssertTrue(app.staticTexts["已结束"].waitForExistence(timeout: 15))
        capture("15-coach-ended")
        let ended = try await coachGoals()
        XCTAssertEqual((ended["runCoach"] as? [String: Any])?["status"] as? String, "ended")
    }

    @MainActor
    func test16RunCoachRaceSetup() async throws {
        let current = try await coachGoals()
        if let plan = current["runCoach"] as? [String: Any], plan["status"] as? String != "ended" {
            try await coachCommand("end", revision: try XCTUnwrap(current["revision"] as? Int))
            launch()
        }
        app.buttons["打开训练计划"].tap()
        scrollTo(app.buttons["coach.create"]); app.buttons["coach.create"].tap()
        app.buttons["coach.setup.goal"].tap(); app.buttons["目标时间"].tap()
        app.buttons["coach.setup.distance"].tap(); app.buttons["半程马拉松"].tap()
        capture("16-coach-time-goal")
        app.buttons["coach.setup.save"].tap()
        guard app.buttons["coach.preferences"].waitForExistence(timeout: 20) else {
            capture("16-coach-create-failed"); XCTFail("Race coach creation did not finish"); return
        }
        let goals = try await coachGoals()
        let profile = try XCTUnwrap(goals["runCoach"] as? [String: Any])
        XCTAssertEqual(profile["goal"] as? String, "time")
        XCTAssertEqual(profile["raceDistanceKm"] as? Double, 21.0975)
        XCTAssertEqual(profile["targetTimeSeconds"] as? Double, 3600)
        capture("16-coach-race-overview")
        try await coachCommand("end", revision: try XCTUnwrap(goals["revision"] as? Int))
    }

    private func coachGoals() async throws -> [String: Any] {
        let (data, response) = try await URLSession.shared.data(from: URL(string: server + "/v1/mobile/goals")!)
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
        return try XCTUnwrap(try JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    private func coachCommand(_ action: String, revision: Int) async throws {
        var request = URLRequest(url: URL(string: server + "/v1/mobile/run-coach")!)
        request.httpMethod = "POST"; request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: ["action": action, "expectedRevision": revision])
        let (_, response) = try await URLSession.shared.data(for: request)
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
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
        app.buttons["手动课表"].tap()
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
        app.buttons["手动课表"].tap()
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
        app.buttons["手动课表"].tap()
        scrollTo(app.buttons["编辑周计划"])
        app.buttons["编辑周计划"].tap()
        let url = URL(string: server + "/v1/mobile/goals")!
        let (body, _) = try await URLSession.shared.data(from: url)
        let before = try XCTUnwrap(try JSONSerialization.jsonObject(with: body) as? [String: Any])
        let revision = try XCTUnwrap(before["revision"] as? Int)
        // Bump a goal the editor still owns. The weekly distance used to be the
        // scratch field here; it is retired, so `easyDurationFloorFraction` moves
        // within its own legal range instead.
        let floor = try XCTUnwrap(before["easyDurationFloorFraction"] as? Double)
        let changed = floor >= 0.9 ? floor - 0.05 : floor + 0.05
        var request = URLRequest(url: url)
        request.httpMethod = "PUT"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: ["expectedRevision": revision, "easyDurationFloorFraction": changed])
        let (_, response) = try await URLSession.shared.data(for: request)
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
        let save = app.buttons["保存计划"]
        scrollTo(save)
        // A known stale draft is disabled before submission. If the latest
        // revision has not arrived yet, the existing CAS rejection refreshes it.
        if save.isEnabled { save.tap() }
        let conflict = app.staticTexts["计划已更新，你的未保存修改仍保留。请查看最新计划后再编辑。"]
        XCTAssertTrue(conflict.waitForExistence(timeout: 15))
        XCTAssertFalse(save.isEnabled, "A stale draft must not be saveable")
        let cap = try XCTUnwrap(before["qualitySessionCap"] as? Int)
        let oldPercent = String(format: "%.0f%%", locale: Locale(identifier: "en_US_POSIX"), floor * 100)
        let newPercent = String(format: "%.0f%%", locale: Locale(identifier: "en_US_POSIX"), changed * 100)
        let comparison = app.staticTexts["最新：轻松训练时长 ≥\(newPercent)，质量课 ≤\(cap)；你的草稿：轻松训练时长 ≥\(oldPercent)，质量课 ≤\(cap)。"]
        XCTAssertTrue(comparison.exists, "The latest settings and the unmodified draft must both remain visible")

        func verifyPersistedGoals() async throws {
            let (data, response) = try await URLSession.shared.data(from: url)
            XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
            let goals = try XCTUnwrap(try JSONSerialization.jsonObject(with: data) as? [String: Any])
            XCTAssertEqual(goals["revision"] as? Int, revision + 1, "Rejected save / draft reload must not create another revision")
            XCTAssertEqual(try XCTUnwrap(goals["easyDurationFloorFraction"] as? Double), changed, accuracy: 0.0000001,
                           "The stale draft must not overwrite the other client's value")
            XCTAssertEqual(goals["qualitySessionCap"] as? Int, cap)
            XCTAssertEqual(
                try JSONSerialization.data(withJSONObject: try XCTUnwrap(goals["weekPlan"]), options: .sortedKeys),
                try JSONSerialization.data(withJSONObject: try XCTUnwrap(before["weekPlan"]), options: .sortedKeys),
                "Conflict handling must not replace the persisted weekly plan"
            )
        }
        try await verifyPersistedGoals()
        scrollTo(conflict)
        capture("03-revision-conflict")

        let discard = app.buttons["放弃草稿并加载最新计划"]
        scrollTo(discard)
        discard.tap()
        let confirmDiscard = app.buttons["放弃并加载最新计划"]
        XCTAssertTrue(confirmDiscard.waitForExistence(timeout: 10), "Discarding requires the existing explicit confirmation")
        capture("03-revision-discard-confirm")
        let cancelConfirmation = app.sheets.buttons["取消"].firstMatch
        if cancelConfirmation.exists {
            cancelConfirmation.tap()
        } else {
            // iOS 26 presents this confirmation as a popover: cancellation is
            // the native, accessibility-identified outside dismiss region.
            let dismissPopup = app.otherElements["PopoverDismissRegion"]
            XCTAssertTrue(dismissPopup.waitForExistence(timeout: 10))
            dismissPopup.tap()
        }
        XCTAssertFalse(confirmDiscard.exists, "Cancellation must dismiss, not confirm, the destructive action")
        XCTAssertTrue(comparison.exists, "Cancelling the confirmation must preserve the original draft")
        XCTAssertFalse(save.isEnabled)
        discard.tap()
        XCTAssertTrue(confirmDiscard.waitForExistence(timeout: 10))
        confirmDiscard.tap()
        XCTAssertFalse(conflict.exists)
        XCTAssertTrue(save.isEnabled, "Explicit reload must restore an editable draft at the latest revision")
        XCTAssertTrue(app.staticTexts[newPercent].exists, "The reloaded draft must display the latest setting")
        try await verifyPersistedGoals()
        app.buttons["取消"].tap()
        capture("03-revision-reloaded")
    }

    @MainActor
    func test17LargeWorkoutDetailAndFeedback() async throws {
        launch(large: true)
        tab("训练")
        let (data, response) = try await URLSession.shared.data(from: URL(string: server + "/v1/workouts?limit=100")!)
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
        let payload = try XCTUnwrap(try JSONSerialization.jsonObject(with: data) as? [String: Any])
        let rows = payload["items"] as? [[String: Any]] ?? []
        let id = try XCTUnwrap(rows.first(where: { $0["hasRoute"] as? Bool == true })?["id"] as? String,
                               "The isolated acceptance database must provide a real route-bearing workout")
        let row = app.buttons["workout." + id]
        scrollTo(row, limit: 60)
        capture("17-large-workout-row")
        row.tap()
        XCTAssertTrue(app.navigationBars["训练详情"].waitForExistence(timeout: 45))
        XCTAssertTrue(app.descendants(matching: .any)["workout.route"].firstMatch.waitForExistence(timeout: 30),
                      "The real route must remain available at accessibility text sizes")
        let summaryTitle = app.staticTexts["训练摘要"]
        XCTAssertTrue(summaryTitle.waitForExistence(timeout: 30))
        capture("17-large-detail-top")
        scrollTo(summaryTitle, limit: 50, horizontalOffset: 0.5)
        summaryTitle.tap()
        capture("17-large-detail-expanded")
        app.buttons["workout.feedback"].tap()
        XCTAssertTrue(app.navigationBars["训练反馈"].waitForExistence(timeout: 20))
        capture("17-large-feedback")
        app.navigationBars["训练反馈"].buttons["完成"].tap()
        XCTAssertTrue(app.navigationBars["训练详情"].exists)
        let pace = app.descendants(matching: .any)["workout.series.pace"].firstMatch
        scrollTo(pace, limit: 60, horizontalOffset: 0.5)
        XCTAssertTrue(pace.isHittable)
        capture("17-large-pace-chart")
    }

    func test18LargeAnalysisAndBody() {
        launch(large: true)
        tab("统计")
        capture("18-large-statistics")
        tab("趋势")
        capture("18-large-trends")
        app.buttons["纪录"].tap()
        capture("18-large-records")
        tab("今日")
        app.buttons["today.body"].tap()
        XCTAssertTrue(app.navigationBars["身体指标"].waitForExistence(timeout: 45))
        capture("18-large-body")
    }

    func test19SettingsSecondaryScreens() {
        let destinations = [
            ("RAI 服务", "server"), ("地图底图", "map"),
            ("训练提醒", "reminders"), ("导出训练摘要", "export"), ("关于 RAI", "about"),
        ]
        for large in [false, true] {
            launch(large: large)
            tab("设置")
            for (title, identifier) in destinations {
                let link = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", title)).firstMatch
                scrollTo(link, limit: 60)
                link.tap()
                XCTAssertTrue(app.navigationBars[title].waitForExistence(timeout: 15))
                capture("19-" + (large ? "large-" : "") + identifier)
                app.buttons["navigation.back"].tap()
                XCTAssertTrue(app.buttons["tab.设置"].exists)
            }
        }
    }

    @MainActor
    func test20RaceEditorAndPlanPreview() async throws {
        for large in [false, true] {
            launch(large: large)
            let before = try await coachGoals()
            app.buttons["打开训练计划"].tap()
            app.buttons["手动课表"].tap()
            let edit = app.buttons["race-goal-edit"]
            scrollTo(edit, limit: 60)
            edit.tap()
            XCTAssertTrue(app.navigationBars["比赛目标"].waitForExistence(timeout: 15))
            capture("20-" + (large ? "large-" : "") + "race-pace")
            app.segmentedControls.buttons["完赛时间"].tap()
            XCTAssertTrue(app.textFields["race-goal-finish"].exists)
            capture("20-" + (large ? "large-" : "") + "race-time")
            app.navigationBars["比赛目标"].buttons["取消"].tap()
            let preview = app.buttons["预览未来 7 日课表"]
            scrollTo(preview, limit: 60)
            XCTAssertTrue(preview.isEnabled)
            preview.tap()
            XCTAssertTrue(app.navigationBars["确认新课表"].waitForExistence(timeout: 30))
            XCTAssertTrue(app.buttons["确认替换"].isEnabled)
            capture("20-" + (large ? "large-" : "") + "plan-preview")
            app.navigationBars["确认新课表"].buttons["取消"].tap()
            let after = try await coachGoals()
            XCTAssertEqual(after["revision"] as? Int, before["revision"] as? Int,
                           "Opening/cancelling editors and previews must not save implicitly")
            XCTAssertEqual(
                try JSONSerialization.data(withJSONObject: try XCTUnwrap(after["weekPlan"]), options: .sortedKeys),
                try JSONSerialization.data(withJSONObject: try XCTUnwrap(before["weekPlan"]), options: .sortedKeys)
            )
        }
    }

    @MainActor
    func test21WatchManagementAfterEndAndOfflineRestart() async throws {
        let current = try await coachGoals()
        if let profile = current["runCoach"] as? [String: Any], profile["status"] as? String != "ended" {
            try await coachCommand("end", revision: try XCTUnwrap(current["revision"] as? Int))
        }
        launch()
        app.buttons["打开训练计划"].tap()
        let clear = app.buttons["plan.watch.clear"]
        scrollTo(clear, limit: 70)
        XCTAssertTrue(clear.isEnabled, "Ended/no-current-plan states must retain explicit withdrawal")
        XCTAssertFalse(app.staticTexts["就绪"].exists, "No current system verification is not readiness")
        clear.tap()
        let result = app.staticTexts["plan.watch.result"]
        XCTAssertTrue(result.waitForExistence(timeout: 15))
        scrollTo(result, limit: 30)
        XCTAssertTrue(result.label.contains("不支持") || result.label.contains("未获") || result.label.contains("未能确认") ||
                      result.label.contains("拒绝") || result.label.contains("限制"),
                      "Simulator support/auth varies by OS; a refusal must never read as successful withdrawal")
        capture("21-ended-watch-management")

        try await proxyMode("normal")
        launchProxy(); sleep(8)
        try await proxyMode("offline")
        launchProxy(); sleep(8)
        defer { Task { try? await self.proxyMode("normal") } }
        app.buttons["打开训练计划"].tap()
        scrollTo(app.buttons["plan.watch.clear"], limit: 70)
        XCTAssertTrue(app.buttons["plan.watch.clear"].isEnabled, "Offline restart must not require a volatile Watch revision to withdraw")
        capture("21-offline-watch-management")
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

/// Current v2 acceptance against the authenticated, migrated synthetic API.
/// It uses production SwiftUI, URLSession, generation and persistence. Device
/// WorkoutKit visibility remains a separate paired-device acceptance.
@MainActor final class Phase5Acceptance: XCTestCase {
    private let app = XCUIApplication(bundleIdentifier: "app.rai.running.debug")
    private let base = "http://127.0.0.1:8792"
    private let fixtureToken = "rai-visual-isolated-test-token"
    private var sessionContract = false
    private var executionContract = false
    private func call(_ path: String, body: [String: Any]? = nil) async throws -> [String: Any] {
        var request = URLRequest(url: URL(string: base + path)!)
        request.setValue("Bearer " + fixtureToken, forHTTPHeaderField: "Authorization")
        request.setValue("2", forHTTPHeaderField: "X-RAI-Training-Contract")
        request.setValue("2", forHTTPHeaderField: "X-RAI-Client-Training-Commands")
        if sessionContract {
            request.setValue("1", forHTTPHeaderField: "X-RAI-Training-Sessions")
            request.setValue("1", forHTTPHeaderField: "X-RAI-Client-Training-Session-Commands")
        }
        if executionContract { request.setValue("1", forHTTPHeaderField: "X-RAI-Client-Training-Execution-Commands") }
        if let body {
            request.httpMethod = "POST"; request.httpBody = try JSONSerialization.data(withJSONObject: body)
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        let (data, response) = try await URLSession.shared.data(for: request)
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200, String(data: data, encoding: .utf8) ?? "")
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }
    private func capture(_ name: String) {
        let image = XCTAttachment(screenshot: app.screenshot()); image.name = name; image.lifetime = .keepAlways; add(image)
        let tree = XCTAttachment(string: app.debugDescription); tree.name = name + "-accessibility"; tree.lifetime = .keepAlways; add(tree)
    }
    private func waitUntilEnabled(_ element: XCUIElement, timeout: TimeInterval = 30) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if element.exists && element.isEnabled { return true }
            Thread.sleep(forTimeInterval: 0.5)
        }
        return false
    }
    private func openEditor() {
        let button = app.buttons["training.commands.open"]
        XCTAssertTrue(button.waitForExistence(timeout: 30))
        XCTAssertTrue(waitUntilEnabled(button), "the v2 editor is enabled only after the unified read is current")
        button.tap()
        XCTAssertTrue(app.buttons["training.commands.preview"].waitForExistence(timeout: 10))
    }
    private func connectService() {
        XCTAssertTrue(app.buttons["tab.设置"].waitForExistence(timeout: 40)); app.buttons["tab.设置"].tap()
        let serviceLink = app.buttons.matching(
            NSPredicate(format: "label BEGINSWITH %@", "RAI 服务")).firstMatch
        XCTAssertTrue(serviceLink.waitForExistence(timeout: 20)); serviceLink.tap()
        let token = app.secureTextFields.firstMatch
        XCTAssertTrue(token.waitForExistence(timeout: 15)); token.tap()
        let count = (token.value as? String)?.count ?? 0
        token.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: count + 2) + fixtureToken)
        let connect = app.buttons["连接服务"].firstMatch
        if connect.exists { connect.tap() } else { app.buttons["重新检查连接"].firstMatch.tap() }
        XCTAssertTrue(app.staticTexts["服务：phase5-validation"].waitForExistence(timeout: 30))
        if app.navigationBars.buttons.element(boundBy: 0).exists {
            app.navigationBars.buttons.element(boundBy: 0).tap()
        }
    }
    func testPreviewCancelConfirmConflictAndRestart() async throws {
        continueAfterFailure = false
        app.launchArguments = ["-rai.serverURL", base, "-rai.privacy.amap.state", "declined", "-AppleLanguages", "(zh-Hans)", "-AppleLocale", "zh_CN"]
        app.launch()
        connectService()
        XCTAssertTrue(app.buttons["tab.今日"].waitForExistence(timeout: 15)); app.buttons["tab.今日"].tap()
        XCTAssertTrue(app.buttons["打开训练计划"].waitForExistence(timeout: 15)); app.buttons["打开训练计划"].tap()
        openEditor()
        let field = app.textFields["training.commands.date"]
        XCTAssertTrue(field.waitForExistence(timeout: 10)); field.tap(); field.typeText("2026-12-20")
        app.buttons["training.commands.preview"].tap()
        XCTAssertTrue(app.buttons["training.commands.confirm"].waitForExistence(timeout: 20)); capture("phase5-preview")
        let before = try await call("/v1/mobile/training-plan-state")
        app.buttons["training.commands.close"].firstMatch.tap()
        let cancelled = try await call("/v1/mobile/training-plan-state")
        XCTAssertEqual(before["stateRevision"] as? Int, cancelled["stateRevision"] as? Int)
        openEditor(); field.tap(); field.typeText("2026-12-20")
        app.buttons["training.commands.preview"].tap()
        XCTAssertTrue(app.buttons["training.commands.confirm"].waitForExistence(timeout: 20))
        app.buttons["training.commands.confirm"].tap()
        XCTAssertTrue(app.staticTexts["已保存并刷新。"].waitForExistence(timeout: 35)); capture("phase5-committed")
        let committed = try await call("/v1/mobile/training-plan-state")
        XCTAssertGreaterThan(try XCTUnwrap(committed["stateRevision"] as? Int), try XCTUnwrap(before["stateRevision"] as? Int))
        XCTAssertEqual((committed["raceGoal"] as? [String: Any])?["date"] as? String, "2026-12-20")
        app.buttons["training.commands.close"].firstMatch.tap(); openEditor()
        app.buttons["training.commands.preview"].tap()
        XCTAssertTrue(app.buttons["training.commands.confirm"].waitForExistence(timeout: 20))
        let scope = try XCTUnwrap(committed["scope"] as? [String: Any])
        let draft: [String: Any] = ["contractVersion":2,"operationScope":scope,"action":"pause","expectedStateRevision":committed["stateRevision"]!]
        let preview = try await call("/v1/mobile/training-plan/commands/preview", body: draft)
        var competing = draft; competing["candidateId"] = preview["candidateId"]; competing["operationId"] = UUID().uuidString
        _ = try await call("/v1/mobile/training-plan/commands", body: competing)
        app.buttons["training.commands.confirm"].tap()
        XCTAssertTrue(app.staticTexts["当前状态或候选已变化。草稿仍保留，请重读后重新预览并确认。"].waitForExistence(timeout: 20))
        capture("phase5-conflict")
        app.terminate(); app.launch()
        // The unsigned Simulator build does not guarantee Keychain persistence
        // across a process restart; re-enter the fixture credential so the
        // restart assertion tests state recovery, not signing entitlements.
        connectService()
        XCTAssertTrue(app.buttons["tab.今日"].waitForExistence(timeout: 15)); app.buttons["tab.今日"].tap()
        XCTAssertTrue(app.buttons["打开训练计划"].waitForExistence(timeout: 30)); app.buttons["打开训练计划"].tap()
        let restartedEditor = app.buttons["training.commands.open"]
        XCTAssertTrue(restartedEditor.waitForExistence(timeout: 30))
        XCTAssertTrue(waitUntilEnabled(restartedEditor), "a restarted app re-reads before enabling edits")
        capture("phase5-restart")
        let after = try await call("/v1/mobile/training-plan-state")
        XCTAssertEqual(after["runState"] as? String, "paused")
    }
    /// Opt-in synthetic schema-2 runtime; see RAI_VISUAL_SESSION_COMMANDS.
    func testSessionEditorMovePreviewSaveAndRestart() async throws {
        sessionContract = true
        continueAfterFailure = false
        app.launchArguments = ["-rai.serverURL", base, "-rai.privacy.amap.state", "declined", "-AppleLanguages", "(zh-Hans)", "-AppleLocale", "zh_CN"]
        app.launch(); connectService()
        let before = try await call("/v1/mobile/training-plan-state")
        let entities = try XCTUnwrap(before["sessions"] as? [String: Any])
        let courses = try XCTUnwrap(entities["sessions"] as? [[String: Any]])
        let today = try XCTUnwrap(before["businessDate"] as? String)
        let course = try XCTUnwrap(courses.first {
            let day = $0["prescription"] as? [String: Any]
            return (day?["localDate"] as? String ?? "") > today && ["easy", "recovery"].contains(day?["kind"] as? String ?? "")
        })
        let id = try XCTUnwrap(course["sessionId"] as? String)
        let originalDate = try XCTUnwrap((course["prescription"] as? [String: Any])?["localDate"] as? String)
        let destination = String(try XCTUnwrap(Calendar(identifier: .gregorian).date(byAdding: .day, value: 10,
            to: ISO8601DateFormatter().date(from: today + "T00:00:00Z")!)).ISO8601Format().prefix(10))
        func openPlan() {
            XCTAssertTrue(app.buttons["tab.今日"].waitForExistence(timeout: 15)); app.buttons["tab.今日"].tap()
            XCTAssertTrue(app.buttons["打开训练计划"].waitForExistence(timeout: 30)); app.buttons["打开训练计划"].tap()
        }
        func openCourse(expectedDate: String) {
            let button = app.buttons["training.session.edit." + id]
            for _ in 0..<16 { if button.exists && button.isHittable { break }; app.swipeUp() }
            XCTAssertTrue(waitUntilEnabled(button)); button.tap()
            XCTAssertTrue(app.textFields["training.session.date"].waitForExistence(timeout: 10))
            XCTAssertTrue(app.navigationBars["调整课程"].exists)
            XCTAssertEqual(app.textFields["training.session.date"].value as? String, expectedDate,
                "the first tap must initialize from the selected server course, never the empty add form")
        }
        func fillDate() {
            let field = app.textFields["training.session.date"]
            XCTAssertTrue(app.buttons["training.session.clear-date"].waitForExistence(timeout: 5))
            app.buttons["training.session.clear-date"].tap()
            let cleared = field.value as? String ?? ""
            XCTAssertTrue(cleared.isEmpty || cleared == "日期（年-月-日）")
            field.typeText(destination)
            XCTAssertEqual(field.value as? String, destination, "the complete date is replaced at every Dynamic Type size")
            XCTAssertTrue(app.buttons["training.session.done-editing"].waitForExistence(timeout: 5))
            app.buttons["training.session.done-editing"].tap()
            XCTAssertEqual(app.keyboards.count, 0, "the native keyboard completion action makes preview reachable")
        }
        func reveal(_ identifier: String) throws -> XCUIElement {
            let button = app.buttons[identifier]
            for _ in 0..<16 {
                if button.exists && button.isHittable && button.frame.midY > 115 &&
                    button.frame.midY < app.windows.firstMatch.frame.height - 34 { break }
                app.swipeUp()
            }
            let visible = try XCTUnwrap(button.waitForExistence(timeout: 15) ? button : nil,
                "the full form must remain scrollable at Accessibility XXXL")
            XCTAssertTrue(waitUntilEnabled(visible))
            return visible
        }
        openPlan(); openCourse(expectedDate: originalDate); fillDate()
        try reveal("training.session.preview").tap()
        XCTAssertEqual(app.keyboards.count, 0, "preview must dismiss the keyboard so the complete impact and save action remain visible")
        _ = try reveal("training.session.save")
        capture("session-move-preview")
        app.buttons["training.session.close"].tap()
        let cancelled = try await call("/v1/mobile/training-plan-state")
        XCTAssertEqual(cancelled["stateRevision"] as? Int, before["stateRevision"] as? Int)
        openCourse(expectedDate: originalDate); fillDate(); try reveal("training.session.preview").tap()
        try reveal("training.session.save").tap()
        XCTAssertTrue(app.staticTexts["已保存并刷新。"].waitForExistence(timeout: 40)); capture("session-move-saved")
        let committed = try await call("/v1/mobile/training-plan-state")
        let savedCourses = try XCTUnwrap((committed["sessions"] as? [String: Any])?["sessions"] as? [[String: Any]])
        let saved = try XCTUnwrap(savedCourses.first { $0["sessionId"] as? String == id })
        XCTAssertEqual((saved["prescription"] as? [String: Any])?["localDate"] as? String, destination)
        XCTAssertEqual(saved["protection"] as? String, "user_protected")
        app.terminate(); app.launch(); connectService(); openPlan(); openCourse(expectedDate: destination); capture("session-move-restart")
        XCTAssertEqual(app.textFields["training.session.date"].value as? String, destination)
        app.buttons["training.session.close"].tap()
    }


    func testExecutionConfirmRetract() async throws {
        sessionContract = true
        executionContract = true
        continueAfterFailure = false
        app.launchArguments = ["-rai.serverURL", base, "-rai.privacy.amap.state", "declined",
            "-AppleLanguages", "(zh-Hans)", "-AppleLocale", "zh_CN"]
        app.launch(); connectService()
        let before = try await call("/v1/mobile/training-plan-state")
        let entities = try XCTUnwrap(before["sessions"] as? [String: Any])
        let courses = try XCTUnwrap(entities["sessions"] as? [[String: Any]])
        let today = try XCTUnwrap(before["businessDate"] as? String)
        let course = try XCTUnwrap(courses.first {
            (($0["prescription"] as? [String: Any])?["localDate"] as? String) == today && ($0["lifecycle"] as? String) == "pending"
        })
        let id = try XCTUnwrap(course["sessionId"] as? String)
        XCTAssertTrue(app.buttons["tab.今日"].waitForExistence(timeout: 15)); app.buttons["tab.今日"].tap()
        XCTAssertTrue(app.buttons["打开训练计划"].waitForExistence(timeout: 30)); app.buttons["打开训练计划"].tap()
        let review = app.buttons["training.session.edit." + id]
        for _ in 0..<18 { if review.exists && review.isHittable { break }; app.swipeUp() }
        XCTAssertTrue(review.waitForExistence(timeout: 20), "the course row opens the combined plan/actual sheet")
        review.tap()
        let candidate = app.buttons["training.execution.candidate.visual-execution-run"]
        for _ in 0..<18 { if candidate.exists && candidate.isHittable { break }; app.swipeUp() }
        XCTAssertTrue(candidate.waitForExistence(timeout: 30), "the isolated run appears as a candidate, never auto-confirmed")
        candidate.tap()
        let confirm = app.buttons["training.execution.confirm"]
        for _ in 0..<18 { if confirm.exists && confirm.isHittable { break }; app.swipeUp() }
        XCTAssertTrue(confirm.waitForExistence(timeout: 15)); confirm.tap()
        XCTAssertTrue(app.staticTexts["关联已保存，正在重读计划与实际。"].waitForExistence(timeout: 40))
        capture("execution-confirmed")
        let confirmed = try await call("/v1/mobile/training-plan-state")
        let confirmedEntities = try XCTUnwrap(confirmed["sessions"] as? [String: Any])
        let confirmedCourses = try XCTUnwrap(confirmedEntities["sessions"] as? [[String: Any]])
        let confirmedCourse = try XCTUnwrap(confirmedCourses.first { $0["sessionId"] as? String == id })
        XCTAssertEqual(confirmedCourse["lifecycle"] as? String, "completed")
        let executions = try XCTUnwrap(confirmedEntities["executions"] as? [[String: Any]])
        let execution = try XCTUnwrap(executions.first { $0["sessionId"] as? String == id })
        XCTAssertEqual(execution["association"] as? String, "confirmed")
        XCTAssertEqual(execution["trainingSessionId"] as? String, "visual-execution-run")
        let retract = app.buttons["training.execution.retract"]
        for _ in 0..<18 { if retract.exists && retract.isHittable { break }; app.swipeUp() }
        XCTAssertTrue(retract.waitForExistence(timeout: 15)); retract.tap()
        XCTAssertTrue(app.staticTexts["撤回已保存，原完成历史仍保留。"].waitForExistence(timeout: 40))
        capture("execution-retracted")
        let after = try await call("/v1/mobile/training-plan-state")
        let afterEntities = try XCTUnwrap(after["sessions"] as? [String: Any])
        let afterCourse = try XCTUnwrap((afterEntities["sessions"] as? [[String: Any]])?.first { $0["sessionId"] as? String == id })
        XCTAssertEqual(afterCourse["lifecycle"] as? String, "pending")
        let afterExecution = try XCTUnwrap((afterEntities["executions"] as? [[String: Any]])?.first { $0["sessionId"] as? String == id })
        XCTAssertEqual(afterExecution["association"] as? String, "invalidated")
        app.buttons["training.session.close"].tap()
    }

}
