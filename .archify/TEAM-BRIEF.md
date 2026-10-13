# RAI architecture visualization — shared team brief

READ THIS FULLY BEFORE DOING ANYTHING.

## Mission

Produce Archify diagrams that visualize the **actual, current implementation** of the RAI  
project at `D:\running`. This is a **read-only audit**. The source code is the only  
authority for every claim you put in a diagram.

## Hard constraints (violating any of these fails the task)

1. **DO NOT modify, create, move, or delete any file** under `D:\running` except:
   - your own candidate JSON and HTML inside your assigned `.archify/rai-audit-*/` folder, and
   - nothing else. Never edit `docs/`, `apps/`, `packages/`, `crates/`, `scripts/`, `var/`,  
     `package.json`, or any existing file.
2. **DO NOT** install dependencies, run migrations, run `npm test`/`npm run build`/`npm run dev`,  
   start the API, or write to any SQLite file. Read-only commands only (`read`, `grep`, `glob`,  
   `git log`, `git show`, `node -e` that only prints).
3. **DO NOT** trust `docs/ARCHITECTURE.md`, `README.md`, or any design doc as truth. They are  
   *claims*. Where a doc and the source disagree, the source wins and you note the difference.
4. Every component and every meaningful relationship in your candidate needs a real  
   `sources` entry: repository-relative `path` + inclusive `line` (optional `end_line`) that you  
   **actually opened and read**. Do not cite a file you did not read. Do not cite line numbers  
   you guessed.
5. Mark uncertain things honestly. If something is not provable from source, either leave it out  
   of the drawing or state it in a card as an explicit unknown. **Never draw a planned or  
   documented-but-absent feature as implemented.**

## Repository identity (use verbatim in `meta.repository`)

```json
"repository": { "url": "https://gitee.com/tpandmr/running.git", "provider": "gitee", "revision": "60678af97e4710cfd8444b3952df9fff09c2bff3" }
```

Worktree is clean at that revision (`git status --short` empty). If you cite a file, it is  
committed bytes.

## Archify usage (exact commands)

Skill base (call it `$ARCH` below):  
`C:\Users\Administrator\.dsh\profiles\desktop\node_modules\@tt-a1i\archify-dsh\skills\archify`

Read, in this order, before authoring:

- `$ARCH\references\authoring-defaults.md`
- `$ARCH\references\repository-authoring.md`
- the schema for your diagram type in `$ARCH\schemas\`
- one matching example in `$ARCH\examples\`

Run every command from the working directory `D:\running`.

```bash
node "C:\Users\Administrator\.dsh\profiles\desktop\node_modules\@tt-a1i\archify-dsh\skills\archify\bin\archify.mjs" finalize <type> <candidate.json> <output.html> --repo-root . --quality showcase --json
```

Write your candidate at  
`.archify/rai-audit-20261013-160439/<your-folder>/candidate.json`  
and set `meta.output` to `.archify/rai-audit-20261013-160439/<your-folder>/<name>.html`  
(POSIX separators, forward slashes, must end in `.html`).

Your folder name is given in your task. **Do not write into another member's folder.**

`finalize` is the only gate you need to run. It runs showcase validation, delivery, strict  
`check`, and a real-browser `browser-check`. A non-zero exit is **never** success: read the  
compact receipt, fix the candidate, rerun the *complete* finalize command. Preserve requested  
meaning and source evidence while repairing. Concurrent `finalize` runs in different folders  
are safe and expected.

## Authoring requirements for this audit

- **Language:** Simplified Chinese (`"locale": "zh-CN"`). Keep exact code identifiers, file  
  paths, table names, endpoint paths, status strings, and product names in their original form.  
  Localize only the surrounding explanation.
- **`"quality_profile": "showcase"`** in every candidate.
- **8–12 core components** where the diagram type has components/participants/nodes. Prefer  
  fewer, denser component cards over more, sparser boxes. Put detail in `sublabel`, `tag`, and  
  the `cards` section — not in long node labels.
- Label every meaningful relationship with its real action / protocol / direction (e.g.  
  `POST /api/import`, `BEGIN IMMEDIATE`, `读 candidate`, `原子 rename`). Mark asynchronous,  
  read-only, and failure paths distinctly with `variant` (`dashed`, `security`, `emphasis`).
- Mark the **trust boundary** and the **persistence boundary** where the type supports  
  `boundaries` (architecture: `kind: "region"` or `"security-group"` only).
- Every card list item must be a claim you can defend from source. No marketing language.

## What is already verified (you may rely on this, but re-read the file if you build on it)

Verified by the Lead by direct reading:

- Monorepo, npm workspaces `packages/*` + `apps/*`; root `package.json` (`D:\running\package.json`).
- `apps/api` is a Fastify server (`apps/api/src/server.ts`), ~85 source files.
- **Single-writer discipline is real and central:**
  - `apps/api/src/mutation-coordinator.ts` — `MutationCoordinator.acquire()` throws  
    `MutationConflictError` (HTTP 409, code `mutation_conflict`) when another write operation  
    is active. One writer at a time, in-process.
  - `apps/api/src/task-admission.ts` — `TaskAdmissionScheduler` allows exactly one CPU-heavy  
    writer across all executors, FIFO by `waiting` set, with `acquireControl` pinning an active  
    owner and `blockUntilRestart`.
  - `apps/api/src/command-queue.ts` — durable write-command queue in the **runtime** SQLite  
    (`mutation_commands` table, `RuntimeStateStore.path`), idempotency key = sha256 of  
    `[scope, idempotencyKey]`, request fingerprint = sha256 of canonical `{kind, payload}`,  
    capacity 16 pending, exponential backoff up to 30 s, statuses  
    `queued|running|succeeded|failed|cancelled`. `applyMutationCommand()` opens the **main** DB and wraps effect + idempotency receipt in ONE `BEGIN IMMEDIATE` transaction, writing the  
    receipt to `import_manifest` under key `rai.applied-command.<id>`.
- Storage layer: `packages/storage-sqlite/src/` — `database.ts`, `database-file-publisher.ts`,  
  `publication-lock.ts`, `recompute-job-repository.ts`, `model-run-repository.ts`,  
  `model-release-repository.ts`, `model-transition-gate.ts`, migrations `v2`, `v24`…`v36`.
- Parser/import layer: `packages/health-export-parser/src/` — `apple-health-parser.ts`,  
  `gpx-parser.ts`, `canonicalize.ts`, `canonicalize-nights.ts`, `identity-algorithm.ts`,  
  `import-guard.ts`, `incremental.ts`, `native-record-writer.ts`, `native-worker.ts`,  
  `owned-transaction.ts`, `record-delta-policy.ts`, `sync-manifest.ts`, `audit.ts`,  
  `prune-tombstones-cli.ts`.
- Application layer: `packages/application/src/` — `service.ts`, `write-gate.ts`,  
  `recompute-job-repository.ts`, `prediction-training-runner.ts`, `prediction-model-service.ts`,  
  `personal-calibration.ts`, plus many `*-cli.ts` entry points.
- Domain packages: `contracts`, `api-contracts`, `features`, `scoring`, `readiness`,  
  `normalization`, `durability`, `training-load`, `training-zones`, `physiology`,  
  `prediction-inference`, `model-eval`, `dynamics`.
- Rust worker crate exists: `crates/rai-data-worker`; root scripts `rust:build`, `rust:verify`  
  via `scripts/rust-worker.mjs`. Whether it is on the default runtime path is **your** job to  
  verify from source before you draw it.
- Runtime databases observed in `var/`: `rai.sqlite` (large, main), `rai-control.sqlite`,  
  `runtime.sqlite`, plus stale/candidate import lock files  
  (`rai.sqlite.import.lock.stale.*`, `rai.sqlite.import.lock.candidate.*`). `var/` is a local  
  runtime directory, not a committed artifact — treat the file list as an observation, and prove  
  every table/column claim from `CREATE TABLE` statements in `packages/storage-sqlite/src/`.

## Evidence classes to keep straight in your own reasoning

- **A = confirmed**: you read the code that does it.
- **B = inferred**: source strongly implies it but no single line asserts it.
- **C = unknown**: cannot confirm. Say so; do not draw it as fact.

In your final report back to the Lead, list your **B** and **C** items explicitly.

## Report back to the Lead (exact shape)

```
TASK: <your diagram>
FILES: <workspace-relative candidate.json path> | <workspace-relative html path>
FINALIZE: <pass|fail> | gates: <what the receipt said> | exit: <n>
COMPONENTS: <n> | CONNECTIONS/FLOWS/MESSAGES: <n> | CARDS: <n>
KEY FINDINGS (A): <bullet, each with path:line>
INFERRED (B): <bullet>
UNKNOWN (C): <bullet>
DOC-VS-SOURCE DIFFS NOTICED: <bullet, each with path:line>
```

Do not claim a passing gate you did not see in the receipt. Do not claim you visually  
inspected a rendering unless you actually did.
