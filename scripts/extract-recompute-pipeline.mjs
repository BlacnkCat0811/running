import fs from "node:fs";

const servicePath = "packages/application/src/service.ts";
const lines = fs.readFileSync(servicePath, "utf8").split(/\r?\n/);

const classStart = lines.findIndex((l) => l.startsWith("export class RaiApplicationService"));
const runFull = lines.findIndex((l) => l.includes("private runFullRecompute("));
if (classStart < 0 || runFull < 0) throw new Error("markers not found");

// Header: everything before the class
const header = lines.slice(0, classStart);

// Class prelude: class declaration through the line before runFullRecompute
const classPrelude = lines.slice(classStart, runFull);

// Pipeline methods: runFullRecompute through end of class (exclusive of final blank lines after })
let classEnd = lines.length - 1;
while (classEnd > runFull && lines[classEnd].trim() === "") classEnd -= 1;
// classEnd should be the closing `}` of the class
if (lines[classEnd].trim() !== "}") {
  throw new Error(`Expected class closing brace, got: ${lines[classEnd]}`);
}
const pipelineMethods = lines.slice(runFull, classEnd);

// Build pipeline file
const pipelineImports = [
  ...header,
  "",
  "/**",
  " * Feature extraction, training metrics/zones, and ability timeline replay.",
  " * Split from RaiApplicationService (ARCHITECTURE_DEBT_MIGRATION P4).",
  " */",
  "export class RecomputePipeline {",
  "  constructor(",
  "    private readonly store: RaiDatabase,",
  "    private readonly jobs: RecomputeJobRepository,",
  "    private readonly modelRuns: SqliteModelRunRepository,",
  "    private readonly sessions: SqliteTrainingSessionRepository",
  "  ) {}",
  "",
  "  get database(): DatabaseSync {",
  "    return this.store.database;",
  "  }",
  ""
];

const pipelineBody = pipelineMethods.map((line) => {
  if (line.includes("private runFullRecompute(")) {
    return line.replace("private runFullRecompute(", "runFullRecompute(");
  }
  if (line.includes("private runSnapshotRefresh(")) {
    return line.replace("private runSnapshotRefresh(", "runSnapshotRefresh(");
  }
  return line;
});

const pipelineFile = [...pipelineImports, ...pipelineBody, "}", ""].join("\n");
fs.mkdirSync("packages/application/src/services", { recursive: true });
fs.writeFileSync("packages/application/src/services/recompute-pipeline.ts", pipelineFile);

// Build slim service: header + classPrelude with constructor/pipeline wiring + close class
let prelude = classPrelude.join("\n");

// Add RecomputePipeline import
if (!prelude.includes("recompute-pipeline") && !header.join("\n").includes("recompute-pipeline")) {
  // will add to service output header
}

// Wire constructor
prelude = prelude.replace(
  `private readonly sessions: SqliteTrainingSessionRepository;

  constructor(private readonly store: RaiDatabase) {
    this.jobs = new RecomputeJobRepository(store.database);
    this.modelRuns = new SqliteModelRunRepository(store.database);
    this.sessions = new SqliteTrainingSessionRepository(store.database);
  }`,
  `private readonly sessions: SqliteTrainingSessionRepository;
  private readonly pipeline: RecomputePipeline;

  constructor(private readonly store: RaiDatabase) {
    this.jobs = new RecomputeJobRepository(store.database);
    this.modelRuns = new SqliteModelRunRepository(store.database);
    this.sessions = new SqliteTrainingSessionRepository(store.database);
    this.pipeline = new RecomputePipeline(store, this.jobs, this.modelRuns, this.sessions);
  }`
);

// Delegate runNextJob
prelude = prelude.replace(
  `if (job.jobType === "full_recompute") {
        this.runFullRecompute(job);
      } else if (job.jobType === "snapshot_refresh") {
        this.runSnapshotRefresh(job);
      } else {`,
  `if (job.jobType === "full_recompute") {
        this.pipeline.runFullRecompute(job);
      } else if (job.jobType === "snapshot_refresh") {
        this.pipeline.runSnapshotRefresh(job);
      } else {`
);

// enqueueJob may still use this.manifestValue which moved to pipeline — inline it
prelude = prelude.replace(
  `return this.jobs.enqueue(jobType, this.manifestValue("dataset_version"), request);`,
  `const row = this.database.prepare("SELECT value FROM import_manifest WHERE key = ?")
      .get("dataset_version") as { value: string } | undefined;
    return this.jobs.enqueue(jobType, row?.value ?? null, request);`
);

const serviceHeader = [
  ...header.filter((l) => !l.includes("recompute-pipeline")),
  'import { RecomputePipeline } from "./services/recompute-pipeline.js";',
  ""
].join("\n");

// Remove unused imports that are only needed by pipeline from service if any — leave for now
const serviceFile = `${serviceHeader}
${prelude}
}
`;

fs.writeFileSync(servicePath, serviceFile);
console.log({
  serviceLines: serviceFile.split("\n").length,
  pipelineLines: pipelineFile.split("\n").length
});
