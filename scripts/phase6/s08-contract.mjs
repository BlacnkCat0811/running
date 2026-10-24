// 阶段 6 S08 结构化合同裁决（纯函数，便于负例回归）。
//
// 合同字段（DX manifest 的 payload.contract）：
//   expectation: accepted | refused | observational
//   expectedLane: data-only | direct-sync | null
//   allowJob / allowedRejectionStages / expectedHttpStatus / expectedCode
//   expectedFacts: { healthRecords, workouts, routePoints }（null = 不约束）
//   required: 是否必须出现在 S08 必需测试列表
//
// `ok=false` 必须由 driver 写入 correctness.oracleFailures；finding/说明文字
// 不能替代机器裁决。

const check = (name, ok, expected = null, actual = null) => ({ name, ok: Boolean(ok), expected, actual });

export function evaluateS08Contract(contract, observed) {
  const checks = [];
  const expectations = contract?.expectedFacts ?? {};
  if (contract === null || contract === undefined || typeof contract !== "object") {
    return [check("structured contract present", false, "object", typeof contract)];
  }
  if (contract.expectation === "accepted") {
    checks.push(check("upload accepted", observed.uploadStatus === 200, 200, observed.uploadStatus));
    if (contract.expectedLane !== null && contract.expectedLane !== undefined) {
      checks.push(check("expected lane", observed.lane === contract.expectedLane, contract.expectedLane, observed.lane));
    }
    checks.push(check("job succeeded", observed.jobStatus === "succeeded", "succeeded", observed.jobStatus));
    for (const [key, expected] of Object.entries(expectations)) {
      if (expected === null) continue;
      checks.push(check(`facts ${key}`, observed.factsDelta?.[key] === expected, expected, observed.factsDelta?.[key] ?? null));
    }
  } else if (contract.expectation === "refused") {
    // 关键负例：HTTP 全是 2xx、但一个拒绝用例被接受 ⇒ no succeeded job FAIL。
    checks.push(check("no succeeded job", observed.jobStatus !== "succeeded", "not succeeded", observed.jobStatus));
    const rejection = observed.rejection;
    checks.push(check("stable rejection observed", rejection !== null && rejection !== undefined,
      "4xx/refusal", rejection?.stage ?? "none"));
    if (rejection !== null && rejection !== undefined) {
      const allowedStages = contract.allowedRejectionStages ?? [];
      checks.push(check("rejection stage allowed", allowedStages.includes(rejection.stage), allowedStages.join("|"), rejection.stage));
      const allowedStatus = contract.expectedHttpStatus ?? [];
      checks.push(check("rejection status allowed", allowedStatus.includes(rejection.status), allowedStatus.join("|"), rejection.status));
      if (contract.expectedCode !== null && contract.expectedCode !== undefined) {
        checks.push(check("stable rejection code", rejection.code === contract.expectedCode, contract.expectedCode, rejection.code));
      }
    }
    for (const [key, expected] of Object.entries(expectations)) {
      if (expected === null) continue;
      checks.push(check(`facts ${key}`, observed.factsDelta?.[key] === expected, expected, observed.factsDelta?.[key] ?? null));
    }
  } else if (contract.expectation === "observational") {
    // 不自动要求拒绝，但必须留在 case 列表里并记录实际结果。
    checks.push(check("observational case recorded", true, "recorded", observed.jobStatus ?? observed.uploadStatus));
  } else {
    checks.push(check("known expectation", false, "accepted|refused|observational", String(contract.expectation)));
  }
  return checks;
}
