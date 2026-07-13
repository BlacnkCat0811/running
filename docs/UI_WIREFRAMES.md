# RAI UI Information Architecture and Low-Fidelity Wireframes

The high-fidelity Figma build specification is in [FIGMA_HIFI_SPEC.md](FIGMA_HIFI_SPEC.md). This document preserves the information hierarchy and state coverage that every high-fidelity frame must retain.

## 1. Navigation and Data Boundary

Desktop navigation:

```text
RAI
  Overview
  Training
  Trends
  Data & Model

  Settings
```

Narrow layouts use the first four destinations in bottom navigation. Settings lives inside Data & Model on narrow screens.

All pages render stored active views and job state. The UI never calculates score values, eligibility, date normalization, confidence, or route quality. `即时跑力` means CA. `真实跑力` means TA. Cardio is always labeled `诊断，不参与 CA` in V1.

## 2. Overview

```text
┌──────────────────────────────────────────────────────────────────────┐
│ RAI / Overview                                      v2  导入更新      │
├───────────────┬──────────────────────────────────────────────────────┤
│ Navigation    │ 真实跑力  46.56          成长速度  -0.02 / 周         │
│               │ 最新训练  CA 38.99  高置信  TA 46.63 -> 46.56        │
│               │ [效率低于基准] [稳定性偏低] [恢复偏低]                 │
│               │                                                      │
│               │ TA line / CA points / Decay bands                    │
│               │                                                      │
│               │ 最近训练                                               │
└───────────────┴──────────────────────────────────────────────────────┘
```

Required variants: empty data, calibrating, active, decay, recompute running. Recompute keeps the previous active result visible and exposes progress; it never shows a temporary or calculated score.

## 3. Training and Detail

```text
Training
[All time] [Eligibility] [Type] [Confidence] [Route]       Clear filters

Date        Type       Distance  Pace     CA     Confidence  Status
2026-07-08  Interval   4.28 km   6'36"    38.99  High        Eligible  >

Run detail
4.28 km     28:15      6'36"/km  168 bpm
[Route trace or route unavailable reason]

Instant ability 38.99   Confidence 0.93   True ability 46.63 -> 46.56
Efficiency 35    Pace 48      Stability 34    Recovery 35
Cardio diagnostic 33                                      Not in CA

Data quality: HR coverage 99.8% / Route quality 0.95
Explanation: efficiency below baseline; low recovery protects negative update

[Edit training override]
```

Required details: route available, route unavailable, trial, excluded, low confidence, and override drawer. A missing route never hides the assessment or data-quality section.

## 4. Trends

```text
Trends                       [4 weeks] [12 weeks] [6 months] [All]

90 ┤              o CA
70 ┤       |      --- TA
50 ┤       |  Decay band
   └────────────────────────────────────
          model version marker

Growth velocity     Active model     Recovery context     Cardio diagnostic
```

CA points are inspectable and link to the associated run. TA stays a continuous stored snapshot line. Low-confidence points, model transitions, and decay are visually distinct.

## 5. Data, Model, and Settings

```text
Data & Model
Import Apple Health export      [Choose local file]

Tasks
Full recompute                  Completed    252 / 252

Model history
Active  rai-model-config-v2     Successful   Compare

Settings
Timezone / Backup / Restore / Delete local data
```

All imports are local. The Web version says `导入更新`, never `同步 Apple Health`. Deletion requires explicit confirmation. Model comparison only allows successful runs and never replaces the active model from the UI.

## 6. Narrow Layout Rules

- Use a bottom navigation and a single-column content flow.
- Training tables become compact list rows while retaining CA, confidence, and status.
- Override editing is a full-screen sheet.
- Charts keep clear axes and inspectable points; controls may scroll horizontally but labels never truncate.
- All empty, calibrating, decay, recompute, trial, excluded, route-unavailable, and failed-job states remain visible in the narrow design.
