# Development Scope

## Supported Product

This repository currently develops only the browser-based Web application in
`apps/web` and the API and shared packages required by that application.

Native mobile applications and native desktop applications are out of scope.
Do not create or modify Electron, Tauri, React Native, Flutter, iOS, Android,
macOS, or Windows client projects unless the user explicitly requests it.

`apps/ios` is an explicitly requested local Xcode debug host: a WKWebView
shell that loads the existing Web app on an iPhone or Mac. HealthKit
read-only sync is authorized: the iOS shell may request Apple Health read
permission, export running-related samples to the existing Apple Health
ZIP/XML import pipeline, and upload them to the local API. Do not rewrite
the TypeScript scoring core on device, and do not add HealthKit write,
background delivery, or a standalone mobile product unless the user
explicitly asks.

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

## Default Verification

Choose checks proportionate to the change. For ordinary Web work, use:

- `npm run typecheck`
- `npm test`
- `npm run build`
- `npm run test:e2e:web` when browser-flow verification is warranted

Do not run `npm run test:e2e:responsive` or the full `npm run test:e2e` unless
the user explicitly requests responsive coverage or the task directly changes
frozen responsive code.

