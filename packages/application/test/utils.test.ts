import assert from "node:assert/strict";
import test from "node:test";

import { localDateStartAt } from "../src/utils.js";

test("localDateStartAt returns the first instant when DST skips local midnight", () => {
  assert.equal(
    localDateStartAt("2018-11-04", "America/Sao_Paulo"),
    "2018-11-04T03:00:00.000Z"
  );
});

test("localDateStartAt supports non-hour timezone offsets at DST boundaries", () => {
  assert.equal(
    localDateStartAt("2024-10-06", "Australia/Lord_Howe"),
    "2024-10-05T13:30:00.000Z"
  );
});
