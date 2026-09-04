import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { budgets, checkBundleBudgets } from "../scripts/check-bundle.mjs";

const temporaryDirectories = [];
const testBudgets = [
  { pattern: /^index-.*\.js$/, maximumBytes: 10, label: "application entry" }
];

async function makeAssetDirectory() {
  const directory = await mkdtemp(join(tmpdir(), "rai-bundle-budget-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

describe("checkBundleBudgets", () => {
  it("matches the current Vite application stylesheet name", async () => {
    const directory = await makeAssetDirectory();
    await writeFile(join(directory, "styles-current.css"), "small");

    const stylesheetBudget = budgets.find((budget) => budget.label === "application styles");
    await expect(checkBundleBudgets(directory, [stylesheetBudget])).resolves.toBeUndefined();
  });

  it("fails when a budget does not match any bundle asset", async () => {
    const directory = await makeAssetDirectory();
    await writeFile(join(directory, "renamed-entry.js"), "small");

    await expect(checkBundleBudgets(directory, testBudgets)).rejects.toThrow(
      "application entry did not match any bundle assets"
    );
  });

  it("fails when a matching asset exceeds its budget", async () => {
    const directory = await makeAssetDirectory();
    await writeFile(join(directory, "index-large.js"), "more than ten bytes");

    await expect(checkBundleBudgets(directory, testBudgets)).rejects.toThrow(
      "index-large.js is 19 bytes; budget is 10 bytes"
    );
  });

  it("passes when every budget matches an asset within its limit", async () => {
    const directory = await makeAssetDirectory();
    await writeFile(join(directory, "index-small.js"), "small");

    await expect(checkBundleBudgets(directory, testBudgets)).resolves.toBeUndefined();
  });
});
