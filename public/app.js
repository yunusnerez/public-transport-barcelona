"use strict";

const UI_KEY = "bcn-ui-v2";
const POLL_MS = 28000;
// Bus lines appear at zoom 11; chip can force every bus line on.
const BUS_ZOOM = 11;
const GROUPS = [
  {
    id: "metro",
    title: "TMB Metro",
    chip: "canlı peron",
    chipClass: "est",
    note: "Seçilince tahmini trenler ve canlı peron ekranı.",
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
const sheetHandleZone = document.getElementById("sheet-handle-zone");
const search = document.getElementById("search");
const searchClearBtn = document.getElementById("search-clear");
const modeTabsEl = document.getElementById("mode-tabs");
const nearbySection = document.getElementById("nearby-section");
const nearbyStatusTitle = document.getElementById("nearby-status-title");
const nearbyStatusDesc = document.getElementById("nearby-status-desc");
const nearbyDemoPrompt = document.getElementById("nearby-demo-prompt");
const nearbyLinesBlock = document.getElementById("nearby-lines-block");
const nearbyLinesChips = document.getElementById("nearby-lines-chips");
const nearbyStopsBlock = document.getElementById("nearby-stops-block");
const nearbyStopsList = document.getElementById("nearby-stops-list");
const searchResultsSection = document.getElementById("search-results-section");
const searchSummaryEl = document.getElementById("search-summary");
const searchResultsListEl = document.getElementById("search-results-list");
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
let currentTab = "all";
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
let activeStationTicker = null;
let currentPopupAbort = null;

// User Geolocation State
let userLocation = null;
let userMarker = null;
let isLocating = false;

function clearStationTicker() {
  if (activeStationTicker) {
    clearInterval(activeStationTicker);
    activeStationTicker = null;
  }
  if (currentPopupAbort) {
    currentPopupAbort.abort();
    currentPopupAbort = null;
  }
}
const openGroups = new Set(["metro"]);

const vehicles = { tmb: new Map(), fgc: new Map(), tram: new Map() };
const markers = new Map();

const narrowQuery = window.matchMedia("(max-width: 760px)");
if (narrowQuery.matches) panel.classList.add("collapsed");
if (sheetToggle) {
  sheetToggle.setAttribute("aria-expanded", panel.classList.contains("collapsed") ? "false" : "true");
  sheetToggle.addEventListener("click", () => {
    panel.classList.toggle("collapsed");
    const open = !panel.classList.contains("collapsed");
    sheetToggle.setAttribute("aria-expanded", open ? "true" : "false");
    layout();
  });
}

// Touch swipe gestures on mobile sheet handle
let touchStartY = 0;
let touchDiffY = 0;
if (sheetHandleZone) {
  sheetHandleZone.addEventListener("click", () => {
    panel.classList.toggle("collapsed");
    layout();
  });
  sheetHandleZone.addEventListener("touchstart", (e) => {
    if (e.touches.length === 1) {
      touchStartY = e.touches[0].clientY;
      touchDiffY = 0;
    }
  }, { passive: true });
  sheetHandleZone.addEventListener("touchmove", (e) => {
    if (e.touches.length === 1) {
      touchDiffY = e.touches[0].clientY - touchStartY;
    }
  }, { passive: true });
  sheetHandleZone.addEventListener("touchend", () => {
    if (touchDiffY > 35) {
      panel.classList.add("collapsed");
      layout();
    } else if (touchDiffY < -35) {
      panel.classList.remove("collapsed");
      layout();
    }
  });
}

if (search) {
  search.addEventListener("input", () => {
    const q = search.value.trim();
    if (q) {
      handleSearch(q);
    } else {
      restoreTabView();
    }
  });
  search.addEventListener("focus", () => {
    if (narrowQuery.matches) {
      panel.classList.remove("collapsed");
      layout();
    }
  });
}

if (searchClearBtn) {
  searchClearBtn.addEventListener("click", () => {
    search.value = "";
    searchClearBtn.hidden = true;
    restoreTabView();
    search.focus();
  });
}

if (modeTabsEl) {
  modeTabsEl.addEventListener("click", (e) => {
    const btn = e.target.closest(".mode-tab");
    if (!btn) return;
    const tab = btn.dataset.tab;
    selectTab(tab);
  });
}

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

  const popup = new maplibregl.Popup({ closeButton: true, maxWidth: "340px", offset: 18, className: "bcn-pop" });
  window.__bcnPopup = popup;
  popup.on("close", () => {
    popupVehicleId = null;
    clearStationTicker();
  });

  map.on("load", async () => {
    setStatus("quiet", "Hatlar yükleniyor", "");
    try {
      const v = "20261008-4";
      const [catDoc, lineDoc, stopDoc] = await Promise.all([
        fetch(`data/catalog.json?v=${v}`).then(readJson),
        fetch(`data/lines.geojson?v=${v}`).then(readJson),
        fetch(`data/stops.geojson?v=${v}`).then(readJson),
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
          metro: props.metro || null,
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
        minzoom: 12.5,
        filter: ["==", ["get", "kind"], "stop"],
        paint: {
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 12.5, 2, 15, 3.5, 17, 5],
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

  // Event Listeners for UI
  document.getElementById("focus-back")?.addEventListener("click", clearFocus);
  document.getElementById("follow-stop")?.addEventListener("click", stopFollow);

  // Focus detail sub-tabs (Stops vs Vehicles)
  document.getElementById("tab-stops")?.addEventListener("click", () => {
    document.getElementById("tab-stops")?.classList.add("active");
    document.getElementById("tab-vehicles")?.classList.remove("active");
    document.getElementById("focus-stops")?.classList.add("active");
    document.getElementById("focus-vehicles")?.classList.remove("active");
  });
  document.getElementById("tab-vehicles")?.addEventListener("click", () => {
    document.getElementById("tab-vehicles")?.classList.add("active");
    document.getElementById("tab-stops")?.classList.remove("active");
    document.getElementById("focus-vehicles")?.classList.add("active");
    document.getElementById("focus-stops")?.classList.remove("active");
  });

  // Floating map controls
  document.getElementById("btn-locate")?.addEventListener("click", () => {
    locateUser(true);
  });
  document.getElementById("quick-locate-btn")?.addEventListener("click", () => {
    selectTab("nearby");
    if (!userLocation) locateUser(true);
  });
  document.getElementById("btn-zoom-in")?.addEventListener("click", () => {
    if (window.__bcnMap) window.__bcnMap.zoomIn();
  });
  document.getElementById("btn-zoom-out")?.addEventListener("click", () => {
    if (window.__bcnMap) window.__bcnMap.zoomOut();
  });
  document.getElementById("btn-reset-view")?.addEventListener("click", () => {
    if (focusId) clearFocus();
    if (window.__bcnMap) {
      skipMovePoll = true;
      window.__bcnMap.flyTo({
        center: [2.17, 41.39],
        zoom: 12,
        duration: 800,
        essential: true,
      });
    }
  });
  document.getElementById("btn-simulate-catalunya")?.addEventListener("click", () => {
    simulateCatalunya();
  });
  document.getElementById("nearby-refresh-btn")?.addEventListener("click", () => {
    locateUser(true);
  });

  if (familiesEl) {
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
  }

  if (search) {
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
  }

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
    const props = feature.properties || {};
    const coord = feature.geometry && feature.geometry.coordinates;
    const lngLat = event.lngLat || (coord ? [coord[0], coord[1]] : null);
    if (!lngLat) return;
    stopFollow();
    renderStationPopup(mapObj, pop, lngLat, props);
  }

  function extractMetroMeta(props) {
    if (!props) return [];

    // 1. Direct props.metro array or JSON string
    if (Array.isArray(props.metro) && props.metro.length) {
      return props.metro.map((m) => ({
        line: m.line,
        code: String(m.code || "").replace(/^6660*/, "") || String(m.code || ""),
      }));
    }
    if (typeof props.metro === "string") {
      try {
        const parsed = JSON.parse(props.metro);
        if (Array.isArray(parsed) && parsed.length) {
          return parsed.map((m) => ({
            line: m.line,
            code: String(m.code || "").replace(/^6660*/, "") || String(m.code || ""),
          }));
        }
      } catch {}
    }

    // 2. Look up in cached stopFeatures by code or station name
    const propCode = props.code != null ? String(props.code).trim() : "";
    const propName = props.name != null ? String(props.name).trim() : "";
    if (propCode || propName) {
      const hit = stopFeatures.find((s) => {
        if (propCode && String(s.code).trim() === propCode) return true;
        if (propName && s.name === propName && s.kind === "station") return true;
        return false;
      });
      if (hit) {
        if (Array.isArray(hit.metro) && hit.metro.length) {
          return hit.metro.map((m) => ({
            line: m.line,
            code: String(m.code || "").replace(/^6660*/, "") || String(m.code || ""),
          }));
        }
        if (typeof hit.metro === "string") {
          try {
            const parsed = JSON.parse(hit.metro);
            if (Array.isArray(parsed) && parsed.length) {
              return parsed.map((m) => ({
                line: m.line,
                code: String(m.code || "").replace(/^6660*/, "") || String(m.code || ""),
              }));
            }
          } catch {}
        }
      }
    }

    // 3. Fallback: Parse metro lines directly from props.lines (e.g. ",tmb-metro:L3,")
    const linesStr = String(props.lines || (props.line ? `,${props.line},` : ""));
    const metroTokens = linesStr
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.startsWith("tmb-metro:"));

    if (metroTokens.length > 0) {
      const cleanCode = propCode.replace(/^6660*/, "") || propCode;
      return metroTokens.map((t) => ({
        line: t.replace("tmb-metro:", ""),
        code: cleanCode,
      }));
    }

    return [];
  }

  function renderStationPopup(mapObj, pop, lngLat, props) {
    clearStationTicker();
    popupVehicleId = null;
    const metroList = extractMetroMeta(props);

    if (metroList.length > 0) {
      const lineBadges = metroList.map((m) => {
        const lineObj = byId.get(`tmb-metro:${m.line}`);
        const c = lineObj ? lineObj.color : "#9AABBE";
        return `<span class="metro-badge" style="background:${esc(c)}">${esc(m.line)}</span>`;
      }).join("");

      pop.setLngLat(lngLat).setHTML(
        `<div class="metro-pop">
          <div class="metro-pop-header">
            <div class="station-title">
              <span class="station-icon">🚇</span>
              <b class="station-name">${esc(props.name || "İstasyon")}</b>
            </div>
            <div class="station-lines">${lineBadges}</div>
          </div>
          <div class="metro-board-subhead">
            <span class="live-pulse"><i class="pulse-dot"></i> CANLI PERON EKRANI</span>
            <span class="metro-board-time js-board-clock">--:--:--</span>
          </div>
          <div class="metro-board js-metro-board">
            <div class="metro-board-loading"><span class="board-spinner"></span> Varış saatleri alınıyor...</div>
          </div>
          <div class="metro-board-foot">
            <span>TMB Metro Peron Bilgisi</span>
            <span class="js-board-source">Canlı</span>
          </div>
        </div>`
      ).addTo(mapObj);

      currentPopupAbort = new AbortController();
      const codes = metroList.map((m) => m.code).join(",");
      const base = apiBase();
      const params = new URLSearchParams();
      params.set("codes", codes);
      if (props.name) params.set("name", props.name);
      if (focusId && focusId.startsWith("tmb-metro:")) {
        params.set("line", focusId.replace("tmb-metro:", ""));
      }
      const url = `${base}/api/metro-arrivals?${params}`;

      let arrivalData = [];
      async function fetchArrivals() {
        try {
          const res = await fetch(url, {
            signal: currentPopupAbort ? currentPopupAbort.signal : undefined,
            headers: { accept: "application/json" },
          });
          if (!res.ok) throw new Error(String(res.status));
          const data = await res.json();
          const nowMs = Date.now();
          arrivalData = (data.arrivals || []).map((a) => ({
            ...a,
            targetTime: nowMs + Math.max(0, a.seconds) * 1000,
          }));
          const popEl = pop.getElement();
          if (!popEl) return;
          const srcEl = popEl.querySelector(".js-board-source");
          if (srcEl) {
            srcEl.textContent = data.configured ? "TMB Canlı API" : "Tarifeli / Tahmini";
          }
          updateDisplay();
        } catch (err) {
          if (err.name === "AbortError") return;
          const boardEl = pop.getElement() && pop.getElement().querySelector(".js-metro-board");
          if (boardEl) {
            boardEl.innerHTML = `<div class="board-error">Varış bilgisi alınamadı</div>`;
          }
        }
      }

      function updateDisplay() {
        const popEl = pop.getElement();
        if (!popEl) return;
        const clockEl = popEl.querySelector(".js-board-clock");
        if (clockEl) {
          clockEl.textContent = new Date().toLocaleTimeString("tr-TR", {
            timeZone: "Europe/Madrid",
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
          });
        }
        const boardEl = popEl.querySelector(".js-metro-board");
        if (!boardEl) return;

        const nowMs = Date.now();
        const active = arrivalData
          .map((a) => {
            const rem = Math.max(0, Math.round((a.targetTime - nowMs) / 1000));
            return { ...a, remaining: rem };
          })
          .filter((a) => a.remaining >= 0);

        if (!active.length) {
          boardEl.innerHTML = `<div class="board-empty">Yaklaşan tren bulunmuyor</div>`;
          return;
        }

        boardEl.innerHTML = active.slice(0, 6).map((a) => {
          const lineObj = byId.get(`tmb-metro:${a.line}`);
          const color = a.color || (lineObj ? lineObj.color : "#9AABBE");
          const isEntra = a.remaining <= 15;
          let timeHtml = "";
          if (isEntra) {
            timeHtml = `<span class="train-countdown entra"><i class="entra-dot"></i> İstasyona giriyor</span>`;
          } else {
            const m = Math.floor(a.remaining / 60);
            const s = a.remaining % 60;
            const timeStr = m > 0 ? `${m} dk ${s} sn` : `${s} sn`;
            timeHtml = `<span class="train-countdown">${timeStr}</span>`;
          }
          return `<div class="metro-train-row">
            <div class="train-left">
              <span class="metro-badge sm" style="background:${esc(color)}">${esc(a.line)}</span>
              <span class="train-dest" title="${esc(a.destination)}">${esc(a.destination)}</span>
            </div>
            <div class="train-right">${timeHtml}</div>
          </div>`;
        }).join("");
      }

      let tickCount = 0;
      activeStationTicker = setInterval(() => {
        tickCount++;
        updateDisplay();
        if (tickCount % 20 === 0) {
          fetchArrivals();
        }
      }, 1000);
      fetchArrivals();
      return;
    }

    const lineTokens = (props.lines || "").split(",").map((s) => s.trim()).filter(Boolean);
    let lineChipsHtml = "";
    if (lineTokens.length) {
      lineChipsHtml = `<div class="stop-lines-wrap">` + lineTokens.map((token) => {
        const line = byId.get(token);
        if (!line) return "";
        return `<button type="button" class="stop-line-chip" data-id="${esc(line.id)}" style="--c:${esc(line.color)}">
          <span class="chip-swatch" style="background:${esc(line.color)}"></span>
          <b>${esc(line.code)}</b>
        </button>`;
      }).join("") + `</div>`;
    }

    const isBusStop = props.kind === "stop" || lineTokens.some((t) => t.startsWith("tmb-bus:"));

    if (isBusStop && props.code) {
      pop.setLngLat(lngLat).setHTML(
        `<div class="metro-pop bus-pop">
          <div class="metro-pop-header">
            <div class="station-title">
              <span class="station-icon">🚏</span>
              <b class="station-name">${esc(props.name || "Otobüs Durağı")}</b>
            </div>
            <span class="stop-code-badge">D. ${esc(props.code)}</span>
          </div>
          <div class="metro-board-subhead">
            <span class="live-pulse"><i class="pulse-dot"></i> CANLI OTOBÜS VARIŞLARI</span>
            <span class="metro-board-time js-board-clock">--:--:--</span>
          </div>
          <div class="metro-board js-bus-board">
            <div class="metro-board-loading"><span class="board-spinner"></span> Otobüs saatleri alınıyor...</div>
          </div>
          ${lineChipsHtml ? `<div class="stop-lines-foot"><span class="stop-lines-label">Geçen Hatlar:</span>${lineChipsHtml}</div>` : ""}
          <div class="metro-board-foot">
            <span>TMB iBus Canlı Gösterge</span>
            <span class="js-board-source">Canlı</span>
          </div>
        </div>`
      ).addTo(mapObj);

      const popEl = pop.getElement();
      if (popEl) {
        for (const chip of popEl.querySelectorAll(".stop-line-chip")) {
          chip.addEventListener("click", () => {
            const id = chip.dataset.id;
            if (id) focusLine(id);
          });
        }
      }

      currentPopupAbort = new AbortController();
      const base = apiBase();
      const params = new URLSearchParams();
      params.set("code", props.code);
      if (props.name) params.set("name", props.name);
      const url = `${base}/api/stop-arrivals?${params}`;

      let arrivalData = [];
      async function fetchBusArrivals() {
        try {
          const res = await fetch(url, {
            signal: currentPopupAbort ? currentPopupAbort.signal : undefined,
            headers: { accept: "application/json" },
          });
          if (!res.ok) throw new Error(String(res.status));
          const data = await res.json();
          const nowMs = Date.now();
          arrivalData = (data.arrivals || []).map((a) => ({
            ...a,
            targetTime: nowMs + Math.max(0, a.seconds) * 1000,
          }));
          const currPop = pop.getElement();
          if (!currPop) return;
          const srcEl = currPop.querySelector(".js-board-source");
          if (srcEl) {
            srcEl.textContent = data.configured ? "TMB iBus Canlı" : "iBus Yanıt Vermedi";
          }
          updateBusDisplay();
        } catch (err) {
          if (err.name === "AbortError") return;
          const boardEl = pop.getElement() && pop.getElement().querySelector(".js-bus-board");
          if (boardEl) {
            boardEl.innerHTML = `<div class="board-error">Varış bilgisi alınamadı</div>`;
          }
        }
      }

      function updateBusDisplay() {
        const currPop = pop.getElement();
        if (!currPop) return;
        const clockEl = currPop.querySelector(".js-board-clock");
        if (clockEl) {
          clockEl.textContent = new Date().toLocaleTimeString("tr-TR", {
            timeZone: "Europe/Madrid",
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
          });
        }
        const boardEl = currPop.querySelector(".js-bus-board");
        if (!boardEl) return;

        const nowMs = Date.now();
        const active = arrivalData
          .map((a) => {
            const rem = Math.max(0, Math.round((a.targetTime - nowMs) / 1000));
            return { ...a, remaining: rem };
          })
          .filter((a) => a.remaining >= 0);

        if (!active.length) {
          boardEl.innerHTML = `<div class="board-empty">Yaklaşan otobüs bulunmuyor</div>`;
          return;
        }

        boardEl.innerHTML = active.slice(0, 8).map((a) => {
          const lineObj = byId.get(`tmb-bus:${a.line}`) || catalog.find((c) => c.code === a.line);
          const color = lineObj ? lineObj.color : "#e20613";
          const isArriving = a.remaining <= 45;
          let timeHtml = "";
          if (isArriving) {
            timeHtml = `<span class="train-countdown entra"><i class="entra-dot"></i> Yaklaşıyor</span>`;
          } else {
            const m = Math.floor(a.remaining / 60);
            const s = a.remaining % 60;
            const timeStr = m > 0 ? `${m} dk` : `${s} sn`;
            timeHtml = `<span class="train-countdown">${timeStr}</span>`;
          }
          return `<div class="metro-train-row">
            <div class="train-left">
              <span class="metro-badge sm" style="background:${esc(color)}">${esc(a.line)}</span>
              <span class="train-dest" title="${esc(a.destination)}">${esc(a.destination)}</span>
            </div>
            <div class="train-right">${timeHtml}</div>
          </div>`;
        }).join("");
      }

      let tickCount = 0;
      activeStationTicker = setInterval(() => {
        tickCount++;
        updateBusDisplay();
        if (tickCount % 20 === 0) {
          fetchBusArrivals();
        }
      }, 1000);
      fetchBusArrivals();
      return;
    }

    pop.setLngLat(lngLat).setHTML(
      `<div class="pop stop-pop">
        <b>${esc(props.name || "Durak")}</b>
        <div class="stop-pop-sub">Durak kodu: <code>${esc(props.code || "—")}</code></div>
        ${lineChipsHtml}
      </div>`
    ).addTo(mapObj);

    const popEl = pop.getElement();
    if (popEl) {
      for (const chip of popEl.querySelectorAll(".stop-line-chip")) {
        chip.addEventListener("click", () => {
          const id = chip.dataset.id;
          if (id) focusLine(id);
        });
      }
    }
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
    if (familiesEl) familiesEl.hidden = Boolean(line);
    if (hintEl) hintEl.hidden = Boolean(line);
    const mainNav = document.getElementById("main-nav");

    if (!line) {
      focusBar.hidden = true;
      focusDetail.hidden = true;
      if (mainNav) mainNav.hidden = false;
      markCurrent();
      return;
    }
    if (mainNav) mainNav.hidden = true;
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
    if (!line) return;
    const kind = line.mode === "bus" ? "stop" : "station";
    const stopsList = stopsFor(line.id).filter((stop) => stop.kind === kind);
    const ordered = alongSort(line.id, stopsList);
    const tabStops = document.getElementById("tab-stops");
    if (tabStops) tabStops.textContent = `Duraklar (${ordered.length})`;

    if (!ordered.length) {
      const empty = document.createElement("p");
      empty.className = "focus-empty";
      empty.textContent = "Bu hatta ait durak bulunamadı.";
      box.append(empty);
      return;
    }

    const list = document.createElement("div");
    list.className = "stops";
    ordered.forEach((stop, index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "stop-timeline-row";
      button.style.setProperty("--c", line.color || "#3d6f99");

      const seq = document.createElement("span");
      seq.className = "stop-seq";
      seq.textContent = `${index + 1}`;

      const dot = document.createElement("span");
      dot.className = "stop-dot";

      const nameSpan = document.createElement("span");
      nameSpan.className = "stop-name-text";
      nameSpan.textContent = stop.name;

      button.append(seq, dot, nameSpan);

      // Transfer badges for other lines passing through this stop
      const otherLines = (stop.lines || "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .filter((lId) => lId !== line.id)
        .map((lId) => byId.get(lId))
        .filter(Boolean);

      if (otherLines.length > 0) {
        const transfers = document.createElement("span");
        transfers.className = "stop-transfers";
        otherLines.slice(0, 3).forEach((other) => {
          const badge = document.createElement("span");
          badge.className = "metro-badge sm";
          badge.style.background = other.color;
          badge.textContent = other.code;
          transfers.append(badge);
        });
        if (otherLines.length > 3) {
          const more = document.createElement("span");
          more.className = "metro-badge sm";
          more.style.background = "#2a3848";
          more.textContent = `+${otherLines.length - 3}`;
          transfers.append(more);
        }
        button.append(transfers);
      }

      button.addEventListener("click", () => {
        stopFollow();
        skipMovePoll = true;
        map.easeTo({
          center: [stop.lng, stop.lat],
          zoom: Math.max(map.getZoom(), 15.5),
          duration: 500,
          essential: true,
        });
        renderStationPopup(map, popup, [stop.lng, stop.lat], stop);
        if (narrowQuery.matches) {
          panel.classList.add("collapsed");
          layout();
        }
      });
      list.append(button);
    });
    box.append(list);
  }

  function renderVehicles() {
    const box = document.getElementById("focus-vehicles");
    if (!box) return;
    box.replaceChildren();
    const line = focusId && byId.get(focusId);
    if (!line || (line.mode !== "metro" && line.live === false)) return;
    const list = [];
    for (const op of ["tmb", "fgc", "tram"]) {
      for (const vehicle of vehicles[op].values()) {
        const match = lineFor(vehicle);
        if (match && match.id === line.id) list.push(vehicle);
      }
    }
    const tabVehicles = document.getElementById("tab-vehicles");
    if (tabVehicles) tabVehicles.textContent = `Canlı Araçlar (${list.length})`;

    if (!list.length) {
      const empty = document.createElement("p");
      empty.className = "focus-empty";
      empty.textContent = line.mode === "metro"
        ? "Tren konumları istasyon sürelerine göre hesaplanıyor..."
        : "Bu hatta şu anda aktif araç görünmüyor.";
      box.append(empty);
      return;
    }
    for (const vehicle of list) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "veh-row";
      if (vehicle.id === followId) button.classList.add("on");
      button.style.setProperty("--c", colorFor(vehicle));

      const left = document.createElement("div");
      left.className = "veh-row-left";
      const dest = document.createElement("div");
      dest.className = "veh-row-dest";
      dest.textContent = vehicle.destination ? `Yön: ${vehicle.destination}` : "Yön belirtilmemiş";
      const tag = document.createElement("div");
      tag.className = "veh-row-tag";
      tag.textContent = line.mode === "metro"
        ? "⏱️ Tahmini tren konumu"
        : (vehicle.source === "gps" ? "⚡ Canlı GPS konumu" : "⏱️ Tahmini konum");
      left.append(dest, tag);

      const action = document.createElement("span");
      action.className = "veh-track-action";
      action.textContent = vehicle.id === followId ? "İzleniyor ✓" : "Takip Et";

      button.append(left, action);
      button.addEventListener("click", () => {
        openPopup(popup, vehicle);
        startFollow(vehicle.id);
        if (narrowQuery.matches) {
          panel.classList.add("collapsed");
          layout();
        }
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
      if (!line) continue;
      if (line.mode === "metro") {
        if (!focusId || line.id !== focusId) continue;
      } else if (line.live === false) {
        continue;
      }
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

// User Location & Nearby Transit logic
function locateUser(animate = true) {
  if (isLocating) return;
  const btn = document.getElementById("btn-locate");
  const quickBtn = document.getElementById("quick-locate-btn");
  if (btn) btn.classList.add("loading");
  if (quickBtn) quickBtn.classList.add("loading");
  isLocating = true;

  if (!navigator.geolocation) {
    isLocating = false;
    if (btn) btn.classList.remove("loading");
    if (quickBtn) quickBtn.classList.remove("loading");
    setStatus("warn", "Konum desteklenmiyor", "Test konumu kullanılabilir");
    simulateCatalunya();
    return;
  }

  setStatus("quiet", "Konum aranıyor...", "");

  navigator.geolocation.getCurrentPosition(
    (pos) => {
      isLocating = false;
      if (btn) {
        btn.classList.remove("loading");
        btn.classList.add("active");
      }
      if (quickBtn) quickBtn.classList.remove("loading");

      const lng = pos.coords.longitude;
      const lat = pos.coords.latitude;
      const accuracy = pos.coords.accuracy;

      setUserLocation(lng, lat, accuracy, false, animate);
    },
    (err) => {
      isLocating = false;
      if (btn) btn.classList.remove("loading");
      if (quickBtn) quickBtn.classList.remove("loading");
      console.warn("Geolocation error:", err);
      handleLocationError(err);
    },
    { enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 }
  );
}

function handleLocationError(err) {
  let msg = "Konum alınamadı";
  if (err.code === 1) msg = "Konum izni reddedildi";
  else if (err.code === 2) msg = "Konum bulunamadı";
  else if (err.code === 3) msg = "Konum zaman aşımı";

  setStatus("warn", msg, "Barselona merkezini test edebilirsiniz");
  selectTab("nearby");
  if (nearbyDemoPrompt) nearbyDemoPrompt.hidden = false;
  if (nearbyStatusTitle) nearbyStatusTitle.textContent = "Konum İzni Alınamadı";
  if (nearbyStatusDesc) nearbyStatusDesc.textContent = "Barselona merkezindeki durakları görmek için aşağıdaki butona dokunun.";
  if (nearbyLinesBlock) nearbyLinesBlock.hidden = true;
  if (nearbyStopsBlock) nearbyStopsBlock.hidden = true;
}

function setUserLocation(lng, lat, accuracy, isDemo = false, animate = true) {
  const distToBcnCenter = haversine(lng, lat, 2.17005, 41.38702);
  const isOutside = distToBcnCenter > 40000;

  userLocation = { lng, lat, accuracy, isDemo, isOutside };
  updateUserMarker(lng, lat);

  if (animate && window.__bcnMap) {
    skipMovePoll = true;
    window.__bcnMap.flyTo({
      center: [lng, lat],
      zoom: isOutside ? 12 : 15.5,
      duration: 1000,
      essential: true,
    });
  }

  setStatus("ok", isDemo ? "Test: Pl. Catalunya" : "Konum bulundu", "");
  selectTab("nearby");
  renderNearby();
}

function simulateCatalunya() {
  setUserLocation(2.17005, 41.38702, 10, true, true);
}

function updateUserMarker(lng, lat) {
  const map = window.__bcnMap;
  if (!map) return;
  if (!userMarker) {
    const el = document.createElement("div");
    el.className = "user-location-marker";
    const radar = document.createElement("span");
    radar.className = "user-location-radar";
    const dot = document.createElement("span");
    dot.className = "user-location-dot";
    el.append(radar, dot);
    userMarker = new maplibregl.Marker({ element: el, anchor: "center" })
      .setLngLat([lng, lat])
      .addTo(map);
  } else {
    userMarker.setLngLat([lng, lat]);
  }
}

function renderNearby() {
  if (!userLocation) return;
  const { lng, lat, isOutside, isDemo } = userLocation;

  if (isOutside && !isDemo) {
    if (nearbyDemoPrompt) nearbyDemoPrompt.hidden = false;
    if (nearbyStatusTitle) nearbyStatusTitle.textContent = "Barselona Dışındasınız";
    const km = Math.round(haversine(lng, lat, 2.17005, 41.38702) / 1000);
    if (nearbyStatusDesc) nearbyStatusDesc.textContent = `Bulunduğunuz konum Barselona'ya ~${km} km mesafede.`;
    if (nearbyLinesBlock) nearbyLinesBlock.hidden = true;
    if (nearbyStopsBlock) nearbyStopsBlock.hidden = true;
    return;
  }

  if (nearbyDemoPrompt) nearbyDemoPrompt.hidden = true;
  if (nearbyStatusTitle) nearbyStatusTitle.textContent = isDemo ? "📍 Plaça de Catalunya (Simülasyon)" : "📍 Bulunduğunuz Bölge";
  if (nearbyStatusDesc) nearbyStatusDesc.textContent = "En yakın duraklar ve canlı hatlar:";
  if (nearbyLinesBlock) nearbyLinesBlock.hidden = false;
  if (nearbyStopsBlock) nearbyStopsBlock.hidden = false;

  const stopsWithDist = [];
  for (const stop of stopFeatures) {
    const dist = Math.round(haversine(lng, lat, stop.lng, stop.lat));
    stopsWithDist.push({ ...stop, distance: dist });
  }
  stopsWithDist.sort((a, b) => a.distance - b.distance);

  const nearest15 = stopsWithDist.slice(0, 15);

  const seenLineIds = new Set();
  const nearbyLines = [];
  for (const s of nearest15) {
    const lineIds = (s.lines || "").split(",").map((t) => t.trim()).filter(Boolean);
    for (const lid of lineIds) {
      if (!seenLineIds.has(lid)) {
        seenLineIds.add(lid);
        const lObj = byId.get(lid);
        if (lObj) nearbyLines.push(lObj);
      }
    }
  }

  if (nearbyLinesChips) {
    nearbyLinesChips.replaceChildren();
    for (const line of nearbyLines) {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "nearby-line-chip";
      chip.style.setProperty("--c", line.color || "#3d6f99");
      chip.innerHTML = `<span class="swatch" style="background:${esc(line.color)}"></span><b>${esc(line.code)}</b>`;
      chip.title = `${line.code}: ${line.name || ""}`;
      chip.addEventListener("click", () => {
        focusLine(line.id);
      });
      nearbyLinesChips.append(chip);
    }
  }

  if (nearbyStopsList) {
    nearbyStopsList.replaceChildren();
    for (const stop of nearest15) {
      const card = document.createElement("button");
      card.type = "button";
      card.className = "nearby-stop-card";

      const top = document.createElement("div");
      top.className = "nearby-stop-top";

      const nameWrap = document.createElement("div");
      nameWrap.className = "nearby-stop-name-wrap";
      const icon = document.createElement("span");
      icon.className = "nearby-stop-icon";
      icon.textContent = stop.kind === "station" ? (stop.lines.includes("fgc:") ? "🚆" : "🚇") : (stop.lines.includes("tram:") ? "🚊" : "🚏");
      const name = document.createElement("span");
      name.className = "nearby-stop-name";
      name.textContent = stop.name;
      nameWrap.append(icon, name);

      const dist = document.createElement("span");
      dist.className = "nearby-stop-dist";
      dist.textContent = stop.distance < 1000 ? `${stop.distance} m` : `${(stop.distance / 1000).toFixed(1)} km`;

      top.append(nameWrap, dist);

      const foot = document.createElement("div");
      foot.className = "nearby-stop-foot";

      const linesWrap = document.createElement("div");
      linesWrap.className = "nearby-stop-lines";
      const stopLineIds = (stop.lines || "").split(",").map((t) => t.trim()).filter(Boolean);
      for (const lid of stopLineIds.slice(0, 5)) {
        const lObj = byId.get(lid);
        if (lObj) {
          const badge = document.createElement("span");
          badge.className = "metro-badge sm";
          badge.style.background = lObj.color || "#3d6f99";
          badge.textContent = lObj.code;
          linesWrap.append(badge);
        }
      }
      if (stopLineIds.length > 5) {
        const more = document.createElement("span");
        more.className = "metro-badge sm";
        more.style.background = "#243140";
        more.textContent = `+${stopLineIds.length - 5}`;
        linesWrap.append(more);
      }

      const walk = document.createElement("span");
      walk.className = "nearby-walk-time";
      const walkMin = Math.round(stop.distance / 80);
      walk.textContent = walkMin <= 1 ? "1 dk yürüme" : `${walkMin} dk yürüme`;

      foot.append(linesWrap, walk);
      card.append(top, foot);

      card.addEventListener("click", () => {
        stopFollow();
        skipMovePoll = true;
        const map = window.__bcnMap;
        const pop = window.__bcnPopup;
        if (map) {
          map.easeTo({
            center: [stop.lng, stop.lat],
            zoom: Math.max(map.getZoom(), 15.5),
            duration: 500,
            essential: true,
          });
          if (pop) renderStationPopup(map, pop, [stop.lng, stop.lat], stop);
        }
        if (narrowQuery.matches) {
          panel.classList.add("collapsed");
          layout();
        }
      });

      nearbyStopsList.append(card);
    }
  }
}

// Category Tabs selection
function selectTab(tab) {
  currentTab = tab;
  if (modeTabsEl) {
    for (const b of modeTabsEl.querySelectorAll(".mode-tab")) {
      b.classList.toggle("active", b.dataset.tab === tab);
    }
  }
  if (search) search.value = "";
  if (searchClearBtn) searchClearBtn.hidden = true;
  if (searchResultsSection) searchResultsSection.hidden = true;

  if (tab === "nearby") {
    groupsEl.hidden = true;
    nearbySection.hidden = false;
    if (userLocation) {
      renderNearby();
    } else {
      locateUser(true);
    }
  } else {
    nearbySection.hidden = true;
    groupsEl.hidden = false;
    filterGroupsByTab(tab);
  }
}

function filterGroupsByTab(tab) {
  for (const groupEl of groupsEl.querySelectorAll(".group")) {
    const groupId = groupEl.dataset.group;
    if (tab === "all") {
      groupEl.hidden = false;
      groupEl.classList.toggle("shut", !openGroups.has(groupId));
    } else if (tab === groupId) {
      groupEl.hidden = false;
      groupEl.classList.remove("shut");
    } else {
      groupEl.hidden = true;
    }
  }
}

function restoreTabView() {
  if (searchClearBtn) searchClearBtn.hidden = true;
  if (searchResultsSection) searchResultsSection.hidden = true;
  if (currentTab === "nearby") {
    groupsEl.hidden = true;
    nearbySection.hidden = false;
  } else {
    nearbySection.hidden = true;
    groupsEl.hidden = false;
    filterGroupsByTab(currentTab);
  }
}

// Search handler
function handleSearch(rawQuery) {
  const query = norm(rawQuery).trim();
  if (!query) {
    restoreTabView();
    return;
  }
  if (searchClearBtn) searchClearBtn.hidden = false;
  groupsEl.hidden = true;
  nearbySection.hidden = true;
  if (searchResultsSection) searchResultsSection.hidden = false;

  const lineMatches = [];
  for (const line of catalog) {
    const code = norm(line.code);
    const name = norm(line.name || "");
    const mode = norm(line.mode || "");
    let score = -1;
    if (code === query) score = 0;
    else if (code.startsWith(query)) score = 1;
    else if (code.includes(query)) score = 2;
    else if (name.includes(query)) score = 3;
    else if (mode.includes(query)) score = 4;

    if (score >= 0) {
      lineMatches.push({ line, score });
    }
  }
  lineMatches.sort((a, b) => a.score - b.score);

  const matchedStops = [];
  if (query.length >= 3) {
    for (const stop of stopFeatures) {
      if (norm(stop.name).includes(query)) {
        matchedStops.push(stop);
        if (matchedStops.length >= 8) break;
      }
    }
  }

  renderSearchResults(lineMatches.map((m) => m.line), matchedStops);
}

function renderSearchResults(lines, stops) {
  if (searchSummaryEl) {
    const parts = [];
    if (lines.length) parts.push(`${lines.length} hat`);
    if (stops.length) parts.push(`${stops.length} durak`);
    searchSummaryEl.textContent = parts.length ? `${parts.join(", ")} bulundu` : "Sonuç bulunamadı";
  }

  if (!searchResultsListEl) return;
  searchResultsListEl.replaceChildren();

  // 1. Line results
  for (const line of lines) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "search-item";
    item.style.setProperty("--c", line.color || "#3d6f99");

    const swatch = document.createElement("i");
    swatch.className = "swatch";
    swatch.style.background = line.color || "#3d6f99";

    const info = document.createElement("div");
    info.className = "search-item-info";
    const name = document.createElement("div");
    name.className = "search-item-name";
    name.textContent = `${line.code} · ${line.name || ""}`;
    const sub = document.createElement("div");
    sub.className = "search-item-sub";
    sub.textContent = `${line.mode.toUpperCase()} · ${chipText(line)}`;
    info.append(name, sub);

    item.append(swatch, info);
    item.addEventListener("click", () => {
      focusLine(line.id);
    });
    searchResultsListEl.append(item);
  }

  // 2. Stop results
  for (const stop of stops) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "search-item";

    const icon = document.createElement("span");
    icon.className = "nearby-stop-icon";
    icon.textContent = stop.kind === "station" ? (stop.lines.includes("fgc:") ? "🚆" : "🚇") : (stop.lines.includes("tram:") ? "🚊" : "🚏");

    const info = document.createElement("div");
    info.className = "search-item-info";
    const name = document.createElement("div");
    name.className = "search-item-name";
    name.textContent = stop.name;
    const sub = document.createElement("div");
    sub.className = "search-item-sub";
    sub.textContent = stop.kind === "station" ? "İstasyon" : `Otobüs Durağı (Kod: ${stop.code || "—"})`;
    info.append(name, sub);

    item.append(icon, info);
    item.addEventListener("click", () => {
      stopFollow();
      skipMovePoll = true;
      const map = window.__bcnMap;
      const pop = window.__bcnPopup;
      if (map) {
        map.easeTo({
          center: [stop.lng, stop.lat],
          zoom: Math.max(map.getZoom(), 15.5),
          duration: 500,
          essential: true,
        });
        if (pop) renderStationPopup(map, pop, [stop.lng, stop.lat], stop);
      }
      if (narrowQuery.matches) {
        panel.classList.add("collapsed");
        layout();
      }
    });
    searchResultsListEl.append(item);
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
  const line = lineFor(vehicle);
  const isMetro = line && line.mode === "metro";
  const gps = vehicle.source === "gps";
  entry.el.classList.toggle("gps", gps);
  entry.el.classList.toggle("est", !gps);
  entry.el.classList.toggle("metro", Boolean(isMetro));
  entry.el.style.setProperty("--c", colorFor(vehicle));
  entry.el.setAttribute("aria-label", `${vehicle.line} ${isMetro ? "metro" : (gps ? "canlı" : "tahmini")}`);
  entry.code.textContent = vehicle.line;
  entry.tag.textContent = isMetro ? "metro" : (gps ? "canlı" : "tahmini");
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
  clearStationTicker();
  const line = lineFor(vehicle);
  const isMetro = line && line.mode === "metro";
  const gps = vehicle.source === "gps";
  const src = isMetro
    ? "Kaynak: tahmini metro konumu. İstasyon varış sürelerine ve GTFS hat geometrisine göre hesaplanmıştır."
    : (gps
      ? "Kaynak: canlı GPS."
      : "Kaynak: tahmini. Konum, iBus varış süresinin GTFS hat şekline işlenmesidir. Gerçek GPS değildir.");
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
  clearStationTicker();
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
    if (!line) return [];
    if (line.mode === "metro") {
      return [`metro:${line.code}`];
    }
    if (line.live === false) return [];
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
  if (vehicle.operator === "tmb") {
    const metro = byId.get(`tmb-metro:${vehicle.line}`);
    if (metro) return metro;
    return byId.get(`tmb-bus:${vehicle.line}`);
  }
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
    /* private mode */
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
  if (!familiesEl) return;
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
  if (!hintEl) return;
  hintEl.textContent = "Metro, FGC ve TRAM çizili. İstasyonlara basınca canlı peron ekranı açılır. Bir hat seçince o hattın tüm araçları gösterilir.";
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
  if (sheetToggle) {
    const textEl = sheetToggle.querySelector(".sheet-toggle-text");
    if (textEl) textEl.textContent = line ? line.code : "Hatlar";
    else sheetToggle.textContent = line ? line.code : "Hatlar";
  }
  subtitle.textContent = line ? focusSubtitle(line) : "Hat seç veya yakınlaş";
}

function focusSubtitle(line) {
  if (line.mode === "metro") return "Tahmini tren takibi & Peron ekranı";
  if (line.mode === "bus") return "Tahmini takip";
  return "Canlı takip";
}

function chipClass(line) {
  if (line.mode === "metro") return "est";
  if (line.mode === "bus") return "est";
  return "gps";
}

function chipText(line) {
  if (line.mode === "metro") return "tahmini / canlı peron";
  if (line.mode === "bus") return "tahmini";
  return "gps";
}

function focusNote(line) {
  if (line.mode === "metro") {
    return "TMB tren GPS'i yayınlamıyor. Tren konumları istasyon varış sürelerine göre hesaplanmıştır. Canlı peron ekranı için istasyonlara tıklayın.";
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
    const bottom = collapsed ? (focusId ? 110 : 80) : Math.round(window.innerHeight * 0.48);
    return { top: 78, bottom, left: 10, right: 10 };
  }
  return { top: focusId ? 86 : 52, bottom: 28, left: 368, right: 16 };
}

function layout() {
  const map = window.__bcnMap;
  if (!map) return;
  map.setPadding(panelPadding());
  if (sheetToggle) {
    sheetToggle.setAttribute("aria-expanded", panel.classList.contains("collapsed") ? "false" : "true");
  }
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
