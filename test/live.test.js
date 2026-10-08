import assert from "node:assert/strict";
import test from "node:test";
import worker from "../worker/src/index.js";

test("live FGC positions are GPS and TMB/TRAM stay empty without keys", { timeout: 25000 }, async (t) => {
  const fgc = ["L6", "L7", "L8", "L12", "S1", "S2", "S3", "S4", "S8", "S9", "R5", "R6", "R50", "R60"];
  const lines = ["tmb:H6", "tmb:L1", "tram:T1", ...fgc.map((code) => `fgc:${code}`)].join(",");
  const res = await worker.fetch(new Request(
    `https://bcn.test/api/vehicles?lines=${lines}&bbox=2.05,41.35,2.25,41.45`,
  ));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.tramConfigured, false);
  const byOp = Object.fromEntries(body.errors.map((item) => [item.operator, item.message]));
  assert.equal(byOp.tmb, "TMB anahtarı yok");
  assert.equal(byOp.tram, "TRAM anahtarı yok");
  if (byOp.fgc) {
    t.skip(`FGC network unreachable: ${byOp.fgc}`);
    return;
  }
  if (!body.vehicles.length) {
    t.skip("FGC feed upstream has no active vehicles right now");
    return;
  }
  const fields = ["id", "operator", "line", "lat", "lon", "bearing", "destination", "updated", "source"];
  for (const vehicle of body.vehicles) {
    for (const field of fields) assert.ok(field in vehicle, field);
    assert.equal(vehicle.operator, "fgc");
    assert.equal(vehicle.source, "gps");
    assert.ok(fgc.includes(vehicle.line), vehicle.line);
    assert.ok(vehicle.lat > 40 && vehicle.lat < 43.8);
    assert.ok(vehicle.lon > 0 && vehicle.lon < 3.6);
    assert.equal(JSON.stringify(vehicle).includes("app_key"), false);
  }
});
