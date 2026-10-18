# Development Scope

## Supported Product

This repository develops the native iOS application in `apps/ios` and the
Node.js API / shared algorithm packages it uses (`apps/api`, `packages/*`).

The browser-based SPA that used to live in `apps/web`, and the macOS platform
support inside the Xcode project, were retired on 2026-10-17 by product
decision. See [DECISIONS](docs/DECISIONS.md) D17 and
[ADR-006](docs/adr/ADR-006-retire-web-and-macos.md). Do not recreate a browser
client, a WebView shell, or a macOS/desktop target.

Native desktop applications and non-iOS mobile applications are out of scope.
Do not create or modify Electron, Tauri, React Native, Flutter, Android,
macOS, or Windows client projects unless the user explicitly requests it.

`apps/ios` is the only client. Its production path is SwiftUI native and it
uses the existing Node.js API for read/write business flows. There is no
WKWebView path and no macOS destination any more; the API is reached directly
over HTTPS with a Bearer token. HealthKit read-only sync is authorized: the iOS
app may request Apple Health read permission, export running-related samples to
the existing Apple Health ZIP/XML import pipeline, and upload them to the API.
"Read-only" here refers to **health samples and records**: scheduling workouts
to Apple Watch through WorkoutKit requires workout-type HealthKit write
authorization (`NSHealthUpdateUsageDescription`). That authorization covers the
workout schedule only — the app must not write or modify health samples/records.
Do not rewrite the TypeScript scoring core on device, and do not add HealthKit
write of health samples/records, or a standalone Watch/macOS/mobile product
unless the user explicitly asks. HealthKit background delivery, BGProcessingTask,
and a background URLSession are authorized for the iOS health sync pipeline
(2026-09-22 product decision); any further background mechanism still requires
explicit user request.

The API keeps every `/v1` route that existed before the retirement, including
routes that were only consumed by the retired Web SPA (backups, model and
prediction management, data operations, audit, import administration,
performance entries, privacy zones). Removing those endpoints is a separate
product decision, not part of the Web retirement.

## Default Verification

Choose checks proportionate to the change. For ordinary API / package work:

- `npm run typecheck`
- `npm test` — on a multi-core or busy host prefer `RAI_TEST_CONCURRENCY=2 npm test`
  (see the `scripts/run-tests.mjs` header: the default concurrency is the host's
  parallelism, and the 5 s / 30 s wall-clock budgets in the heavy suites can fail
  spuriously under load). A release record must state the concurrency used.
- `npm run check:docs` when README, AGENTS, or anything under `docs/` changes
- `npm run check:acceptance-matrix` when tests or `docs/ALGORITHM.md` change
- `npm run smoke:api` when server startup or `deploy/` changes

For iOS work under `apps/ios`, use:

- `npm run test:ios` — type-checks every iOS source and runs the pure-logic
  regressions. On a host without Xcode it skips loudly ("no iOS source was
  checked") instead of passing quietly. The pre-commit hook runs it whenever
  paths under `apps/ios/` are staged.
- Simulator-bound acceptance (`apps/ios/tests/run-visual-tests.sh`) and the AMap
  coordinate cross-check stay manual; they need a booted Simulator and, for the
  former, `var/rai.sqlite`.

For `deploy/` template changes, `npm test` covers the text-contract tests
(`deploy-cloud`, `deploy-n100`, `deploy-upgrade`); `nginx -t` and
`systemctl daemon-reload` belong to the server runbook
([operations](docs/OPERATIONS.md)).

## Retired Surfaces

Do not reintroduce any of the following without a new explicit product decision:

- `apps/web`, React/Vite/Vitest/Playwright, `npm run build`, `test:e2e:*`,
  `scripts/check-web-build.mjs`, or a `@rai/web` workspace.
- The macOS destination in `apps/ios/RAI.xcodeproj`, `AppWebView.swift`, the
  `#if os(macOS)` branches, or any WebKit import under `apps/ios/RAI/`.
- A browser fallback served by the API: the API has no static file hosting.
- `RAI_WEB_PORT` / `RAI_ALLOW_LAN_DEV`: local device debugging now starts the
  API only (`npm run dev:device`) and requires a dev `RAI_API_TOKEN`.

## Cross-Platform Command Rules

This repository is developed on Windows and built on macOS, so every npm script
must behave identically under cmd, PowerShell and bash. Three hard rules, checked
by `npm run check:scripts` (also wired into `.githooks/pre-commit`):

- npm script bodies may only use `&&`, a plain command, or `node xxx.mjs`.
  Never `;`, `$?`, `$VAR`, `VAR=x cmd`, `test`, `[ ]`, `uname`, or a glob `*`
  that needs shell expansion.
- Platform detection lives inside the script: `process.platform` in Node,
  `uname -s` in bash. A host that cannot run the check must skip loudly
  ("no iOS source was checked") and exit 0 — never fail, never pass quietly.
- Prefer `.mjs`; keep `.sh` only for what must run on macOS. Invoke shell
  scripts as `bash <path>`, never `./x.sh` (Windows git does not record `+x`).
  Never use WSL or Git Bash to imitate macOS: `xcodebuild`, CocoaPods and the
  Simulator run on macOS only.

Do not rely on filename case: Windows and macOS are both case-insensitive, so a
mismatch stays silent on both ends. `.gitattributes` pins `*.sh`, `*.py`,
`*.swift` and `*.pbxproj` to LF; verify with `git ls-files --eol` (`i/lf w/lf`)
instead of assuming.
