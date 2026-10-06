import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import worker from "../worker/src/index.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const env = {};

for (const name of [".env", ".dev.vars"]) {
  const file = path.join(root, name);
  if (!existsSync(file)) continue;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!env[key]) env[key] = value;
  }
}

for (const key of ["TMB_APP_ID", "TMB_APP_KEY", "TRAM_CLIENT_ID", "TRAM_API_KEY"]) {
  if (process.env[key]) env[key] = process.env[key];
}

const port = Number(process.env.PORT) || 8787;

createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://127.0.0.1:${port}`);
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
      if (value == null) continue;
      headers.set(key, Array.isArray(value) ? value.join(", ") : value);
    }
    const response = await worker.fetch(new Request(url, { method: req.method, headers }), env);
    const buf = Buffer.from(await response.arrayBuffer());
    const out = {};
    response.headers.forEach((value, key) => {
      out[key] = value;
    });
    res.writeHead(response.status, out);
    res.end(buf);
  } catch (err) {
    const message = String(err && err.message ? err.message : err)
      .replace(/app_key=[^&\s]+/gi, "app_key=***")
      .replace(/app_id=[^&\s]+/gi, "app_id=***")
      .replace(/client_secret=[^&\s]+/gi, "client_secret=***");
    console.error(message);
    res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
    res.end("worker error");
  }
}).listen(port, "127.0.0.1", () => {
  const hasTmb = Boolean(env.TMB_APP_ID && env.TMB_APP_KEY);
  const hasTram = Boolean(env.TRAM_API_KEY);
  console.log(`worker http://127.0.0.1:${port}  tmb=${hasTmb ? "yes" : "no"}  tram=${hasTram ? "yes" : "no"}`);
});
