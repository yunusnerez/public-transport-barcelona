"use strict";

const UI_KEY = "bcn-ui-v2";
const POLL_MS = 28000;
// TMB publishes no train GPS. Bus lines stay off until this zoom so the city
// view stays a rail map; the chip can force every bus line on.
const BUS_ZOOM = 13;
const GROUPS = [
  {
    id: "metro",
    title: "TMB Metro",
    chip: "statik",
    chipClass: "static",
    note: "Tren konumu yok. Hat ve istasyon.",
    match: (line) => line.mode === "metro",
  },
  {
    id: "fgc",
    title: "FGC",
    chip: "gps",
    chipClass: "gps",
    note: "Canlı GPS.",
    match: (line) => line.mode === "fgc",
  },
  {
    id: "tram",
    title: "TRAM",
    chip: "gps",
    chipClass: "gps",
    note: "Canlı GPS.",
    match: (line) => line.mode === "tram",
  },
  {
    id: "bus",
    title: "TMB Otobüs",
    chip: "tahmini",
    chipClass: "est",
    note: "Tahmini konum. Yakınlaşınca ya da seçince.",
    match: (line) => line.mode === "bus",
  },
];

const statusEl = document.getElementById("status");
const statusMain = document.getElementById("status-main");
const statusNote = document.getElementById("status-note");
const panel = document.getElementById("panel");
const sheetToggle = document.getElementById("sheet-toggle");
const search = document.getElementById("search");
const groupsEl = document.getElementById("groups");
const familiesEl = document.getElementById("families");
const hintEl = document.getElementById("hint");
const subtitle = document.getElementById("subtitle");
const focusBar = document.getElementById("focus-bar");
const focusDetail = document.getElementById("focus-detail");
const followBar = document.getElementById("follow-bar");
const followLabel = document.getElementById("follow-label");

const byId = new Map();
const geometry = new Map();
const buttons = new Map();
const stopFeatures = [];
let catalog = [];
let families = { metro: true, fgc: true, tram: true, bus: "auto" };
let focusId = null;
let followId = null;
let followAnchor = null;
let skipMovePoll = false;
let tramConfigured = null;
let everOk = false;
let workerDown = false;
let lastGood = null;
let pollTimer = 0;
let moveTimer = 0;
let pollGen = 0;
let popupVehicleId = null;
const openGroups = new Set(["metro"]);

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
narrowQuery.addEventListener("change", () => {
  if (narrowQuery.matches) panel.classList.add("collapsed");
  layout();
});
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
  window.__bcnPopup = popup;
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
      for (const feature of stopDoc.features || []) {
        const props = feature.properties || {};
        const coord = feature.geometry && feature.geometry.coordinates;
        if (!coord) continue;
        stopFeatures.push({
          name: props.name || "Durak",
          code: props.code || "",
          kind: props.kind,
          lines: props.lines || "",
          lng: coord[0],
          lat: coord[1],
        });
      }
      loadUi();
      if (focusId && !byId.has(focusId)) focusId = null;
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
      map.addLayer({
        id: "stop-labels",
        type: "symbol",
        source: "stops",
        minzoom: 14.5,
        layout: {
          "text-field": ["get", "name"],
          "text-size": 11,
          "text-offset": [0, 0.85],
          "text-anchor": "top",
          "text-font": labelFont(map),
        },
        paint: {
          "text-color": "#e7eef6",
          "text-halo-color": "#0e141b",
          "text-halo-width": 1.2,
        },
      });
      map.on("click", "stops-station", (event) => showStop(map, popup, event));
      map.on("click", "stops-bus", (event) => showStop(map, popup, event));
      map.on("click", "lines-rail", (event) => focusFromMap(event));
      map.on("click", "lines-bus", (event) => focusFromMap(event));
      for (const layer of ["stops-station", "stops-bus", "lines-rail", "lines-bus"]) {
        map.on("mouseenter", layer, () => { map.getCanvas().style.cursor = "pointer"; });
        map.on("mouseleave", layer, () => { map.getCanvas().style.cursor = ""; });
      }
      renderGroups();
      updateFamilyChips();
      renderFocus();
      applyView(map);
      layout();
      if (focusId) fitLine(map, focusId);
      map.on("moveend", () => {
        const programmatic = skipMovePoll;
        skipMovePoll = false;
        clearTimeout(moveTimer);
        moveTimer = setTimeout(() => {
          applyView(map);
          if (programmatic) return;
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

  map.on("dragstart", () => stopFollow());
  map.on("zoomstart", (event) => {
    if (event.originalEvent) stopFollow();
  });

  map.on("error", (event) => {
    if (event && event.error) console.error(event.error);
  });

  document.getElementById("focus-back").addEventListener("click", clearFocus);
  document.getElementById("follow-stop").addEventListener("click", stopFollow);
  familiesEl.addEventListener("click", (event) => {
    const button = event.target.closest(".family");
    if (!button) return;
    const key = button.dataset.family;
    if (key === "bus") {
      families.bus = families.bus === "auto" ? "on" : families.bus === "on" ? "off" : "auto";
    } else {
      families[key] = !families[key];
    }
    if (focusId) {
      focusId = null;
      stopFollow();
    }
    saveUi();
    renderFocus();
    updateFamilyChips();
    layout();
    applyView(map);
    poll(true);
    arm(POLL_MS);
  });
  search.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    const query = norm(search.value).trim();
    if (!query) {
      if (focusId) clearFocus();
      return;
    }
    const hits = catalog.filter((line) => lineMatches(line.code, line.name, query));
    hits.sort((a, b) => rankMatch(a, query) - rankMatch(b, query));
    if (hits[0]) focusLine(hits[0].id);
  });
  window.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    if (event.target === search) return;
    if (followId) {
      stopFollow();
      return;
    }
    if (focusId) clearFocus();
  });

  function showStop(mapObj, pop, event) {
    const feature = event.features && event.features[0];
    if (!feature) return;
    const name = feature.properties.name || "Durak";
    const code = feature.properties.code || "";
    stopFollow();
    pop.setLngLat(event.lngLat).setHTML(
      `<div class="pop"><b>${esc(name)}</b><div>${esc(code)}</div></div>`,
    ).addTo(mapObj);
    popupVehicleId = null;
  }

  function focusFromMap(event) {
    const stops = map.queryRenderedFeatures(event.point, { layers: ["stops-station", "stops-bus"] });
    if (stops.length) return;
    const feature = event.features && event.features[0];
    const id = feature && feature.properties && feature.properties.id;
    if (id) focusLine(id);
  }

  function renderGroups() {
    groupsEl.replaceChildren();
    for (const group of GROUPS) {
      const lines = catalog.filter(group.match);
      const section = document.createElement("section");
      section.className = "group";
      section.dataset.group = group.id;
      if (!openGroups.has(group.id)) section.classList.add("shut");
      const head = document.createElement("button");
      head.type = "button";
      head.className = "group-head";
      const title = document.createElement("span");
      title.className = "group-title";
      title.textContent = group.title;
      const chip = document.createElement("span");
      chip.className = `chip ${group.chipClass}`;
      chip.textContent = group.chip;
      title.append(chip);
      const count = document.createElement("span");
      count.className = "count";
      count.textContent = String(lines.length);
      head.append(title, count);
      head.addEventListener("click", () => {
        if (openGroups.has(group.id)) openGroups.delete(group.id);
        else openGroups.add(group.id);
        filterList();
      });
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
        button.style.setProperty("--c", line.color);
        const swatch = document.createElement("i");
        swatch.className = "swatch";
        swatch.style.background = line.color;
        const code = document.createElement("b");
        code.textContent = line.code;
        const name = document.createElement("small");
        name.textContent = line.name || "";
        button.append(swatch, code, name);
        button.addEventListener("click", () => focusLine(line.id));
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
    setHint();
  }

  function focusLine(id) {
    const line = byId.get(id);
    if (!line) return;
    focusId = id;
    stopFollow();
    dismissPopup();
    saveUi();
    renderFocus();
    if (narrowQuery.matches) panel.classList.add("collapsed");
    layout();
    applyView(map);
    fitLine(map, id);
    poll(true);
    arm(POLL_MS);
  }

  function clearFocus() {
    focusId = null;
    stopFollow();
    dismissPopup();
    saveUi();
    renderFocus();
    layout();
    applyView(map);
    poll(true);
    arm(POLL_MS);
  }

  function renderFocus() {
    const line = focusId && byId.get(focusId);
    familiesEl.hidden = Boolean(line);
    hintEl.hidden = Boolean(line);
    if (!line) {
      focusBar.hidden = true;
      focusDetail.hidden = true;
      markCurrent();
      return;
    }
    focusBar.hidden = false;
    focusDetail.hidden = false;
    focusBar.style.borderLeftColor = line.color;
    document.getElementById("focus-swatch").style.background = line.color;
    document.getElementById("focus-code").textContent = line.code;
    const chip = document.getElementById("focus-chip");
    chip.className = `chip ${chipClass(line)}`;
    chip.textContent = chipText(line);
    document.getElementById("focus-name").textContent = line.name || "";
    document.getElementById("focus-note").textContent = focusNote(line);
    renderStops(line);
    renderVehicles();
    markCurrent();
  }

  function renderStops(line) {
    const box = document.getElementById("focus-stops");
    box.replaceChildren();
    if (!line || line.mode === "bus") return;
    const ordered = alongSort(line.id, stopsFor(line.id).filter((stop) => stop.kind === "station"));
    if (!ordered.length) return;
    const label = document.createElement("p");
    label.className = "stop-label";
    label.textContent = "İstasyonlar";
    const list = document.createElement("div");
    list.className = "stops";
    ordered.forEach((stop, index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "stop";
      button.textContent = `${index + 1}. ${stop.name}`;
      button.addEventListener("click", () => {
        stopFollow();
        skipMovePoll = true;
        map.easeTo({
          center: [stop.lng, stop.lat],
          zoom: Math.max(map.getZoom(), 15),
          duration: 500,
          essential: true,
        });
        popup.setLngLat([stop.lng, stop.lat]).setHTML(
          `<div class="pop"><b>${esc(stop.name)}</b><div>${esc(line.code)}</div></div>`,
        ).addTo(map);
        popupVehicleId = null;
      });
      list.append(button);
    });
    box.append(label, list);
  }

  function renderVehicles() {
    const box = document.getElementById("focus-vehicles");
    if (!box) return;
    box.replaceChildren();
    const line = focusId && byId.get(focusId);
    if (!line || line.mode === "metro" || line.live === false) return;
    const list = [];
    for (const op of ["tmb", "fgc", "tram"]) {
      for (const vehicle of vehicles[op].values()) {
        const match = lineFor(vehicle);
        if (match && match.id === line.id) list.push(vehicle);
      }
    }
    if (!list.length) {
      const empty = document.createElement("p");
      empty.className = "focus-empty";
      empty.textContent = "Bu turda araç görünmüyor.";
      box.append(empty);
      return;
    }
    for (const vehicle of list) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "veh-row";
      if (vehicle.id === followId) button.classList.add("on");
      const where = vehicle.destination || "yön yok";
      button.textContent = `${where} · ${vehicle.source === "gps" ? "canlı" : "tahmini"}`;
      button.addEventListener("click", () => {
        openPopup(popup, vehicle);
        startFollow(vehicle.id);
      });
      box.append(button);
    }
  }

  async function poll(force) {
    const selected = visibleLiveLines(map);
    if (!force && workerDown && selected.length === 0 && tramConfigured !== null) return;
    if (selected.length === 0 && tramConfigured !== null) {
      clearLiveOperators();
      syncMarkers(popup);
      if (everOk) setStatus("ok", refreshLabel(lastGood), focusId ? "" : "");
      return;
    }
    const gen = ++pollGen;
    const ctrl = new AbortController();
    const kill = setTimeout(() => ctrl.abort(), 22000);
    try {
      const params = new URLSearchParams();
      if (selected.length) params.set("lines", selected.join(","));
      params.set("bbox", requestBbox(map));
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
  window.__bcnRenderVehicles = renderVehicles;

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
    const visible = new Set(shownIds(map));
    for (const op of ["tmb", "fgc", "tram"]) {
      for (const vehicle of vehicles[op].values()) {
        const line = lineFor(vehicle);
        if (!line || !visible.has(line.id)) continue;
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
    renderVehicles();
    trackFollow();
  }

  function paintStatus(body, networkStale) {
    const messages = [];
    for (const err of (body && body.errors) || []) {
      if (!err || err.message === "TRAM anahtarı yok") continue;
      messages.push(err.message);
    }
    if (networkStale || (body && body.stale)) messages.push("Veri eski");
    if (body && body.partial) {
      messages.push(focusId
        ? "Bu hattın bazı durakları atlandı"
        : "Yakındaki hatların bir kısmı atlandı");
    }
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
    startFollow(el._vehicle.id);
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
      <button type="button" class="js-follow">Takip et</button>
    </div>`,
  ).addTo(window.__bcnMap);
  const button = pop.getElement() && pop.getElement().querySelector(".js-follow");
  if (button) button.addEventListener("click", () => startFollow(vehicle.id));
  popupVehicleId = vehicle.id;
}

function startFollow(id) {
  const vehicle = findVehicle(id);
  if (!vehicle) return;
  followId = id;
  followAnchor = null;
  followBar.hidden = false;
  followLabel.textContent = `${vehicle.line} izleniyor`;
  easeToVehicle(vehicle, true);
  if (typeof window.__bcnRenderVehicles === "function") window.__bcnRenderVehicles();
}

function trackFollow() {
  if (!followId) return;
  const vehicle = findVehicle(followId);
  followBar.hidden = false;
  if (!vehicle) {
    followLabel.textContent = "Araç bu turda yok";
    return;
  }
  const line = lineFor(vehicle);
  const view = window.__bcnMap;
  if (line && view && !shownIds(view).includes(line.id)) {
    followLabel.textContent = `${vehicle.line} görünmüyor`;
    return;
  }
  followLabel.textContent = `${vehicle.line} izleniyor`;
  easeToVehicle(vehicle, false);
}

function easeToVehicle(vehicle, first) {
  const map = window.__bcnMap;
  if (!map) return;
  if (!first && followAnchor) {
    const moved = haversine(followAnchor[0], followAnchor[1], vehicle.lon, vehicle.lat);
    if (moved < 8) return;
  }
  followAnchor = [vehicle.lon, vehicle.lat];
  skipMovePoll = true;
  map.easeTo({
    center: [vehicle.lon, vehicle.lat],
    zoom: first ? Math.max(map.getZoom(), 15) : map.getZoom(),
    duration: first ? 650 : 400,
    essential: true,
  });
}

function dismissPopup() {
  const pop = window.__bcnPopup;
  if (pop && pop.isOpen()) pop.remove();
  popupVehicleId = null;
}

function stopFollow() {
  followId = null;
  followAnchor = null;
  followBar.hidden = true;
  followLabel.textContent = "";
}

function applyView(map) {
  const ids = shownIds(map);
  const idIn = ids.length ? ["in", ["get", "id"], ["literal", ids]] : ["literal", false];
  map.setFilter("lines-bus", ["all", ["==", ["get", "mode"], "bus"], idIn]);
  map.setFilter("lines-rail", ["all", ["!=", ["get", "mode"], "bus"], idIn]);
  const needles = ids.map((id) => ["in", `,${id},`, ["get", "lines"]]);
  const any = needles.length ? ["any", ...needles] : ["literal", false];
  map.setFilter("stops-station", ["all", ["==", ["get", "kind"], "station"], any]);
  map.setFilter("stops-bus", ["all", ["==", ["get", "kind"], "stop"], any]);
  map.setFilter("stop-labels", any);
  const focused = Boolean(focusId);
  map.setPaintProperty("lines-rail", "line-width", [
    "interpolate", ["linear"], ["zoom"],
    10, focused ? 4 : 2.2,
    14, focused ? 7 : 4,
    16, focused ? 9 : 6,
  ]);
  map.setPaintProperty("lines-bus", "line-opacity", focused ? 0.95 : 0.7);
  if (map.getLayer("stop-labels")) map.setLayerZoomRange("stop-labels", focused ? 13 : 14.5, 24);
}

function shownIds(map) {
  if (focusId && byId.has(focusId)) return [focusId];
  const zoom = map.getZoom();
  const bounds = map.getBounds();
  const ids = [];
  for (const line of catalog) {
    if (!familyShown(line, zoom, bounds)) continue;
    ids.push(line.id);
  }
  return ids;
}

function familyShown(line, zoom, bounds) {
  if (line.mode === "metro") return families.metro;
  if (line.mode === "fgc") return families.fgc;
  if (line.mode === "tram") return families.tram;
  if (line.mode !== "bus") return false;
  if (families.bus === "off") return false;
  if (families.bus === "auto" && zoom < BUS_ZOOM) return false;
  return bboxHits(line.bbox, bounds, 0.012);
}

function bboxHits(bbox, bounds, pad) {
  if (!bbox || bbox.length !== 4) return true;
  const [west, south, east, north] = bbox;
  return east >= bounds.getWest() - pad
    && west <= bounds.getEast() + pad
    && north >= bounds.getSouth() - pad
    && south <= bounds.getNorth() + pad;
}

function visibleLiveLines(map) {
  if (focusId && byId.has(focusId)) {
    const line = byId.get(focusId);
    if (!line || line.live === false || line.mode === "metro") return [];
    if (line.mode === "tram" && tramConfigured === false) return [];
    if (!/^[A-Za-z0-9]{1,12}$/.test(line.code)) return [];
    const token = line.mode === "bus" ? `tmb:${line.code}` : `${line.operator}:${line.code}`;
    return [token];
  }
  const bounds = map.getBounds();
  const pad = 0.02;
  const west = bounds.getWest() - pad;
  const east = bounds.getEast() + pad;
  const south = bounds.getSouth() - pad;
  const north = bounds.getNorth() + pad;
  const center = map.getCenter();
  const visible = new Set(shownIds(map));
  const hits = [];
  for (const line of catalog) {
    if (!visible.has(line.id) || line.live === false || line.mode === "metro") continue;
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

function requestBbox(map) {
  const line = focusId && byId.get(focusId);
  if (line && line.bbox && line.bbox.length === 4) {
    return line.bbox.map((n) => (Math.round(n * 100) / 100).toFixed(2)).join(",");
  }
  return bboxParam(map);
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

function findVehicle(id) {
  for (const op of ["tmb", "fgc", "tram"]) {
    const vehicle = vehicles[op].get(id);
    if (vehicle) return vehicle;
  }
  return null;
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

function loadUi() {
  try {
    const raw = localStorage.getItem(UI_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    const saved = parsed && parsed.families;
    if (saved) {
      if (typeof saved.metro === "boolean") families.metro = saved.metro;
      if (typeof saved.fgc === "boolean") families.fgc = saved.fgc;
      if (typeof saved.tram === "boolean") families.tram = saved.tram;
      if (saved.bus === "auto" || saved.bus === "on" || saved.bus === "off") families.bus = saved.bus;
    }
    if (typeof parsed.focusId === "string") focusId = parsed.focusId;
  } catch {
    /* keep defaults */
  }
}

function saveUi() {
  try {
    localStorage.setItem(UI_KEY, JSON.stringify({ families, focusId }));
  } catch {
    /* private mode */
  }
}

function updateFamilyChips() {
  for (const button of familiesEl.querySelectorAll(".family")) {
    const key = button.dataset.family;
    if (key === "bus") {
      button.dataset.state = families.bus;
      button.setAttribute("aria-pressed", families.bus === "off" ? "false" : "true");
      button.textContent = families.bus === "auto"
        ? "Otobüs · yakın"
        : families.bus === "on"
          ? "Otobüs · hepsi"
          : "Otobüs · kapalı";
      button.title = "Yakın, hepsi ve kapalı arasında değişir";
    } else {
      const on = Boolean(families[key]);
      button.setAttribute("aria-pressed", on ? "true" : "false");
    }
  }
}

function setHint() {
  hintEl.textContent = "Metro, FGC ve TRAM çizili. Otobüsler zoom 13'te bu bölgede çıkar; çipe basınca hepsi açılır. Bir hat seçince yalnız o kalır. TMB tren konumu yayınlamaz. FGC, TRAM ve otobüste araca basınca takip başlar.";
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
    const count = section.querySelector(".count");
    if (count) count.textContent = String(shown);
    const shut = !query && !openGroups.has(section.dataset.group);
    section.classList.toggle("shut", shut);
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

function rankMatch(line, query) {
  const code = norm(line.code);
  if (code === query) return 0;
  if (code.startsWith(query)) return 1;
  return 2;
}

function markCurrent() {
  for (const [id, button] of buttons) {
    if (id === focusId) button.setAttribute("aria-current", "true");
    else button.removeAttribute("aria-current");
  }
  const line = focusId && byId.get(focusId);
  sheetToggle.textContent = line ? line.code : "Hatlar";
  subtitle.textContent = line ? focusSubtitle(line) : "Hat seç veya yakınlaş";
}

function focusSubtitle(line) {
  if (line.mode === "metro" || line.live === false) return "Hat ve istasyon";
  if (line.mode === "bus") return "Tahmini takip";
  return "Canlı takip";
}

function chipClass(line) {
  if (line.mode === "metro" || line.live === false) return "static";
  if (line.mode === "bus") return "est";
  return "gps";
}

function chipText(line) {
  if (line.mode === "metro" || line.live === false) return "statik";
  if (line.mode === "bus") return "tahmini";
  return "gps";
}

function focusNote(line) {
  if (line.mode === "metro" || line.live === false) {
    return "TMB bu hattın tren konumunu yayınlamıyor. İstasyona basınca harita oraya gider.";
  }
  if (line.mode === "bus") {
    return "Konum tahmini, gerçek GPS değil. Araca basınca harita onu izler.";
  }
  return "Gerçek GPS. Araca basınca harita onu izler.";
}

function stopsFor(lineId) {
  const needle = `,${lineId},`;
  return stopFeatures.filter((stop) => stop.lines.includes(needle));
}

function alongSort(lineId, points) {
  const features = geometry.get(lineId) || [];
  let spine = [];
  let best = 0;
  for (const feature of features) {
    const coords = feature.geometry.coordinates || [];
    let len = 0;
    for (let i = 1; i < coords.length; i++) {
      len += Math.hypot(coords[i][0] - coords[i - 1][0], coords[i][1] - coords[i - 1][1]);
    }
    if (len > best) {
      best = len;
      spine = coords;
    }
  }
  if (spine.length < 2) return points.slice();
  const cum = [0];
  for (let i = 1; i < spine.length; i++) {
    cum.push(cum[i - 1] + Math.hypot(spine[i][0] - spine[i - 1][0], spine[i][1] - spine[i - 1][1]));
  }
  const placed = points.map((point) => ({ ...point, along: projectAlong(spine, cum, point.lng, point.lat) }));
  placed.sort((a, b) => a.along - b.along);
  return placed;
}

function projectAlong(spine, cum, lng, lat) {
  let bestD = Infinity;
  let bestA = 0;
  for (let i = 1; i < spine.length; i++) {
    const ax = spine[i - 1][0];
    const ay = spine[i - 1][1];
    const bx = spine[i][0];
    const by = spine[i][1];
    const dx = bx - ax;
    const dy = by - ay;
    const den = dx * dx + dy * dy || 1e-12;
    let t = ((lng - ax) * dx + (lat - ay) * dy) / den;
    t = Math.max(0, Math.min(1, t));
    const px = ax + dx * t;
    const py = ay + dy * t;
    const dist = (lng - px) ** 2 + (lat - py) ** 2;
    if (dist < bestD) {
      bestD = dist;
      bestA = cum[i - 1] + (cum[i] - cum[i - 1]) * t;
    }
  }
  return bestA;
}

function fitLine(map, lineId) {
  const bounds = new maplibregl.LngLatBounds();
  for (const feature of geometry.get(lineId) || []) {
    for (const coord of feature.geometry.coordinates || []) bounds.extend(coord);
  }
  if (bounds.isEmpty()) return;
  skipMovePoll = true;
  map.fitBounds(bounds, { padding: 28, maxZoom: 15, duration: 650 });
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
    const bottom = collapsed ? (focusId ? 150 : 84) : Math.round(window.innerHeight * 0.46);
    return { top: 78, bottom, left: 10, right: 10 };
  }
  return { top: focusId ? 86 : 52, bottom: 28, left: 352, right: 16 };
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

function labelFont(map) {
  const layers = (map.getStyle() && map.getStyle().layers) || [];
  for (const layer of layers) {
    const font = layer.layout && layer.layout["text-font"];
    if (Array.isArray(font) && font.length && font.every((item) => typeof item === "string")) return font;
  }
  return ["Open Sans Regular", "Arial Unicode MS Regular"];
}
