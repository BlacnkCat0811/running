# ADR-006: Retire the Web SPA and the macOS Shell

- Status: Accepted
- Date: 2026-10-17
- Scope: Client topology, repository scope, deployment of this repository

## Context

The repository used to ship three client surfaces from one tree: a browser SPA
in `apps/web`, a SwiftUI iOS application in `apps/ios`, and the same Xcode
project also built a macOS destination whose UI was a WKWebView shell
(`AppWebView.swift`, `RootView.swift`'s `#else` branch).

The iOS application has long been the production client: it enters
`NativeRootView` and never loads the WKWebView shell. The Web SPA was kept for
desktop browser inspection and for a handful of operations that only existed
there (backup restore, performance entry, privacy zone editing, model and
prediction management). The API already serves every `/v1` route the iOS app
uses, and the deployment only needed the SPA's `dist` for browsers.

Keeping both surfaces forces every shared change through three clients, keeps
Playwright/React/Vite in the gate set, and pins the API to a static-file
hosting mode it does not need. The product decision on 2026-10-17 is to
retire the browser client and the macOS destination and keep exactly two
deliverables: the native iOS app and the API it talks to.

## Decision

1. Remove the `apps/web` workspace (92 tracked files), its build/test/E2E
   scripts, and its toolchain dependencies (React, Vite, Vitest, jsdom,
   Playwright, concurrently).
2. Remove the macOS destination from `apps/ios/RAI.xcodeproj`
   (`SUPPORTED_PLATFORMS`, `MACOSX_DEPLOYMENT_TARGET`, macOS-only build
   settings) and delete the dual-platform WKWebView shell
   (`AppWebView.swift`, its bridge state, and the macOS branch of
   `RootView.swift`). `ChromeController` is removed with it: on iOS nothing
   set its `showSettings` flag after the macOS toolbar went away.
3. The API stops hosting static files: `web-assets.ts`, the
   `@fastify/static` dependency and the `existsSync(webDist)` wiring are
   removed. Nginx becomes a pure `/v1` reverse proxy; the site root returns
   `404`.
4. Every `/v1` route is kept, including the 36 routes that only the Web SPA
   used. Endpoint pruning is a separate product decision with test, schema and
   OpenAPI coupling (see the retirement plan's optional B7 batch).
5. `npm run dev:device` starts the API only. Because native clients send no
   `Origin` header and the API's local request guard only trusts loopback
   `Host` values when no token is configured, the dev script injects a dev
   `RAI_API_TOKEN` and prints it together with the LAN address.

## Consequences

- iOS is the only product client; the repository has one UI to verify and one
  gate set to keep green.
- The only browser-level E2E suite (`apps/web/e2e/web-flows.test.ts`, 1973
  lines) is gone. Backend semantics it covered must be re-established as
  API-level `node --test` cases or accepted as manual checks; the retirement
  plan tracks this as a follow-up (D7).
- Backup restore, performance entry and privacy-zone editing have no native
  entry point. Restore is documented as an operator curl flow in
  `docs/OPERATIONS.md`; the other two are accepted gaps listed in the plan's
  follow-up section.
- The deployment runbook changes: no frontend build step, no `apps/web/dist`,
  and `nginx -t` plus the API health endpoint become the release gate.
- Rollback is a git revert of the retirement batches, plus restoring the
  backed-up nginx/systemd files. The database schema is untouched.
