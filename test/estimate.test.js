import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { arrivalEtaSeconds, placeOnPattern } from "../worker/src/estimate.js";
import { decodePolyline, encodePolyline } from "../worker/src/polyline.js";
import { haversineMeters, pointAt, shapeMetrics } from "../worker/src/geo.js";

const a = [2.15, 41.39];
const b = [2.17, 41.39];
const length = haversineMeters(a, b);
const pattern = {
  dest: "Besòs",
  direction: 0,
  shape: encodePolyline([a, b]),
  stops: [
    ["100", 0, 0],
    ["200", length, 600],
  ],
};

test("halfway ETA sits on the middle of the shape", () => {
  const placed = placeOnPattern(pattern, "200", 300);
  assert.ok(placed);
  assert.ok(Math.abs(placed.lon - 2.16) < 1e-4);
  assert.ok(Math.abs(placed.lat - 41.39) < 1e-4);
  assert.ok(Math.abs(placed.bearing - 90) < 2);
  assert.equal(placed.destination, "Besòs");
});

test("ETA beyond the start of the pattern returns null", () => {
  assert.equal(placeOnPattern(pattern, "200", 800), null);
  assert.equal(placeOnPattern(pattern, "999", 30), null);
});

test("arrival timestamps and durations clamp to a ride, not a coordinate", () => {
  const now = 1_700_000_000;
  assert.equal(arrivalEtaSeconds(now + 90, now), 90);
  assert.equal(arrivalEtaSeconds((now + 90) * 1000, now), 90);
  assert.equal(arrivalEtaSeconds(new Date(now * 1000 + 15_000).toISOString(), now), 15);
  assert.equal(arrivalEtaSeconds(20, now), 20);
  assert.equal(arrivalEtaSeconds(-10, now), 0);
  assert.equal(arrivalEtaSeconds(50 * 60, now), null);
  assert.equal(arrivalEtaSeconds(now - 120, now), null);
});

test("real H6 pattern places a bus on the route and refuses an ETA that does not fit", () => {
  const bus = JSON.parse(readFileSync(new URL("../worker/data/bus-index.json", import.meta.url), "utf8"));
  const live = bus.lines.H6[0];
  assert.ok(live.stops.length > 5);
  let pair = null;
  for (let i = 1; i < live.stops.length; i++) {
    if (live.stops[i][2] - live.stops[i - 1][2] > 60) {
      pair = [live.stops[i - 1], live.stops[i]];
      break;
    }
  }
  assert.ok(pair);
  const [prev, stop] = pair;
  const eta = (stop[2] - prev[2]) / 2;
  const placed = placeOnPattern(live, stop[0], eta);
  assert.ok(placed);
  assert.equal(placed.destination, live.dest);
  const metrics = shapeMetrics(decodeShape(live.shape));
  const expected = pointAt(metrics, prev[1] + 0.5 * (stop[1] - prev[1]));
  assert.ok(haversineMeters([placed.lon, placed.lat], [expected.lon, expected.lat]) < 30);
  assert.equal(placeOnPattern(live, stop[0], stop[2] + 120), null);
  assert.equal(bus.lines.L1, undefined);
});

function decodeShape(encoded) {
  return decodePolyline(encoded);
}
