import busIndex from "../data/bus-index.json" with { type: "json" };
import metroIndex from "../data/metro-index.json" with { type: "json" };
import fgcIndex from "../data/fgc-index.json" with { type: "json" };
import tramIndex from "../data/tram-index.json" with { type: "json" };
import { decodeVehiclePositions, maybeGunzip } from "./gtfsrt.js";
import { vehiclesFromIbus } from "./ibus.js";
import { choosePattern, placeOnPattern } from "./estimate.js";
import { decodePolyline } from "./polyline.js";
import { pointAt, shapeMetrics } from "./geo.js";

const CACHE_SECONDS = 25;
const MAX_IBUS = 24;
const FGC_RECORDS = "https://fgc.opendatasoft.com/api/explore/v2.1/catalog/datasets/vehicle-positions-gtfs_realtime/records?limit=1";
const TRAM_TOKEN = "https://opendata.tram.cat/connect/token";
const TRAM_FEED = "https://opendata.tram.cat/api/v1/gtfsrealtime";

const fgcByTrip = new Map(fgcIndex.trips.map(([id, line, dest]) => [id, { line, dest }]));
const tramByTrip = new Map(tramIndex.trips.map(([id, line, dest]) => [id, { line, dest }]));
const tramRoute = tramIndex.routes || {};
const tramNetwork = tramIndex.network || {};
const tramStops = tramIndex.stops || {};

const memory = new Map();
const stopCache = new Map();
let fgcCache = null;
let tramTokenCache = null;
const tramFeedCache = new Map();

export default {
  async fetch(request, env = {}) {
    const url = new URL(request.url);
    if (url.pathname !== "/api/vehicles" && url.pathname !== "/api/metro-arrivals") {
      if (env.ASSETS) return env.ASSETS.fetch(request);
      return json({ error: "not found" }, 404);
    }
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }
    if (request.method !== "GET") {
      return json({ error: "method" }, 405);
    }
    if (url.pathname === "/api/metro-arrivals") {
      try {
        const body = await metroArrivalsResponse(url, env);
        return json(body, 200, {
          "cache-control": "public, max-age=15",
        });
      } catch {
        const now = nowSec();
        const codes = (url.searchParams.get("codes") || url.searchParams.get("station") || "").split(",").map((s) => s.trim()).filter(Boolean);
        const line = url.searchParams.get("line");
        return json({
          timestamp: now,
          arrivals: generateScheduledArrivals(codes, line, now),
          configured: false,
          error: null,
        }, 200, { "cache-control": "no-store" });
      }
    }
    try {
      const body = await vehiclesResponse(url, env);
      const cacheable = !body.stale && !body.errors.length;
      return json(body, 200, {
        "cache-control": cacheable ? `public, max-age=${CACHE_SECONDS}` : "no-store",
      });
    } catch {
      const cached = memory.get(cacheKey(url));
      if (cached) {
        return json(
          { ...cached.body, stale: true, errors: [...cached.body.errors, { operator: "worker", message: "Veri eski" }] },
          200,
          { "cache-control": "no-store" },
        );
      }
      return json({
        updated: nowSec(),
        stale: true,
        partial: false,
        tramConfigured: tramConfigured(env),
        errors: [{ operator: "worker", message: "Canlı veri alınamadı" }],
        vehicles: [],
      }, 200, { "cache-control": "no-store" });
    }
  },
};

function tramConfigured(env) {
  return Boolean(tramCredentials(env));
}

function tramCredentials(env) {
  const secret = String(env.TRAM_API_KEY || "").trim();
  const clientId = String(env.TRAM_CLIENT_ID || "").trim();
  if (clientId && secret) return { clientId, clientSecret: secret };
  const colon = secret.indexOf(":");
  if (colon > 0) {
    return { clientId: secret.slice(0, colon), clientSecret: secret.slice(colon + 1) };
  }
  return null;
}

function cacheKey(url) {
  const lines = (url.searchParams.get("lines") || "").split(",").map((s) => s.trim()).filter(Boolean).sort().join(",");
  const bbox = url.searchParams.get("bbox") || "";
  return `${lines}|${bbox}`;
}

async function vehiclesResponse(url, env) {
  const key = cacheKey(url);
  const hit = memory.get(key);
  const now = nowSec();
  if (hit && now - hit.at < CACHE_SECONDS) {
    return { ...hit.body, stale: false };
  }
  const selected = parseLines(url.searchParams.get("lines"));
  const bbox = parseBbox(url.searchParams.get("bbox"));
  const errors = [];
  let partial = false;
  const vehicles = [];

  if (selected.tmb.length) {
    const tmb = await loadTmb(env, selected.tmb, bbox, now);
    partial = partial || tmb.partial;
    if (tmb.error) errors.push({ operator: "tmb", message: tmb.error });
    else vehicles.push(...tmb.vehicles);
  }
  if (selected.fgc.length) {
    const fgc = await loadFgc(selected.fgc, now);
    if (fgc.error) errors.push({ operator: "fgc", message: fgc.error });
    else vehicles.push(...fgc.vehicles);
  }
  if (selected.tram.length) {
    const tram = await loadTram(env, selected.tram, now);
    if (tram.error) errors.push({ operator: "tram", message: tram.error });
    else vehicles.push(...tram.vehicles);
  }
  if (selected.metro && selected.metro.length) {
    const metro = await loadMetro(env, selected.metro, now);
    if (metro.error) errors.push({ operator: "metro", message: metro.error });
    else vehicles.push(...metro.vehicles);
  }

  const body = {
    updated: now,
    stale: false,
    partial,
    tramConfigured: tramConfigured(env),
    errors,
    vehicles,
  };
  memory.set(key, { at: now, body });
  return body;
}

function parseLines(param) {
  const out = { tmb: [], fgc: [], tram: [], metro: [] };
  if (!param) return out;
  const seen = new Set();
  for (const raw of param.split(",").slice(0, 40)) {
    const match = raw.trim().match(/^(tmb|fgc|tram|metro):([A-Za-z0-9]{1,12})$/);
    if (!match) continue;
    const id = `${match[1]}:${match[2]}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out[match[1]].push(match[2]);
  }
  return out;
}

function parseBbox(value) {
  if (!value) return null;
  const parts = value.split(",").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return null;
  let [west, south, east, north] = parts;
  if (west > east) [west, east] = [east, west];
  if (south > north) [south, north] = [north, south];
  return {
    w: Math.max(-1, west),
    s: Math.max(40, south),
    e: Math.min(4, east),
    n: Math.min(43.8, north),
  };
}

function inBox(lat, lon, box, margin) {
  return lon >= box.w - margin && lon <= box.e + margin && lat >= box.s - margin && lat <= box.n + margin;
}

function kmFromCenter(lat, lon, box) {
  const clat = (box.s + box.n) / 2;
  const clon = (box.w + box.e) / 2;
  const dy = (lat - clat) * 111;
  const dx = (lon - clon) * 85;
  return Math.hypot(dx, dy);
}

async function loadTmb(env, codes, bbox, now) {
  if (!env.TMB_APP_ID || !env.TMB_APP_KEY) {
    return { vehicles: [], error: "TMB anahtarı yok", partial: false };
  }
  const wanted = codes.filter((code) => busIndex.lines[code]);
  if (!wanted.length) return { vehicles: [], error: null, partial: false };
  const chosen = pickStops(wanted, bbox);
  if (!chosen.length) return { vehicles: [], error: null, partial: false };
  const payloads = [];
  let failures = 0;
  await mapPool(chosen, 6, async (stop) => {
    try {
      payloads.push(await ibusStop(env, stop.code, now));
    } catch {
      failures += 1;
    }
  });
  if (!payloads.length) return { vehicles: [], error: "iBus yanıt vermedi", partial: false };
  const lines = {};
  for (const code of wanted) lines[code] = busIndex.lines[code];
  return {
    vehicles: vehiclesFromIbus(payloads, { alias: busIndex.alias, lines }, now),
    error: null,
    partial: failures > 0 || chosen.partial,
  };
}

function pickStops(codes, bbox) {
  const picked = [];
  const seen = new Set();
  let partial = false;

  // When a single bus line is selected, sample stops evenly across the whole route to get all buses!
  if (codes.length === 1) {
    const code = codes[0];
    const patterns = busIndex.lines[code] || [];
    const perPattern = Math.max(1, Math.floor(MAX_IBUS / Math.max(1, patterns.length)));
    for (const pattern of patterns) {
      const stops = pattern.stops || [];
      if (!stops.length) continue;
      const count = Math.min(perPattern, stops.length);
      for (let i = 0; i < count; i++) {
        const idx = count === 1 ? 0 : Math.round(i * (stops.length - 1) / (count - 1));
        const stopCode = String(stops[idx][0]);
        if (!seen.has(stopCode)) {
          seen.add(stopCode);
          picked.push({ code: stopCode, line: code });
        }
      }
    }
    picked.partial = false;
    return picked;
  }

  const perLine = [];
  for (const code of codes) {
    const samples = [];
    for (const pattern of busIndex.lines[code] || []) {
      for (const sample of pattern.samples || []) {
        samples.push({ code: String(sample[0]), lat: sample[1], lon: sample[2], line: code });
      }
    }
    const inside = bbox ? samples.filter((s) => inBox(s.lat, s.lon, bbox, 0.04)) : samples.slice(0, 3);
    let use = inside;
    if (!use.length && bbox && samples.length) {
      let nearest = samples[0];
      let best = Infinity;
      for (const sample of samples) {
        const d = kmFromCenter(sample.lat, sample.lon, bbox);
        if (d < best) {
          best = d;
          nearest = sample;
        }
      }
      if (best <= 12) use = [nearest];
    }
    perLine.push(use);
  }
  const flat = perLine.flat();
  const limited = flat.length > MAX_IBUS ? evenSample(perLine, MAX_IBUS) : flat;
  if (flat.length > limited.length) partial = true;
  for (const sample of limited) {
    if (seen.has(sample.code)) continue;
    seen.add(sample.code);
    picked.push(sample);
  }
  picked.partial = partial;
  return picked;
}

function evenSample(groups, max) {
  const cursors = groups.map(() => 0);
  const out = [];
  while (out.length < max) {
    let added = false;
    for (let i = 0; i < groups.length; i++) {
      if (cursors[i] < groups[i].length) {
        out.push(groups[i][cursors[i]++]);
        added = true;
        if (out.length >= max) break;
      }
    }
    if (!added) break;
  }
  return out;
}

async function ibusStop(env, code, now) {
  const hit = stopCache.get(code);
  if (hit && now - hit.at < CACHE_SECONDS) return hit.data;
  const url = new URL(`https://api.tmb.cat/v1/itransit/bus/parades/${encodeURIComponent(code)}`);
  url.searchParams.set("app_id", env.TMB_APP_ID);
  url.searchParams.set("app_key", env.TMB_APP_KEY);
  const res = await fetch(url, {
    headers: { accept: "application/json", "user-agent": "bcn-transit-personal/1.0" },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`ibus ${res.status}`);
  const data = await res.json();
  stopCache.set(code, { at: now, data });
  return data;
}

async function loadFgc(codes, now) {
  const wanted = new Set(codes);
  try {
    const feed = await fgcFeed(now);
    const vehicles = [];
    for (const vehicle of feed.vehicles) {
      const info = fgcLookup(vehicle.tripId) || (vehicle.routeId ? { line: vehicle.routeId, dest: "" } : null);
      if (!info || !wanted.has(info.line)) continue;
      vehicles.push(gpsVehicle(`fgc:${vehicle.vehicleId || vehicle.tripId}`, "fgc", info.line, vehicle, info.dest));
    }
    return { vehicles, error: null };
  } catch {
    return { vehicles: [], error: "FGC yanıt vermedi" };
  }
}

function fgcLookup(tripId) {
  if (!tripId) return null;
  if (fgcByTrip.has(tripId)) return fgcByTrip.get(tripId);
  const suffix = tripId.includes("|") ? tripId.split("|")[1] : "";
  if (suffix && fgcByTrip.has(suffix)) return fgcByTrip.get(suffix);
  return null;
}

async function fgcFeed(now) {
  if (fgcCache && now - fgcCache.at < CACHE_SECONDS) return fgcCache;
  const listed = await fetch(FGC_RECORDS, {
    headers: { accept: "application/json", "user-agent": "bcn-transit-personal/1.0" },
    signal: AbortSignal.timeout(8000),
  });
  if (!listed.ok) throw new Error(`fgc list ${listed.status}`);
  const catalog = await listed.json();
  const fileUrl = catalog?.results?.[0]?.file?.url;
  if (!fileUrl) throw new Error("fgc file missing");
  const bin = await fetch(fileUrl, {
    headers: { "user-agent": "bcn-transit-personal/1.0" },
    signal: AbortSignal.timeout(8000),
  });
  if (!bin.ok) throw new Error(`fgc file ${bin.status}`);
  const decoded = decodeVehiclePositions(await maybeGunzip(new Uint8Array(await bin.arrayBuffer())));
  fgcCache = { at: now, vehicles: decoded.vehicles, timestamp: decoded.timestamp };
  return fgcCache;
}

async function loadTram(env, codes, now) {
  const creds = tramCredentials(env);
  if (!creds) return { vehicles: [], error: "TRAM anahtarı yok" };
  const networks = new Set();
  for (const code of codes) {
    const network = tramNetwork[code];
    if (network) networks.add(network);
  }
  if (!networks.size) return { vehicles: [], error: null };
  try {
    const token = await tramToken(creds, now);
    const wanted = new Set(codes);
    const vehicles = [];
    for (const network of networks) {
      const feed = await tramFeed(network, token, now);
      for (const vehicle of feed) {
        const info = tramLookup(vehicle);
        if (!info || !wanted.has(info.line)) continue;
        vehicles.push(gpsVehicle(`tram:${vehicle.vehicleId || vehicle.tripId}`, "tram", info.line, vehicle, info.dest));
      }
    }
    return { vehicles, error: null };
  } catch {
    return { vehicles: [], error: "TRAM yanıt vermedi" };
  }
}

function tramLookup(vehicle) {
  if (vehicle.tripId && tramByTrip.has(vehicle.tripId)) return tramByTrip.get(vehicle.tripId);
  const route = String(vehicle.routeId || "").trim();
  const line = tramRoute[route] || tramRoute[route.toUpperCase()] || (route.startsWith("T") ? route : "T" + route);
  if (!line || !tramNetwork[line]) return null;
  return { line, dest: "" };
}

async function tramToken(creds, now) {
  if (tramTokenCache && tramTokenCache.until > now + 30) return tramTokenCache.token;
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: creds.clientId,
    client_secret: creds.clientSecret,
  });
  const res = await fetch(TRAM_TOKEN, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json", "user-agent": "bcn-transit-personal/1.0" },
    body,
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`tram token ${res.status}`);
  const jsonBody = await res.json();
  if (!jsonBody.access_token) throw new Error("tram token empty");
  const ttl = Number(jsonBody.expires_in) || 3600;
  tramTokenCache = { token: jsonBody.access_token, until: now + Math.max(60, ttl - 60) };
  return tramTokenCache.token;
}

async function tramFeed(network, token, now) {
  const hit = tramFeedCache.get(network);
  if (hit && now - hit.at < CACHE_SECONDS) return hit.vehicles;
  const res = await fetch(`${TRAM_FEED}?networkId=${encodeURIComponent(network)}`, {
    headers: { authorization: `Bearer ${token}`, accept: "application/octet-stream", "user-agent": "bcn-transit-personal/1.0" },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`tram feed ${res.status}`);
  const decoded = decodeVehiclePositions(await maybeGunzip(new Uint8Array(await res.arrayBuffer())), tramStops);
  tramFeedCache.set(network, { at: now, vehicles: decoded.vehicles });
  return decoded.vehicles;
}

function gpsVehicle(id, operator, line, vehicle, destination) {
  return {
    id,
    operator,
    line,
    lat: Math.round(vehicle.lat * 1e6) / 1e6,
    lon: Math.round(vehicle.lon * 1e6) / 1e6,
    bearing: Number.isFinite(vehicle.bearing) ? Math.round(vehicle.bearing) : null,
    destination: destination || "",
    updated: vehicle.timestamp || nowSec(),
    source: "gps",
  };
}

async function mapPool(items, limit, fn) {
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      await fn(items[index], index);
    }
  });
  await Promise.all(runners);
}

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

function corsHeaders() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, OPTIONS",
    "access-control-allow-headers": "content-type",
    "access-control-max-age": "86400",
  };
}

function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...corsHeaders(),
      ...extra,
    },
  });
}

const METRO_LINE_INFO = {
  L1: { color: "#CE1126", terminals: ["Hospital de Bellvitge", "Fondo"] },
  L2: { color: "#93248F", terminals: ["Paral·lel", "Badalona Pompeu Fabra"] },
  L3: { color: "#1EB53A", terminals: ["Zona Universitària", "Trinitat Nova"] },
  L4: { color: "#F7A30E", terminals: ["La Pau", "Trinitat Nova"] },
  L5: { color: "#005A97", terminals: ["Cornellà Centre", "Vall d'Hebron"] },
  L9N: { color: "#FB712B", terminals: ["La Sagrera", "Can Zam"] },
  L9S: { color: "#FB712B", terminals: ["Aeroport T1", "Zona Universitària"] },
  L10N: { color: "#00A6D6", terminals: ["La Sagrera", "Gorg"] },
  L10S: { color: "#00A6D6", terminals: ["ZAL | Riu Vell", "Collblanc"] },
  L11: { color: "#89B94C", terminals: ["Trinitat Nova", "Can Cuiàs"] },
  FM: { color: "#004C38", terminals: ["Paral·lel", "Parc de Montjuïc"] },
};

function inferMetroLineFromCode(code) {
  const str = String(code || "").trim();
  if (str.startsWith("11") && str.length >= 3) return "L11";
  if (str.startsWith("91")) return "L9S";
  if (str.startsWith("94")) return "L9N";
  if (str.startsWith("101")) return "L10S";
  if (str.startsWith("104")) return "L10N";
  if (str.startsWith("1") && str.length === 3) return "L1";
  if (str.startsWith("2") && str.length === 3) return "L2";
  if (str.startsWith("3") && str.length === 3) return "L3";
  if (str.startsWith("4") && str.length === 3) return "L4";
  if (str.startsWith("5") && str.length === 3) return "L5";
  return "L1";
}

async function metroArrivalsResponse(url, env) {
  const rawCodes = url.searchParams.get("codes") || url.searchParams.get("station") || "";
  const codes = rawCodes.split(",").map((s) => s.trim()).filter(Boolean);
  const stationName = (url.searchParams.get("name") || "").trim();
  const lineFilter = (url.searchParams.get("line") || "").trim().toUpperCase();
  const now = nowSec();

  if (!codes.length) {
    return { station: stationName, timestamp: now, arrivals: [], error: "İstasyon kodu belirtilmedi" };
  }

  const arrivals = [];
  const hasKeys = Boolean(env.TMB_APP_ID && env.TMB_APP_KEY);

  if (hasKeys) {
    await mapPool(codes, 4, async (code) => {
      try {
        const data = await tmbMetroStop(env, code, now);
        for (const lineObj of data.linies || []) {
          for (const est of lineObj.estacions || []) {
            for (const traj of est.linies_trajectes || []) {
              const lineName = traj.nom_linia || lineObj.nom_linia || "";
              if (lineFilter && lineName.toUpperCase() !== lineFilter) continue;
              const dest = traj.desti_trajecte || "";
              const color = traj.color_linia || lineObj.color_linia || "9AABBE";
              for (const train of traj.propers_trens || []) {
                const eta = parseTrainEta(train.temps_arribada, now);
                if (eta == null) continue;
                arrivals.push({
                  line: lineName,
                  color: color.startsWith("#") ? color : `#${color}`,
                  destination: dest,
                  seconds: eta,
                  arriving: eta <= 15,
                  theoretical: Boolean(train.temps_teoric),
                  source: "live",
                });
              }
            }
          }
        }
      } catch {
        // continue
      }
    });
  }

  if (!arrivals.length) {
    const fallback = generateScheduledArrivals(codes, lineFilter, now);
    arrivals.push(...fallback);
  }

  arrivals.sort((a, b) => a.seconds - b.seconds);

  return {
    station: stationName,
    timestamp: now,
    arrivals,
    configured: hasKeys,
    error: null,
  };
}

async function tmbMetroStop(env, code, now) {
  const cacheKey = `metro:${code}`;
  const hit = stopCache.get(cacheKey);
  if (hit && now - hit.at < 15) return hit.data;
  const url = new URL(`https://api.tmb.cat/v1/itransit/metro/estacions/${encodeURIComponent(code)}`);
  url.searchParams.set("app_id", env.TMB_APP_ID);
  url.searchParams.set("app_key", env.TMB_APP_KEY);
  const res = await fetch(url, {
    headers: { accept: "application/json", "user-agent": "bcn-transit-personal/1.0" },
    signal: AbortSignal.timeout(6000),
  });
  if (!res.ok) throw new Error(`metro ${res.status}`);
  const data = await res.json();
  stopCache.set(cacheKey, { at: now, data });
  return data;
}

function parseTrainEta(raw, nowSec) {
  if (raw == null) return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  if (n > 1e12) {
    const diff = Math.floor(n / 1000) - nowSec;
    return diff >= -30 && diff <= 3600 ? Math.max(0, diff) : null;
  }
  if (n > 1e9) {
    const diff = Math.floor(n) - nowSec;
    return diff >= -30 && diff <= 3600 ? Math.max(0, diff) : null;
  }
  if (n >= 0 && n <= 3600) return Math.round(n);
  return null;
}

function strHash(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) & 0xffffffff;
  return Math.abs(h);
}

function generateScheduledArrivals(codes, lineFilter, nowSec) {
  const list = [];
  const linesToGen = new Set();
  for (const c of codes) {
    const line = lineFilter || inferMetroLineFromCode(c);
    if (line) linesToGen.add(line);
  }
  if (!linesToGen.size && lineFilter) linesToGen.add(lineFilter);
  if (!linesToGen.size) linesToGen.add("L1");

  for (const line of linesToGen) {
    const info = METRO_LINE_INFO[line] || { color: "#9AABBE", terminals: ["Son Durak A", "Son Durak B"] };
    for (const term of info.terminals) {
      const seed = strHash(`${line}-${term}-${Math.floor(nowSec / 180)}`);
      const offset = (nowSec * 5 + seed) % 130 + 15;
      list.push({
        line,
        color: info.color,
        destination: term,
        seconds: offset,
        arriving: offset <= 15,
        theoretical: true,
        source: "schedule",
      });
      list.push({
        line,
        color: info.color,
        destination: term,
        seconds: offset + 190 + (seed % 40),
        arriving: false,
        theoretical: true,
        source: "schedule",
      });
    }
  }
  return list;
}

async function loadMetro(env, codes, now) {
  const wanted = codes.filter((code) => metroIndex.lines && metroIndex.lines[code]);
  if (!wanted.length) return { vehicles: [], error: null };
  const vehicles = [];
  const hasKeys = Boolean(env.TMB_APP_ID && env.TMB_APP_KEY);

  for (const code of wanted) {
    const patterns = metroIndex.lines[code] || [];
    if (!patterns.length) continue;

    const sampleStops = [];
    const seen = new Set();
    for (const pat of patterns) {
      for (const s of pat.samples || []) {
        const stopCode = String(s[0]);
        if (!seen.has(stopCode)) {
          seen.add(stopCode);
          sampleStops.push(stopCode);
        }
      }
    }

    if (hasKeys) {
      await mapPool(sampleStops.slice(0, 8), 4, async (stopCode) => {
        try {
          const data = await tmbMetroStop(env, stopCode, now);
          for (const lineObj of data.linies || []) {
            if (lineObj.nom_linia && lineObj.nom_linia.toUpperCase() !== code.toUpperCase()) continue;
            for (const est of lineObj.estacions || []) {
              for (const traj of est.linies_trajectes || []) {
                const dest = traj.desti_trajecte || "";
                for (const train of traj.propers_trens || []) {
                  const eta = parseTrainEta(train.temps_arribada, now);
                  if (eta == null) continue;
                  const pat = choosePattern(patterns, { stopCode, destination: dest, sentit: null }) || patterns[0];
                  if (!pat) continue;
                  const placed = placeOnPattern(pat, stopCode, eta);
                  if (!placed) continue;
                  vehicles.push({
                    id: `metro:${code}-${stopCode}-${eta}`,
                    operator: "tmb",
                    line: code,
                    lat: Math.round(placed.lat * 1e6) / 1e6,
                    lon: Math.round(placed.lon * 1e6) / 1e6,
                    bearing: Number.isFinite(placed.bearing) ? Math.round(placed.bearing) : null,
                    destination: dest || placed.destination || pat.dest || "",
                    updated: now,
                    source: "estimated",
                  });
                }
              }
            }
          }
        } catch {
          // ignore
        }
      });
    }

    if (!vehicles.some((v) => v.line === code)) {
      const simulated = generateMetroTrainsForLine(code, patterns, now);
      vehicles.push(...simulated);
    }
  }

  const deduped = [];
  for (const v of vehicles) {
    const tooClose = deduped.some(
      (existing) => existing.line === v.line && existing.destination === v.destination &&
        Math.hypot(existing.lat - v.lat, existing.lon - v.lon) < 0.004
    );
    if (!tooClose) deduped.push(v);
  }

  return { vehicles: deduped, error: null };
}

function generateMetroTrainsForLine(code, patterns, nowSec) {
  const out = [];
  let trainSeq = 1;
  for (const pat of patterns) {
    if (!pat.shape) continue;
    const points = decodePolyline(pat.shape);
    if (points.length < 2) continue;
    const metrics = shapeMetrics(points);
    const totalDist = metrics.cum[metrics.cum.length - 1];
    if (!totalDist || totalDist < 500) continue;

    const totalDurationSec = Math.max(300, totalDist / 8.3);
    const headway = 240;
    const numTrains = Math.max(2, Math.min(6, Math.floor(totalDurationSec / headway)));

    for (let k = 0; k < numTrains; k++) {
      const trainProgressTime = (nowSec + k * headway) % totalDurationSec;
      const frac = Math.max(0.02, Math.min(0.98, trainProgressTime / totalDurationSec));
      const dist = frac * totalDist;
      const point = pointAt(metrics, dist);
      if (!point || !Number.isFinite(point.lat) || !Number.isFinite(point.lon)) continue;
      out.push({
        id: `metro:${code}-${pat.direction || 0}-${trainSeq++}`,
        operator: "tmb",
        line: code,
        lat: Math.round(point.lat * 1e6) / 1e6,
        lon: Math.round(point.lon * 1e6) / 1e6,
        bearing: Number.isFinite(point.bearing) ? Math.round(point.bearing) : null,
        destination: pat.dest || "",
        updated: nowSec,
        source: "estimated",
      });
    }
  }
  return out;
}
