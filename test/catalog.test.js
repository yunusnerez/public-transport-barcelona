import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("metro stays static and the default set is small", () => {
  const catalog = JSON.parse(readFileSync(path.join(root, "public/data/catalog.json"), "utf8"));
  const on = catalog.lines.filter((line) => line.defaultOn).map((line) => line.id).sort();
  assert.deepEqual(on, ["fgc:L6", "tmb-metro:L1", "tmb-metro:L2", "tmb-metro:L3", "tmb-metro:L4", "tmb-metro:L5"]);
  const metro = catalog.lines.filter((line) => line.mode === "metro");
  assert.ok(metro.length >= 10);
  for (const line of metro) assert.equal(line.live, false);
  assert.ok(catalog.lines.some((line) => line.id === "tram:T1" && line.needsKey === true));
  assert.ok(catalog.lines.some((line) => line.id === "tmb-bus:H6" && line.mode === "bus" && line.live === true));
  assert.ok(catalog.lines.some((line) => line.id === "fgc:L6" && line.live === true));
});

test("the site bundle has no API key", () => {
  const files = walk(root);
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    assert.equal(/app_(id|key)=[0-9a-f]{8,}/i.test(text), false, file);
    assert.equal(/client_secret["']?\s*[:=]\s*["'][^"']{4,}/i.test(text), false, file);
    if (file.includes(`${path.sep}public${path.sep}`)) {
      assert.equal(/app_key/i.test(text), false, file);
      assert.equal(/app_id/i.test(text), false, file);
      assert.equal(/client_secret/i.test(text), false, file);
      assert.equal(/TMB_APP_(ID|KEY)/.test(text), false, file);
    }
  }
  const example = readFileSync(path.join(root, ".env.example"), "utf8");
  for (const line of example.split("\n")) {
    if (!line.includes("=")) continue;
    assert.equal(line.split("=").slice(1).join("=").trim(), "");
  }
});

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".cache" || name === ".git" || name === ".wrangler") continue;
    const full = path.join(dir, name);
    const info = statSync(full);
    if (info.isDirectory()) walk(full, out);
    else if (info.size < 3_000_000 && /\.(js|json|mjs|html|css|md|toml|example|txt)$/.test(name)) out.push(full);
  }
  return out;
}
