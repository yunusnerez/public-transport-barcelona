"use strict";

const STORE_KEY = "bcn-lines-v1";
const POLL_MS = 28000;
const GROUPS = [
  {
    id: "metro",
    title: "TMB Metro",
    chip: "statik",
    chipClass: "static",
    note: "Canlı tren GPS'i yok. Yalnızca hat ve istasyon.",
    match: (line) => line.mode === "metro",
  },
  {
    id: "fgc",
    title: "FGC",
    chip: "gps",
    chipClass: "gps",
    note: "Gerçek araç konumu (GPS).",
    match: (line) => line.mode === "fgc",
  },
  {
    id: "tram",
    title: "TRAM",
    chip: "gps",
    chipClass: "gps",
    note: "Gerçek araç konumu (GPS). Anahtar yoksa katman kapalı.",
    match: (line) => line.mode === "tram",
  },
  {
    id: "bus",
    title: "TMB Otobüs",
    chip: "tahmini",
    chipClass: "est",
    note: "Konum tahmini. iBus varış süresinden, gerçek GPS değil.",
    match: (line) => line.mode === "bus",
  },
];

const statusEl = document.getElementById("status");
const statusMain = document.getElementById("status-main");
const statusNote = document.getElementById("status-note");
const panel = document.getElementById("panel");
const panelBody = document.getElementById("panel-body");
const sheetToggle = document.getElementById("sheet-toggle");
const search = document.getElementById("search");
const groupsEl = document.getElementById("groups");

const byId = new Map();
const geometry = new Map();
const buttons = new Map();
let enabled = new Set();
let catalog = [];
let tramConfigured = null;
let everOk = false;
let workerDown = false;
let lastGood = null;
let pollTimer = 0;
let moveTimer = 0;
let pollGen = 0;
let popupVehicleId = null;

const vehicles = { tmb: new Map(), fgc: new Map(), tram: new Map() };
const markers = new Map();

const narrowQuery = window.matchMedia("(max-width: 760px)");
if (narrowQuery.matches) panel.classList.add("collapsed");
sheetToggle.setAttribute("aria-expanded", panel.classList.contains("collapsed") ? "false" : "true");

sheetToggle.addEventListener("click", () => {
  panel.classList.toggle("collapsed");
  const open = !panel.classList.contains("collapsed");
  sheetToggle.setAttribute("aria-expanded", open ? "true" : "false");
  layout();
});

search.addEventListener("input", filterList);
window.addEventListener("resize", layout);
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    clearTimeout(pollTimer);
    return;
  }
  if (typeof window.__bcnPoll === "function") window.__bcnPoll(true);
  arm(POLL_MS);
});

if (!window.maplibregl) {
  setStatus("quiet", "Harita yüklenemedi", "");
} else {
  boot();
}

function boot() {
  const map = new maplibregl.Map({
    container: "map",
    style: "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json",
    center: [2.17, 41.39],
    zoom: 12,
    padding: panelPadding(),
    dragRotate: false,
    pitchWithRotate: false,
    attributionControl: true,
  });
  map.touchPitch.disable();
  window.__bcnMap = map;

  const popup = new maplibregl.Popup({ closeButton: true, maxWidth: "280px", offset: 18, className: "bcn-pop" });
  popup.on("close", () => {
    popupVehicleId = null;
  });

  map.on("load", async () => {
    setStatus("quiet", "Hatlar yükleniyor", "");
    try {
      const [catDoc, lineDoc, stopDoc] = await Promise.all([
        fetch("data/catalog.json").then(readJson),
        fetch("data/lines.geojson").then(readJson),
        fetch("data/stops.geojson").then(readJson),
      ]);
      catalog = catDoc.lines || [];
      for (const line of catalog) byId.set(line.id, line);
      for (const feature of lineDoc.features || []) {
        const id = feature.properties && feature.properties.id;
        if (!id) continue;
        let list = geometry.get(id);
        if (!list) geometry.set(id, list = []);
        list.push(feature);
      }
      enabled = loadEnabled(catalog);
      map.addSource("lines", { type: "geojson", data: lineDoc });
      map.addSource("stops", { type: "geojson", data: stopDoc });
      map.addLayer({
        id: "lines-bus",
        type: "line",
        source: "lines",
        filter: ["==", ["get", "mode"], "bus"],
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": ["coalesce", ["get", "color"], "#9AABBE"],
          "line-width": ["interpolate", ["linear"], ["zoom"], 10, 1.1, 14, 2.2, 16, 3.6],
          "line-opacity": 0.8,
        },
      });
      map.addLayer({
        id: "lines-rail",
        type: "line",
        source: "lines",
        filter: ["!=", ["get", "mode"], "bus"],
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": ["coalesce", ["get", "color"], "#9AABBE"],
          "line-width": ["interpolate", ["linear"], ["zoom"], 10, 2.2, 14, 4, 16, 6],
          "line-opacity": 0.92,
        },
      });
      map.addLayer({
        id: "stops-station",
        type: "circle",
        source: "stops",
        filter: ["==", ["get", "kind"], "station"],
        paint: {
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 11, 3, 15, 6],
          "circle-color": "#d5deea",
          "circle-stroke-width": 1,
          "circle-stroke-color": "#0e141b",
        },
      });
      map.addLayer({
        id: "stops-bus",
        type: "circle",
        source: "stops",
        minzoom: 14,
        filter: ["==", ["get", "kind"], "stop"],
        paint: {
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 14, 2.5, 17, 5],
          "circle-color": "#9aabbe",
          "circle-stroke-width": 1,
          "circle-stroke-color": "#0e141b",
          "circle-opacity": 0.9,
        },
      });
      map.on("click", "stops-station", (event) => showStop(map, popup, event));
      map.on("click", "stops-bus", (event) => showStop(map, popup, event));
      map.on("mouseenter", "stops-station", () => { map.getCanvas().style.cursor = "pointer"; });
      map.on("mouseleave", "stops-station", () => { map.getCanvas().style.cursor = ""; });
      renderGroups();
      applyFilters(map);
      layout();
      map.on("moveend", () => {
        clearTimeout(moveTimer);
        moveTimer = setTimeout(() => {
          poll(false);
          arm(POLL_MS);
        }, 400);
      });
      await poll(true);
      arm(POLL_MS);
    } catch (err) {
      setStatus("quiet", "Hat verisi yüklenemedi", "");
      console.error(err);
    }
  });

  map.on("error", (event) => {
    if (event && event.error) console.error(event.error);
  });

  function showStop(mapObj, pop, event) {
    const feature = event.features && event.features[0];
    if (!feature) return;
    const name = feature.properties.name || "Durak";
    const code = feature.properties.code || "";
    pop.setLngLat(event.lngLat).setHTML(
      `<div class="pop"><b>${esc(name)}</b><div>${esc(code)}</div></div>`,
    ).addTo(mapObj);
    popupVehicleId = null;
  }

  function renderGroups() {
    groupsEl.replaceChildren();
    for (const group of GROUPS) {
      const lines = catalog.filter(group.match);
      const section = document.createElement("section");
      section.className = "group";
      section.dataset.group = group.id;
      const head = document.createElement("div");
      head.className = "group-head";
      const title = document.createElement("h2");
      title.textContent = group.title;
      const chip = document.createElement("span");
      chip.className = `chip ${group.chipClass}`;
      chip.textContent = group.chip;
      title.append(chip);
      const bulk = document.createElement("button");
      bulk.type = "button";
      bulk.className = "group-toggle";
      bulk.textContent = "tümü";
      bulk.addEventListener("click", () => toggleGroup(lines, bulk));
      head.append(title, bulk);
      const note = document.createElement("p");
      note.textContent = group.note;
      const keyNote = document.createElement("p");
      keyNote.className = "key-missing";
      keyNote.hidden = true;
      keyNote.textContent = "TRAM anahtarı yok";
      if (group.id === "tram") keyNote.id = "tram-key";
      const list = document.createElement("div");
      list.className = "lines";
      for (const line of lines) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "line";
        button.dataset.code = line.code;
        button.dataset.name = line.name || "";
        button.setAttribute("aria-pressed", enabled.has(line.id) ? "true" : "false");
        const swatch = document.createElement("i");
        swatch.className = "swatch";
        swatch.style.background = line.color;
        const code = document.createElement("b");
        code.textContent = line.code;
        const name = document.createElement("small");
        name.textContent = line.name || "";
        button.append(swatch, code, name);
        button.addEventListener("click", () => {
          if (enabled.has(line.id)) enabled.delete(line.id);
          else enabled.add(line.id);
          saveEnabled();
          button.setAttribute("aria-pressed", enabled.has(line.id) ? "true" : "false");
          applyFilters(map);
          syncMarkers(popup);
          poll(true);
          arm(POLL_MS);
        });
        buttons.set(line.id, button);
        list.append(button);
      }
      section.append(head, note);
      if (group.id === "tram") section.append(keyNote);
      section.append(list);
      groupsEl.append(section);
    }
    filterList();
    updateTramKey();
  }

  function toggleGroup(lines, bulk) {
    const visible = lines.filter((line) => {
      const button = buttons.get(line.id);
      return button && !button.hidden;
    });
    const allOn = visible.every((line) => enabled.has(line.id));
    for (const line of visible) {
      if (allOn) enabled.delete(line.id);
      else enabled.add(line.id);
      const button = buttons.get(line.id);
      if (button) button.setAttribute("aria-pressed", enabled.has(line.id) ? "true" : "false");
    }
    bulk.textContent = allOn ? "tümü" : "kapat";
    saveEnabled();
    applyFilters(map);
    syncMarkers(popup);
    poll(true);
    arm(POLL_MS);
  }

  async function poll(force) {
    const selected = visibleLiveLines(map);
    if (!force && workerDown && selected.length === 0 && tramConfigured !== null) return;
    if (selected.length === 0 && tramConfigured !== null) {
      clearLiveOperators();
      syncMarkers(popup);
      if (everOk) setStatus("ok", refreshLabel(lastGood), "");
      return;
    }
    const gen = ++pollGen;
    const ctrl = new AbortController();
    const kill = setTimeout(() => ctrl.abort(), 22000);
    try {
      const params = new URLSearchParams();
      if (selected.length) params.set("lines", selected.join(","));
      params.set("bbox", bboxParam(map));
      const base = apiBase();
      const res = await fetch(`${base}/api/vehicles?${params}`, {
        signal: ctrl.signal,
        headers: { accept: "application/json" },
      });
      if (!res.ok) throw new Error(String(res.status));
      const body = await res.json();
      if (gen !== pollGen) return;
      everOk = true;
      workerDown = false;
      lastGood = body;
      if (typeof body.tramConfigured === "boolean") tramConfigured = body.tramConfigured;
      applyBody(body);
      syncMarkers(popup);
      updateTramKey();
      paintStatus(body, false);
    } catch {
      if (gen !== pollGen) return;
      if (!everOk) {
        workerDown = true;
        setStatus("quiet", "Canlı katman kapalı", "");
      } else {
        paintStatus(lastGood, true);
      }
    } finally {
      clearTimeout(kill);
    }
  }

  window.__bcnPoll = poll;

  function applyBody(body) {
    const erred = new Set((body.errors || []).map((item) => item.operator));
    const incoming = { tmb: [], fgc: [], tram: [] };
    for (const raw of body.vehicles || []) {
      if (!incoming[raw.operator]) continue;
      if (raw.source !== "gps" && raw.source !== "estimated") continue;
      if (!Number.isFinite(raw.lat) || !Number.isFinite(raw.lon)) continue;
      if (raw.lat < 40 || raw.lat > 43.8 || raw.lon < -0.5 || raw.lon > 3.6) continue;
      const line = lineFor(raw);
      if (!line || line.mode === "metro" || line.live === false) continue;
      incoming[raw.operator].push(raw);
    }
    for (const op of ["tmb", "fgc", "tram"]) {
      if (erred.has(op)) continue;
      const next = new Map();
      for (const raw of incoming[op]) {
        next.set(raw.id, withBearing(vehicles[op].get(raw.id), raw));
      }
      vehicles[op] = next;
    }
  }

  function clearLiveOperators() {
    vehicles.tmb = new Map();
    vehicles.fgc = new Map();
    vehicles.tram = new Map();
  }

  function syncMarkers(pop) {
    const alive = new Set();
    for (const op of ["tmb", "fgc", "tram"]) {
      for (const vehicle of vehicles[op].values()) {
        const line = lineFor(vehicle);
        if (!line || !enabled.has(line.id)) continue;
        alive.add(vehicle.id);
        let entry = markers.get(vehicle.id);
        if (!entry) {
          entry = createMarker(map, pop, vehicle);
          markers.set(vehicle.id, entry);
        }
        paintMarker(entry, vehicle);
        if (popupVehicleId === vehicle.id && pop.isOpen()) pop.setLngLat([vehicle.lon, vehicle.lat]);
      }
    }
    for (const [id, entry] of markers) {
      if (alive.has(id)) continue;
      entry.marker.remove();
      markers.delete(id);
      if (popupVehicleId === id) pop.remove();
    }
  }

  function paintStatus(body, networkStale) {
    const messages = [];
    for (const err of (body && body.errors) || []) {
      if (!err || err.message === "TRAM anahtarı yok") continue;
      messages.push(err.message);
    }
    if (networkStale || (body && body.stale)) messages.push("Veri eski");
    if (body && body.partial) messages.push("Bazı duraklar atlandı");
    const stamp = (body && body.updated) || (lastGood && lastGood.updated);
    const warn = messages.length > 0;
    setStatus(warn ? "warn" : "ok", refreshLabel(stamp), messages.join(" · "));
  }
}

function createMarker(map, pop, vehicle) {
  const el = document.createElement("button");
  el.type = "button";
  el.className = "veh";
  const arrow = document.createElement("span");
  arrow.className = "arrow";
  arrow.hidden = true;
  const code = document.createElement("span");
  code.className = "code";
  const tag = document.createElement("span");
  tag.className = "tag";
  el.append(arrow, code, tag);
  el.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    openPopup(pop, el._vehicle);
  });
  const marker = new maplibregl.Marker({ element: el, anchor: "center" })
    .setLngLat([vehicle.lon, vehicle.lat])
    .addTo(map);
  return { el, marker, arrow, code, tag };
}

function paintMarker(entry, vehicle) {
  entry.el._vehicle = vehicle;
  const gps = vehicle.source === "gps";
  entry.el.classList.toggle("gps", gps);
  entry.el.classList.toggle("est", !gps);
  entry.el.style.setProperty("--c", colorFor(vehicle));
  entry.el.setAttribute("aria-label", `${vehicle.line} ${gps ? "canlı" : "tahmini"}`);
  entry.code.textContent = vehicle.line;
  entry.tag.textContent = gps ? "canlı" : "tahmini";
  if (Number.isFinite(vehicle.bearing)) {
    entry.arrow.hidden = false;
    entry.arrow.style.transform = `rotate(${vehicle.bearing}deg)`;
  } else {
    entry.arrow.hidden = true;
  }
  entry.marker.setLngLat([vehicle.lon, vehicle.lat]);
}

function openPopup(pop, vehicle) {
  if (!vehicle) return;
  const line = lineFor(vehicle);
  const gps = vehicle.source === "gps";
  const src = gps
    ? "Kaynak: canlı GPS."
    : "Kaynak: tahmini. Konum, iBus varış süresinin GTFS hat şekline işlenmesidir. Gerçek GPS değildir.";
  pop.setLngLat([vehicle.lon, vehicle.lat]).setHTML(
    `<div class="pop">
      <b style="color:${esc(colorFor(vehicle))}">${esc(vehicle.line)}</b>
      <div>${esc(line && line.name || "")}</div>
      <div>Yön: ${esc(vehicle.destination || "—")}</div>
      <div>Son güncelleme: ${esc(formatStamp(vehicle.updated))}</div>
      <div class="src">${src}</div>
    </div>`,
  ).addTo(window.__bcnMap);
  popupVehicleId = vehicle.id;
}

function applyFilters(map) {
  const ids = [...enabled];
  const idIn = ids.length ? ["in", ["get", "id"], ["literal", ids]] : ["literal", false];
  map.setFilter("lines-bus", ["all", ["==", ["get", "mode"], "bus"], idIn]);
  map.setFilter("lines-rail", ["all", ["!=", ["get", "mode"], "bus"], idIn]);
  const needles = ids.map((id) => ["in", `,${id},`, ["get", "lines"]]);
  const any = needles.length ? ["any", ...needles] : ["literal", false];
  map.setFilter("stops-station", ["all", ["==", ["get", "kind"], "station"], any]);
  map.setFilter("stops-bus", ["all", ["==", ["get", "kind"], "stop"], any]);
}

function visibleLiveLines(map) {
  const bounds = map.getBounds();
  const pad = 0.02;
  const west = bounds.getWest() - pad;
  const east = bounds.getEast() + pad;
  const south = bounds.getSouth() - pad;
  const north = bounds.getNorth() + pad;
  const center = map.getCenter();
  const hits = [];
  for (const line of catalog) {
    if (!enabled.has(line.id) || line.live === false || line.mode === "metro") continue;
    if (line.mode === "tram" && tramConfigured === false) continue;
    if (!/^[A-Za-z0-9]{1,12}$/.test(line.code)) continue;
    const features = geometry.get(line.id) || [];
    let near = features.length ? Infinity : 0;
    let seen = features.length === 0;
    for (const feature of features) {
      const coords = feature.geometry.coordinates || [];
      for (let i = 0; i < coords.length; i++) {
        const point = coords[i];
        if (point[0] >= west && point[0] <= east && point[1] >= south && point[1] <= north) {
          seen = true;
          near = Math.min(near, Math.hypot(point[0] - center.lng, point[1] - center.lat));
        }
        if (i === 0) continue;
        if (segmentHits(coords[i - 1], point, west, south, east, north)) {
          seen = true;
          near = Math.min(near, Math.hypot(point[0] - center.lng, point[1] - center.lat));
        }
      }
    }
    if (!seen) continue;
    const token = line.mode === "bus" ? `tmb:${line.code}` : `${line.operator}:${line.code}`;
    hits.push({ token, near });
  }
  hits.sort((a, b) => a.near - b.near);
  const uniq = [];
  const seenToken = new Set();
  for (const hit of hits) {
    if (seenToken.has(hit.token)) continue;
    seenToken.add(hit.token);
    uniq.push(hit.token);
    if (uniq.length >= 40) break;
  }
  return uniq;
}

function segmentHits(a, b, west, south, east, north) {
  const inside = (p) => p[0] >= west && p[0] <= east && p[1] >= south && p[1] <= north;
  if (inside(a) || inside(b)) return true;
  const minX = Math.min(a[0], b[0]);
  const maxX = Math.max(a[0], b[0]);
  const minY = Math.min(a[1], b[1]);
  const maxY = Math.max(a[1], b[1]);
  if (maxX < west || minX > east || maxY < south || minY > north) return false;
  for (let step = 1; step < 8; step++) {
    const t = step / 8;
    if (inside([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t])) return true;
  }
  return false;
}

function withBearing(prev, next) {
  const vehicle = { ...next };
  if (vehicle.source !== "gps") return vehicle;
  if (Number.isFinite(vehicle.bearing)) return vehicle;
  if (!prev || prev.source !== "gps") return vehicle;
  const moved = haversine(prev.lon, prev.lat, vehicle.lon, vehicle.lat);
  if (moved >= 18) vehicle.bearing = Math.round(bearing(prev.lon, prev.lat, vehicle.lon, vehicle.lat));
  else if (Number.isFinite(prev.bearing)) vehicle.bearing = prev.bearing;
  return vehicle;
}

function haversine(lon1, lat1, lon2, lat2) {
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLon = (lon2 - lon1) * rad;
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.min(1, Math.sqrt(h)));
}

function bearing(lon1, lat1, lon2, lat2) {
  const rad = Math.PI / 180;
  const y = Math.sin((lon2 - lon1) * rad) * Math.cos(lat2 * rad);
  const x = Math.cos(lat1 * rad) * Math.sin(lat2 * rad)
    - Math.sin(lat1 * rad) * Math.cos(lat2 * rad) * Math.cos((lon2 - lon1) * rad);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

function lineFor(vehicle) {
  if (vehicle.operator === "tmb") return byId.get(`tmb-bus:${vehicle.line}`);
  if (vehicle.operator === "fgc") return byId.get(`fgc:${vehicle.line}`);
  if (vehicle.operator === "tram") return byId.get(`tram:${vehicle.line}`);
  return null;
}

function colorFor(vehicle) {
  const line = lineFor(vehicle);
  return line && line.color ? line.color : "#9AABBE";
}

function bboxParam(map) {
  const bounds = map.getBounds();
  const round = (n) => (Math.round(n * 100) / 100).toFixed(2);
  return [round(bounds.getWest()), round(bounds.getSouth()), round(bounds.getEast()), round(bounds.getNorth())].join(",");
}

function apiBase() {
  const query = new URLSearchParams(location.search).get("api");
  const raw = query || (window.BCN_CONFIG && window.BCN_CONFIG.apiBase) || "";
  if (!raw) return "";
  try {
    const url = new URL(raw, location.origin);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "";
    const path = url.pathname === "/" ? "" : url.pathname.replace(/\/$/, "");
    return url.origin + path;
  } catch {
    return "";
  }
}

function loadEnabled(lines) {
  const known = new Set(lines.map((line) => line.id));
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw != null) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return new Set(parsed.filter((id) => known.has(id)));
    }
  } catch {
    /* keep defaults */
  }
  return new Set(lines.filter((line) => line.defaultOn).map((line) => line.id));
}

function saveEnabled() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify([...enabled]));
  } catch {
    /* private mode */
  }
}

function filterList() {
  const query = norm(search.value).trim();
  for (const section of groupsEl.querySelectorAll(".group")) {
    let shown = 0;
    for (const button of section.querySelectorAll(".line")) {
      const hit = lineMatches(button.dataset.code, button.dataset.name, query);
      button.hidden = !hit;
      if (hit) shown += 1;
    }
    section.hidden = shown === 0;
  }
}

function lineMatches(code, name, query) {
  if (!query) return true;
  const short = norm(code);
  const title = norm(name);
  if (short === query || title.includes(query)) return true;
  if (!short.startsWith(query)) return false;
  const next = short.charAt(query.length);
  if (/\d$/.test(query) && /\d/.test(next)) return false;
  return true;
}

function updateTramKey() {
  const note = document.getElementById("tram-key");
  if (!note) return;
  note.hidden = tramConfigured !== false;
}

function arm(delay) {
  clearTimeout(pollTimer);
  if (document.hidden) return;
  pollTimer = setTimeout(async () => {
    if (typeof window.__bcnPoll === "function") await window.__bcnPoll(false);
    arm(POLL_MS);
  }, delay);
}

function panelPadding() {
  if (narrowQuery.matches) {
    const collapsed = panel.classList.contains("collapsed");
    return {
      top: 78,
      bottom: collapsed ? 84 : Math.round(window.innerHeight * 0.42),
      left: 10,
      right: 10,
    };
  }
  return { top: 52, bottom: 28, left: 352, right: 16 };
}

function layout() {
  const map = window.__bcnMap;
  if (!map) return;
  map.setPadding(panelPadding());
  sheetToggle.setAttribute("aria-expanded", panel.classList.contains("collapsed") ? "false" : "true");
}

function setStatus(kind, main, note) {
  statusEl.className = kind;
  statusMain.textContent = main;
  statusNote.textContent = note || "";
}

function refreshLabel(stamp) {
  const text = formatStamp(stamp);
  return text === "—" ? "Son yenileme —" : `Son yenileme ${text}`;
}

function formatStamp(stamp) {
  const sec = typeof stamp === "object" && stamp ? stamp.updated : stamp;
  if (!Number.isFinite(sec)) return "—";
  return new Date(sec * 1000).toLocaleString("tr-TR", {
    timeZone: "Europe/Madrid",
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function norm(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[ch]);
}

function readJson(res) {
  if (!res.ok) throw new Error(String(res.status));
  return res.json();
}
