/**
 * RADAR MAR MENOR — Lógica de cliente (MVP estático, sin backend)
 *
 * Todas las consultas se realizan directamente desde el navegador contra
 * servicios públicos que envían la cabecera CORS `Access-Control-Allow-Origin: *`
 * (verificado manualmente antes del despliegue):
 *   - UPCT THREDDS (marmenor.upct.es): catálogo L1, OPeNDAP CTD/Secchi, CSV L4, WMS L2.
 *     Es un ARCHIVO HISTÓRICO de campañas discretas; no es telemetría en tiempo real.
 *   - Open-Meteo (api.open-meteo.com / marine-api.open-meteo.com): valores "current"
 *     derivados de MODELOS NUMÉRICOS, no mediciones in situ.
 *   - GBIF (api.gbif.org): registros de ocurrencias indexados.
 *   - CARM (nexo.carm.es): CSV estático del catálogo de playas.
 *
 * No hay proxy ni servidor propio. Si una fuente falla, se muestra el error real;
 * nunca se sustituyen datos por valores inventados.
 */

(function () {
  "use strict";

  const MAR_MENOR_CENTER = [37.735, -0.785];
  const DEFAULT_ZOOM = 11;
  const FETCH_TIMEOUT_MS = 25000;

  const UPCT = {
    ctdCatalog: "https://marmenor.upct.es/thredds/catalog/L1/SERVICIODEPESCA/catalog.xml",
    secchiCatalog: "https://marmenor.upct.es/thredds/catalog/L1/SECCHI/catalog.xml",
    ctdData: (c) =>
      `https://marmenor.upct.es/thredds/dodsC/L1/SERVICIODEPESCA/${c}/data.nc.ascii?Latitud,Longitud,Profundidad,Temperatura,Salinidad,Oxigeno,Clorofila,Turbidez,CDOM`,
    secchiData: (c) => `https://marmenor.upct.es/thredds/dodsC/L1/SECCHI/${c}/data_transparency.nc.ascii`,
    l4: (name) => `https://marmenor.upct.es/thredds/fileServer/L4/${name}.csv`,
    wms: (variable) => `https://marmenor.upct.es/thredds/wms/L2/${variable}.nc`,
  };

  const L4_FILES = {
    temperatura: { file: "Temperatura", label: "Temperatura del agua", unit: "°C" },
    salinidad: { file: "Salinidad", label: "Salinidad", unit: "PSU" },
    oxigeno: { file: "Oxigeno", label: "Oxígeno disuelto", unit: "mg/L" },
    clorofila: { file: "Clorofila", label: "Clorofila-a", unit: "mg/m³" },
    turbidez: { file: "Turbidez", label: "Turbidez", unit: "FTU" },
    transparencia: { file: "Transparencia", label: "Transparencia (Disco Secchi)", unit: "m" },
  };

  const METEO_POINTS = [
    { id: "centro", label: "Centro de la laguna", lat: 37.735, lon: -0.785 },
    { id: "norte", label: "Cubeta norte", lat: 37.812, lon: -0.782 },
    { id: "estacio", label: "Gola del Estacio", lat: 37.746, lon: -0.732 },
    { id: "albujon", label: "Rambla del Albujón", lat: 37.718, lon: -0.838 },
    { id: "sur", label: "Cubeta sur", lat: 37.658, lon: -0.758 },
  ];
  const METEO_VARS = "temperature_2m,relative_humidity_2m,wind_speed_10m,wind_direction_10m,wind_gusts_10m,precipitation,surface_pressure";
  const METEO_URL =
    "https://api.open-meteo.com/v1/forecast?latitude=" +
    METEO_POINTS.map((p) => p.lat).join(",") +
    "&longitude=" +
    METEO_POINTS.map((p) => p.lon).join(",") +
    `&current=${METEO_VARS}&timezone=Europe%2FMadrid`;
  const MARINE_URL =
    "https://marine-api.open-meteo.com/v1/marine?latitude=37.735&longitude=-0.785&current=wave_height,wave_direction,wave_period,sea_surface_temperature&timezone=Europe%2FMadrid";
  const GBIF_URL =
    "https://api.gbif.org/v1/occurrence/search?decimalLatitude=37.62,37.85&decimalLongitude=-0.87,-0.71&hasCoordinate=true&limit=40";
  const PLAYAS_URL = "https://nexo.carm.es/nexo/archivos/recursos/opendata/csv/Playas.csv";

  const SECTOR_PRESETS = {
    all: { center: [37.735, -0.785], zoom: 11 },
    norte: { center: [37.812, -0.782], zoom: 13 },
    estacio: { center: [37.746, -0.732], zoom: 13 },
    albujon: { center: [37.718, -0.838], zoom: 13 },
    sur: { center: [37.658, -0.758], zoom: 13 },
  };

  const WMS_SCALE_RANGES = {
    Temperatura: "12,32",
    Salinidad: "38,47",
    Oxigeno: "3,9",
    Clorofila: "0,3",
    Turbidez: "0,5",
  };

  // Contorno aproximado de referencia (no oficial) de la laguna; se usa para dibujar
  // el perímetro y para comprobar si una celda de modelo cae dentro o fuera de la laguna.
  const LAGOON_REFERENCE_POLYGON = [
    [37.832, -0.768],
    [37.81, -0.788],
    [37.785, -0.812],
    [37.74, -0.848],
    [37.705, -0.842],
    [37.668, -0.822],
    [37.638, -0.762],
    [37.633, -0.72],
    [37.685, -0.728],
    [37.748, -0.735],
    [37.805, -0.752],
  ];

  const SOURCE_LABELS = {
    upctCatalog: "UPCT THREDDS · Catálogo L1 (campañas)",
    upctCtd: "UPCT THREDDS · CTD L1 (OPeNDAP)",
    upctSecchi: "UPCT THREDDS · Secchi L1 (OPeNDAP)",
    upctL4: "UPCT THREDDS · Series agregadas L4 (CSV)",
    meteo: "Open-Meteo Forecast API (modelo atmosférico)",
    marine: "Open-Meteo Marine API (modelo marino)",
    gbif: "GBIF Occurrence Search API",
    playas: "CARM · Catálogo de playas (CSV nexo.carm.es)",
  };

  const state = {
    map: null,
    baseLayers: {},
    activeBaseLayer: null,
    wmsOverlay: null,
    wmsTimesCache: {},
    wmsToken: 0,
    layerGroups: {},
    campaigns: [],
    secchiCampaigns: new Set(),
    selectedCampaign: null,
    campaignToken: 0,
    data: {
      stations: null,
      secchi: null,
      series: null,
      meteo: null,
      marine: null,
      gbif: null,
      playas: null,
    },
    sources: {},
    selectedCtdMetric: "oxy_mgl",
    selectedSeriesParam: "temperatura",
    searchQuery: "",
    selectedItem: null,
    sweepActive: true,
    loading: false,
  };

  // ---------------------------------------------------------------------------
  // Utilidades
  // ---------------------------------------------------------------------------
  function escapeHtml(str) {
    return String(str ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function formatNum(val, decimals = 2, fallback = "N/D") {
    if (val === null || val === undefined || Number.isNaN(Number(val))) return fallback;
    return Number(val).toFixed(decimals);
  }

  function fmtCampaign(c) {
    return c && c.length === 8 ? `${c.slice(0, 4)}-${c.slice(4, 6)}-${c.slice(6, 8)}` : String(c || "");
  }

  function daysSince(isoDate) {
    const t = Date.parse(`${isoDate}T00:00:00Z`);
    if (Number.isNaN(t)) return null;
    return Math.floor((Date.now() - t) / 86400000);
  }

  function fmtLocal(iso) {
    try {
      return new Date(iso).toLocaleString("es-ES", { timeZone: "Europe/Madrid" });
    } catch (_) {
      return iso;
    }
  }

  function haversineKm(lat1, lon1, lat2, lon2) {
    const toRad = (d) => (d * Math.PI) / 180;
    const R = 6371.0;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  function pointInPolygon(lat, lon, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [yi, xi] = poly[i];
      const [yj, xj] = poly[j];
      if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }

  function mean(vals) {
    const clean = vals.filter((v) => typeof v === "number" && Number.isFinite(v) && v > -900);
    return clean.length ? Number((clean.reduce((a, b) => a + b, 0) / clean.length).toFixed(2)) : null;
  }

  function normalizeDate(raw) {
    const m = String(raw || "").trim().match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})/);
    if (!m) return String(raw || "").trim();
    return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  }

  /** fetch con timeout que registra estado HTTP, latencia y hora de consulta. */
  async function timedFetch(url, { timeoutMs = FETCH_TIMEOUT_MS, cache = "default" } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const queriedAt = new Date().toISOString();
    const t0 = performance.now();
    let resp;
    try {
      resp = await fetch(url, { signal: controller.signal, cache, mode: "cors", credentials: "omit" });
    } catch (err) {
      clearTimeout(timer);
      if (err && err.name === "AbortError") {
        throw Object.assign(new Error(`Tiempo de espera agotado (${timeoutMs / 1000} s)`), { url, queriedAt, httpStatus: 0 });
      }
      throw Object.assign(new Error("Error de red o bloqueo CORS (el navegador no expone más detalle)"), { url, queriedAt, httpStatus: 0 });
    }
    clearTimeout(timer);
    const latencyMs = Math.round(performance.now() - t0);
    if (!resp.ok) {
      throw Object.assign(new Error(`HTTP ${resp.status}`), { url, queriedAt, httpStatus: resp.status, latencyMs });
    }
    return { resp, queriedAt, latencyMs, url, httpStatus: resp.status };
  }

  function setSource(key, info) {
    state.sources[key] = Object.assign({ label: SOURCE_LABELS[key] || key }, info);
  }

  function setSourceError(key, err, extra = {}) {
    setSource(key, Object.assign({
      ok: false,
      error: String((err && err.message) || err),
      url: err && err.url,
      queriedAt: (err && err.queriedAt) || new Date().toISOString(),
      httpStatus: err && err.httpStatus,
    }, extra));
  }

  function parseOpendapAscii(text) {
    const parts = text.split("---------------------------------------------");
    if (parts.length < 2) throw new Error("Formato OPeNDAP ASCII inesperado");
    const out = {};
    for (const sec of parts[1].trim().split(/\r?\n\s*\r?\n/)) {
      const lines = sec.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      if (lines.length < 2) continue;
      const varName = lines[0].split("[")[0].trim();
      // Se conservan los NaN para no desalinear los índices entre variables.
      out[varName] = lines
        .slice(1)
        .join(",")
        .split(",")
        .map((x) => x.trim())
        .filter((x) => x !== "")
        .map((x) => Number(x));
    }
    return out;
  }

  /** Convierte UTM huso 30N (ETRS89 ≈ WGS84) a lat/lon decimales. */
  function utm30nToWgs84(easting, northing) {
    const a = 6378137.0;
    const f = 1 / 298.257223563;
    const k0 = 0.9996;
    const e = Math.sqrt(f * (2 - f));
    const e1sq = (e * e) / (1 - e * e);
    const x = easting - 500000.0;
    const M = northing / k0;
    const mu = M / (a * (1 - e ** 2 / 4 - (3 * e ** 4) / 64 - (5 * e ** 6) / 256));
    const e1 = (1 - Math.sqrt(1 - e * e)) / (1 + Math.sqrt(1 - e * e));
    const fp =
      mu +
      ((3 * e1) / 2 - (27 * e1 ** 3) / 32) * Math.sin(2 * mu) +
      ((21 * e1 ** 2) / 16 - (55 * e1 ** 4) / 32) * Math.sin(4 * mu) +
      ((151 * e1 ** 3) / 96) * Math.sin(6 * mu) +
      ((1097 * e1 ** 4) / 512) * Math.sin(8 * mu);
    const c1 = e1sq * Math.cos(fp) ** 2;
    const t1 = Math.tan(fp) ** 2;
    const r1 = (a * (1 - e * e)) / (1 - (e * Math.sin(fp)) ** 2) ** 1.5;
    const n1 = a / Math.sqrt(1 - (e * Math.sin(fp)) ** 2);
    const d = x / (n1 * k0);
    const q1 = (n1 * Math.tan(fp)) / r1;
    const q2 = d ** 2 / 2;
    const q3 = ((5 + 3 * t1 + 10 * c1 - 4 * c1 ** 2 - 9 * e1sq) * d ** 4) / 24;
    const q4 = ((61 + 90 * t1 + 298 * c1 + 45 * t1 ** 2 - 3 * c1 ** 2 - 252 * e1sq) * d ** 6) / 720;
    const lat = fp - q1 * (q2 - q3 + q4);
    const q6 = ((1 + 2 * t1 + c1) * d ** 3) / 6;
    const q7 = ((5 - 2 * c1 + 28 * t1 - 3 * c1 ** 2 + 8 * e1sq + 24 * t1 ** 2) * d ** 5) / 120;
    const lon = (-3 * Math.PI) / 180 + (d - q6 + q7) / Math.cos(fp);
    return [Number(((lat * 180) / Math.PI).toFixed(6)), Number(((lon * 180) / Math.PI).toFixed(6))];
  }

  function classifySector(lat, lon) {
    if (lat >= 37.79) return "Cubeta Norte (San Pedro / Lo Pagán)";
    if (lat >= 37.745 && lon < -0.79) return "Sector Noroeste (San Javier / Santiago de la Ribera)";
    if (lat >= 37.745 && lon >= -0.76) return "Sector Noreste (Gola del Estacio / La Manga Norte)";
    if (lat >= 37.745) return "Cubeta Centro-Norte";
    if (lat >= 37.7 && lon < -0.81) return "Margen Oeste (Los Alcázares / Rambla del Albujón)";
    if (lat >= 37.7) return "Cubeta Central";
    if (lat < 37.67 && lon < -0.79) return "Cubeta Suroeste (Los Urrutias / Los Nietos)";
    if (lat < 37.67 && lon >= -0.75) return "Cubeta Sureste (La Manga Sur)";
    return "Cubeta Sur (Islas Menores)";
  }

  // ---------------------------------------------------------------------------
  // Mapa
  // ---------------------------------------------------------------------------
  function initMap() {
    const map = L.map("radar-map", {
      center: MAR_MENOR_CENTER,
      zoom: DEFAULT_ZOOM,
      minZoom: 8,
      maxZoom: 18,
      zoomControl: true,
    });

    const osmAttribution =
      '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors (ODbL)';

    state.baseLayers.osm_dark = L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      className: "basemap-dark-radar",
      attribution: `${osmAttribution} · estilo oscuro aplicado localmente con filtro CSS`,
    });
    state.baseLayers.osm_std = L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: osmAttribution,
    });
    state.baseLayers.ign_pnoa = L.tileLayer.wms("https://www.ign.es/wms-inspire/pnoa-ma", {
      layers: "OI.OrthoimageCoverage",
      format: "image/jpeg",
      transparent: false,
      version: "1.3.0",
      maxZoom: 19,
      attribution:
        'PNOA cedido por &copy; <a href="https://www.ign.es" target="_blank" rel="noopener">Instituto Geográfico Nacional de España (IGN PNOA)</a> · CC BY 4.0',
    });
    state.baseLayers.ign_base = L.tileLayer(
      "https://www.ign.es/wmts/ign-base?Service=WMTS&Request=GetTile&Version=1.0.0&Layer=IGNBaseTodo&Style=default&Format=image/jpeg&TileMatrixSet=GoogleMapsCompatible&TileMatrix={z}&TileRow={y}&TileCol={x}",
      {
        maxZoom: 18,
        attribution:
          '&copy; <a href="https://www.ign.es" target="_blank" rel="noopener">Instituto Geográfico Nacional de España (IGN Base)</a> · CC BY 4.0',
      }
    );

    state.activeBaseLayer = state.baseLayers.osm_dark;
    state.activeBaseLayer.addTo(map);

    map.attributionControl.addAttribution(
      'Datos: <a href="https://marmenor.upct.es/thredds/catalog/catalog.html" target="_blank" rel="noopener">UPCT</a> · ' +
        '<a href="https://open-meteo.com/" target="_blank" rel="noopener">Open-Meteo</a> (CC BY 4.0) · ' +
        '<a href="https://www.gbif.org/" target="_blank" rel="noopener">GBIF.org</a> · ' +
        '<a href="https://datosabiertos.regiondemurcia.es/" target="_blank" rel="noopener">CARM</a>'
    );

    for (const key of ["upct", "secchi", "meteo", "playas", "gbif", "userLocation"]) {
      state.layerGroups[key] = L.layerGroup().addTo(map);
    }

    L.polygon(LAGOON_REFERENCE_POLYGON, {
      color: "#38bdf8",
      weight: 1.2,
      dashArray: "5, 6",
      fillColor: "#0284c7",
      fillOpacity: 0.04,
      interactive: false,
    }).addTo(map);

    const coordsBox = document.getElementById("cursor-coords-box");
    map.on("mousemove", (ev) => {
      if (coordsBox) {
        coordsBox.textContent = `CURSOR WGS84: ${ev.latlng.lat.toFixed(4)}° N, ${ev.latlng.lng.toFixed(4)}° E · Zoom ${map.getZoom()}`;
      }
    });
    map.on("zoomend moveend", () => {
      const c = map.getCenter();
      if (coordsBox) {
        coordsBox.textContent = `CENTRO WGS84: ${c.lat.toFixed(4)}° N, ${c.lng.toFixed(4)}° E · Zoom ${map.getZoom()}`;
      }
    });

    L.control.scale({ metric: true, imperial: false, position: "bottomleft" }).addTo(map);
    state.map = map;
  }

  // ---------------------------------------------------------------------------
  // Carga de fuentes
  // ---------------------------------------------------------------------------
  async function loadUpctCatalog() {
    const [ctdRes, secRes] = await Promise.allSettled([timedFetch(UPCT.ctdCatalog), timedFetch(UPCT.secchiCatalog)]);
    if (ctdRes.status !== "fulfilled") {
      setSourceError("upctCatalog", ctdRes.reason);
      throw ctdRes.reason;
    }
    const xml = await ctdRes.value.resp.text();
    const campaigns = Array.from(new Set(Array.from(xml.matchAll(/xlink:title="(\d{8})"/g), (m) => m[1]))).sort().reverse();
    if (!campaigns.length) {
      const err = new Error("El catálogo no contiene campañas con formato AAAAMMDD");
      setSourceError("upctCatalog", Object.assign(err, { url: UPCT.ctdCatalog }));
      throw err;
    }
    let secchiNote = "";
    if (secRes.status === "fulfilled") {
      const sxml = await secRes.value.resp.text();
      state.secchiCampaigns = new Set(Array.from(sxml.matchAll(/xlink:title="(\d{8})"/g), (m) => m[1]));
      secchiNote = ` · Catálogo Secchi: ${state.secchiCampaigns.size} campañas`;
    } else {
      state.secchiCampaigns = new Set();
      secchiNote = ` · Catálogo Secchi no disponible (${secRes.reason && secRes.reason.message})`;
    }
    state.campaigns = campaigns;
    if (!state.selectedCampaign || !campaigns.includes(state.selectedCampaign)) {
      state.selectedCampaign = campaigns[0];
    }
    const newest = fmtCampaign(campaigns[0]);
    setSource("upctCatalog", {
      ok: true,
      url: UPCT.ctdCatalog,
      queriedAt: ctdRes.value.queriedAt,
      latencyMs: ctdRes.value.latencyMs,
      httpStatus: ctdRes.value.httpStatus,
      dataDate: newest,
      note: `${campaigns.length} campañas CTD (${fmtCampaign(campaigns[campaigns.length - 1])} → ${newest}). Campaña más reciente descubierta: ${newest} (hace ${daysSince(newest)} días)${secchiNote}.`,
      kind: "historico",
    });
    populateCampaignSelector();
  }

  function buildStations(parsed, secchiPoints) {
    const lats = parsed.Latitud || [];
    const lons = parsed.Longitud || [];
    const depths = parsed.Profundidad || [];
    const cols = {
      temp: parsed.Temperatura || [],
      sal: parsed.Salinidad || [],
      oxy: parsed.Oxigeno || [],
      chl: parsed.Clorofila || [],
      turb: parsed.Turbidez || [],
      cdom: parsed.CDOM || [],
    };
    const groups = new Map();
    for (let i = 0; i < lats.length; i++) {
      if (!Number.isFinite(lats[i]) || !Number.isFinite(lons[i])) continue;
      const k = `${lats[i].toFixed(5)},${lons[i].toFixed(5)}`;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push({
        depth: depths[i],
        temp: cols.temp[i],
        sal: cols.sal[i],
        oxy: cols.oxy[i],
        chl: cols.chl[i],
        turb: cols.turb[i],
        cdom: cols.cdom[i],
      });
    }
    const keys = Array.from(groups.keys()).sort((a, b) => {
      const [la, loa] = a.split(",").map(Number);
      const [lb, lob] = b.split(",").map(Number);
      return lb - la || loa - lob;
    });

    return keys.map((key, i) => {
      const [lat, lon] = key.split(",").map(Number);
      const rows = groups.get(key);
      const idx = String(i + 1).padStart(2, "0");
      const validDepths = rows.map((r) => r.depth).filter(Number.isFinite);
      const maxDepth = validDepths.length ? Number(Math.max(...validDepths).toFixed(2)) : 0;
      const bottomRows = rows.filter((r) => r.depth >= Math.max(1.5, maxDepth - 1.0));
      const surfaceRows = rows.filter((r) => r.depth <= 1.2);
      const pick = (arr, f) => mean((arr.length ? arr : rows).map(f));

      const m = {
        temp_c: pick(rows, (r) => r.temp),
        temp_surface_c: pick(surfaceRows, (r) => r.temp),
        temp_bottom_c: pick(bottomRows, (r) => r.temp),
        sal_psu: pick(rows, (r) => r.sal),
        oxy_mgl: pick(rows, (r) => r.oxy),
        oxy_bottom_mgl: pick(bottomRows, (r) => r.oxy),
        chl_mgm3: pick(rows, (r) => r.chl),
        turb_ftu: pick(rows, (r) => r.turb),
        cdom_ppb: pick(rows, (r) => r.cdom),
        secchi_m: null,
      };

      let best = Infinity;
      for (const sp of secchiPoints || []) {
        const d = Math.hypot(sp.lat - lat, sp.lon - lon);
        if (d < 0.015 && d < best) {
          best = d;
          m.secchi_m = sp.transparency_m;
        }
      }

      const profile = [];
      for (let dc = 0.5; dc <= maxDepth + 0.25; dc += 0.5) {
        const bucket = rows.filter((r) => r.depth >= dc - 0.5 && r.depth < dc);
        if (!bucket.length) continue;
        profile.push({
          depth_m: Number((dc - 0.25).toFixed(2)),
          temp_c: mean(bucket.map((r) => r.temp)),
          sal_psu: mean(bucket.map((r) => r.sal)),
          oxy_mgl: mean(bucket.map((r) => r.oxy)),
          chl_mgm3: mean(bucket.map((r) => r.chl)),
          turb_ftu: mean(bucket.map((r) => r.turb)),
        });
      }

      // Clasificación orientativa propia de esta app (umbrales fijos, no oficial).
      let level = "normal";
      const alerts = [];
      if (m.oxy_bottom_mgl !== null && m.oxy_bottom_mgl < 4.0) {
        level = "alerta";
        alerts.push(`O₂ de fondo bajo (${m.oxy_bottom_mgl} mg/L)`);
      } else if (m.oxy_mgl !== null && m.oxy_mgl < 4.8) {
        level = "vigilancia";
        alerts.push(`O₂ medio moderado-bajo (${m.oxy_mgl} mg/L)`);
      }
      if (m.chl_mgm3 !== null && m.chl_mgm3 > 1.5) {
        level = "alerta";
        alerts.push(`Clorofila-a elevada (${m.chl_mgm3} mg/m³)`);
      } else if (m.chl_mgm3 !== null && m.chl_mgm3 > 0.65) {
        if (level === "normal") level = "vigilancia";
        alerts.push(`Clorofila-a moderada (${m.chl_mgm3} mg/m³)`);
      }
      if (m.turb_ftu !== null && m.turb_ftu > 2.5) {
        if (level === "normal") level = "vigilancia";
        alerts.push(`Turbidez alta (${m.turb_ftu} FTU)`);
      }
      if (!alerts.length) alerts.push("Sin superar los umbrales orientativos de la app");

      const sector = classifySector(lat, lon);
      return {
        id: `UPCT-CTD-${idx}`,
        code: `Estación CTD-${idx}`,
        short: `E${idx}`,
        name: `Estación CTD-${idx} · ${sector}`,
        sector,
        lat,
        lon,
        sample_count: rows.length,
        max_depth_m: maxDepth,
        metrics: m,
        status_level: level,
        alerts,
        vertical_profile: profile,
      };
    });
  }

  async function loadCampaign(campaign) {
    const token = ++state.campaignToken;
    state.data.stations = null;
    state.data.secchi = null;

    const wantsSecchi = state.secchiCampaigns.has(campaign);
    const [ctdRes, secRes] = await Promise.allSettled([
      timedFetch(UPCT.ctdData(campaign)).then(async (r) => ({ meta: r, text: await r.resp.text() })),
      wantsSecchi
        ? timedFetch(UPCT.secchiData(campaign)).then(async (r) => ({ meta: r, text: await r.resp.text() }))
        : Promise.resolve(null),
    ]);
    if (token !== state.campaignToken) return; // otra campaña seleccionada mientras tanto

    const date = fmtCampaign(campaign);
    let secchiPoints = [];
    if (!wantsSecchi) {
      setSource("upctSecchi", {
        ok: true,
        url: UPCT.secchiData(campaign),
        queriedAt: new Date().toISOString(),
        dataDate: date,
        note: `El catálogo L1/SECCHI no publica la campaña ${date}; no se realizó la consulta.`,
        kind: "historico",
        skipped: true,
      });
    } else if (secRes.status === "fulfilled" && secRes.value) {
      try {
        const p = parseOpendapAscii(secRes.value.text);
        const la = p.lat || [];
        const lo = p.lon || [];
        const tr = p.trns || [];
        for (let i = 0; i < Math.min(la.length, lo.length, tr.length); i++) {
          if (Number.isFinite(tr[i]) && tr[i] >= 0) {
            secchiPoints.push({
              id: `SECCHI-${String(i + 1).padStart(2, "0")}`,
              lat: la[i],
              lon: lo[i],
              transparency_m: Number(tr[i].toFixed(2)),
              sector: classifySector(la[i], lo[i]),
            });
          }
        }
        setSource("upctSecchi", {
          ok: true,
          url: secRes.value.meta.url,
          queriedAt: secRes.value.meta.queriedAt,
          latencyMs: secRes.value.meta.latencyMs,
          httpStatus: secRes.value.meta.httpStatus,
          dataDate: date,
          note: `${secchiPoints.length} lecturas de disco de Secchi de la campaña ${date}.`,
          kind: "historico",
        });
      } catch (e) {
        setSourceError("upctSecchi", Object.assign(e, { url: UPCT.secchiData(campaign) }));
      }
    } else if (secRes.status === "rejected") {
      setSourceError("upctSecchi", secRes.reason);
    }
    state.data.secchi = secchiPoints;

    if (ctdRes.status === "fulfilled") {
      try {
        const parsed = parseOpendapAscii(ctdRes.value.text);
        const stations = buildStations(parsed, secchiPoints);
        state.data.stations = stations;
        setSource("upctCtd", {
          ok: true,
          url: ctdRes.value.meta.url,
          queriedAt: ctdRes.value.meta.queriedAt,
          latencyMs: ctdRes.value.meta.latencyMs,
          httpStatus: ctdRes.value.meta.httpStatus,
          dataDate: date,
          note: `${stations.length} estaciones · ${(parsed.Latitud || []).length} medidas CTD de la campaña ${date} (hace ${daysSince(date)} días). Dato histórico, no tiempo real.`,
          kind: "historico",
        });
      } catch (e) {
        setSourceError("upctCtd", Object.assign(e, { url: UPCT.ctdData(campaign) }));
      }
    } else {
      setSourceError("upctCtd", ctdRes.reason);
    }

    const badge = document.getElementById("campaign-badge");
    if (badge) badge.textContent = date;

    if (state.selectedItem && (state.selectedItem.kind === "ctd" || state.selectedItem.kind === "secchi")) {
      state.selectedItem = null;
    }
    renderAllMapLayers();
    if (!state.selectedItem && state.data.stations && state.data.stations.length) {
      inspectStation(state.data.stations[0], "ctd");
    }
    if (state.wmsOverlay || (document.getElementById("sel-wms-layer")?.value || "none") !== "none") {
      updateWmsLayer();
    }
  }

  async function loadSeries() {
    const entries = Object.entries(L4_FILES);
    const results = await Promise.allSettled(
      entries.map(([, meta]) => timedFetch(UPCT.l4(meta.file)).then(async (r) => ({ meta: r, text: await r.resp.text() })))
    );
    const series = {};
    const errors = [];
    let firstMeta = null;
    let latestDate = null;
    results.forEach((res, i) => {
      const [key, meta] = entries[i];
      if (res.status !== "fulfilled") {
        errors.push(`${meta.file}.csv: ${res.reason && res.reason.message}`);
        return;
      }
      firstMeta = firstMeta || res.value.meta;
      const lines = res.value.text.trim().split(/\r?\n/).slice(1).filter(Boolean);
      const all = lines
        .map((ln) => {
          const [d, mv, sv] = ln.split(",");
          let v = parseFloat(mv);
          if (key === "transparencia") v = Math.abs(v);
          return { date: normalizeDate(d), mean: Number(v.toFixed(3)), std: Number((parseFloat(sv) || 0).toFixed(3)) };
        })
        .filter((p) => Number.isFinite(p.mean));
      const pts = all.slice(-48);
      const latest = pts[pts.length - 1] || null;
      const previous = pts[pts.length - 2] || null;
      if (latest && (!latestDate || latest.date > latestDate)) latestDate = latest.date;
      series[key] = {
        key,
        label: meta.label,
        unit: meta.unit,
        csv_url: UPCT.l4(meta.file),
        total_records: all.length,
        first_date: all.length ? all[0].date : null,
        latest,
        previous,
        delta: latest && previous ? Number((latest.mean - previous.mean).toFixed(3)) : null,
        points: pts,
      };
    });
    state.data.series = Object.keys(series).length ? series : null;
    if (!state.data.series) {
      setSourceError("upctL4", { message: errors.join(" | ") || "Sin datos", url: UPCT.l4("Temperatura") });
      return;
    }
    setSource("upctL4", {
      ok: errors.length === 0,
      partial: errors.length > 0,
      url: UPCT.l4("Temperatura"),
      queriedAt: firstMeta.queriedAt,
      latencyMs: firstMeta.latencyMs,
      httpStatus: firstMeta.httpStatus,
      dataDate: latestDate,
      note: `${Object.keys(series).length}/6 CSV L4 leídos. Último registro agregado: ${latestDate} (hace ${daysSince(latestDate)} días).` +
        (errors.length ? ` Errores: ${errors.join(" | ")}` : ""),
      error: errors.length ? errors.join(" | ") : undefined,
      kind: "historico",
    });
  }

  async function loadMeteo(force) {
    const cache = force ? "no-store" : "default";
    const [wRes, mRes] = await Promise.allSettled([
      timedFetch(METEO_URL, { cache }).then(async (r) => ({ meta: r, json: await r.resp.json() })),
      timedFetch(MARINE_URL, { cache }).then(async (r) => ({ meta: r, json: await r.resp.json() })),
    ]);

    if (wRes.status === "fulfilled") {
      const arr = Array.isArray(wRes.value.json) ? wRes.value.json : [wRes.value.json];
      const cells = new Map();
      arr.forEach((item, i) => {
        const req = METEO_POINTS[i];
        if (!item || !req) return;
        const k = `${item.latitude},${item.longitude}`;
        if (!cells.has(k)) {
          cells.set(k, {
            id: `METEO-${cells.size + 1}`,
            lat: item.latitude,
            lon: item.longitude,
            elevation: item.elevation,
            current: item.current || {},
            units: item.current_units || {},
            requested: [],
            insideLagoon: pointInPolygon(item.latitude, item.longitude, LAGOON_REFERENCE_POLYGON),
          });
        }
        cells.get(k).requested.push({
          label: req.label,
          lat: req.lat,
          lon: req.lon,
          distance_km: Number(haversineKm(req.lat, req.lon, item.latitude, item.longitude).toFixed(1)),
        });
      });
      const list = Array.from(cells.values());
      const modelTime = list[0]?.current?.time || null;
      state.data.meteo = { cells: list, modelTime, queriedAt: wRes.value.meta.queriedAt };
      setSource("meteo", {
        ok: true,
        url: METEO_URL,
        queriedAt: wRes.value.meta.queriedAt,
        latencyMs: wRes.value.meta.latencyMs,
        httpStatus: wRes.value.meta.httpStatus,
        dataDate: modelTime ? `${modelTime} (hora local Europe/Madrid)` : null,
        note: `${METEO_POINTS.length} puntos solicitados → ${list.length} celdas distintas del modelo. Valores "current" estimados por modelo numérico (no estación meteorológica in situ).`,
        kind: "modelo",
      });
    } else {
      state.data.meteo = null;
      setSourceError("meteo", wRes.reason);
    }

    if (mRes.status === "fulfilled") {
      const j = mRes.value.json;
      const inside = pointInPolygon(j.latitude, j.longitude, LAGOON_REFERENCE_POLYGON);
      state.data.marine = {
        id: "MARINE-1",
        lat: j.latitude,
        lon: j.longitude,
        current: j.current || {},
        units: j.current_units || {},
        requested: { lat: 37.735, lon: -0.785 },
        distance_km: Number(haversineKm(37.735, -0.785, j.latitude, j.longitude).toFixed(1)),
        insideLagoon: inside,
        queriedAt: mRes.value.meta.queriedAt,
      };
      setSource("marine", {
        ok: true,
        url: MARINE_URL,
        queriedAt: mRes.value.meta.queriedAt,
        latencyMs: mRes.value.meta.latencyMs,
        httpStatus: mRes.value.meta.httpStatus,
        dataDate: j.current?.time ? `${j.current.time} (hora local Europe/Madrid)` : null,
        note: inside
          ? `Celda del modelo marino en ${j.latitude}, ${j.longitude}, dentro del contorno aproximado de la laguna. Sigue siendo un valor de modelo, no medido.`
          : `Se pidió el centro de la laguna, pero el modelo devolvió la celda ${j.latitude}, ${j.longitude} (a ${state.data.marine.distance_km} km), FUERA del contorno aproximado de la laguna. El oleaje y la SST corresponden al mar abierto, no al Mar Menor.`,
        kind: "modelo",
      });
    } else {
      state.data.marine = null;
      setSourceError("marine", mRes.reason);
    }
  }

  async function loadGbif() {
    try {
      const r = await timedFetch(GBIF_URL);
      const data = await r.resp.json();
      const occurrences = (data.results || [])
        .filter((o) => Number.isFinite(o.decimalLatitude) && Number.isFinite(o.decimalLongitude))
        .map((o) => ({
          key: o.key,
          scientific_name: o.scientificName || o.species || "Taxón GBIF",
          species: o.species || o.genericName || "",
          family: o.family || "",
          lat: Number(o.decimalLatitude.toFixed(6)),
          lon: Number(o.decimalLongitude.toFixed(6)),
          event_date: o.eventDate || (o.year ? String(o.year) : "Sin fecha"),
          basis: o.basisOfRecord || "",
          institution: o.institutionCode || o.datasetName || "GBIF",
          license: o.license || "No indicada",
          gbif_url: `https://www.gbif.org/occurrence/${encodeURIComponent(o.key)}`,
          insideLagoon: pointInPolygon(o.decimalLatitude, o.decimalLongitude, LAGOON_REFERENCE_POLYGON),
        }));
      const dates = occurrences.map((o) => String(o.event_date).slice(0, 10)).filter((d) => /^\d{4}/.test(d)).sort();
      state.data.gbif = { total: data.count ?? occurrences.length, occurrences };
      setSource("gbif", {
        ok: true,
        url: GBIF_URL,
        queriedAt: r.queriedAt,
        latencyMs: r.latencyMs,
        httpStatus: r.httpStatus,
        dataDate: dates.length ? `${dates[0]} → ${dates[dates.length - 1]}` : null,
        note: `Primeros ${occurrences.length} de ${data.count ?? "?"} registros en el rectángulo 37.62–37.85 N / 0.87–0.71 W (incluye tierra firme; orden por defecto de la API, no es una muestra representativa). Licencia por registro (muchos CC BY-NC 4.0).`,
        kind: "registro",
      });
    } catch (err) {
      state.data.gbif = null;
      setSourceError("gbif", err);
    }
  }

  async function loadPlayas() {
    try {
      const r = await timedFetch(PLAYAS_URL);
      const lastModified = r.resp.headers.get("Last-Modified");
      const text = (await r.resp.text()).replace(/^\uFEFF/, "");
      const lines = text.split(/\r?\n/).filter(Boolean);
      const hdr = lines[0].split(";").map((h) => h.trim());
      const col = (name) => hdr.indexOf(name);
      const iMar = col("Mar");
      const iLat = col("Latitud");
      const iLon = col("Longitud");
      if (iMar < 0 || iLat < 0 || iLon < 0) throw new Error("Cabecera CSV inesperada (faltan columnas Mar/Latitud/Longitud)");
      const beaches = [];
      let skipped = 0;
      let total = 0;
      for (const ln of lines.slice(1)) {
        const f = ln.split(";");
        if (!String(f[iMar] || "").includes("Menor")) continue;
        total++;
        const v1 = parseFloat(String(f[iLat] || "").replace(",", "."));
        const v2 = parseFloat(String(f[iLon] || "").replace(",", "."));
        let lat;
        let lon;
        let crs;
        if (!Number.isFinite(v1) || !Number.isFinite(v2)) {
          skipped++;
          continue;
        } else if (v1 > 1000000 && v2 > 100000) {
          [lat, lon] = utm30nToWgs84(v2, v1);
          crs = "Convertido en el navegador desde UTM 30N (columna Latitud = Y, Longitud = X)";
        } else if (37 <= v1 && v1 <= 38.5 && -2 <= v2 && v2 <= 0) {
          [lat, lon] = [v1, v2];
          crs = "WGS84 directo";
        } else if (37 <= v2 && v2 <= 38.5 && -2 <= v1 && v1 <= 0) {
          [lat, lon] = [v2, v1];
          crs = "WGS84 con ejes invertidos en origen (corregido)";
        } else {
          skipped++;
          continue;
        }
        const g = (name) => String(f[col(name)] ?? "").trim();
        beaches.push({
          id: `PLAYA-${g("Código")}`,
          name: g("Nombre").replace(/\s+/g, " "),
          municipality: g("Municipio"),
          district: g("Pedanía"),
          lat,
          lon,
          crs,
          soil_type: g("Tipo Suelo") || "No especificado",
          occupancy: g("Ocupación") || "No especificado",
          blue_flag: g("Bandera Azul") || "No consta",
          accessible: g("Accesible") || "No consta",
        });
      }
      state.data.playas = { beaches, skipped, total, lastModified };
      setSource("playas", {
        ok: true,
        url: PLAYAS_URL,
        queriedAt: r.queriedAt,
        latencyMs: r.latencyMs,
        httpStatus: r.httpStatus,
        dataDate: lastModified ? `Archivo modificado: ${lastModified}` : "Sin cabecera Last-Modified",
        note: `${beaches.length} de ${total} playas del Mar Menor con coordenadas válidas (${skipped} sin coordenadas). Catálogo administrativo estático: los atributos (bandera azul, accesibilidad…) no reflejan el estado actual.`,
        kind: "catalogo",
      });
    } catch (err) {
      state.data.playas = null;
      setSourceError("playas", err);
    }
  }

  async function loadAllSources(force = false) {
    if (state.loading) return;
    state.loading = true;
    const btn = document.getElementById("btn-refresh-all");
    if (btn) btn.disabled = true;
    setGlobalStatus("loading", "Consultando fuentes públicas (CORS directo)…");
    const alertBox = document.getElementById("network-alert-box");
    if (alertBox) {
      alertBox.className = "status-banner loading";
      alertBox.textContent = "Consultando UPCT THREDDS (histórico), Open-Meteo (modelo), GBIF y catálogo de playas CARM…";
    }
    state.sources = {};

    const upctChain = loadUpctCatalog()
      .then(() => loadCampaign(state.selectedCampaign))
      .catch(() => {
        setSourceError("upctCtd", { message: "No se consultó: falló el catálogo de campañas", url: UPCT.ctdCatalog });
        renderAllMapLayers();
      });

    await Promise.allSettled([
      upctChain,
      loadSeries().then(() => {
        renderKpiBar();
        renderSeriesChart();
      }),
      loadMeteo(force).then(() => {
        renderKpiBar();
        renderAllMapLayers();
      }),
      loadGbif().then(renderAllMapLayers),
      loadPlayas().then(renderAllMapLayers),
    ]);

    renderAllMapLayers();
    renderKpiBar();
    renderSeriesChart();
    renderProvenancePanel();
    updateNetworkStatusBanner();
    state.loading = false;
    if (btn) btn.disabled = false;
  }

  // ---------------------------------------------------------------------------
  // Estado global
  // ---------------------------------------------------------------------------
  function setGlobalStatus(mode, text) {
    const dot = document.getElementById("global-status-dot");
    const label = document.getElementById("global-status-text");
    if (dot) dot.className = `status-dot ${mode === "loading" ? "loading" : mode === "error" ? "error" : mode === "warn" ? "loading" : ""}`;
    if (label) label.textContent = text;
  }

  function updateNetworkStatusBanner() {
    const alertBox = document.getElementById("network-alert-box");
    const entries = Object.values(state.sources);
    const failed = entries.filter((s) => !s.ok);
    const okCount = entries.length - failed.length;
    const hhmm = new Date().toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" });
    const newest = state.campaigns.length ? fmtCampaign(state.campaigns[0]) : null;
    const freshness =
      (newest ? `UPCT = archivo histórico (última campaña publicada ${escapeHtml(newest)}, hace ${daysSince(newest)} días). ` : "") +
      (state.data.meteo?.modelTime ? `Open-Meteo = modelo numérico, hora válida ${escapeHtml(state.data.meteo.modelTime)} (Europe/Madrid).` : "");

    if (!entries.length || okCount === 0) {
      setGlobalStatus("error", "Ninguna fuente respondió");
      if (alertBox) {
        alertBox.className = "status-banner error";
        alertBox.innerHTML =
          "<strong>✕ Sin respuesta de las fuentes públicas.</strong> Compruebe la conexión. No se muestran datos simulados.";
      }
      return;
    }
    if (failed.length === 0) {
      setGlobalStatus("ok", `${okCount}/${entries.length} consultas OK · ${hhmm}`);
      if (alertBox) {
        alertBox.className = "status-banner ok";
        alertBox.innerHTML = `<strong>✓ Consultas completadas.</strong> ${freshness}`;
      }
    } else {
      setGlobalStatus("warn", `${okCount}/${entries.length} consultas OK (${failed.length} con error) · ${hhmm}`);
      if (alertBox) {
        alertBox.className = "status-banner loading";
        alertBox.innerHTML =
          `<strong>Estado parcial:</strong> ` +
          failed.map((s) => `${escapeHtml(s.label)}: ${escapeHtml(s.error)}`).join(" · ") +
          `<br/>${freshness}`;
      }
    }
  }

  function populateCampaignSelector() {
    const sel = document.getElementById("sel-campaign");
    if (!sel || !state.campaigns.length) return;
    sel.innerHTML = "";
    const byYear = new Map();
    for (const c of state.campaigns) {
      const y = c.slice(0, 4);
      if (!byYear.has(y)) byYear.set(y, []);
      byYear.get(y).push(c);
    }
    for (const [year, list] of byYear) {
      const og = document.createElement("optgroup");
      og.label = year;
      for (const c of list) {
        const opt = document.createElement("option");
        opt.value = c;
        const secchi = state.secchiCampaigns.has(c) ? " · con Secchi" : "";
        opt.textContent = `${fmtCampaign(c)}${c === state.campaigns[0] ? " (más reciente del catálogo)" : ""}${secchi}`;
        if (c === state.selectedCampaign) opt.selected = true;
        og.appendChild(opt);
      }
      sel.appendChild(og);
    }
  }

  // ---------------------------------------------------------------------------
  // Renderizado del mapa
  // ---------------------------------------------------------------------------
  function matchesFilter(fields) {
    if (!state.searchQuery) return true;
    const q = state.searchQuery.toLowerCase().trim();
    return fields.some((t) => String(t || "").toLowerCase().includes(q));
  }

  function getStationColor(st) {
    if (st.status_level === "alerta") return "#f87171";
    if (st.status_level === "vigilancia") return "#fbbf24";
    return "#34d399";
  }

  function isChecked(id) {
    const el = document.getElementById(id);
    return el ? el.checked : true;
  }

  function setCount(id, text) {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
  }

  function renderAllMapLayers() {
    if (!state.map) return;
    const show = {
      upct: isChecked("chk-layer-upct"),
      secchi: isChecked("chk-layer-secchi"),
      meteo: isChecked("chk-layer-meteo"),
      playas: isChecked("chk-layer-playas"),
      gbif: isChecked("chk-layer-gbif"),
    };
    const present = ["chk-layer-upct", "chk-layer-secchi", "chk-layer-meteo", "chk-layer-playas", "chk-layer-gbif"].filter((id) =>
      document.getElementById(id)
    );
    setCount("active-layers-badge", `${present.filter((id) => isChecked(id)).length} activas`);
    const date = fmtCampaign(state.selectedCampaign);

    // CTD
    const gUp = state.layerGroups.upct;
    gUp.clearLayers();
    let nUp = 0;
    for (const st of state.data.stations || []) {
      if (!matchesFilter([st.code, st.name, st.sector, "ctd", ...(st.alerts || [])])) continue;
      nUp++;
      if (!show.upct) continue;
      const val = st.metrics[state.selectedCtdMetric];
      const icon = L.divIcon({
        className: "radar-marker-ctd",
        html: `<span style="background:${getStationColor(st)};width:26px;height:26px;border-radius:50%;display:flex;align-items:center;justify-content:center;border:2px solid #020617;">${escapeHtml(st.short)}</span>`,
        iconSize: [28, 28],
        iconAnchor: [14, 14],
      });
      const marker = L.marker([st.lat, st.lon], { icon, title: `${st.name} (${formatNum(val)})`, keyboard: true });
      marker.bindPopup(
        `<strong>${escapeHtml(st.name)}</strong><br/><small>Campaña histórica UPCT ${escapeHtml(date)}</small><br/>` +
          `Temp: <b>${formatNum(st.metrics.temp_c)} °C</b> · Sal: <b>${formatNum(st.metrics.sal_psu)} PSU</b><br/>` +
          `O₂: <b>${formatNum(st.metrics.oxy_mgl)} mg/L</b> · Clorofila: <b>${formatNum(st.metrics.chl_mgm3)} mg/m³</b><br/>` +
          `Turbidez: <b>${formatNum(st.metrics.turb_ftu)} FTU</b> · Secchi: <b>${formatNum(st.metrics.secchi_m, 2, "sin dato")}</b>`
      );
      marker.on("click", () => inspectStation(st, "ctd"));
      marker.addTo(gUp);
    }
    setCount("count-upct", state.data.stations ? `${nUp} est.` : state.sources.upctCtd?.ok === false ? "Error" : "…");

    // Secchi
    const gSe = state.layerGroups.secchi;
    gSe.clearLayers();
    let nSe = 0;
    for (const sp of state.data.secchi || []) {
      if (!matchesFilter([sp.id, sp.sector, "secchi", "transparencia"])) continue;
      nSe++;
      if (!show.secchi) continue;
      const mk = L.circleMarker([sp.lat, sp.lon], { radius: 15, color: "#a78bfa", weight: 2, fill: false, dashArray: "3,3" });
      mk.bindPopup(
        `<strong>Disco de Secchi · ${escapeHtml(sp.sector)}</strong><br/>Transparencia: <b>${formatNum(sp.transparency_m)} m</b><br/><small>Campaña histórica UPCT ${escapeHtml(date)}</small>`
      );
      mk.on("click", () => inspectStation(sp, "secchi"));
      mk.addTo(gSe);
    }
    const secSrc = state.sources.upctSecchi;
    setCount("count-secchi", secSrc?.skipped ? "No publ." : state.data.secchi ? `${nSe} pts` : secSrc?.ok === false ? "Error" : "…");

    // Modelo Open-Meteo
    const gMe = state.layerGroups.meteo;
    gMe.clearLayers();
    let nMe = 0;
    for (const cell of state.data.meteo?.cells || []) {
      if (!matchesFilter(["modelo", "open-meteo", "meteo", ...cell.requested.map((r) => r.label)])) continue;
      nMe++;
      if (!show.meteo) continue;
      const c = cell.current;
      const mk = L.circleMarker([cell.lat, cell.lon], { radius: 8, color: "#0284c7", weight: 2, fillColor: "#38bdf8", fillOpacity: 0.85 });
      mk.bindPopup(
        `<strong>Celda de modelo atmosférico Open-Meteo</strong><br/>${formatNum(c.temperature_2m, 1)} °C · viento ${formatNum(c.wind_speed_10m, 1)} km/h<br/>` +
          `<small>Hora válida del modelo: ${escapeHtml(c.time)} (Europe/Madrid) · valor modelado, no medido</small>`
      );
      mk.on("click", () => inspectStation(cell, "meteo"));
      mk.addTo(gMe);
    }
    const mar = state.data.marine;
    if (mar && matchesFilter(["modelo", "open-meteo", "marino", "oleaje", "sst"])) {
      nMe++;
      if (show.meteo) {
        const mk = L.circleMarker([mar.lat, mar.lon], { radius: 8, color: "#0e7490", weight: 2, fillColor: "#22d3ee", fillOpacity: 0.6, dashArray: "2,2" });
        mk.bindPopup(
          `<strong>Celda de modelo marino Open-Meteo</strong><br/>Oleaje ${formatNum(mar.current.wave_height, 2)} m · SST ${formatNum(mar.current.sea_surface_temperature, 1)} °C<br/>` +
            `<small>${mar.insideLagoon ? "Dentro" : "FUERA"} del contorno aproximado de la laguna · valor modelado</small>`
        );
        mk.on("click", () => inspectStation(mar, "marine"));
        mk.addTo(gMe);
      }
    }
    const meteoFailed = state.sources.meteo?.ok === false && state.sources.marine?.ok === false;
    setCount("count-meteo", state.data.meteo || mar ? `${nMe} celdas` : meteoFailed ? "Error" : "…");

    // Playas CARM
    const gPl = state.layerGroups.playas;
    if (gPl) {
      gPl.clearLayers();
      let nPl = 0;
      for (const b of state.data.playas?.beaches || []) {
        if (!matchesFilter([b.name, b.municipality, b.district, b.soil_type, "playa"])) continue;
        nPl++;
        if (!show.playas) continue;
        const mk = L.circleMarker([b.lat, b.lon], { radius: 5, color: "#6d28d9", weight: 1.5, fillColor: "#c4b5fd", fillOpacity: 0.85 });
        mk.bindPopup(
          `<strong>${escapeHtml(b.name)}</strong> (${escapeHtml(b.municipality)})<br/>Suelo: ${escapeHtml(b.soil_type)} · Ocupación: ${escapeHtml(b.occupancy)}<br/>` +
            `<small>Catálogo CARM estático; atributos no actualizados en tiempo real</small>`
        );
        mk.on("click", () => inspectStation(b, "playa"));
        mk.addTo(gPl);
      }
      setCount("count-playas", state.data.playas ? `${nPl} playas` : state.sources.playas?.ok === false ? "Error" : "…");
    }

    // GBIF
    const gGb = state.layerGroups.gbif;
    gGb.clearLayers();
    let nGb = 0;
    for (const o of state.data.gbif?.occurrences || []) {
      if (!matchesFilter([o.scientific_name, o.species, o.family, o.institution, "gbif"])) continue;
      nGb++;
      if (!show.gbif) continue;
      const mk = L.circleMarker([o.lat, o.lon], { radius: 5, color: "#be185d", weight: 1.5, fillColor: "#f472b6", fillOpacity: 0.85 });
      mk.bindPopup(
        `<strong><em>${escapeHtml(o.scientific_name)}</em></strong><br/>Fecha: ${escapeHtml(o.event_date)} · ${escapeHtml(o.basis)}<br/>` +
          `<a href="${escapeHtml(o.gbif_url)}" target="_blank" rel="noopener">Ver registro en GBIF.org ↗</a>`
      );
      mk.on("click", () => inspectStation(o, "gbif"));
      mk.addTo(gGb);
    }
    setCount("count-gbif", state.data.gbif ? `${nGb} reg.` : state.sources.gbif?.ok === false ? "Error" : "…");
  }

  // ---------------------------------------------------------------------------
  // WMS L2 histórico UPCT
  // ---------------------------------------------------------------------------
  async function getWmsTimes(variable) {
    if (state.wmsTimesCache[variable]) return state.wmsTimesCache[variable];
    const url = `${UPCT.wms(variable)}?service=WMS&version=1.3.0&request=GetCapabilities`;
    const r = await timedFetch(url);
    const xml = await r.resp.text();
    const m = xml.match(/<Dimension[^>]*name="time"[^>]*>([\s\S]*?)<\/Dimension>/);
    const times = m && !m[1].includes("/") ? m[1].split(",").map((t) => t.trim()).filter(Boolean) : [];
    state.wmsTimesCache[variable] = times;
    return times;
  }

  function setWmsStatus(html) {
    const el = document.getElementById("wms-status");
    if (el) el.innerHTML = html;
  }

  async function updateWmsLayer() {
    if (!state.map) return;
    const token = ++state.wmsToken;
    if (state.wmsOverlay) {
      state.map.removeLayer(state.wmsOverlay);
      state.wmsOverlay = null;
    }
    const variable = document.getElementById("sel-wms-layer")?.value || "none";
    const depth = document.getElementById("sel-wms-depth")?.value || "-0.5";
    const legend = document.getElementById("wms-legend");
    if (variable === "none") {
      setWmsStatus("Ráster desactivado.");
      if (legend) legend.hidden = true;
      return;
    }
    const scaleRange = WMS_SCALE_RANGES[variable] || "0,30";
    const campaignDate = fmtCampaign(state.selectedCampaign);
    setWmsStatus("Consultando fechas disponibles en GetCapabilities…");

    let timeParam = null;
    let timeNote = "";
    try {
      const times = await getWmsTimes(variable);
      if (token !== state.wmsToken) return;
      if (times.length) {
        const candidates = times.filter((t) => t.slice(0, 10) <= campaignDate);
        timeParam = candidates.length ? candidates[candidates.length - 1] : times[0];
        const d = timeParam.slice(0, 10);
        timeNote =
          d === campaignDate
            ? `Fecha ráster L2: <b>${escapeHtml(d)}</b> (coincide con la campaña seleccionada).`
            : `Fecha ráster L2: <b>${escapeHtml(d)}</b> (la campaña ${escapeHtml(campaignDate)} no tiene rejilla L2; se usa la fecha anterior más cercana).`;
      } else {
        timeNote = "GetCapabilities no lista fechas; el servidor usará su fecha por defecto.";
      }
    } catch (err) {
      if (token !== state.wmsToken) return;
      timeNote = `No se pudo leer GetCapabilities (${escapeHtml(err.message)}); el servidor usará su fecha por defecto.`;
    }

    const params = {
      layers: variable,
      styles: "boxfill/rainbow",
      format: "image/png",
      transparent: true,
      version: "1.3.0",
      elevation: depth,
      colorscalerange: scaleRange,
      opacity: 0.68,
      attribution: '<a href="https://marmenor.upct.es/thredds/catalog/L2/catalog.html" target="_blank" rel="noopener">UPCT THREDDS WMS L2</a>',
    };
    if (timeParam) params.time = timeParam;
    const layer = L.tileLayer.wms(UPCT.wms(variable), params);
    let tileErrors = 0;
    layer.on("tileerror", () => {
      tileErrors++;
    });
    layer.on("load", () => {
      if (token !== state.wmsToken) return;
      setWmsStatus(
        `${timeNote} Profundidad ${escapeHtml(depth)} m. Interpolación histórica UPCT, no tiempo real.` +
          (tileErrors ? ` <span class="txt-warn">${tileErrors} teselas fallaron al cargar.</span>` : "")
      );
    });
    state.wmsOverlay = layer.addTo(state.map);
    setWmsStatus(`${timeNote} Cargando teselas…`);

    if (legend) {
      const [mn, mx] = scaleRange.split(",");
      legend.hidden = false;
      legend.innerHTML =
        `<img alt="Escala de color ${escapeHtml(variable)} de ${escapeHtml(mn)} a ${escapeHtml(mx)}" width="200" height="10" src="${escapeHtml(
          `${UPCT.wms(variable)}?REQUEST=GetLegendGraphic&LAYER=${variable}&PALETTE=rainbow&COLORSCALERANGE=${scaleRange}&COLORBARONLY=true&WIDTH=200&HEIGHT=10&VERTICAL=false`
        )}"/>` + `<span class="wms-legend-labels"><span>${escapeHtml(mn)}</span><span>${escapeHtml(mx)}</span></span>`;
    }
  }

  // ---------------------------------------------------------------------------
  // KPIs, inspector, gráfico y procedencia
  // ---------------------------------------------------------------------------
  function setText(id, text) {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
  }

  function renderKpiBar() {
    const s = state.data.series;
    const age = (d) => (d ? ` · hace ${daysSince(d)} d` : "");
    if (s) {
      if (s.temperatura?.latest) {
        setText("kpi-water-temp", `${formatNum(s.temperatura.latest.mean)} °C`);
        setText("kpi-water-temp-sub", `Campaña ${s.temperatura.latest.date}${age(s.temperatura.latest.date)}`);
      }
      if (s.oxigeno?.latest) {
        setText("kpi-oxygen", `${formatNum(s.oxigeno.latest.mean)} mg/L`);
        setText("kpi-oxygen-sub", `Campaña ${s.oxigeno.latest.date}${age(s.oxigeno.latest.date)}`);
      }
      if (s.salinidad?.latest) {
        setText("kpi-salinity", `${formatNum(s.salinidad.latest.mean)} PSU`);
        setText("kpi-salinity-sub", `Campaña ${s.salinidad.latest.date}${age(s.salinidad.latest.date)}`);
      }
      if (s.clorofila?.latest) {
        setText("kpi-chl-turb", `${formatNum(s.clorofila.latest.mean)} mg/m³`);
        setText(
          "kpi-chl-turb-sub",
          `Turb. ${formatNum(s.turbidez?.latest?.mean)} FTU · Secchi ${formatNum(s.transparencia?.latest?.mean)} m · ${s.clorofila.latest.date}`
        );
      }
    } else if (state.sources.upctL4?.ok === false) {
      for (const id of ["kpi-water-temp-sub", "kpi-oxygen-sub", "kpi-salinity-sub", "kpi-chl-turb-sub"]) setText(id, "Error al leer CSV L4");
    }

    const centre = state.data.meteo?.cells?.find((c) => c.requested.some((r) => r.label === "Centro de la laguna"));
    if (centre) {
      const w = centre.current;
      setText("kpi-live-meteo", `${formatNum(w.temperature_2m, 1)} °C · ${formatNum(w.wind_speed_10m, 0)} km/h`);
      setText("kpi-live-meteo-sub", `Modelo · válido ${String(w.time || "").replace("T", " ")} · consulta ${new Date(state.data.meteo.queriedAt).toLocaleTimeString("es-ES", { timeZone: "Europe/Madrid", hour: "2-digit", minute: "2-digit" })}`);
    } else if (state.sources.meteo?.ok === false) {
      setText("kpi-live-meteo", "Error");
      setText("kpi-live-meteo-sub", state.sources.meteo.error || "Sin respuesta de Open-Meteo");
    }
  }

  function freshnessTag(kind) {
    const map = {
      historico: ["tag-hist", "Histórico"],
      modelo: ["tag-model", "Modelo numérico"],
      registro: ["tag-rec", "Registros"],
      catalogo: ["tag-cat", "Catálogo estático"],
    };
    const [cls, txt] = map[kind] || ["tag-rec", kind || ""];
    return `<span class="freshness-tag ${cls}">${escapeHtml(txt)}</span>`;
  }

  function inspectStation(item, kind) {
    state.selectedItem = { item, kind };
    const container = document.getElementById("station-inspector-content");
    const badge = document.getElementById("inspector-badge");
    if (!container) return;
    const date = fmtCampaign(state.selectedCampaign);

    if (kind === "ctd") {
      if (badge) badge.textContent = item.code;
      const m = item.metrics;
      const rows = item.vertical_profile
        .map(
          (p) =>
            `<tr><td>${formatNum(p.depth_m)} m</td><td>${formatNum(p.temp_c)}</td><td>${formatNum(p.sal_psu)}</td><td>${formatNum(p.oxy_mgl)}</td><td>${formatNum(p.chl_mgm3)}</td><td>${formatNum(p.turb_ftu)}</td></tr>`
        )
        .join("");
      container.innerHTML = `
        <div class="inspector-head">
          <strong class="inspector-title">${escapeHtml(item.name)}</strong> ${freshnessTag("historico")}
          <div class="prov-meta">Campaña UPCT ${escapeHtml(date)} (hace ${daysSince(date)} días) · ${item.lat.toFixed(5)}° N, ${item.lon.toFixed(5)}° E · ${item.sample_count} medidas (prof. máx. ${item.max_depth_m} m)</div>
        </div>
        <div class="status-banner ${item.status_level === "alerta" ? "error" : item.status_level === "vigilancia" ? "loading" : "ok"}">
          <strong>Clasificación orientativa:</strong> ${escapeHtml(item.alerts.join(" · "))}
          <div class="prov-meta">Umbrales fijos de esta app (O₂ fondo &lt; 4 mg/L, clorofila &gt; 0,65/1,5 mg/m³, turbidez &gt; 2,5 FTU). No es un diagnóstico oficial.</div>
        </div>
        <div class="metrics-grid">
          <div class="metric-box"><span class="m-label">Temperatura (media / fondo)</span><span class="m-val">${formatNum(m.temp_c)} °C <small class="m-sub">(${formatNum(m.temp_bottom_c)}°)</small></span></div>
          <div class="metric-box"><span class="m-label">Oxígeno (media / fondo)</span><span class="m-val">${formatNum(m.oxy_mgl)} mg/L <small class="m-sub">(${formatNum(m.oxy_bottom_mgl)})</small></span></div>
          <div class="metric-box"><span class="m-label">Salinidad columna</span><span class="m-val">${formatNum(m.sal_psu)} PSU</span></div>
          <div class="metric-box"><span class="m-label">Clorofila-a / Turbidez</span><span class="m-val">${formatNum(m.chl_mgm3)} · ${formatNum(m.turb_ftu)} FTU</span></div>
          <div class="metric-box"><span class="m-label">Disco de Secchi</span><span class="m-val">${m.secchi_m === null ? "Sin dato" : `${formatNum(m.secchi_m)} m`}</span></div>
          <div class="metric-box"><span class="m-label">CDOM</span><span class="m-val">${formatNum(m.cdom_ppb)} ppb</span></div>
        </div>
        ${
          rows
            ? `<div class="profile-table-wrap"><strong class="mini-title">Perfil vertical (medias cada 0,5 m)</strong>
               <table class="profile-table" aria-label="Perfil vertical por profundidad">
                 <thead><tr><th>Prof.</th><th>T (°C)</th><th>Sal</th><th>O₂</th><th>Chl</th><th>Turb</th></tr></thead>
                 <tbody>${rows}</tbody></table></div>`
            : ""
        }`;
    } else if (kind === "secchi") {
      if (badge) badge.textContent = "SECCHI";
      container.innerHTML = `
        <strong class="inspector-title">Disco de Secchi · ${escapeHtml(item.sector)}</strong> ${freshnessTag("historico")}
        <div class="prov-meta">Campaña UPCT ${escapeHtml(date)} · ${item.lat.toFixed(5)}° N, ${item.lon.toFixed(5)}° E</div>
        <div class="metrics-grid"><div class="metric-box"><span class="m-label">Transparencia</span><span class="m-val">${formatNum(item.transparency_m)} m</span></div></div>`;
    } else if (kind === "meteo") {
      if (badge) badge.textContent = "MODELO";
      const c = item.current;
      const u = item.units;
      container.innerHTML = `
        <strong class="inspector-title">Celda del modelo atmosférico Open-Meteo</strong> ${freshnessTag("modelo")}
        <div class="prov-meta">Celda ${item.lat}, ${item.lon} (elev. ${formatNum(item.elevation, 0)} m) · hora válida ${escapeHtml(c.time)} Europe/Madrid · paso ${escapeHtml(c.interval)} s</div>
        <div class="prov-meta">Puntos solicitados que caen en esta celda: ${item.requested.map((r) => `${escapeHtml(r.label)} (a ${r.distance_km} km)`).join(", ")}</div>
        <div class="metrics-grid">
          <div class="metric-box"><span class="m-label">Temp. aire 2 m</span><span class="m-val">${formatNum(c.temperature_2m, 1)} ${escapeHtml(u.temperature_2m || "°C")}</span></div>
          <div class="metric-box"><span class="m-label">Humedad relativa</span><span class="m-val">${formatNum(c.relative_humidity_2m, 0)} %</span></div>
          <div class="metric-box"><span class="m-label">Viento 10 m / rachas</span><span class="m-val">${formatNum(c.wind_speed_10m, 1)} / ${formatNum(c.wind_gusts_10m, 1)} km/h</span></div>
          <div class="metric-box"><span class="m-label">Dirección viento</span><span class="m-val">${formatNum(c.wind_direction_10m, 0)}°</span></div>
          <div class="metric-box"><span class="m-label">Precipitación</span><span class="m-val">${formatNum(c.precipitation, 1)} mm</span></div>
          <div class="metric-box"><span class="m-label">Presión superficie</span><span class="m-val">${formatNum(c.surface_pressure, 1)} hPa</span></div>
        </div>
        <p class="section-note mt">Valores estimados por modelo numérico, no medidos por una estación en la laguna.</p>`;
    } else if (kind === "marine") {
      if (badge) badge.textContent = "MODELO MARINO";
      const c = item.current;
      container.innerHTML = `
        <strong class="inspector-title">Celda del modelo marino Open-Meteo</strong> ${freshnessTag("modelo")}
        <div class="prov-meta">Solicitado: 37.735, -0.785 (centro de la laguna) → celda devuelta ${item.lat}, ${item.lon} (a ${item.distance_km} km) · hora válida ${escapeHtml(c.time)}</div>
        <div class="status-banner ${item.insideLagoon ? "loading" : "error"}">
          ${item.insideLagoon
            ? "La celda cae dentro del contorno aproximado de la laguna, pero la resolución del modelo marino no está pensada para una laguna somera: úselo solo como orientación."
            : "<strong>La celda cae FUERA de la laguna</strong> (mar abierto). Estos valores NO representan el oleaje ni la temperatura del agua del Mar Menor."}
        </div>
        <div class="metrics-grid">
          <div class="metric-box"><span class="m-label">Altura de ola</span><span class="m-val">${formatNum(c.wave_height, 2)} m</span></div>
          <div class="metric-box"><span class="m-label">Periodo / dirección</span><span class="m-val">${formatNum(c.wave_period, 1)} s · ${formatNum(c.wave_direction, 0)}°</span></div>
          <div class="metric-box"><span class="m-label">SST (modelo)</span><span class="m-val">${formatNum(c.sea_surface_temperature, 1)} °C</span></div>
        </div>`;
    } else if (kind === "playa") {
      if (badge) badge.textContent = "PLAYA CARM";
      container.innerHTML = `
        <strong class="inspector-title">${escapeHtml(item.name)}</strong> ${freshnessTag("catalogo")}
        <div class="prov-meta">${escapeHtml(item.municipality)}${item.district ? ` (${escapeHtml(item.district)})` : ""} · ${item.lat}° N, ${item.lon}° E</div>
        <div class="prov-meta">${escapeHtml(item.crs)}</div>
        <div class="metrics-grid">
          <div class="metric-box"><span class="m-label">Accesible (catálogo)</span><span class="m-val">${escapeHtml(item.accessible)}</span></div>
          <div class="metric-box"><span class="m-label">Bandera azul (catálogo)</span><span class="m-val">${escapeHtml(item.blue_flag)}</span></div>
          <div class="metric-box"><span class="m-label">Ocupación</span><span class="m-val">${escapeHtml(item.occupancy)}</span></div>
          <div class="metric-box"><span class="m-label">Tipo de suelo</span><span class="m-val small">${escapeHtml(item.soil_type)}</span></div>
        </div>
        <p class="section-note mt">Atributos tal como figuran en el CSV de la CARM (${escapeHtml(state.data.playas?.lastModified || "fecha no indicada")}); no indican el estado actual ni la calidad del agua.</p>`;
    } else if (kind === "gbif") {
      if (badge) badge.textContent = "GBIF";
      container.innerHTML = `
        <strong class="inspector-title"><em>${escapeHtml(item.scientific_name)}</em></strong> ${freshnessTag("registro")}
        <div class="prov-meta">Familia: ${escapeHtml(item.family || "N/D")} · Fecha de observación: ${escapeHtml(item.event_date)} · ${escapeHtml(item.basis)}</div>
        <div class="prov-meta">${item.lat}° N, ${item.lon}° E (${item.insideLagoon ? "dentro" : "fuera"} del contorno aproximado de la laguna) · ${escapeHtml(item.institution)}</div>
        <div class="prov-meta">Licencia del registro: ${escapeHtml(item.license)}</div>
        <p class="section-note mt"><a href="${escapeHtml(item.gbif_url)}" target="_blank" rel="noopener">Ficha original en GBIF.org (#${escapeHtml(item.key)}) ↗</a></p>`;
    }
  }

  function renderSeriesChart() {
    const svg = document.getElementById("series-svg-chart");
    const summaryEl = document.getElementById("series-summary-line");
    const badgeEl = document.getElementById("series-count-badge");
    if (!svg || !summaryEl) return;
    const d = state.data.series?.[state.selectedSeriesParam];
    if (!d || d.points.length < 2) {
      svg.innerHTML = `<text x="170" y="62" text-anchor="middle" fill="#94a3b8" font-size="11">Serie histórica no disponible</text>`;
      summaryEl.textContent = state.sources.upctL4?.error || (state.data.series ? "Sin datos para este parámetro." : "Consultando CSV L4…");
      return;
    }
    const pts = d.points;
    if (badgeEl) badgeEl.textContent = `${pts.length}/${d.total_records} camp.`;
    const values = pts.map((p) => p.mean);
    const minV = Math.min(...values);
    const maxV = Math.max(...values);
    const span = maxV - minV || 1;
    const W = 340, H = 125, padL = 36, padR = 12, padT = 14, padB = 22;
    const plotW = W - padL - padR;
    const plotH = H - padT - padB;
    const coords = pts.map((p, i) => ({
      x: Number((padL + (i / (pts.length - 1)) * plotW).toFixed(1)),
      y: Number((padT + plotH - ((p.mean - minV) / span) * plotH).toFixed(1)),
    }));
    const poly = coords.map((c) => `${c.x},${c.y}`).join(" ");
    const area = `${coords[0].x},${padT + plotH} ${poly} ${coords[coords.length - 1].x},${padT + plotH}`;
    const last = pts[pts.length - 1];
    svg.innerHTML = `
      <defs><linearGradient id="areaGrad" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#38bdf8" stop-opacity="0.40"/><stop offset="100%" stop-color="#38bdf8" stop-opacity="0.02"/>
      </linearGradient></defs>
      <line x1="${padL}" y1="${padT}" x2="${W - padR}" y2="${padT}" stroke="rgba(148,163,184,0.18)" stroke-dasharray="2,2"/>
      <line x1="${padL}" y1="${padT + plotH / 2}" x2="${W - padR}" y2="${padT + plotH / 2}" stroke="rgba(148,163,184,0.18)" stroke-dasharray="2,2"/>
      <line x1="${padL}" y1="${padT + plotH}" x2="${W - padR}" y2="${padT + plotH}" stroke="rgba(148,163,184,0.3)"/>
      <text x="${padL - 4}" y="${padT + 4}" text-anchor="end" fill="#94a3b8" font-size="9">${maxV.toFixed(1)}</text>
      <text x="${padL - 4}" y="${padT + plotH}" text-anchor="end" fill="#94a3b8" font-size="9">${minV.toFixed(1)}</text>
      <text x="${padL}" y="${H - 5}" text-anchor="start" fill="#94a3b8" font-size="9">${escapeHtml(pts[0].date)}</text>
      <text x="${W - padR}" y="${H - 5}" text-anchor="end" fill="#38bdf8" font-size="9">${escapeHtml(last.date)}: ${formatNum(last.mean)} ${escapeHtml(d.unit)}</text>
      <polygon points="${area}" fill="url(#areaGrad)"/>
      <polyline fill="none" stroke="#38bdf8" stroke-width="2" points="${poly}"/>
      <circle cx="${coords[coords.length - 1].x}" cy="${coords[coords.length - 1].y}" r="3.5" fill="#2dd4bf" stroke="#020617" stroke-width="1.5"/>`;
    const delta = d.delta === null ? "N/D" : `${d.delta > 0 ? "+" : ""}${d.delta}`;
    summaryEl.innerHTML =
      `Último registro: <strong>${formatNum(last.mean)} ${escapeHtml(d.unit)}</strong> (${escapeHtml(last.date)}, hace ${daysSince(last.date)} días) · ` +
      `Δ vs. campaña previa: ${escapeHtml(delta)} ${escapeHtml(d.unit)} · Se muestran las últimas ${pts.length} de ${d.total_records} campañas (desde ${escapeHtml(d.first_date)}). ` +
      `<a href="${escapeHtml(d.csv_url)}" target="_blank" rel="noopener">CSV original ↗</a>`;
  }

  function renderProvenancePanel() {
    const container = document.getElementById("provenance-container");
    if (!container) return;
    const order = ["upctCatalog", "upctCtd", "upctSecchi", "upctL4", "meteo", "marine", "gbif", "playas"];
    const blocks = order
      .filter((k) => state.sources[k])
      .map((k) => {
        const s = state.sources[k];
        const statusTxt = s.ok
          ? s.skipped
            ? "No consultado (no publicado)"
            : `HTTP ${escapeHtml(s.httpStatus)}${s.latencyMs !== undefined ? ` · ${s.latencyMs} ms` : ""}${s.partial ? " · parcial" : ""}`
          : `<span class="txt-err">Error: ${escapeHtml(s.error)}</span>`;
        return `
          <div class="prov-card ${s.ok ? "" : "prov-card-err"}">
            <strong>${escapeHtml(s.label)} ${s.kind ? freshnessTag(s.kind) : ""}</strong>
            <div class="prov-meta">Consulta: ${escapeHtml(fmtLocal(s.queriedAt))} (${escapeHtml(s.queriedAt)}) · ${statusTxt}</div>
            ${s.dataDate ? `<div class="prov-meta">Fecha de los datos: ${escapeHtml(s.dataDate)}</div>` : ""}
            ${s.note ? `<div class="prov-meta">${escapeHtml(s.note)}</div>` : ""}
            ${s.url ? `<div class="prov-meta">URL: <a href="${escapeHtml(s.url)}" target="_blank" rel="noopener">${escapeHtml(s.url)}</a></div>` : ""}
          </div>`;
      });

    blocks.push(`
      <div class="prov-card">
        <strong>Licencias y atribución</strong>
        <div class="prov-meta">
          • UPCT THREDDS (Observatorio del Mar Menor): datos públicos; consulte las condiciones de reutilización del portal de la UPCT / CARM.<br/>
          • Open-Meteo: datos bajo CC BY 4.0 (“Weather data by Open-Meteo.com”); API gratuita solo para uso no comercial y con límite de peticiones.<br/>
          • GBIF: licencia por registro (CC0, CC BY o CC BY-NC); cite GBIF.org y el conjunto de datos de origen.<br/>
          • Playas CARM: Datos Abiertos de la Región de Murcia (reutilización de información del sector público).<br/>
          • Mapas base: © OpenStreetMap contributors (ODbL, sujeto a la política de uso de tile.openstreetmap.org); PNOA e IGN Base © Instituto Geográfico Nacional (CC BY 4.0).
        </div>
      </div>
      <div class="prov-card">
        <strong>Fuentes no incluidas en esta versión estática</strong>
        <div class="prov-meta">
          • API CKAN de <code>datosabiertos.regiondemurcia.es</code> (series CARM y estaciones SIAM-IMIDA): no envía cabecera CORS, por lo que un navegador no puede leerla sin un proxy. No se usa proxy.<br/>
          • <code>canalmarmenor.carm.es</code>: protegido por un sistema anti-bot; no se consulta ni se elude.
        </div>
      </div>`);
    container.innerHTML = blocks.join("");
  }

  // ---------------------------------------------------------------------------
  // Geolocalización opcional
  // ---------------------------------------------------------------------------
  function handleRequestGeolocation() {
    const statusMsg = document.getElementById("geo-status-msg");
    const clearBtn = document.getElementById("btn-clear-location");
    if (!("geolocation" in navigator)) {
      if (statusMsg) statusMsg.textContent = "Su navegador no soporta la API de geolocalización.";
      return;
    }
    if (!window.isSecureContext) {
      if (statusMsg) statusMsg.textContent = "La geolocalización requiere HTTPS (contexto seguro).";
      return;
    }
    if (statusMsg) statusMsg.textContent = "Solicitando permiso de ubicación al navegador (procesamiento solo local)…";
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const { latitude: lat, longitude: lon } = pos.coords;
        const acc = Math.round(pos.coords.accuracy || 0);
        state.layerGroups.userLocation.clearLayers();
        let nearestInfo = "";
        let best = Infinity;
        let nearest = null;
        for (const st of state.data.stations || []) {
          const d = haversineKm(lat, lon, st.lat, st.lon);
          if (d < best) {
            best = d;
            nearest = st;
          }
        }
        if (nearest) nearestInfo = ` · Estación CTD más cercana: ${nearest.code} a ${best.toFixed(2)} km`;
        L.circleMarker([lat, lon], { radius: 9, color: "#ffffff", weight: 2.5, fillColor: "#10b981", fillOpacity: 0.95 })
          .bindPopup(
            `<strong>Su ubicación (solo local)</strong><br/>${lat.toFixed(5)}° N, ${lon.toFixed(5)}° E (±${acc} m)${escapeHtml(nearestInfo)}<br/><small>No se envía a ningún servidor.</small>`
          )
          .addTo(state.layerGroups.userLocation)
          .openPopup();
        state.map.setView([lat, lon], 12);
        if (statusMsg) statusMsg.textContent = `Ubicación local activa: ${lat.toFixed(4)}° N, ${lon.toFixed(4)}° E (±${acc} m)${nearestInfo}`;
        if (clearBtn) clearBtn.style.display = "inline-flex";
      },
      (err) => {
        if (statusMsg) statusMsg.textContent = `Permiso denegado o ubicación no disponible (código ${err.code}: ${err.message}). El mapa sigue operativo.`;
      },
      { enableHighAccuracy: false, timeout: 10000, maximumAge: 60000 }
    );
  }

  function handleClearGeolocation() {
    state.layerGroups.userLocation.clearLayers();
    const statusMsg = document.getElementById("geo-status-msg");
    const clearBtn = document.getElementById("btn-clear-location");
    if (statusMsg) statusMsg.textContent = "Estado: ubicación local borrada de la sesión.";
    if (clearBtn) clearBtn.style.display = "none";
  }

  // ---------------------------------------------------------------------------
  // Eventos
  // ---------------------------------------------------------------------------
  function bindEvents() {
    document.getElementById("btn-refresh-all")?.addEventListener("click", () => loadAllSources(true));

    document.getElementById("btn-toggle-sweep")?.addEventListener("click", (ev) => {
      state.sweepActive = !state.sweepActive;
      document.getElementById("radar-hud-overlay")?.classList.toggle("paused", !state.sweepActive);
      const btn = ev.currentTarget;
      btn.setAttribute("aria-pressed", String(state.sweepActive));
      btn.classList.toggle("btn-active", state.sweepActive);
      btn.textContent = state.sweepActive ? "◎ Barrido Radar: Activo" : "◎ Barrido Radar: Pausado";
    });

    document.getElementById("btn-center-lagoon")?.addEventListener("click", () => {
      if (state.map) state.map.setView(MAR_MENOR_CENTER, DEFAULT_ZOOM);
    });

    for (const id of ["chk-layer-upct", "chk-layer-secchi", "chk-layer-meteo", "chk-layer-playas", "chk-layer-gbif"]) {
      document.getElementById(id)?.addEventListener("change", renderAllMapLayers);
    }

    document.getElementById("sel-campaign")?.addEventListener("change", async (ev) => {
      if (!ev.target.value) return;
      state.selectedCampaign = ev.target.value;
      setGlobalStatus("loading", `Cargando campaña histórica ${fmtCampaign(state.selectedCampaign)}…`);
      await loadCampaign(state.selectedCampaign);
      renderProvenancePanel();
      updateNetworkStatusBanner();
    });

    document.getElementById("sel-ctd-metric")?.addEventListener("change", (ev) => {
      state.selectedCtdMetric = ev.target.value;
      renderAllMapLayers();
    });

    document.getElementById("sel-wms-layer")?.addEventListener("change", updateWmsLayer);
    document.getElementById("sel-wms-depth")?.addEventListener("change", updateWmsLayer);

    document.getElementById("sel-basemap")?.addEventListener("change", (ev) => {
      const next = state.baseLayers[ev.target.value];
      if (state.map && next && next !== state.activeBaseLayer) {
        state.map.removeLayer(state.activeBaseLayer);
        next.addTo(state.map);
        next.bringToBack();
        state.activeBaseLayer = next;
      }
    });

    document.getElementById("inp-search-filter")?.addEventListener("input", (ev) => {
      state.searchQuery = ev.target.value || "";
      renderAllMapLayers();
    });

    document.getElementById("sel-sector-preset")?.addEventListener("change", (ev) => {
      const p = SECTOR_PRESETS[ev.target.value];
      if (p && state.map) state.map.setView(p.center, p.zoom);
    });

    document.getElementById("sel-series-param")?.addEventListener("change", (ev) => {
      state.selectedSeriesParam = ev.target.value;
      renderSeriesChart();
    });

    document.getElementById("btn-locate-me")?.addEventListener("click", handleRequestGeolocation);
    document.getElementById("btn-clear-location")?.addEventListener("click", handleClearGeolocation);

    const tabs = document.querySelectorAll(".mobile-tab-btn");
    const grid = document.getElementById("workspace-grid");
    tabs.forEach((btn) => {
      btn.addEventListener("click", () => {
        const target = btn.getAttribute("data-target") || "map";
        if (grid) grid.setAttribute("data-mobile-view", target);
        tabs.forEach((b) => b.setAttribute("aria-selected", String(b === btn)));
        if (target === "map" && state.map) setTimeout(() => state.map.invalidateSize(), 60);
      });
    });

    let resizeTimer = null;
    window.addEventListener("resize", () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => state.map && state.map.invalidateSize(), 150);
    });
  }

  document.addEventListener("DOMContentLoaded", () => {
    if (typeof L === "undefined") {
      const box = document.getElementById("network-alert-box");
      if (box) {
        box.className = "status-banner error";
        box.textContent = "No se pudo cargar la biblioteca cartográfica Leaflet (vendor/leaflet.js).";
      }
      return;
    }
    initMap();
    bindEvents();
    loadAllSources(false);
  });
})();
