import { arrivalEtaSeconds, choosePattern, placeOnPattern, sameStopCode } from "./estimate.js";

function paradesOf(payload) {
  if (!payload || typeof payload !== "object") return [];
  if (Array.isArray(payload.parades)) return payload.parades;
  if (payload.data && Array.isArray(payload.data.parades)) return payload.data.parades;
  return [];
}

function lineKey(alias, raw) {
  const text = String(raw ?? "").trim();
  if (!text) return null;
  return alias[text.toUpperCase()] || alias[text] || null;
}

// One vehicle per fleet id. The soonest arrival is the next stop; that ETA
// is walked backwards along the scheduled pattern. No coordinate is invented
// when the stop is not on a known shape.
export function vehiclesFromIbus(payloads, { alias, lines }, nowSec) {
  const best = new Map();
  for (const payload of payloads) {
    const stamp = Number(payload?.timestamp);
    const observed = stamp > 1e12 ? Math.floor(stamp / 1000) : stamp > 1e9 ? Math.floor(stamp) : nowSec;
    for (const parade of paradesOf(payload)) {
      const stopCode = String(parade.codi_parada ?? parade.codiParada ?? "").trim();
      const trajectories = parade.linies_trajectes || parade.liniesTrajectes || [];
      for (const traj of trajectories) {
        const code = lineKey(alias, traj.codi_linia) || lineKey(alias, traj.nom_linia) || lineKey(alias, traj.codiLinia);
        if (!code || !lines[code]) continue;
        const buses = traj.propers_busos || traj.propersBusos || [];
        for (const bus of buses) {
          const id = bus.id_bus ?? bus.idBus;
          if (id == null || id === "") continue;
          const eta = arrivalEtaSeconds(bus.temps_arribada ?? bus.tempsArribada, nowSec);
          if (eta == null) continue;
          const key = String(id);
          const prev = best.get(key);
          if (prev && prev.eta <= eta) continue;
          best.set(key, {
            id: key,
            code,
            stopCode,
            eta,
            destination: String(traj.desti_trajecte || traj.destiTrajecte || ""),
            sentit: Number(traj.id_sentit ?? traj.idSentit) || null,
            observed,
          });
        }
      }
    }
  }

  const vehicles = [];
  for (const item of best.values()) {
    const pattern = choosePattern(lines[item.code], item);
    if (!pattern) continue;
    if (!pattern.stops.some((s) => sameStopCode(s[0], item.stopCode))) continue;
    const placed = placeOnPattern(pattern, item.stopCode, item.eta);
    if (!placed) continue;
    vehicles.push({
      id: `tmb:${item.id}`,
      operator: "tmb",
      line: item.code,
      lat: round5(placed.lat),
      lon: round5(placed.lon),
      bearing: roundBearing(placed.bearing),
      destination: placed.destination || item.destination || "",
      updated: item.observed,
      source: "estimated",
    });
  }
  return vehicles;
}

function round5(n) {
  return Math.round(n * 1e5) / 1e5;
}

function roundBearing(n) {
  if (!Number.isFinite(n)) return null;
  return Math.round(n);
}
