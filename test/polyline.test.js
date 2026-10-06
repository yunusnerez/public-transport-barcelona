import assert from "node:assert/strict";
import test from "node:test";
import { decodePolyline, encodePolyline } from "../worker/src/polyline.js";

test("encoded polyline round-trips Barcelona coordinates", () => {
  const points = [[2.17, 41.39], [2.18, 41.4], [2.15, 41.37], [2.2, 41.41]];
  const back = decodePolyline(encodePolyline(points));
  assert.equal(back.length, points.length);
  for (let i = 0; i < points.length; i++) {
    assert.ok(Math.abs(back[i][0] - points[i][0]) < 1e-5);
    assert.ok(Math.abs(back[i][1] - points[i][1]) < 1e-5);
  }
});

test("matches the published Google polyline sample", () => {
  const encoded = encodePolyline([[-120.2, 38.5], [-120.95, 40.7], [-126.453, 43.252]]);
  assert.equal(encoded, "_p~iF~ps|U_ulLnnqC_mqNvxq`@");
  const back = decodePolyline(encoded);
  assert.ok(Math.abs(back[0][0] + 120.2) < 1e-5);
  assert.ok(Math.abs(back[2][1] - 43.252) < 1e-5);
});
