import { execFile } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { encodePolyline } from "../worker/src/polyline.js";
import { haversineMeters, shapeMetrics } from "../worker/src/geo.js";
import { normText } from "../worker/src/estimate.js";

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cacheDir = path.join(root, ".cache");
const publicData = path.join(root, "public", "data");
const workerData = path.join(root, "worker", "data");
const refresh = process.argv.includes("--refresh");

const MIRROR = "https://storage.googleapis.com/storage/v1/b/mdb-latest/o/es-barcelona-transports-metropolitans-de-barcelona-tmb-gtfs-2359.zip?alt=media";
const FGC_URL = "https://www.fgc.cat/google/google_transit.zip";
const TRAM_URLS = [
  ["tbx.zip", "https://opendata.tram.cat/GTFS/zip/TBX.zip", 1],
  ["tbs.zip", "https://opendata.tram.cat/GTFS/zip/TBS.zip", 2],
];
const DEFAULT_ON = new Set(["tmb-metro:L1", "tmb-metro:L2", "tmb-metro:L3", "tmb-metro:L4", "tmb-metro:L5", "fgc:L6"]);

loadDotEnv(path.join(root, ".env"));
loadDotEnv(path.join(root, ".dev.vars"));

const ymd = madridYmd();
const weekday = new Intl.DateTimeFormat("en-US", { timeZone: "Europe/Madrid", weekday: "long" }).format(new Date()).toLowerCase();

await mkdir(cacheDir, { recursive: true });
await mkdir(publicData, { recursive: true });
await mkdir(workerData, { recursive: true });

const tmb = await loadTmb();
const fgcZip = await ensureZip("fgc.zip", FGC_URL);
const tramZips = [];
for (const [name, url, network] of TRAM_URLS) {
  tramZips.push({ zip: await ensureZip(name, url), network });
}

const catalog = [];
const lineFeatures = [];
const stopMap = new Map();
const busLines = {};
const alias = {};
const fgcTrips = [];
const tramTrips = [];
const tramRoutes = {};
const tramNetwork = {};

const tmbPack = await readFeed(tmb.zip);
addFeed(tmbPack, { operator: "tmb", network: null, tripOut: null });
const fgcPack = await readFeed(fgcZip);
addFeed(fgcPack, { operator: "fgc", network: null, tripOut: fgcTrips });
for (const item of tramZips) {
  const pack = await readFeed(item.zip);
  addFeed(pack, { operator: "tram", network: item.network, tripOut: tramTrips, tramRoutes, tramNetwork });
}

catalog.sort((a, b) => groupRank(a) - groupRank(b) || a.code.localeCompare(b.code, "en", { numeric: true }));

const fgcIndex = compactTrips(fgcTrips);
const busIndex = { alias, lines: busLines };
const tramIndex = { network: tramNetwork, routes: tramRoutes, trips: tramTrips };

await writeFile(path.join(publicData, "catalog.json"), JSON.stringify({ generated: new Date().toISOString(), lines: catalog }));
await writeFile(path.join(publicData, "lines.geojson"), JSON.stringify({ type: "FeatureCollection", features: lineFeatures }));
await writeFile(path.join(publicData, "stops.geojson"), JSON.stringify({
  type: "FeatureCollection",
  features: [...stopMap.values()],
}));
const tmbFeed = await feedMeta(tmb.zip);
const fgcFeed = await feedMeta(fgcZip);
await writeFile(path.join(publicData, "build-info.json"), JSON.stringify({
  built: new Date().toISOString(),
  serviceDate: ymd,
  sources: {
    tmb: { id: tmb.source, ...tmbFeed },
    fgc: { url: FGC_URL, ...fgcFeed },
    tram: TRAM_URLS.map((item) => item[1]),
  },
  counts: {
    lines: catalog.length,
    lineStrings: lineFeatures.length,
    stops: stopMap.size,
    busLines: Object.keys(busLines).length,
  },
}, null, 2));
await writeFile(path.join(workerData, "bus-index.json"), JSON.stringify(busIndex));
await writeFile(path.join(workerData, "fgc-index.json"), JSON.stringify(fgcIndex));
await writeFile(path.join(workerData, "tram-index.json"), JSON.stringify(tramIndex));

const busBytes = Buffer.byteLength(JSON.stringify(busIndex));
const fgcBytes = Buffer.byteLength(JSON.stringify(fgcIndex));
console.log(`lines ${catalog.length}  strings ${lineFeatures.length}  stops ${stopMap.size}`);
console.log(`bus index ${(busBytes / 1024).toFixed(0)} KiB   fgc index ${(fgcBytes / 1024).toFixed(0)} KiB (${fgcIndex.trips.length} keys)`);
if (!busLines.H6?.length) throw new Error("H6 pattern missing");
if (!catalog.some((line) => line.id === "tmb-metro:L1" && line.live === false)) throw new Error("L1 must stay static");
if (!catalog.some((line) => line.id === "fgc:L6")) throw new Error("FGC L6 missing");
if (!catalog.some((line) => line.id === "tram:T1")) throw new Error("TRAM T1 missing");

function loadDotEnv(file) {
  if (!existsSync(file)) return;
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
    if (!process.env[key]) process.env[key] = value;
  }
}

function madridYmd(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Madrid",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date).replaceAll("-", "");
}

async function loadTmb() {
  const id = process.env.TMB_APP_ID;
  const key = process.env.TMB_APP_KEY;
  if (id && key) {
    const url = `https://api.tmb.cat/v1/static/datasets/gtfs.zip?app_id=${encodeURIComponent(id)}&app_key=${encodeURIComponent(key)}`;
    try {
      return { zip: await ensureZip("tmb-official.zip", url), source: "tmb-api" };
    } catch (err) {
      console.warn("official TMB GTFS failed, using the public mirror:", err.message);
    }
  } else {
    console.warn("TMB_APP_ID / TMB_APP_KEY unset. Geometry comes from the Mobility Database mirror of the TMB GTFS.");
  }
  return { zip: await ensureZip("tmb-mirror.zip", MIRROR), source: "mobility-database-mirror" };
}

async function ensureZip(name, url) {
  const dest = path.join(cacheDir, name);
  if (!refresh && existsSync(dest) && (await stat(dest)).size > 1000) {
    console.log("cache", name);
    return dest;
  }
  console.log("download", name);
  const res = await fetch(url, {
    headers: { "user-agent": "Mozilla/5.0 bcn-transit-build/1.0" },
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`${name} HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 1000 || buf[0] !== 0x50) throw new Error(`${name} is not a zip`);
  await writeFile(dest, buf);
  return dest;
}

async function feedMeta(zip) {
  const rows = parseCsv(await unzipEntry(zip, "feed_info.txt"));
  const row = rows[0] || {};
  return {
    publisher: row.feed_publisher_name || "",
    version: row.feed_version || "",
    start: row.feed_start_date || "",
    end: row.feed_end_date || "",
  };
}

async function unzipEntry(zip, name) {
  try {
    const { stdout } = await execFileAsync("unzip", ["-p", zip, name], {
      maxBuffer: 96 * 1024 * 1024,
      encoding: "buffer",
    });
    return stdout.toString("utf8").replace(/^\uFEFF/, "");
  } catch (err) {
    const text = `${err.stderr || ""} ${err.message || ""}`;
    if (err.code === 11 || /cannot find|not found/i.test(text)) return "";
    throw err;
  }
}

function parseCsv(text) {
  if (!text.trim()) return [];
  const rows = [];
  let row = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cur += '"';
          i++;
        } else quoted = false;
      } else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(cur);
      cur = "";
    } else if (ch === "\n") {
      row.push(cur);
      rows.push(row);
      row = [];
      cur = "";
    } else if (ch !== "\r") cur += ch;
  }
  if (cur.length || row.length) {
    row.push(cur);
    rows.push(row);
  }
  const header = rows.shift();
  if (!header) return [];
  return rows.filter((cells) => cells.some(Boolean)).map((cells) => {
    const obj = {};
    header.forEach((key, index) => {
      obj[key] = cells[index] ?? "";
    });
    return obj;
  });
}

async function readFeed(zip) {
  const [routes, stops, trips, calendar, calendarDates, shapesText] = await Promise.all([
    unzipEntry(zip, "routes.txt"),
    unzipEntry(zip, "stops.txt"),
    unzipEntry(zip, "trips.txt"),
    unzipEntry(zip, "calendar.txt"),
    unzipEntry(zip, "calendar_dates.txt"),
    unzipEntry(zip, "shapes.txt"),
  ]);
  const stopTimes = await unzipEntry(zip, "stop_times.txt");
  return {
    routes: parseCsv(routes),
    stops: indexStops(parseCsv(stops)),
    trips: parseCsv(trips),
    services: activeServices(parseCsv(calendar), parseCsv(calendarDates)),
    shapes: loadShapes(shapesText),
    stopTimes,
  };
}

function indexStops(rows) {
  const map = new Map();
  for (const row of rows) {
    const lat = Number(row.stop_lat);
    const lon = Number(row.stop_lon);
    map.set(row.stop_id, {
      id: row.stop_id,
      code: (row.stop_code || "").trim(),
      name: (row.stop_name || "").trim(),
      lat,
      lon,
      location_type: row.location_type || "0",
      parent: row.parent_station || "",
    });
  }
  return map;
}

function activeServices(calendar, dates) {
  const set = new Set();
  for (const row of calendar) {
    if (ymd >= row.start_date && ymd <= row.end_date && row[weekday] === "1") set.add(row.service_id);
  }
  for (const row of dates) {
    if (row.date !== ymd) continue;
    if (row.exception_type === "1") set.add(row.service_id);
    if (row.exception_type === "2") set.delete(row.service_id);
  }
  return set;
}

function loadShapes(text) {
  const map = new Map();
  if (!text.trim()) return map;
  const lines = text.split(/\r?\n/);
  const header = splitCsvLite(lines[0]);
  const iId = header.indexOf("shape_id");
  const iLat = header.indexOf("shape_pt_lat");
  const iLon = header.indexOf("shape_pt_lon");
  const iSeq = header.indexOf("shape_pt_sequence");
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i]) continue;
    const cols = splitCsvLite(lines[i]);
    const lat = Number(cols[iLat]);
    const lon = Number(cols[iLon]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    if (Math.abs(lat) < 1 || Math.abs(lon) < 0.01) continue;
    let list = map.get(cols[iId]);
    if (!list) map.set(cols[iId], list = []);
    list.push([Number(cols[iSeq] || list.length), lon, lat]);
  }
  for (const [id, list] of map) {
    list.sort((a, b) => a[0] - b[0]);
    const points = [];
    for (const item of list) {
      const point = [item[1], item[2]];
      const prev = points[points.length - 1];
      if (prev && haversineMeters(prev, point) < 2) continue;
      points.push(point);
    }
    map.set(id, points);
  }
  return map;
}

function splitCsvLite(line) {
  return line.split(",");
}

function addFeed(pack, { operator, network, tripOut, tramRoutes, tramNetwork }) {
  const chosen = chooseTrips(pack.routes, pack.trips, pack.services);
  const { times, routeStops } = scanStopTimes(pack.stopTimes, chosen, pack.trips);
  const seenCodes = new Set();
  for (const route of pack.routes) {
    const mode = modeOf(operator, route.route_type);
    let code = (route.route_short_name || route.route_id || "").trim();
    if (!code) continue;
    if (seenCodes.has(`${operator}:${mode}:${code}`)) code = `${code}-${route.route_id}`;
    seenCodes.add(`${operator}:${mode}:${code}`);
    const id = lineId(operator, mode, code);
    const patterns = [];
    let west = Infinity;
    let south = Infinity;
    let east = -Infinity;
    let north = -Infinity;
    const shapeDest = new Map();
    for (const trip of chosen.get(route.route_id) || []) {
      const built = buildPattern(trip, times.get(trip.trip_id) || [], pack.shapes, pack.stops, mode);
      if (!built) continue;
      patterns.push(built);
      shapeDest.set(trip.shape_id, built.dest);
      for (const [lon, lat] of built.points) {
        west = Math.min(west, lon);
        east = Math.max(east, lon);
        south = Math.min(south, lat);
        north = Math.max(north, lat);
      }
      lineFeatures.push({
        type: "Feature",
        properties: {
          id,
          code,
          operator,
          mode,
          color: colorOf(route, mode),
          destination: built.dest,
        },
        geometry: { type: "LineString", coordinates: built.points.map(([lon, lat]) => [round5(lon), round5(lat)]) },
      });
    }
    if (!patterns.length) continue;
    for (const stopId of routeStops.get(route.route_id) || []) {
      addStop(stopId, mode, operator, id, pack.stops);
    }
    if (mode === "bus") {
      busLines[code] = patterns.map((pattern) => ({
        dest: pattern.dest,
        direction: pattern.direction,
        stops: pattern.stops,
        samples: pattern.samples,
        shape: pattern.shape,
      }));
      alias[code.toUpperCase()] = code;
      alias[String(route.route_id).toUpperCase()] = code;
      const middle = String(route.route_id).split(".")[1];
      if (middle && !alias[middle.toUpperCase()]) alias[middle.toUpperCase()] = code;
    }
    if (operator === "tram") {
      tramNetwork[code] = network;
      tramRoutes[code] = code;
      tramRoutes[code.toUpperCase()] = code;
      tramRoutes[String(route.route_id)] = code;
    }
    if (tripOut) {
      for (const trip of pack.trips) {
        if (trip.route_id !== route.route_id || !trip.trip_id) continue;
        const dest = (trip.trip_headsign || "").trim() || shapeDest.get(trip.shape_id) || patterns[0]?.dest || "";
        tripOut.push([trip.trip_id, code, dest]);
      }
    }
    catalog.push({
      id,
      code,
      name: (route.route_long_name || "").trim(),
      operator,
      mode,
      live: mode !== "metro",
      needsKey: operator === "tram",
      color: colorOf(route, mode),
      defaultOn: DEFAULT_ON.has(id),
      bbox: Number.isFinite(west) ? [round5(west), round5(south), round5(east), round5(north)] : null,
    });
  }
}

function chooseTrips(routes, trips, services) {
  const byRoute = new Map();
  for (const trip of trips) {
    let list = byRoute.get(trip.route_id);
    if (!list) byRoute.set(trip.route_id, list = []);
    list.push(trip);
  }
  const chosen = new Map();
  for (const route of routes) {
    const mine = byRoute.get(route.route_id) || [];
    const groups = new Map();
    for (const trip of mine) {
      const head = normText(trip.trip_headsign || "");
      const dir = trip.direction_id ?? "";
      const key = !head && dir === "" ? `shape:${trip.shape_id}` : `${dir}|${head}`;
      let list = groups.get(key);
      if (!list) groups.set(key, list = []);
      list.push(trip);
    }
    let entries = [...groups.values()].sort((a, b) => b.length - a.length).slice(0, 4);
    const picked = [];
    for (const list of entries) {
      const shapeCount = new Map();
      for (const trip of list) shapeCount.set(trip.shape_id, (shapeCount.get(trip.shape_id) || 0) + 1);
      const shapeId = [...shapeCount.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
      const candidates = list.filter((trip) => trip.shape_id === shapeId);
      const trip = candidates.find((item) => services.has(item.service_id)) || candidates[0];
      if (trip) picked.push(trip);
    }
    if (!picked.length && mine.length) {
      const fallback = mine.find((trip) => services.has(trip.service_id)) || mine[0];
      picked.push(fallback);
    }
    chosen.set(route.route_id, picked);
  }
  return chosen;
}

function scanStopTimes(text, chosen, trips) {
  const tripRoute = new Map(trips.map((trip) => [trip.trip_id, trip.route_id]));
  const wanted = new Set();
  for (const list of chosen.values()) for (const trip of list) wanted.add(trip.trip_id);
  const times = new Map();
  const routeStops = new Map();
  if (!text.trim()) return { times, routeStops };
  const lines = text.split(/\r?\n/);
  const header = lines[0].split(",");
  const iTrip = header.indexOf("trip_id");
  const iArr = header.indexOf("arrival_time");
  const iStop = header.indexOf("stop_id");
  const iSeq = header.indexOf("stop_sequence");
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const cols = line.split(",");
    const tripId = cols[iTrip];
    const routeId = tripRoute.get(tripId);
    if (!routeId) continue;
    const stopId = cols[iStop];
    let set = routeStops.get(routeId);
    if (!set) routeStops.set(routeId, set = new Set());
    set.add(stopId);
    if (!wanted.has(tripId)) continue;
    let arr = times.get(tripId);
    if (!arr) times.set(tripId, arr = []);
    arr.push({ seq: Number(cols[iSeq]), stopId, t: gtfsSeconds(cols[iArr]) });
  }
  for (const arr of times.values()) arr.sort((a, b) => a.seq - b.seq);
  return { times, routeStops };
}

function buildPattern(trip, rows, shapes, stops, mode) {
  if (rows.length < 2) return null;
  const base = rows[0].t;
  const sequence = [];
  for (const row of rows) {
    const stop = stops.get(row.stopId);
    if (!stop || !Number.isFinite(stop.lat) || !Number.isFinite(stop.lon)) continue;
    sequence.push({
      code: stop.code || stop.id,
      name: stop.name,
      lat: stop.lat,
      lon: stop.lon,
      t: Math.max(0, row.t - base),
    });
  }
  if (sequence.length < 2) return null;
  let points = shapes.get(trip.shape_id);
  if (!points || points.length < 2) points = sequence.map((stop) => [stop.lon, stop.lat]);
  points = simplify(points, mode === "bus" ? 12 : 16);
  if (points.length < 2) return null;
  const metrics = shapeMetrics(points);
  let cursor = 0;
  let poor = 0;
  for (const stop of sequence) {
    let found = projectFrom(stop, metrics, cursor);
    if (found.dist > 220) {
      const wide = projectFrom(stop, metrics, 0);
      if (wide.dist < found.dist) found = wide;
    }
    if (found.dist > 350) poor += 1;
    cursor = found.index;
    stop.d = found.along;
  }
  if (poor > sequence.length / 2) return null;
  for (let i = 1; i < sequence.length; i++) {
    if (sequence[i].d < sequence[i - 1].d) sequence[i].d = sequence[i - 1].d;
  }
  const last = sequence[sequence.length - 1];
  const dest = (trip.trip_headsign || last.name || "").trim();
  return {
    tripId: trip.trip_id,
    dest,
    direction: trip.direction_id === "" || trip.direction_id == null ? 0 : Number(trip.direction_id),
    points,
    shape: encodePolyline(points),
    stops: sequence.map((stop) => [stop.code, Math.round(stop.d), Math.round(stop.t)]),
    samples: pickSamples(sequence).map((stop) => [stop.code, round5(stop.lat), round5(stop.lon)]),
  };
}

function projectFrom(stop, metrics, start) {
  const { points, cum } = metrics;
  let best = { dist: Infinity, index: start, along: cum[Math.min(start, cum.length - 1)] || 0 };
  const end = points.length - 1;
  for (let i = start; i < end; i++) {
    const proj = projectSeg([stop.lon, stop.lat], points[i], points[i + 1]);
    if (proj.dist < best.dist) {
      best = {
        dist: proj.dist,
        index: i,
        along: cum[i] + proj.frac * (cum[i + 1] - cum[i]),
      };
    }
  }
  return best;
}

function projectSeg(p, a, b) {
  const lat0 = a[1];
  const P = xy(p, lat0);
  const A = xy(a, lat0);
  const B = xy(b, lat0);
  const dx = B[0] - A[0];
  const dy = B[1] - A[1];
  const len2 = dx * dx + dy * dy || 1;
  let frac = ((P[0] - A[0]) * dx + (P[1] - A[1]) * dy) / len2;
  frac = Math.max(0, Math.min(1, frac));
  const x = A[0] + frac * dx;
  const y = A[1] + frac * dy;
  return { frac, dist: Math.hypot(P[0] - x, P[1] - y) };
}

function xy(point, lat0) {
  const scale = Math.cos(lat0 * Math.PI / 180);
  return [point[0] * 111320 * scale, point[1] * 110540];
}

function simplify(points, eps) {
  if (points.length < 3) return points.slice();
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [from, to] = stack.pop();
    let max = 0;
    let idx = -1;
    for (let i = from + 1; i < to; i++) {
      const dist = projectSeg(points[i], points[from], points[to]).dist;
      if (dist > max) {
        max = dist;
        idx = i;
      }
    }
    if (idx >= 0 && max > eps) {
      keep[idx] = 1;
      stack.push([from, idx], [idx, to]);
    }
  }
  const out = [];
  for (let i = 0; i < points.length; i++) if (keep[i]) out.push(points[i]);
  return out;
}

function pickSamples(stops) {
  const picked = [];
  let last = -1e9;
  for (let i = 0; i < stops.length; i++) {
    if (i === stops.length - 1 || stops[i].t - last >= 420) {
      picked.push(stops[i]);
      last = stops[i].t;
    }
  }
  const capped = picked.length <= 8
    ? picked
    : Array.from({ length: 8 }, (_, i) => picked[Math.round(i * (picked.length - 1) / 7)]);
  const seen = new Set();
  const out = [];
  for (const stop of capped) {
    if (!stop.code || seen.has(stop.code)) continue;
    seen.add(stop.code);
    out.push(stop);
  }
  return out;
}

function addStop(stopId, mode, operator, lineIdValue, stops) {
  const stop = stops.get(stopId);
  if (!stop || !Number.isFinite(stop.lat) || !Number.isFinite(stop.lon)) return;
  if (stop.lat < 40 || stop.lat > 43.6 || stop.lon < -0.5 || stop.lon > 3.5) return;
  let use = stop;
  let kind = "stop";
  if (mode !== "bus") {
    const parent = stop.parent ? stops.get(stop.parent) : null;
    if (parent && Number.isFinite(parent.lat)) use = parent;
    if (stop.location_type === "1" || parent) kind = "station";
  }
  const key = `${operator}:${kind}:${use.id}`;
  let feature = stopMap.get(key);
  if (!feature) {
    feature = {
      type: "Feature",
      properties: {
        name: use.name,
        code: use.code || use.id,
        kind,
        lines: `,${lineIdValue},`,
      },
      geometry: { type: "Point", coordinates: [round5(use.lon), round5(use.lat)] },
    };
    stopMap.set(key, feature);
    return;
  }
  if (!feature.properties.lines.includes(`,${lineIdValue},`)) {
    feature.properties.lines += `${lineIdValue},`;
  }
}

function modeOf(operator, routeType) {
  if (operator === "tram") return "tram";
  if (operator === "fgc") return "fgc";
  if (routeType === "3") return "bus";
  return "metro";
}

function lineId(operator, mode, code) {
  if (operator === "tmb" && mode === "metro") return `tmb-metro:${code}`;
  if (operator === "tmb") return `tmb-bus:${code}`;
  if (operator === "fgc") return `fgc:${code}`;
  return `tram:${code}`;
}

function colorOf(route, mode) {
  const raw = String(route.route_color || "").replace("#", "").trim();
  if (/^[0-9a-fA-F]{6}$/.test(raw) && raw.toLowerCase() !== "000000") return `#${raw.toUpperCase()}`;
  const code = route.route_short_name || "";
  if (mode === "bus") {
    if (code.startsWith("H")) return "#003888";
    if (code.startsWith("V")) return "#6AB023";
    if (code.startsWith("D")) return "#93107E";
    if (code.startsWith("N")) return "#D0D7E2";
  }
  return "#9AABBE";
}

function groupRank(line) {
  if (line.mode === "metro") return 0;
  if (line.mode === "fgc") return 1;
  if (line.mode === "tram") return 2;
  return 3;
}

function gtfsSeconds(value) {
  const [h, m, s] = String(value || "").split(":").map(Number);
  if (!Number.isFinite(h)) return 0;
  return h * 3600 + (m || 0) * 60 + (s || 0);
}

function round5(n) {
  return Math.round(n * 1e5) / 1e5;
}

function compactTrips(rows) {
  const bySuffix = new Map();
  let ambiguous = false;
  for (const [tripId, line, dest] of rows) {
    const suffix = tripId.includes("|") ? tripId.split("|")[1] : "";
    if (!suffix) {
      ambiguous = true;
      break;
    }
    const prev = bySuffix.get(suffix);
    if (!prev) bySuffix.set(suffix, [line, dest]);
    else if (prev[0] !== line || prev[1] !== dest) {
      ambiguous = true;
      break;
    }
  }
  if (!ambiguous && bySuffix.size) {
    return { trips: [...bySuffix.entries()].map(([suffix, value]) => [suffix, value[0], value[1]]) };
  }
  const uniq = new Map();
  for (const row of rows) uniq.set(row[0], row);
  return { trips: [...uniq.values()] };
}
