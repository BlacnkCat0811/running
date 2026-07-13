import { existsSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "../..");
const venv = resolve(root, "research/.venv");
const venvPython = process.platform === "win32"
  ? resolve(venv, "Scripts/python.exe")
  : resolve(venv, "bin/python");

function result(command, args, stdio = ["ignore", "pipe", "pipe"]) {
  return spawnSync(command, args, { cwd: root, encoding: "utf8", stdio });
}

function selectedPython() {
  if (process.env.RAI_PYTHON) return { command: process.env.RAI_PYTHON, prefix: [] };
  if (existsSync(venvPython)) return { command: venvPython, prefix: [] };
  if (process.platform === "win32") {
    for (const version of ["-3.12", "-3.13"]) {
      if (result("py", [version, "-c", "import sys"]).status === 0) {
        return { command: "py", prefix: [version] };
      }
    }
  }
  return { command: "python", prefix: [] };
}

const versionProbe = [
  "import sys",
  "assert (3, 12) <= sys.version_info[:2] < (3, 14), f'需要 Python 3.12 或 3.13，当前为 {sys.version.split()[0]}'"
].join("; ");

function compatible(command, prefix = []) {
  const probe = result(command, [...prefix, "-c", versionProbe]);
  return !probe.error && probe.status === 0;
}

function runOrFail(command, args, label) {
  const completed = result(command, args, "inherit");
  if (completed.error || completed.status !== 0) {
    console.error(`${label}失败。请运行 npm run ml:bootstrap，或通过 RAI_PYTHON 指定 Python。`);
    process.exit(completed.status ?? 1);
  }
}

const mode = process.argv[2] ?? "--check";
if (mode === "--bootstrap") {
  if (existsSync(venvPython) && !compatible(venvPython)) {
    console.warn("现有 research/.venv 的 Python 版本不受支持，正在重建。");
    rmSync(venv, { recursive: true, force: true });
  }
  if (!existsSync(venvPython)) {
    const base = selectedPython();
    if (!compatible(base.command, base.prefix)) {
      console.error("找不到 Python 3.12 或 3.13。请安装兼容版本，或通过 RAI_PYTHON 指定解释器。");
      process.exit(1);
    }
    runOrFail(base.command, [...base.prefix, "-m", "venv", venv], "创建 Python 虚拟环境");
  }
  runOrFail(venvPython, ["-m", "pip", "install", "--requirement", "research/requirements.lock"], "安装锁定依赖");
  runOrFail(venvPython, ["-m", "pip", "install", "--no-deps", "--editable", "research"], "安装训练包");
}

const python = mode === "--bootstrap" ? { command: venvPython, prefix: [] } : selectedPython();
const check = result(python.command, [...python.prefix, "-c", [
  versionProbe,
  "from importlib.metadata import version",
  "from pathlib import Path",
  "locked = {line.split('==', 1)[0].lower(): line.split('==', 1)[1] for line in Path('research/requirements.lock').read_text().splitlines() if line and not line.startswith('#') and '==' in line}",
  "mismatch = {name: (expected, version(name)) for name, expected in locked.items() if version(name) != expected}",
  "assert not mismatch, f'依赖版本与 research/requirements.lock 不一致: {mismatch}'",
  "import catboost, numpy, onnx, onnxruntime, pytest, rai_ml",
  "print(sys.executable)"
].join("; ")]);
if (check.error || check.status !== 0) {
  process.stderr.write(check.stderr || check.stdout || "Python 训练环境不可用\n");
  console.error("请运行 npm run ml:bootstrap，或通过 RAI_PYTHON 指定已安装 research 包的 Python。");
  process.exit(check.status ?? 1);
}
console.log(`Python 训练环境就绪: ${check.stdout.trim()}`);
if (mode === "--pytest") {
  runOrFail(python.command, [...python.prefix, "-m", "pytest", "research/tests", ...process.argv.slice(3)], "Python 测试");
}
if (mode === "--train") {
  runOrFail(python.command, [...python.prefix, "research/rai_ml/train.py", ...process.argv.slice(3)], "模型训练");
}
