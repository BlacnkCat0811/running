import assert from "node:assert/strict";
import test from "node:test";

import { trimRouteForShare } from "../src/share-card.js";

/**
 * V01–V03: the three ways a "privacy zone" fails to be private.
 *
 *   V01  the zone removes points, but the line still runs straight through it;
 *   V02  an empty or absent zone set changes the route (or a single zone silently
 *        removes a route it never touched);
 *   V03  a route with no coordinates at all, or a degenerate one, is reported as
 *        if it had been drawn.
 */

/** ~1 km of latitude is 0.009 degrees; ~1 km of longitude at 30° is ~0.0104. */
const DEGREE_LATITUDE_METERS = 110_540;
const metresOfLatitude = (degrees: number): number => degrees * DEGREE_LATITUDE_METERS;

/** A straight south→north line at longitude 120, 100 m per step. */
function line(metersLong: number, stepMeters = 100): Array<{ latitude: number; longitude: number }> {
  const steps = Math.round(metersLong / stepMeters);
  return Array.from({ length: steps + 1 }, (_, index) => ({
    latitude: (index * stepMeters) / DEGREE_LATITUDE_METERS,
    longitude: 120
  }));
}

const zoneAt = (latitude: number, radiusMeters: number) => ({
  centerLatitude: latitude,
  centerLongitude: 120,
  radiusMeters
});

test("V02: with no zones the route passes through untouched", () => {
  const points = line(1_000);
  const result = trimRouteForShare(points, []);
  assert.equal(result.polylines.length, 1);
  assert.equal(result.polylines[0]!.length, points.length);
  assert.equal(result.redactedPoints, 0);
  assert.equal(result.gaps, 0);
  assert.equal(result.zonesApplied, 0);
  assert.deepEqual(result.polylines[0], points);
});

test("V01: points inside a zone are removed AND the crossing segments are cut", () => {
  // A 1 km line with a 200 m zone centred on the middle of it.
  const points = line(1_000, 50);
  const middle = metresOfLatitude(points[points.length - 1]!.latitude) / 2;
  const result = trimRouteForShare(points, [zoneAt(middle / DEGREE_LATITUDE_METERS, 200)]);

  assert.equal(result.zonesApplied, 1);
  assert.ok(result.redactedPoints > 0, "the zone must actually contain points");
  assert.equal(result.polylines.length, 2, "the line must be broken in two, not reconnected");

  // The gap must be at least the zone's diameter: a chord through the zone would
  // leave the two ends far closer together than that.
  const southern = result.polylines[0]!;
  const northern = result.polylines[1]!;
  const gapStart = southern[southern.length - 1]!;
  const gapEnd = northern[0]!;
  const gapMeters = metresOfLatitude(gapEnd.latitude - gapStart.latitude);
  assert.ok(gapMeters >= 2 * 200 - 1, `the drawn gap must clear the zone (got ${gapMeters.toFixed(1)} m)`);
  assert.ok(
    southern.every((point) => metresOfLatitude(Math.abs(point.latitude - middle / DEGREE_LATITUDE_METERS)) >= 200 - 0.001),
    "no surviving point may sit inside the zone"
  );
  assert.equal(result.gaps, 1, "one break in the drawn line");
});

test("V01: a zone that swallows the whole route yields no polylines at all", () => {
  const points = line(500, 50);
  const middle = metresOfLatitude(points[points.length - 1]!.latitude) / 2;
  const result = trimRouteForShare(points, [zoneAt(middle / DEGREE_LATITUDE_METERS, 2_000)]);
  assert.deepEqual(result.polylines, []);
  assert.equal(result.redactedPoints, points.length);
  assert.equal(result.gaps, 0, "nothing is drawn, so there is no break to describe");
});

test("V02: a zone far from the route changes nothing it did not touch", () => {
  const points = line(1_000);
  const result = trimRouteForShare(points, [
    { centerLatitude: 10, centerLongitude: 10, radiusMeters: 300 }
  ]);
  assert.equal(result.polylines.length, 1);
  assert.equal(result.polylines[0]!.length, points.length);
  assert.equal(result.redactedPoints, 0);
  assert.equal(result.gaps, 0);
  assert.equal(result.zonesApplied, 1, "the zone is still reported as applied");
});

test("V01: two overlapping zones are unioned, not subtracted twice", () => {
  const points = line(1_000, 25);
  const middle = metresOfLatitude(points[points.length - 1]!.latitude) / 2;
  const result = trimRouteFromTwoZones(points, middle);
  assert.equal(result.polylines.length, 2, "overlapping zones must leave one gap, not two");
  assert.equal(result.zonesApplied, 2);
});

function trimRouteFromTwoZones(points: ReturnType<typeof line>, middleMeters: number) {
  return trimRouteForShare(points, [
    zoneAt((middleMeters - 60) / DEGREE_LATITUDE_METERS, 150),
    zoneAt((middleMeters + 60) / DEGREE_LATITUDE_METERS, 150)
  ]);
}

test("V01: a zone touching only the start removes the start without breaking the rest", () => {
  const points = line(1_000, 50);
  const result = trimRouteForShare(points, [zoneAt(0, 150)]);
  assert.equal(result.polylines.length, 1, "one continuous line remains");
  assert.ok(result.redactedPoints > 0);
  const first = result.polylines[0]![0]!;
  assert.ok(metresOfLatitude(first.latitude) >= 150 - 0.001, "the drawn line starts outside the zone");
});

test("V03: an empty or degenerate route produces no polylines and no invented stats", () => {
  assert.deepEqual(trimRouteForShare([], []).polylines, []);
  const single = trimRouteForShare([{ latitude: 0, longitude: 120 }], []);
  assert.deepEqual(single.polylines, [], "a single point is not a route");
  assert.equal(single.redactedPoints, 0);
});

test("V03: non-finite and out-of-range coordinates are dropped before geometry", () => {
  const points = [
    { latitude: Number.NaN, longitude: 120 },
    { latitude: 0, longitude: 120 },
    { latitude: 0.001, longitude: 120 },
    { latitude: 95, longitude: 120 },
    { latitude: 0.002, longitude: 120 }
  ];
  const result = trimRouteForShare(points, []);
  assert.equal(result.polylines.length, 1);
  assert.equal(result.polylines[0]!.length, 3, "only the three valid points survive");
  assert.ok(result.polylines[0]!.every((point) => Math.abs(point.latitude) <= 90));
});

test("V03: zone parameters that cannot describe a circle are ignored, not obeyed", () => {
  const points = line(500);
  const result = trimRouteForShare(points, [
    { centerLatitude: 0, centerLongitude: 120, radiusMeters: 0 },
    { centerLatitude: 0, centerLongitude: 120, radiusMeters: Number.NaN },
    { centerLatitude: 999, centerLongitude: 120, radiusMeters: 100 }
  ]);
  assert.equal(result.zonesApplied, 0);
  assert.equal(result.polylines[0]!.length, points.length, "an invalid zone must not silently delete the route");
});

test("privacy zones redact nearby points across the antimeridian", () => {
  for (const direction of [-1, 1]) {
    const points = [-179.999, -179.9985].map(longitude => ({ latitude: 0, longitude: direction * longitude }));
    const result = trimRouteForShare(points, [{ centerLatitude: 0, centerLongitude: direction * 179.999, radiusMeters: 300 }]);
    assert.equal(result.redactedPoints, 2);
    assert.deepEqual(result.polylines, []);
  }
});

test("dateline-crossing segments are clipped along their short arc in either direction", () => {
  const points = [179.99, 179.999, -179.999, -179.99].map(longitude => ({ latitude: 0, longitude }));
  for (const route of [points, [...points].reverse()]) {
    for (const centerLongitude of [-180, 180]) {
      const result = trimRouteForShare(route, [{ centerLatitude: 0, centerLongitude, radiusMeters: 300 }]);
      assert.equal(result.redactedPoints, 2);
      assert.equal(result.polylines.length, 2);
      assert.equal(result.gaps, 1);
      for (const polyline of result.polylines) {
        for (const point of polyline) {
          assert.ok(Math.abs(point.longitude) <= 180);
          assert.ok((180 - Math.abs(point.longitude)) * 111_320 >= 300 - 0.001, "no boundary interpolation may reveal a point inside the zone");
        }
        assert.ok(Math.abs(polyline[0]!.longitude - polyline.at(-1)!.longitude) < 1);
      }
    }
  }
});

test("unredacted dateline crossings never draw a chord across the world", () => {
  const points = [179.99, 179.999, -179.999, -179.99].map(longitude => ({ latitude: 0, longitude }));
  for (const route of [points, [...points].reverse()]) {
    const result = trimRouteForShare(route, []);
    assert.equal(result.redactedPoints, 0);
    assert.equal(result.gaps, 0, "a geographic seam is not a privacy gap");
    assert.equal(result.polylines.length, 2);
    for (const polyline of result.polylines) {
      for (let index = 1; index < polyline.length; index++) {
        assert.ok(Math.abs(polyline[index]!.longitude - polyline[index - 1]!.longitude) < 1);
      }
    }
  }
});

test("a short dateline-crossing segment is cut even when both endpoints are outside the zone", () => {
  for (const latitude of [0, 60]) {
    const points = [179.99, -179.99].map(longitude => ({ latitude, longitude }));
    const metersPerDegree = 111_320 * Math.cos(latitude * Math.PI / 180);
    for (const route of [points, [...points].reverse()]) {
      const result = trimRouteForShare(route, [{ centerLatitude: latitude, centerLongitude: 180, radiusMeters: 300 }]);
      assert.equal(result.redactedPoints, 0);
      assert.equal(result.polylines.length, 2);
      assert.equal(result.gaps, 1);
      for (const polyline of result.polylines) {
        assert.ok(Math.abs(polyline[0]!.longitude - polyline.at(-1)!.longitude) < 1);
        for (const point of polyline) {
          assert.ok(Math.abs(point.longitude) <= 180);
          assert.ok((180 - Math.abs(point.longitude)) * metersPerDegree >= 300 - 0.001);
        }
      }
    }
  }
});

test("privacy boundaries do not move when distant parts of a route change its mean latitude", () => {
  for (const direction of [-1, 1]) {
    const latitude = direction * 60;
    const metersPerDegree = 111_320 * Math.cos(latitude * Math.PI / 180);
    const points = [
      { latitude: direction * 59.8, longitude: 120 },
      { latitude, longitude: 120 + 299.5 / metersPerDegree },
      { latitude, longitude: 120 + 400 / metersPerDegree }
    ];
    const result = trimRouteForShare(points, [{ centerLatitude: latitude, centerLongitude: 120, radiusMeters: 300 }]);
    assert.equal(result.redactedPoints, 1, "a point 299.5 m from the zone center must remain hidden");
    for (const polyline of result.polylines) {
      for (const point of polyline) {
        const x = (point.longitude - 120) * metersPerDegree;
        const y = (point.latitude - latitude) * DEGREE_LATITUDE_METERS;
        assert.ok(Math.hypot(x, y) >= 300 - 0.001, "all emitted coordinates must clear the zone's own boundary");
      }
    }
  }
});
