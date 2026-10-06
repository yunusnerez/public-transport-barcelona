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
