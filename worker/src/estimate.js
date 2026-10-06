import { decodePolyline } from "./polyline.js";
import { pointAt, shapeMetrics } from "./geo.js";

const metricsCache = new WeakMap();

export function normText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function sameStopCode(a, b) {
  const left = String(a ?? "").trim();
  const right = String(b ?? "").trim();
  if (!left || !right) return false;
  if (left === right) return true;
  if (/^\d+$/.test(left) && /^\d+$/.test(right)) return String(Number(left)) === String(Number(right));
  return false;
}

// temps_arribada is documented as an absolute arrival timestamp.
// Values above 1e12 are milliseconds; above 1e9 are unix seconds.
// A small number is a duration in seconds, not a guessed coordinate.
export function arrivalEtaSeconds(value, nowSec) {
  if (typeof value === "string" && value.includes("T")) {
    const ms = Date.parse(value);
    if (!Number.isFinite(ms)) return null;
    return clampEta(ms / 1000 - nowSec);
  }
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  if (n > 1e12) return clampEta(n / 1000 - nowSec);
  if (n > 1e9) return clampEta(n - nowSec);
  return clampEta(n);
}

function clampEta(eta) {
  if (eta < -45 || eta > 45 * 60) return null;
  return Math.max(0, eta);
}

function metricsFor(pattern) {
  let metrics = metricsCache.get(pattern);
  if (!metrics) {
    const points = pattern.shape ? decodePolyline(pattern.shape) : [];
    metrics = shapeMetrics(points);
    metricsCache.set(pattern, metrics);
  }
  return metrics;
}

export function choosePattern(patterns, { stopCode, destination, sentit }) {
  if (!patterns?.length) return null;
  const withStop = patterns.filter((p) => p.stops.some((s) => sameStopCode(s[0], stopCode)));
  const pool = withStop.length ? withStop : patterns;
  const want = normText(destination);
  let best = null;
  let bestScore = -1;
  for (const pattern of pool) {
    let score = withStop.length ? 10 : 0;
    const dest = normText(pattern.dest);
    if (want && dest) {
      if (want === dest) score += 100;
      else if (dest.includes(want) || want.includes(dest)) score += 70;
      else {
        const words = want.split(" ").filter((w) => w.length > 2);
        const hits = words.filter((w) => dest.includes(w)).length;
        if (words.length) score += Math.round(40 * hits / words.length);
      }
    }
    if (sentit === 1 && pattern.direction === 0) score += 5;
    if (sentit === 2 && pattern.direction === 1) score += 5;
    if (score > bestScore) {
      bestScore = score;
      best = pattern;
    }
  }
  if (!withStop.length && bestScore < 40) return null;
  return best;
}

// Place a bus on the GTFS shape using scheduled running time before `stopCode`.
// Returns null when the arrival is further away than the start of this pattern:
// the vehicle is not on this trip yet, and a point is not invented off the route.
export function placeOnPattern(pattern, stopCode, etaSec) {
  if (!pattern || etaSec == null) return null;
  const stops = pattern.stops;
  let idx = -1;
  for (let i = 0; i < stops.length; i++) {
    if (sameStopCode(stops[i][0], stopCode)) {
      idx = i;
      break;
    }
  }
  if (idx < 0) return null;
  const metrics = metricsFor(pattern);
  if (!metrics.points.length) return null;

  let i = idx;
  let rem = etaSec;
  while (i > 0) {
    const leg = stops[i][2] - stops[i - 1][2];
    if (!(leg > 0)) {
      i -= 1;
      continue;
    }
    if (rem <= leg) break;
    rem -= leg;
    i -= 1;
  }
  if (i === 0 && rem > 90) return null;

  const distEnd = stops[i][1];
  const secEnd = stops[i][2];
  const distStart = i === 0 ? distEnd : stops[i - 1][1];
  const secStart = i === 0 ? secEnd : stops[i - 1][2];
  const leg = Math.max(1, secEnd - secStart);
  const into = Math.min(leg, Math.max(0, leg - rem));
  const frac = into / leg;
  const dist = distStart + frac * (distEnd - distStart);
  const point = pointAt(metrics, dist);
  if (!point || !Number.isFinite(point.lat) || !Number.isFinite(point.lon)) return null;
  return {
    lat: point.lat,
    lon: point.lon,
    bearing: point.bearing,
    destination: pattern.dest || "",
  };
}
