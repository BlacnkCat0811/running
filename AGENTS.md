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

"Still mounted" does not always mean "still callable": two capability groups
were retired later by their own product decisions and now answer `410 Gone`
with a stable code (`legacy_surface_retired` or `*_retired`). Do not treat them
as working features or route new clients to them:

- the legacy training-plan write surface (`/v1/mobile/goals`, `/v1/mobile/run-coach`,
  `/v1/mobile/workout-plan/{preview,confirm,generate}`) — replaced by the
  unified plan v2 endpoints documented in
  [IOS_NATIVE_API_CONTRACT](docs/IOS_NATIVE_API_CONTRACT.md) (decision D19);
- backup creation/deletion (`POST /v1/backups`, `DELETE /v1/backups/:name`) —
  backups are an operator responsibility (decision D18).

A stale client must be able to tell `410` from `404`; see
[DECISIONS](docs/DECISIONS.md) D18/D19 and the retirement matrix in the API contract.

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
  regressions, including the cross-platform `apps/ios/tests/check-*.py` source
  gates in the aggregate chain (gates excluded by design run only through their
  explicit manual entry). On a host without Xcode it skips loudly ("no iOS
  source was checked") instead of passing quietly. The pre-commit hook runs it
  whenever paths under `apps/ios/` are staged.
- `npm run check:ios-gates` — runs the cross-platform source gates directly
  (no Xcode needed, so it works on Windows/Linux too). It also fails when a
  non-excluded gate is not referenced by any `apps/ios/tests/run-*.sh`
  ("judgement exists ≠ judgement executes"). The pre-commit hook runs it when
  `apps/ios`, `packages/api-contracts`, or `packages/contracts` changes.
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

Official environments are macOS development/iOS builds and Linux production/backend CI.
Windows is no longer a supported CI platform (2026-10-25); existing portable
wrappers and platform-specific regression cases remain. Every npm script must
still behave identically under cmd, PowerShell and bash. Three hard rules, checked
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
