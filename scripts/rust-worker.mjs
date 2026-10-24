import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const mode = process.argv[2] ?? "build";
if (!["build", "verify"].includes(mode)) throw new Error("Usage: rust-worker.mjs build|verify");
const root = resolve(import.meta.dirname, "..");
const local = resolve(root, "var/cargo/bin");
const cargoName = process.platform === "win32" ? "cargo.exe" : "cargo";
const useLocal = existsSync(resolve(local, cargoName));
const env = useLocal ? {
  ...process.env, CARGO_HOME: resolve(root, "var/cargo"), RUSTUP_HOME: resolve(root, "var/rustup"),
  PATH: `${local}${process.platform === "win32" ? ";" : ":"}${process.env.PATH ?? ""}`
} : { ...process.env };
function run(command, args, extra = {}) {
  const result = spawnSync(command, args, { cwd: root, env: { ...env, ...extra }, stdio: "inherit" });
  if (result.error) throw new Error(`Cannot run ${command}; install the toolchain from rust-toolchain.toml first`, { cause: result.error });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
const cargo = useLocal ? resolve(local, cargoName) : cargoName;
run(cargo, ["build", "--release", "--locked", "--workspace"]);
if (mode === "verify") {
  run(cargo, ["test", "--release", "--locked", "--workspace"]);
  run(process.execPath, ["--import", "tsx", "--test",
    "packages/health-export-parser/test/native-worker.test.ts",
    "packages/health-export-parser/test/healthkit-record-sync.test.ts",
    "apps/api/test/native-import-worker.test.ts"
  ], { RAI_REQUIRE_RUST_TESTS: "1" });
}
