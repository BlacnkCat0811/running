import { readFileSync, writeFileSync } from "node:fs";

const path = ".archify/rai-audit-20261013-160439/architecture-modules/candidate.json";
const doc = JSON.parse(readFileSync(path, "utf8"));

const W = 220, H = 84;
const layout = {
  api: [40, 120], application: [340, 120], storage: [640, 120],
  contracts: [40, 420], algo_leaf: [340, 420], parser: [640, 420],
  algo_src: [340, 720], python: [40, 720], rust: [640, 720],
  inference: [340, 1020]
};
for (const c of doc.components) {
  const next = layout[c.id];
  if (!next) continue;
  c.pos = next;
  c.size = [W, H];
}

// Split the aggregate "纯函数算法包群" node: the whitelist proves `features` and
// `training-load` are NOT leaves (features -> normalization, training-load ->
// readiness), while `scoring`/`readiness` only depend on contracts.
const algo = doc.components.find((c) => c.id === "algo");
if (algo) {
  algo.id = "algo_leaf";
  algo.label = "评分 / 恢复 / 负荷";
  algo.sublabel = "scoring · readiness · training-load";
  algo.tag = "叶子或近叶子";
  algo.pos = layout.algo_leaf;
  algo.size = [W, H];
  algo.sources = [
    { path: "packages/scoring/src/index.ts", line: 13, label: "SCORING_MODEL_VERSION" },
    { path: "packages/scoring/src/model.ts", line: 425, label: "scoreFeature" },
    { path: "scripts/check-package-boundaries.mjs", line: 39, end_line: 73, label: "包依赖白名单" }
  ];
  doc.components.push({
    id: "algo_src",
    type: "backend",
    label: "特征与训练负荷",
    sublabel: "features · training-load",
    tag: "仍只写 contracts + 内部依赖",
    icon: "backend",
    pos: layout.algo_src,
    size: [W, H],
    sources: [
      { path: "scripts/check-package-boundaries.mjs", line: 58, end_line: 59, label: "features -> normalization" },
      { path: "scripts/check-package-boundaries.mjs", line: 69, end_line: 70, label: "training-load -> readiness" },
      { path: "packages/application/src/services/recompute-pipeline.ts", line: 213, label: "extractFeatures 调用点" }
    ]
  });
}

// Re-point the aggregate edges at the two real packages and add the two internal
// edges the whitelist contains.
doc.connections = doc.connections.filter((c) => !["application-to-algo", "algo-to-contracts"].includes(c.id));
doc.connections.push(
  { id: "application-to-algo-src", from: "application", to: "algo_src", label: "特征与负荷", variant: "emphasis" },
  { id: "application-to-algo-leaf", from: "application", to: "algo_leaf", label: "评分与恢复", variant: "emphasis" },
  { id: "algo-src-to-algo-leaf", from: "algo_src", to: "algo_leaf", label: "training-load → readiness", variant: "default" },
  { id: "algo-src-to-contracts", from: "algo_src", to: "contracts", label: "经 normalization", variant: "default" },
  { id: "algo-leaf-to-contracts", from: "algo_leaf", to: "contracts", label: "只依赖契约", variant: "default" }
);

for (const b of doc.boundaries ?? []) {
  b.wraps = b.wraps.filter((id) => id !== "algo");
  if (!b.wraps.includes("algo_leaf")) b.wraps.push("algo_leaf");
  if (!b.wraps.includes("algo_src")) b.wraps.push("algo_src");
}

writeFileSync(path, JSON.stringify(doc, null, 2) + "\n", "utf8");
console.log("components:", doc.components.map((c) => c.id).join(", "));
console.log("connections:", doc.connections.length);
