# RAI Figma High-Fidelity UI Specification

> Privacy: this specification contains private Health-derived sample values. Keep the Figma file private. Before sharing outside the personal workspace, duplicate it and replace all dates, route paths, values, model IDs, and import history with synthetic data.

## 1. Product Frame

### 1.1 Scope

This is a high-fidelity Figma specification for the local-first RAI Web workspace. It covers desktop at 1440 px and a responsive narrow layout at 390 px. It does not create a Web project, API, mobile app, Figma cloud file, or scoring behavior.

The active algorithm is frozen at `rai-model-config-v2`. UI consumes stored active assessments and snapshots; it must never calculate CA, TA, GV, confidence, quality, eligibility, dates, or explanations in the presentation layer.

### 1.2 Figma File Structure

Create these pages in this order:

1. `00 Cover & Privacy`: title, private-data warning, active model version, prototype entry links.
2. `01 Foundations`: color, typography, spacing, elevation, layout grids, chart conventions, content rules.
3. `02 Components`: components and variants described in section 3.
4. `03 Desktop`: all 1440 px desktop frames and overlays.
5. `04 Responsive`: all 390 px responsive frames and overlays.
6. `05 Prototype`: duplicate linked frames only, with annotations hidden from presentation.

Use a 1440 x 1024 desktop frame and a 390 x 844 narrow frame. Desktop uses a 12-column content grid: 64 px outer margin, 24 px gutter, 98 px columns. Narrow uses a 4-column grid: 20 px outer margin, 12 px gutter, 81.5 px columns.

### 1.3 Real Private Sample Set

Use the following imported-data samples consistently. Do not invent a score or explanation that is absent from the stored assessment.

| Usage | Local date | Data to show |
|---|---|---|
| Dashboard active state | 2026-07-10 | TA `46.56`, GV `-0.02 / 周`, active `rai-model-config-v2` |
| Latest run detail | 2026-07-08 | 4.28 km, 28:15, 6'36"/km, 168 bpm, interval, CA `38.99`, confidence `0.93`, TA `46.63 -> 46.56` |
| Latest run dimensions | 2026-07-08 | Efficiency `35`, Pace `48`, Cardio diagnostic `33`, Stability `34`, Recovery `35` |
| Latest run quality | 2026-07-08 | Heart-rate coverage `99.8%`, route quality `0.95`, route available, explanations: efficiency below baseline, stability below baseline, recovery low, fatigue-protected update |
| Route-unavailable detail | 2026-06-09 | 5.04 km, 30:17, 6'01"/km, 173 bpm, CA `43.26`, confidence `0.74`, route unavailable, score remains eligible |
| Completed recompute | Current dataset | `252 / 252`, status succeeded, latest active model `rai-model-config-v2` |

All sample data comes from current active views and assessments. Route imagery may use the actual local route path only in this private file; it must not contain a public map tile, street address, or location label.

## 2. Foundations

### 2.1 Color Variables

Use Figma variables with semantic names. Do not use gradients, decorative orbs, or color as the only status signal.

| Variable | Hex | Use |
|---|---|---|
| `surface/canvas` | `#F3F5F2` | App background |
| `surface/raised` | `#FFFFFF` | Tools, tables, drawers, modals |
| `surface/subtle` | `#E8ECE8` | Selected or chart support surface |
| `ink/primary` | `#17211E` | Main text and icons |
| `ink/secondary` | `#63706A` | Supporting text |
| `ink/disabled` | `#98A29D` | Disabled controls |
| `line/default` | `#D8DFDA` | Dividers and control borders |
| `rai/true-ability` | `#147A5B` | TA line and stable positive state |
| `rai/current-ability` | `#D86452` | CA points and latest-performance state |
| `status/warning` | `#B96F18` | Decay, calibration, caution |
| `status/danger` | `#B6403D` | Excluded, failed, destructive action |
| `status/info` | `#2A6FA8` | Route/data diagnostics and informational state |

### 2.2 Typography and Layout

- UI body: `PingFang SC`; metrics and chart axes: `Inter` with tabular figures.
- Type scale: 12, 14, 16, 20, 24, 32, 48 px. Use 48 only for the dashboard TA. Use letter spacing `0` throughout.
- Spacing tokens: 4, 8, 12, 16, 24, 32, 40, 48 px.
- Radius: 6 px for every tool, table, input, modal, and chart frame. Do not nest cards inside cards.
- Shadows: only drawers and modals use `0 12 32 / 16%` graphite. Page sections use dividers and grid alignment instead of floating cards.
- Buttons with a familiar tool action are icon buttons with a tooltip. Text buttons are reserved for import, create override, confirm, and destructive commands.

### 2.3 Data Visualization Rules

- TA is a 2 px green line. CA is a 7 px coral point. Never join CA points with a line.
- Decay periods use a faint amber vertical band and a labeled event marker; they are never drawn as a training-caused slope.
- Low confidence CA is an outlined coral point. Trial and excluded runs are not plotted as CA.
- Model changes use a vertical dashed line and compact version label. Do not join points from different model runs into one implied continuous CA series.
- Charts use neutral axes and sparse horizontal grid lines. Every non-obvious mark has an inspect tooltip.
- `Cardio` is a gray diagnostic bar with the label `诊断，不参与 CA`; it never appears in the CA legend or effective weight chart.

## 3. Component Library

Build all components with Auto Layout, 8 px spacing increments, and named variants.

| Component | Required variants and behavior |
|---|---|
| `Navigation / Desktop` | Expanded and compact; active item; Overview, Training, Trends, Data & Model; settings icon at the footer |
| `Navigation / Mobile` | Bottom navigation with four icons and labels; selected state; settings accessed from Data & Model |
| `Button` | Primary, secondary, destructive, icon, disabled, loading; tooltips on icon-only buttons |
| `Status Badge` | Active, calibrating, decay, eligible, trial, excluded, low confidence, succeeded, running, failed; icon plus text |
| `Metric` | Label, metric, unit, secondary delta, optional status glyph; fixed-height variants for dashboard and table |
| `Segmented Control` | Default, selected, disabled; used for time ranges and data filters |
| `Filter` | Date range, eligibility, training type, confidence; clear-all state and active-count badge |
| `Run Row` | Desktop table row and narrow list item; selected, low confidence, trial, excluded, route unavailable |
| `Dimension Bar` | Scored, unavailable, diagnostic; value, effective weight when applicable, source hint, tooltip |
| `Quality Tag` | Heart-rate, route, source, session ambiguity, recovery context; high/medium/low/absent |
| `Job Progress` | Queued, running, succeeded, failed, cancelled; phase, current/total, last message, cancel action |
| `Drawer / Override` | Default, validation error, dirty, submitting, queued-after-submit; 480 px desktop width and full-screen narrow variant |
| `Modal / Confirm` | Destructive delete and recompute confirmation; requires explicit primary or destructive confirmation |
| `Chart Tooltip` | Date, CA, TA, confidence, assessment status, model version; click-through action when associated with a run |

## 4. Desktop Frames

### 4.1 Shared Shell

Use a fixed 224 px left navigation rail, a 56 px top utility row, and a scrollable main canvas. The wordmark `RAI` is large enough to be visible in the first viewport. The top row contains the active model version, current local-data status, and an `导入更新` command. Never label this command `同步`.

### 4.2 Overview

Create five variants using the same shell.

| Variant | Main content | Required interaction |
|---|---|---|
| Normal | TA `46.56`, GV `-0.02 / 周`, latest CA `38.99`, explanation strip, four-week TA/CA preview, recent runs | Time-range change; click latest run or chart point to open detail |
| Calibrating | Progress against 6 sessions and 14 days; no default score or 50-point line | Open Training to inspect accepted and trial runs |
| Decay | TA with amber `Decay` label, days since eligible run, no implication that a run caused loss | Open Trends pre-filtered to the decay segment |
| Recompute running | Keep prior active metrics visible; job progress appears in persistent utility strip | Open Data & Model job detail |
| Empty | Import panel, accepted export formats, local-only privacy statement | Select import file or open Data & Model |

The normal overview contains one unframed metric band, one 8-column trend panel, one 4-column latest-run panel, and a full-width recent-run table. Do not place a section inside another card.

### 4.3 Training

Create a full list frame and a filtered frame. The list has date, training type, distance, pace, heart rate, CA, confidence, status, route availability, and disclosure action. Use source quality only as a tooltip/detail field, not as a primary table column.

Filters: time range, eligibility, training type, confidence, and route availability. Apply filters instantly to the visual data set, display the active filter count, and retain the active row when navigating back from detail.

### 4.4 Run Detail

Create three variants: `route available`, `route unavailable`, and `trial/excluded`.

The route-available frame uses the latest 2026-07-08 sample. Top metrics show 4.28 km, 28:15, 6'36"/km, 168 bpm. Below that, use a full-width route trace on a neutral local-coordinate plane, not a public street map. The assessment panel shows CA `38.99`, confidence `0.93`, TA `46.63 -> 46.56`, and a small protected-negative-update explanation.

Dimension bars display Efficiency 35, Pace 48, Stability 34, Recovery 35, and a separate Cardio diagnostic 33. Effective weights are shown only for the four CA dimensions. The Cardio row must read `诊断，不参与 CA`.

The route-unavailable variant keeps the assessment and quality sections, replacing the route canvas with the route-missing reason and a quality tag. The trial/excluded variant replaces CA/TA updates with an eligibility explanation and leaves source metrics visible.

`编辑训练覆盖` opens the right-side drawer. Fields are: include/exclude control, training type menu, RPE 1–10 stepper, status tag multi-select, note field, cancel, save. Saving shows validation, then a queued recompute state; active scores remain unchanged until the new run becomes active.

### 4.5 Trends

Create normal, low-confidence, model-change, decay, and no-data variants. Desktop normal state has an 8-column primary chart and a 4-column insight rail. Range controls: 4 weeks, 12 weeks, 6 months, all. A point tooltip shows stored CA, TA, confidence, assessment status, and model version. Clicking an eligible CA point opens its training detail.

The insight rail shows current GV, the active model version, latest data-quality summary, and dimension distribution summaries. It must describe Recovery as state context and Cardio as diagnostic only.

### 4.6 Data & Model

Use three unframed bands: Import, Tasks, and Model History.

- Import: local Apple Health export file selection, import requirements, parse status, issue count, and privacy statement.
- Tasks: current job progress plus completed jobs. A running job exposes cancel; a failed job exposes error detail and retry; succeeded shows `252 / 252` style progress.
- Model history: active run marker, version, evaluation time, status, assessment count, snapshot count, and comparison selection. Comparison charts show only stored run outputs and clearly label version boundaries.

### 4.7 Settings

Provide local preferences, timezone display, export/backup command, restore entry point, and destructive local-data deletion. Local data deletion always opens a destructive confirmation modal and never shares or uploads data.

## 5. Responsive Frames

Create narrow equivalents for Overview, Training, Run Detail, Trends, Data & Model, and the Override drawer.

- Replace the left rail with a fixed bottom navigation. Preserve a 16 px safe area above it.
- Use full-width content with 20 px margins. Metric bands wrap into two columns without changing metric height.
- Replace training tables with compact list items: date/type, distance/pace, CA/confidence, and status; route state is an icon with tooltip-equivalent inline text on tap.
- Run Detail becomes a single column: metrics, route/route-missing, assessment, dimensions, quality, explanation, override command.
- Trends keeps fixed chart height and allows the inspected tooltip to anchor inside the viewport; range controls remain horizontally scrollable but never truncate their labels.
- Data & Model stacks import, current task, history, and settings. The override drawer becomes a full-screen modal sheet.

## 6. Prototype Connections

Connect the following in `05 Prototype`:

1. Overview nav to Training, Trends, Data & Model; narrow bottom navigation mirrors the same destinations.
2. Overview latest run and chart point to Run Detail; Training row to the same detail; back preserves filters and scroll position.
3. Trends range controls change visible chart state; point hover/tap opens tooltip; eligible point click opens detail.
4. `编辑训练覆盖` opens drawer; validation error prevents save; valid save opens queued recompute state; task completion transitions to refreshed active model state.
5. `导入更新` opens local import flow; selected file transitions to queued, parsing, canonicalizing, recomputing, succeeded, and failed frames.
6. Data & Model model picker toggles comparison state; no comparison is shown unless both selected runs are successful.
7. Settings deletion opens confirmation then empty-data overview only after success.

## 7. Data Contract and Content Rules

| UI area | Stored source | Rendering rule |
|---|---|---|
| TA, GV, decay state | `active_daily_ability_snapshots` | Render stored values and local date only |
| Latest CA, dimensions, confidence, explanation | `active_ability_assessments` plus `workout_features` | Use the active assessment; do not recompute dimension scores |
| Route and quality | `workout_features`, route data | Show availability and stored quality; no inferred route quality |
| Filters and list labels | Training Session, Feature, Assessment | Filter server/query results; no client-side eligibility inference |
| Overrides | `workout_overrides`, recompute job | Append revision, then reflect job and active-run transition |
| Import/recompute progress | `recompute_jobs`, `recompute_job_events` | Render phase, count, status, and stored message |
| Model history | `model_runs`, Feature Run, snapshots | Successful runs are selectable; only active run drives normal product pages |

Use Chinese copy. Explain missing or excluded data directly instead of blanking the area. Never call CA `真实跑力`; CA is `即时跑力`, TA is `真实跑力`.

## 8. Figma QA Checklist

- Every component is an Auto Layout component with default, hover, focus, disabled, loading, and error variants where applicable.
- Desktop and narrow frames contain no clipping, overlaps, hard-to-tap controls, or text resizing caused by dynamic content.
- All five overview states, three detail states, trends states, job states, and destructive confirmation state have a dedicated frame.
- All CA/TA, confidence, status, explanation, Cardio diagnostic, and model labels match the existing contracts and active data semantics.
- Every icon-only action has a tooltip in desktop and an accessible text alternative in narrow layouts.
- Charts distinguish CA, TA, Decay, low confidence, and model-version transitions without relying on color alone.
- The cover states `Private Health Data`; a redacted duplicate must be created before any external sharing.
