import assert from "node:assert/strict";
import test from "node:test";

import { FEATURE_CONFIG_VERSION, defaultFeatureConfig } from "@rai/features";

import { configHash } from "../src/utils.js";

test("the feature-config hash covers the extractor version, not only its tunables", () => {
  // This release changed the heart-rate-reserve formula in the feature extractor
  // without changing a single `FeatureConfig` value. If the hash stored on
  // `feature_runs.feature_config_hash` covered the values alone, the equality
  // check in `reuseFeaturePrefix` would still match and an incremental recompute
  // would keep serving features built by the previous formula — silently mixing
  // two extractor generations in one run.
  const valuesOnly = configHash(defaultFeatureConfig);
  const withVersion = configHash({ version: FEATURE_CONFIG_VERSION, config: defaultFeatureConfig });
  assert.notEqual(valuesOnly, withVersion);

  // Stable for identical input, or the guard would be useless in the other
  // direction (never matching and forcing a full recompute every time).
  assert.equal(withVersion, configHash({ version: FEATURE_CONFIG_VERSION, config: defaultFeatureConfig }));
  assert.notEqual(
    withVersion,
    configHash({ version: `${FEATURE_CONFIG_VERSION}-next`, config: defaultFeatureConfig })
  );
});
