/** Required named compile-then-behavior probes; shared by producer and replay
 * auditor so a truncated artifact or an unnamed crash cannot certify AC8-05. */
export const COACH_MUTATION_ASSERTIONS: Record<string, string> = {
  minimum: "AC0-05", suggestion: "AC0-13-candidate", rolling: "AC0-16", anchor: "AC0-15", single: "AC0-19",
  protection: "AC1-02", work: "AC4-11", "execution-unknown": "AC2-02", "execution-reconstructed": "AC2-04",
  "execution-coverage": "AC2-05", "execution-retroactive": "AC2-08", "repair-lock": "AC3-04",
  "repair-feasibility": "AC3-09", "repair-authorization": "AC0-21/AC3-no-change",
  "repair-exhaustion": "AC3-search-budget", "repair-intent": "AC0-21/AC3-intent",
  "feedback-late": "AC5-03", "feedback-expiry": "AC5-02", "feedback-skip": "AC5-01",
  "gap-sign": "AC6-01", "gap-freshness": "AC6-04", "gap-compatibility": "AC6-05",
  "runtime-policy": "AC0-21-policy", "runtime-cas": "AC0-22-cas", "runtime-facts": "AC0-22-facts",
  "runtime-completion": "AC0-17-completed-slot", "runtime-identity": "AC0-21-authority-identity",
  "runtime-rollback": "AC0-22-rollback", "device-token": "AC0-12-device-token"
};
