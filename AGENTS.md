# Development Scope

## Supported Product

This repository develops the browser-based Web application in `apps/web`, the
API/shared packages required by it, and the explicitly requested native iOS
debug host in `apps/ios`.

Native mobile applications and native desktop applications are out of scope.
Do not create or modify Electron, Tauri, React Native, Flutter, iOS, Android,
macOS, or Windows client projects unless the user explicitly requests it.

`apps/ios` is an explicitly requested local Xcode iOS application. Its
production path is SwiftUI native and it may use the existing Node.js API for
read/write business flows. The former WKWebView shell remains only as a
development fallback until native acceptance is complete. HealthKit read-only
sync is authorized: the iOS app may request Apple Health read permission,
export running-related samples to the existing Apple Health ZIP/XML import
pipeline, and upload them to the local API. Do not rewrite the TypeScript
scoring core on device, and do not add HealthKit write, background delivery,
or a standalone Watch/macOS/mobile product unless the user explicitly asks.

## Supported Web Viewport

The actively supported experience is desktop browser Web:

- Primary verification viewport: 1440 x 900.
- Minimum actively supported width: 1024px.
- Target browsers: current Chrome and Edge.

Existing behavior below 1024px is frozen compatibility code. Preserve it, but
do not extend, redesign, or optimize it unless the user explicitly puts narrow
or responsive layouts in scope.

Unless the user explicitly requests responsive or narrow-screen work:

- Do not add or modify native mobile or native desktop client behavior.
- Do not modify CSS media queries targeting widths below 1024px.
- Do not modify mobile navigation or mobile-only components.
- Do not add mobile viewport tests, screenshots, or visual baselines.
- Do not run responsive or mobile-specific E2E tests.
- Do not treat mobile-browser polish as an implicit acceptance criterion.
- Preserve existing narrow-screen behavior when changing shared Web code.

## Frozen Responsive Areas

Do not modify these areas without explicit user authorization:

- `mobileNavigation` in `apps/web/src/App.tsx`.
- `.mobile-nav-links` and `.workout-mobile-list` behavior.
- Media-query rules below 1024px in `apps/web/src/styles.css`.
- The 390px E2E coverage in `apps/web/e2e/web-flows.test.ts`.

> 断点实况（供措辞统一，不改变冻结范围）：styles.css 中 <1024px 冻结的媒体查询为
> `@media (max-width: 820px)`（820px 以下切底部导航 / mobile-nav-links / 紧凑列表）
> 与 `@media (max-width: 480px)`（细节微调）；`@media (max-width: 1180px)` 段不在
> 窄屏冻结之列，但桌面 1024–1180px 宽度依赖它，改动必须走桌面回归（e2e:web）。

## Default Verification

Choose checks proportionate to the change. For ordinary Web work, use:

- `npm run typecheck`
- `npm test`
- `npm run build`
- `npm run test:e2e:web` when browser-flow verification is warranted

Do not run `npm run test:e2e:responsive` or the full `npm run test:e2e` unless
the user explicitly requests responsive coverage or the task directly changes
frozen responsive code.

