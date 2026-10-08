import assert from "node:assert/strict";
import test from "node:test";
import worker from "../worker/src/index.js";

test("metro codes are not drawn as vehicles", async () => {
  const res = await worker.fetch(new Request("https://bcn.test/api/vehicles?lines=tmb:L1,tmb:L5,tmb:L9N"), {
    TMB_APP_ID: "example-id",
    TMB_APP_KEY: "example-key",
  });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.deepEqual(body.vehicles, []);
  assert.deepEqual(body.errors, []);
  assert.equal(JSON.stringify(body).includes("example-key"), false);
});

test("missing TMB and TRAM keys add no fake positions", async () => {
  const res = await worker.fetch(new Request("https://bcn.test/api/vehicles?lines=tmb:H6,tram:T1"));
  const body = await res.json();
  assert.equal(body.tramConfigured, false);
  assert.equal(body.vehicles.length, 0);
  const messages = body.errors.map((item) => item.message).sort();
  assert.deepEqual(messages, ["TMB anahtarı yok", "TRAM anahtarı yok"]);
});

test("routing and CORS", async () => {
  const options = await worker.fetch(new Request("https://bcn.test/api/vehicles", { method: "OPTIONS" }));
  assert.equal(options.status, 204);
  assert.equal(options.headers.get("access-control-allow-origin"), "*");
  const missing = await worker.fetch(new Request("https://bcn.test/nope"));
  assert.equal(missing.status, 404);
  const posted = await worker.fetch(new Request("https://bcn.test/api/vehicles", { method: "POST" }));
  assert.equal(posted.status, 405);
});

test("metro arrivals API returns realistic countdowns and handles line filter", async () => {
  const noCodeRes = await worker.fetch(new Request("https://bcn.test/api/metro-arrivals"));
  assert.equal(noCodeRes.status, 200);
  const noCodeBody = await noCodeRes.json();
  assert.equal(noCodeBody.arrivals.length, 0);
  assert.ok(noCodeBody.error);

  const res = await worker.fetch(new Request("https://bcn.test/api/metro-arrivals?codes=328,521&name=Diagonal"));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.station, "Diagonal");
  assert.ok(body.arrivals.length > 0);
  for (const arr of body.arrivals) {
    assert.ok(arr.line === "L3" || arr.line === "L5");
    assert.ok(typeof arr.destination === "string" && arr.destination.length > 0);
    assert.ok(typeof arr.seconds === "number" && arr.seconds >= 0);
    assert.ok(arr.color.startsWith("#"));
  }

  const filteredRes = await worker.fetch(new Request("https://bcn.test/api/metro-arrivals?codes=328,521&line=L3"));
  assert.equal(filteredRes.status, 200);
  const filteredBody = await filteredRes.json();
  assert.ok(filteredBody.arrivals.length > 0);
  for (const arr of filteredBody.arrivals) {
    assert.equal(arr.line, "L3");
  }
});

test("focusing a metro line generates estimated train positions on tracks", async () => {
  const res = await worker.fetch(new Request("https://bcn.test/api/vehicles?lines=metro:L3"));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(body.vehicles.length >= 2, "Expected at least 2 estimated trains on L3");
  for (const v of body.vehicles) {
    assert.equal(v.operator, "tmb");
    assert.equal(v.line, "L3");
    assert.equal(v.source, "estimated");
    assert.ok(v.lat > 41.3 && v.lat < 41.5);
    assert.ok(v.lon > 2.0 && v.lon < 2.3);
    assert.ok(v.destination);
  }
});

