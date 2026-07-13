import { status } from "../format.js";

export function StatusBadge({ value }: { value: string | null }) {
  const tone = value === "eligible" || value === "succeeded"
    ? "positive"
    : value === "trial" || value === "queued" || value === "running" || value === "validating" || value === "calibrating"
      ? "attention"
      : value === "excluded" || value === "failed" || value === "rejected"
        ? "danger"
        : "neutral";
  return <span className={`status-badge ${tone}`}>{status(value)}</span>;
}
