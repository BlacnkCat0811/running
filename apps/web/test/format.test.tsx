import { describe, expect, it } from "vitest";

import { sleepDuration } from "../src/format.js";

describe("sleepDuration", () => {
  it("formats hours and zero-padded minutes", () => {
    expect(sleepDuration(419.3)).toBe("6h59min");
    expect(sleepDuration(420)).toBe("7h00min");
    expect(sleepDuration(65)).toBe("1h05min");
  });

  it("rounds fractional minutes and handles missing values", () => {
    expect(sleepDuration(0.4)).toBe("0h00min");
    expect(sleepDuration(0.5)).toBe("0h01min");
    expect(sleepDuration(null)).toBe("--");
    expect(sleepDuration(Number.NaN)).toBe("--");
    expect(sleepDuration(-1)).toBe("--");
  });
});
