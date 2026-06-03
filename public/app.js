const state = {
  map: null,
  tileLayer: null,
  routeRenderer: null,
  resizeObserver: null,
  bounds: null,
  selectedRouteId: "",
  hoveredRouteId: "",
  users: [],
  currentUserId: localStorage.getItem("mapRoutesUserId") || "",
  routes: new Map(),
  styleSaveTimers: new Map()
};

const elements = {
  uploadForm: document.querySelector("#uploadForm"),
  routeFile: document.querySelector("#routeFile"),
  fileName: document.querySelector("#fileName"),
  status: document.querySelector("#status"),
  groupsOverview: document.querySelector("#groupsOverview"),
  layersList: document.querySelector("#layersList"),
  emptyState: document.querySelector("#emptyState"),
  routeCount: document.querySelector("#routeCount"),
  totalDistance: document.querySelector("#totalDistance"),
  totalRideTime: document.querySelector("#totalRideTime"),
  totalTime: document.querySelector("#totalTime"),
  currentUserName: document.querySelector("#currentUserName"),
  userMenuButton: document.querySelector("#userMenuButton"),
  userMenu: document.querySelector("#userMenu"),
  userList: document.querySelector("#userList"),
  createUserButton: document.querySelector("#createUserButton"),
  renameUserButton: document.querySelector("#renameUserButton"),
  fitAllButton: document.querySelector("#fitAllButton"),
  baseLayerSelect: document.querySelector("#baseLayerSelect"),
  mapWrap: document.querySelector(".map-wrap"),
  fileDrop: document.querySelector(".file-drop")
};

const BASE_LAYERS = {
  standard: {
    url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
  },
  light: {
    url: "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png",
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>'
  },
  dark: {
    url: "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png",
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>'
  }
};

const TILE_OPTIONS = {
  maxZoom: 19,
  detectRetina: false,
  updateWhenIdle: true,
  keepBuffer: 3
};

const DEFAULT_ROUTE_COLOR = "#ff3300";
const DEFAULT_ROUTE_WEIGHT = 2;
const DEFAULT_BIKE = "Twiter Gravel V1";
const SELECTED_ROUTE_COLOR = "#ff3300";
const MUTED_ROUTE_COLOR = "#a8a8a8";
const ROUTE_HITBOX_WEIGHT = 22;

function setStatus(message, isError = false) {
  elements.status.textContent = message;
  elements.status.classList.toggle("error", isError);
}

function setFileNameHint(message) {
  if (elements.fileName) {
    elements.fileName.textContent = message;
  }
}

function userQueryString() {
  return state.currentUserId ? `?user=${encodeURIComponent(state.currentUserId)}` : "";
}

function userApiUrl(path) {
  return `${path}${userQueryString()}`;
}

async function fetchUsers() {
  const response = await fetch("/api/users");
  if (!response.ok) {
    throw new Error("Не удалось получить список пользователей.");
  }

  const data = await response.json();
  return Array.isArray(data.users) ? data.users : [];
}

function getCurrentUser() {
  return state.users.find((user) => user.id === state.currentUserId)
    || state.users[0]
    || null;
}

function closeUserMenu() {
  if (!elements.userMenu) {
    return;
  }

  elements.userMenu.hidden = true;
  elements.userMenuButton?.setAttribute("aria-expanded", "false");
}

function toggleUserMenu() {
  const shouldOpen = elements.userMenu.hidden;
  elements.userMenu.hidden = !shouldOpen;
  elements.userMenuButton.setAttribute("aria-expanded", String(shouldOpen));
}

function renderUsers() {
  const currentUser = getCurrentUser();
  const currentUserName = currentUser?.name || "";

  elements.currentUserName.textContent = currentUserName.toUpperCase();
  elements.currentUserName.title = currentUserName;
  elements.userMenuButton.setAttribute("aria-label", currentUserName ? `Пользователь: ${currentUserName}` : "Меню пользователя");
  elements.userList.innerHTML = state.users
    .map((user) => {
      const isActive = user.id === state.currentUserId;
      return `
        <button class="user-menu-item${isActive ? " is-active" : ""}" type="button" role="menuitem" data-user-id="${escapeHtml(user.id)}">
          <span>${escapeHtml(user.name)}</span>
          ${isActive ? "<span aria-hidden=\"true\">✓</span>" : ""}
        </button>
      `;
    })
    .join("");
}

async function switchUser(userId) {
  if (!userId || userId === state.currentUserId) {
    closeUserMenu();
    return;
  }

  state.currentUserId = userId;
  localStorage.setItem("mapRoutesUserId", state.currentUserId);
  renderUsers();
  clearRoutes();
  closeUserMenu();

  await loadSavedRoutes();
  const user = getCurrentUser();
  setStatus(`Пользователь: ${user?.name || state.currentUserId}.`);
}

async function initUsers() {
  state.users = await fetchUsers();
  const selectedUser = state.users.find((user) => user.id === state.currentUserId)
    || state.users[0];

  if (!selectedUser) {
    throw new Error("Нет доступных пользователей.");
  }

  state.currentUserId = selectedUser.id;
  localStorage.setItem("mapRoutesUserId", state.currentUserId);
  renderUsers();
}

async function createUser() {
  const name = window.prompt("Имя нового пользователя");
  if (!name || !name.trim()) {
    return;
  }

  const response = await fetch("/api/users", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: name.trim() })
  });
  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(data.error || "Не удалось создать пользователя.");
  }

  state.users.push(data.user);
  state.currentUserId = data.user.id;
  localStorage.setItem("mapRoutesUserId", state.currentUserId);
  renderUsers();
  clearRoutes();
  closeUserMenu();
  await loadSavedRoutes();
  setStatus(`Пользователь "${data.user.name}" создан.`);
}

async function renameCurrentUser() {
  const user = getCurrentUser();
  if (!user) {
    return;
  }

  const name = window.prompt("Новое имя пользователя", user.name);
  if (!name || !name.trim()) {
    return;
  }

  const normalizedName = name.trim();
  if (normalizedName === user.name) {
    closeUserMenu();
    return;
  }

  const response = await fetch(`/api/users/${encodeURIComponent(user.id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: normalizedName })
  });
  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(data.error || "Не удалось переименовать пользователя.");
  }

  const userIndex = state.users.findIndex((item) => item.id === user.id);
  if (userIndex >= 0) {
    state.users[userIndex] = data.user;
  }

  renderUsers();
  closeUserMenu();
  setStatus(`Пользователь переименован: ${data.user.name}.`);
}

function initMap() {
  state.map = L.map("map", {
    zoomControl: true,
    preferCanvas: true
  }).setView([55.751244, 37.618423], 10);

  state.routeRenderer = L.canvas({ padding: 0.45 });
  setBaseLayer("light");
  setupMapResizeHandling();
}

function setBaseLayer(key) {
  const layerConfig = BASE_LAYERS[key] || BASE_LAYERS.standard;

  if (state.tileLayer) {
    state.map.removeLayer(state.tileLayer);
  }

  state.tileLayer = L.tileLayer(layerConfig.url, {
    ...TILE_OPTIONS,
    attribution: layerConfig.attribution
  });

  state.tileLayer.addTo(state.map);
  elements.baseLayerSelect.value = BASE_LAYERS[key] ? key : "standard";
  document.body.dataset.mapTheme = key;
  invalidateMapSize();
}

function invalidateMapSize() {
  if (!state.map) {
    return;
  }

  requestAnimationFrame(() => {
    state.map.invalidateSize({ pan: false, debounceMoveend: true });
  });
}

function setupMapResizeHandling() {
  if ("ResizeObserver" in window) {
    state.resizeObserver = new ResizeObserver(() => invalidateMapSize());
    state.resizeObserver.observe(elements.mapWrap);
  }

  window.addEventListener("resize", invalidateMapSize, { passive: true });
  window.addEventListener("orientationchange", () => {
    [120, 450, 900].forEach((delay) => setTimeout(invalidateMapSize, delay));
  });
}

function getRouteStyle(route, isSelected = false, isMuted = false) {
  const color = route.color || DEFAULT_ROUTE_COLOR;
  const weight = Number.isFinite(Number(route.weight)) ? Number(route.weight) : DEFAULT_ROUTE_WEIGHT;
  const selectedWeight = Math.max(weight + 3, 5);
  const activeColor = isSelected ? SELECTED_ROUTE_COLOR : color;
  const displayColor = isMuted ? MUTED_ROUTE_COLOR : activeColor;

  return {
    color: displayColor,
    fillColor: displayColor,
    fillOpacity: isMuted ? 0.12 : isSelected ? 0.35 : 0.2,
    weight: isSelected ? selectedWeight : weight,
    opacity: isMuted ? 0.42 : isSelected ? 1 : 0.95,
    lineCap: "round",
    lineJoin: "round",
    smoothFactor: isSelected ? 1 : 1.6
  };
}

function normalizeRouteStyle(route, forceDefault = false) {
  const weight = Number(route.weight);
  const routeDate = normalizeRouteDate(route.routeDate, route.originalName);

  return {
    ...route,
    originalName: route.originalName || "Маршрут",
    routeDate,
    description: route.description || "",
    bike: route.bike || DEFAULT_BIKE,
    rideTime: route.rideTime || "",
    totalTime: route.totalTime || "",
    averageSpeed: route.averageSpeed || "",
    color: forceDefault ? DEFAULT_ROUTE_COLOR : route.color || DEFAULT_ROUTE_COLOR,
    weight: forceDefault
      ? DEFAULT_ROUTE_WEIGHT
      : Number.isFinite(weight) ? weight : DEFAULT_ROUTE_WEIGHT
  };
}

function getTodayIsoDate() {
  const today = new Date();
  const year = today.getFullYear();
  const month = String(today.getMonth() + 1).padStart(2, "0");
  const day = String(today.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function normalizeRouteDate(routeDate, fallbackText = "") {
  if (typeof routeDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(routeDate)) {
    return routeDate;
  }

  const isoMatch = String(fallbackText).match(/(20\d{2})[-_./](\d{2})[-_./](\d{2})/);
  if (isoMatch) {
    return `${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}`;
  }

  const ruMatch = String(fallbackText).match(/(\d{1,2})[-_./\s](\d{1,2})[-_./\s](20\d{2})/);
  if (ruMatch) {
    return `${ruMatch[3]}-${ruMatch[2].padStart(2, "0")}-${ruMatch[1].padStart(2, "0")}`;
  }

  return getTodayIsoDate();
}

const RUSSIAN_MONTHS = [
  "января",
  "февраля",
  "марта",
  "апреля",
  "мая",
  "июня",
  "июля",
  "августа",
  "сентября",
  "октября",
  "ноября",
  "декабря"
];

const RUSSIAN_MONTHS_SHORT = [
  "янв",
  "фев",
  "мар",
  "апр",
  "май",
  "июн",
  "июл",
  "авг",
  "сен",
  "окт",
  "ноя",
  "дек"
];

function formatHumanDate(routeDate) {
  const normalized = normalizeRouteDate(routeDate);
  const [year, month, day] = normalized.split("-").map(Number);
  return `${day} ${RUSSIAN_MONTHS[month - 1]} ${year}г.`;
}

function formatShortDate(routeDate) {
  const normalized = normalizeRouteDate(routeDate);
  const [year, month, day] = normalized.split("-").map(Number);
  return `${day} ${RUSSIAN_MONTHS_SHORT[month - 1]} ${year}`;
}

function formatDateForInput(routeDate) {
  const normalized = normalizeRouteDate(routeDate);
  const [year, month, day] = normalized.split("-");
  return `${day}.${month}.${year}`;
}

function getLayerDisplayName(route) {
  const name = route.originalName || "";
  const normalizedDate = normalizeRouteDate(route.routeDate, name);

  if (/^\d{4}-\d{2}-\d{2}$/.test(name)) {
    return formatHumanDate(name);
  }

  return name || formatHumanDate(normalizedDate);
}

function parseDateInput(value) {
  const text = String(value || "").trim().toLowerCase().replace(/г\.?$/, "").trim();
  const isoMatch = text.match(/^(20\d{2})[-_./](\d{1,2})[-_./](\d{1,2})$/);
  if (isoMatch) {
    return `${isoMatch[1]}-${isoMatch[2].padStart(2, "0")}-${isoMatch[3].padStart(2, "0")}`;
  }

  const numericMatch = text.match(/^(\d{1,2})[-_./\s](\d{1,2})[-_./\s](20\d{2})$/);
  if (numericMatch) {
    return `${numericMatch[3]}-${numericMatch[2].padStart(2, "0")}-${numericMatch[1].padStart(2, "0")}`;
  }

  const monthNames = [...RUSSIAN_MONTHS, ...RUSSIAN_MONTHS_SHORT];
  const monthPattern = monthNames.join("|");
  const monthMatch = text.match(new RegExp(`^(\\d{1,2})\\s+(${monthPattern})\\s+(20\\d{2})$`));
  if (monthMatch) {
    const fullMonthIndex = RUSSIAN_MONTHS.indexOf(monthMatch[2]);
    const shortMonthIndex = RUSSIAN_MONTHS_SHORT.indexOf(monthMatch[2]);
    const month = String((fullMonthIndex >= 0 ? fullMonthIndex : shortMonthIndex) + 1).padStart(2, "0");
    return `${monthMatch[3]}-${month}-${monthMatch[1].padStart(2, "0")}`;
  }

  return "";
}

function maskDateInputValue(value) {
  const digits = String(value || "").replace(/\D/g, "").slice(0, 8);

  if (digits.length <= 2) {
    return digits;
  }

  if (digits.length <= 4) {
    return `${digits.slice(0, 2)}.${digits.slice(2)}`;
  }

  return `${digits.slice(0, 2)}.${digits.slice(2, 4)}.${digits.slice(4)}`;
}

function bindDateMask(input) {
  input.addEventListener("beforeinput", (event) => {
    if (event.data && /\D/.test(event.data)) {
      event.preventDefault();
    }
  });

  input.addEventListener("input", () => {
    input.value = maskDateInputValue(input.value);
  });
}

function maskClockInputValue(value) {
  const digits = String(value || "").replace(/\D/g, "").slice(0, 4);

  if (digits.length <= 2) {
    return digits;
  }

  const hours = digits.slice(0, 2);
  let minutes = digits.slice(2);

  if (minutes.length === 2 && Number(minutes) > 59) {
    minutes = "59";
  }

  return `${hours}:${minutes}`;
}

function bindClockMask(input) {
  input.addEventListener("beforeinput", (event) => {
    if (event.data && /\D/.test(event.data)) {
      event.preventDefault();
    }
  });

  input.addEventListener("input", () => {
    input.value = maskClockInputValue(input.value);
  });
}

function flattenCoordinates(coordinates, output = []) {
  if (!Array.isArray(coordinates)) {
    return output;
  }

  if (typeof coordinates[0] === "number" && typeof coordinates[1] === "number") {
    output.push([coordinates[1], coordinates[0]]);
    return output;
  }

  coordinates.forEach((item) => flattenCoordinates(item, output));
  return output;
}

function getGeoJsonPointCount(geojson) {
  let count = 0;

  function visitGeometry(geometry) {
    if (!geometry) {
      return;
    }

    if (geometry.type === "GeometryCollection") {
      (geometry.geometries || []).forEach(visitGeometry);
      return;
    }

    count += flattenCoordinates(geometry.coordinates).length;
  }

  if (geojson.type === "FeatureCollection") {
    geojson.features.forEach((feature) => visitGeometry(feature.geometry));
  } else if (geojson.type === "Feature") {
    visitGeometry(geojson.geometry);
  } else {
    visitGeometry(geojson);
  }

  return count;
}

function getGeoJsonDistanceKm(geojson) {
  function visitGeometry(geometry) {
    if (!geometry) {
      return 0;
    }

    if (geometry.type === "GeometryCollection") {
      return (geometry.geometries || []).reduce((sum, item) => sum + visitGeometry(item), 0);
    }

    if (geometry.type === "LineString") {
      return getLineDistanceKm(geometry.coordinates);
    }

    if (geometry.type === "MultiLineString") {
      return (geometry.coordinates || []).reduce((sum, line) => sum + getLineDistanceKm(line), 0);
    }

    if (geometry.type === "Polygon") {
      return (geometry.coordinates || []).reduce((sum, ring) => sum + getLineDistanceKm(ring), 0);
    }

    if (geometry.type === "MultiPolygon") {
      return (geometry.coordinates || []).reduce((sum, polygon) => {
        return sum + (polygon || []).reduce((polygonSum, ring) => polygonSum + getLineDistanceKm(ring), 0);
      }, 0);
    }

    return 0;
  }

  if (geojson.type === "FeatureCollection") {
    return geojson.features.reduce((sum, feature) => sum + visitGeometry(feature.geometry), 0);
  }

  if (geojson.type === "Feature") {
    return visitGeometry(geojson.geometry);
  }

  return visitGeometry(geojson);
}

function getLineDistanceKm(coordinates = []) {
  let distance = 0;

  for (let index = 1; index < coordinates.length; index += 1) {
    const previous = coordinates[index - 1];
    const current = coordinates[index];

    if (isCoordinate(previous) && isCoordinate(current)) {
      distance += haversineKm(previous[1], previous[0], current[1], current[0]);
    }
  }

  return distance;
}

function isCoordinate(coordinate) {
  return Array.isArray(coordinate)
    && Number.isFinite(Number(coordinate[0]))
    && Number.isFinite(Number(coordinate[1]));
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const radiusKm = 6371;
  const toRadians = (value) => Number(value) * Math.PI / 180;
  const dLat = toRadians(lat2 - lat1);
  const dLon = toRadians(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * Math.sin(dLon / 2) ** 2;

  return 2 * radiusKm * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function formatDistanceKm(distanceKm) {
  if (!Number.isFinite(distanceKm) || distanceKm <= 0) {
    return "0.0";
  }

  return distanceKm < 10 ? distanceKm.toFixed(1) : Math.round(distanceKm).toString();
}

function getGeoJsonTimeStats(geojson, distanceKm) {
  let movingSeconds = 0;
  let totalSeconds = 0;

  function readTimes(feature, lineIndex = 0) {
    const properties = feature?.properties || {};
    const source = [
      properties.times,
      properties.coordTimes,
      properties.coordinateTimes
    ].find(Array.isArray);

    if (!Array.isArray(source)) {
      return [];
    }

    return Array.isArray(source[0]) ? source[lineIndex] || [] : source;
  }

  function addLine(coordinates = [], times = []) {
    if (!Array.isArray(times) || times.length < 2) {
      return;
    }

    for (let index = 1; index < coordinates.length; index += 1) {
      const previous = coordinates[index - 1];
      const current = coordinates[index];
      const previousTime = Date.parse(times[index - 1]);
      const currentTime = Date.parse(times[index]);
      const seconds = (currentTime - previousTime) / 1000;

      if (!isCoordinate(previous) || !isCoordinate(current) || !Number.isFinite(seconds) || seconds <= 0) {
        continue;
      }

      const segmentKm = haversineKm(previous[1], previous[0], current[1], current[0]);
      const speedKmh = segmentKm / (seconds / 3600);
      totalSeconds += seconds;

      if (segmentKm > 0.003 && speedKmh >= 1 && speedKmh <= 140) {
        movingSeconds += seconds;
      }
    }
  }

  function visitFeature(feature) {
    const geometry = feature?.geometry || feature;
    if (!geometry) {
      return;
    }

    if (geometry.type === "LineString") {
      addLine(geometry.coordinates, readTimes(feature));
      return;
    }

    if (geometry.type === "MultiLineString") {
      (geometry.coordinates || []).forEach((line, index) => addLine(line, readTimes(feature, index)));
      return;
    }

    if (geometry.type === "GeometryCollection") {
      (geometry.geometries || []).forEach((item) => visitFeature({ type: "Feature", properties: feature.properties, geometry: item }));
    }
  }

  if (geojson.type === "FeatureCollection") {
    geojson.features.forEach(visitFeature);
  } else if (geojson.type === "Feature") {
    visitFeature(geojson);
  } else {
    visitFeature({ type: "Feature", properties: {}, geometry: geojson });
  }

  const speedTime = movingSeconds || totalSeconds;
  return {
    movingSeconds,
    totalSeconds,
    averageSpeedKmh: speedTime > 0 ? distanceKm / (speedTime / 3600) : 0
  };
}

function formatClockDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return "";
  }

  const minutes = Math.max(1, Math.round(seconds / 60));
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  return `${String(hours).padStart(2, "0")}:${String(restMinutes).padStart(2, "0")}`;
}

function parseClockDuration(value) {
  const match = String(value || "").trim().match(/^(\d{1,3}):([0-5]\d)$/);
  if (!match) {
    return 0;
  }

  return (Number(match[1]) * 60 + Number(match[2])) * 60;
}

function formatTotalClockDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return "00:00";
  }

  const minutes = Math.round(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  return `${String(hours).padStart(2, "0")}:${String(restMinutes).padStart(2, "0")}`;
}

function formatSpeedValue(kmh) {
  if (!Number.isFinite(kmh) || kmh <= 0) {
    return "";
  }

  return kmh.toFixed(1);
}

function getRouteMetaValues(route, stats) {
  return {
    date: formatShortDate(route.routeDate),
    rideTime: route.rideTime || formatClockDuration(stats.movingSeconds) || "00:00",
    totalTime: route.totalTime || formatClockDuration(stats.totalSeconds) || "00:00",
    averageSpeed: route.averageSpeed || formatSpeedValue(stats.averageSpeedKmh) || "0.0"
  };
}

function updateLayerMetaText(card, route, stats) {
  const meta = getRouteMetaValues(route, stats);
  card.querySelector(".layer-date").textContent = meta.date;
  card.querySelector(".layer-ride-time").textContent = `${meta.rideTime} rH`;
  card.querySelector(".layer-total-time").textContent = `${meta.totalTime} tH`;
  card.querySelector(".layer-average-speed").textContent = `${meta.averageSpeed} kmh`;
}

function parseGpx(text) {
  const documentXml = new DOMParser().parseFromString(text, "application/xml");
  const parserError = documentXml.querySelector("parsererror");

  if (parserError) {
    throw new Error("GPX файл не удалось прочитать.");
  }

  const features = [];

  documentXml.querySelectorAll("trk").forEach((track, trackIndex) => {
    const trackName = track.querySelector("name")?.textContent?.trim();

    track.querySelectorAll("trkseg").forEach((segment, segmentIndex) => {
      const points = Array.from(segment.querySelectorAll("trkpt"))
        .map((point) => ({
          coordinates: [
            Number(point.getAttribute("lon")),
            Number(point.getAttribute("lat"))
          ],
          time: point.querySelector("time")?.textContent?.trim() || ""
        }))
        .filter((point) => isCoordinate(point.coordinates));
      const coordinates = points.map((point) => point.coordinates);

      if (coordinates.length > 1) {
        features.push({
          type: "Feature",
          properties: {
            name: trackName || `Track ${trackIndex + 1}.${segmentIndex + 1}`,
            times: points.map((point) => point.time)
          },
          geometry: {
            type: "LineString",
            coordinates
          }
        });
      }
    });
  });

  documentXml.querySelectorAll("rte").forEach((route, routeIndex) => {
    const routeName = route.querySelector("name")?.textContent?.trim();
    const points = Array.from(route.querySelectorAll("rtept"))
      .map((point) => ({
        coordinates: [
          Number(point.getAttribute("lon")),
          Number(point.getAttribute("lat"))
        ],
        time: point.querySelector("time")?.textContent?.trim() || ""
      }))
      .filter((point) => isCoordinate(point.coordinates));
    const coordinates = points.map((point) => point.coordinates);

    if (coordinates.length > 1) {
      features.push({
        type: "Feature",
        properties: {
          name: routeName || `Route ${routeIndex + 1}`,
          times: points.map((point) => point.time)
        },
        geometry: {
          type: "LineString",
          coordinates
        }
      });
    }
  });

  documentXml.querySelectorAll("wpt").forEach((point, pointIndex) => {
    const lon = Number(point.getAttribute("lon"));
    const lat = Number(point.getAttribute("lat"));

    if (Number.isFinite(lon) && Number.isFinite(lat)) {
      features.push({
        type: "Feature",
        properties: {
          name: point.querySelector("name")?.textContent?.trim() || `Waypoint ${pointIndex + 1}`
        },
        geometry: {
          type: "Point",
          coordinates: [lon, lat]
        }
      });
    }
  });

  if (!features.length) {
    throw new Error("В GPX файле не найден маршрут.");
  }

  return {
    type: "FeatureCollection",
    features
  };
}

function normalizeGeoJson(raw) {
  const geojson = JSON.parse(raw);
  const allowedTypes = new Set([
    "FeatureCollection",
    "Feature",
    "Point",
    "MultiPoint",
    "LineString",
    "MultiLineString",
    "Polygon",
    "MultiPolygon",
    "GeometryCollection"
  ]);

  if (!allowedTypes.has(geojson.type)) {
    throw new Error("GeoJSON файл должен содержать FeatureCollection, Feature или Geometry.");
  }

  return geojson;
}

async function loadRouteGeometry(route) {
  const response = await fetch(route.url);
  if (!response.ok) {
    throw new Error(`Не удалось загрузить ${route.originalName}.`);
  }

  const raw = await response.text();
  return route.type === "gpx" ? parseGpx(raw) : normalizeGeoJson(raw);
}

function updateGlobalBounds(layer) {
  const bounds = layer.getBounds?.();
  if (!bounds || !bounds.isValid()) {
    return;
  }

  state.bounds = state.bounds ? state.bounds.extend(bounds) : bounds;
}

function fitAllRoutes() {
  if (state.bounds?.isValid()) {
    state.map.fitBounds(state.bounds, {
      padding: window.innerWidth < 780 ? [22, 22] : [42, 42],
      maxZoom: 16
    });
  }
}

function isLayerCardAction(event) {
  return Boolean(event.target.closest("button, input, textarea, select, label, .layer-menu, .layer-menu-wrap, .bike-group-heading"));
}

function getGroupCards(bikeName) {
  return Array.from(elements.layersList.querySelectorAll(".layer-card"))
    .filter((card) => getBikeGroupName(card) === bikeName);
}

function setRouteVisibility(routeId, shouldShow) {
  const item = state.routes.get(routeId);
  const card = document.querySelector(`.layer-card[data-route-id="${CSS.escape(routeId)}"]`);
  const toggle = card?.querySelector(".layer-toggle");

  if (!item) {
    return;
  }

  if (toggle) {
    toggle.setAttribute("aria-pressed", String(shouldShow));
    toggle.classList.toggle("is-visible", shouldShow);
    toggle.classList.toggle("is-hidden", !shouldShow);
    toggle.setAttribute("aria-label", shouldShow ? "Скрыть слой" : "Показать слой");
  }

  if (shouldShow) {
    item.layer.addTo(state.map);
    item.hitboxLayer?.addTo(state.map);
  } else {
    if (state.hoveredRouteId === routeId) {
      state.hoveredRouteId = "";
    }
    state.map.removeLayer(item.layer);
    if (item.hitboxLayer) {
      state.map.removeLayer(item.hitboxLayer);
    }
  }

  applyRouteStyles();
  updateAllGroupVisibilityControls();
}

function fitRouteLayer(layer) {
  const bounds = layer.getBounds?.();

  if (!bounds || !bounds.isValid()) {
    return;
  }

  state.map.fitBounds(bounds, {
    padding: [56, 56],
    maxZoom: 16
  });
}

function getRouteHitboxStyle() {
  return {
    color: "#000000",
    weight: ROUTE_HITBOX_WEIGHT,
    opacity: 0,
    fillOpacity: 0,
    lineCap: "round",
    lineJoin: "round",
    interactive: true
  };
}

function applyRouteStyles() {
  state.routes.forEach((item, id) => {
    const isSelected = id === state.selectedRouteId;
    const isHovered = id === state.hoveredRouteId;
    const isMuted = state.selectedRouteId
      ? !isSelected
      : Boolean(state.hoveredRouteId) && !isHovered;
    item.layer.setStyle?.(getRouteStyle(item.route, isSelected, isMuted));

    if (isSelected || isHovered) {
      item.layer.bringToFront?.();
      item.hitboxLayer?.bringToFront?.();
    }
  });
}

function setHoveredRoute(routeId) {
  state.hoveredRouteId = routeId;
  applyRouteStyles();
}

function selectRoute(routeId, shouldFit = true) {
  state.selectedRouteId = routeId;
  applyRouteStyles();

  document.querySelectorAll(".layer-card").forEach((card) => {
    card.classList.toggle("is-selected", card.dataset.routeId === routeId);
  });

  const selectedItem = state.routes.get(routeId);
  if (shouldFit && selectedItem) {
    fitRouteLayer(selectedItem.layer);
  }
}

function clearSelectedRoute() {
  if (!state.selectedRouteId) {
    return;
  }

  state.selectedRouteId = "";
  applyRouteStyles();
  document.querySelectorAll(".layer-card.is-selected").forEach((card) => {
    card.classList.remove("is-selected");
  });
}

function getBikeGroupRank(bike) {
  return String(bike || DEFAULT_BIKE).trim() === DEFAULT_BIKE ? 0 : 1;
}

function getBikeGroupName(card) {
  return card.dataset.bikeName || DEFAULT_BIKE;
}

function getVisibilityButtonMarkup(className, label, isVisible = true) {
  return `
    <button class="${className} ${isVisible ? "is-visible" : "is-hidden"}" type="button" aria-pressed="${isVisible}" aria-label="${escapeHtml(label)}">
      <svg class="toggle-icon toggle-icon-on" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M2.5 12s3.4-6 9.5-6 9.5 6 9.5 6-3.4 6-9.5 6-9.5-6-9.5-6Z"/>
        <circle cx="12" cy="12" r="3"/>
      </svg>
      <svg class="toggle-icon toggle-icon-off" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M2.5 12s3.4-6 9.5-6 9.5 6 9.5 6-3.4 6-9.5 6-9.5-6-9.5-6Z"/>
        <circle cx="12" cy="12" r="3"/>
        <path class="toggle-slash" d="M4 20 20 4"/>
      </svg>
    </button>
  `;
}

function isRouteVisible(routeId) {
  const card = document.querySelector(`.layer-card[data-route-id="${CSS.escape(routeId)}"]`);
  const toggle = card?.querySelector(".layer-toggle");
  return toggle?.getAttribute("aria-pressed") !== "false";
}

function getBikeGroupDistanceKm(bikeName) {
  return getGroupCards(bikeName).reduce((sum, card) => {
    const item = state.routes.get(card.dataset.routeId);
    return sum + (Number(item?.distanceKm) || 0);
  }, 0);
}

function formatRouteCountLabel(count) {
  const lastDigit = count % 10;
  const lastTwoDigits = count % 100;

  if (lastDigit === 1 && lastTwoDigits !== 11) {
    return `${count} маршрут`;
  }

  if (lastDigit >= 2 && lastDigit <= 4 && (lastTwoDigits < 12 || lastTwoDigits > 14)) {
    return `${count} маршрута`;
  }

  return `${count} маршрутов`;
}

function setGroupToggleButtonState(button, bikeName, isVisible) {
  button.setAttribute("aria-pressed", String(isVisible));
  button.classList.toggle("is-visible", isVisible);
  button.classList.toggle("is-hidden", !isVisible);
  button.setAttribute("aria-label", isVisible ? `Скрыть группу ${bikeName}` : `Показать группу ${bikeName}`);
}

function updateGroupVisibilityControls(bikeName) {
  const groupCards = getGroupCards(bikeName);
  const isVisible = groupCards.some((card) => isRouteVisible(card.dataset.routeId));
  const heading = elements.layersList.querySelector(`.bike-group-heading[data-bike-name="${CSS.escape(bikeName)}"]`);
  const headingButton = heading?.querySelector(".group-toggle");
  const overviewButton = elements.groupsOverview?.querySelector(`.group-overview-toggle[data-bike-name="${CSS.escape(bikeName)}"]`);

  if (headingButton) {
    setGroupToggleButtonState(headingButton, bikeName, isVisible);
  }

  if (overviewButton) {
    setGroupToggleButtonState(overviewButton, bikeName, isVisible);
  }
}

function updateAllGroupVisibilityControls() {
  const bikeNames = new Set(
    Array.from(elements.layersList.querySelectorAll(".layer-card"))
      .map((card) => getBikeGroupName(card))
  );

  bikeNames.forEach(updateGroupVisibilityControls);
}

function toggleBikeGroup(bikeName, shouldShow) {
  const groupCards = getGroupCards(bikeName);

  groupCards.forEach((card) => setRouteVisibility(card.dataset.routeId, shouldShow));
  updateAllGroupVisibilityControls();
}

function applyBikeGroupStyle(bikeName, color, weight) {
  const normalizedWeight = normalizeRouteWeight(weight);

  getGroupCards(bikeName).forEach((card) => {
    const item = state.routes.get(card.dataset.routeId);
    if (!item) {
      return;
    }

    item.route.color = color;
    item.route.weight = normalizedWeight;

    const colorInput = card.querySelector(".color-input");
    const weightInput = card.querySelector(".weight-input");
    const weightNumberInput = card.querySelector(".weight-number-input");

    if (colorInput) {
      colorInput.value = color;
    }

    if (weightInput) {
      weightInput.value = String(normalizedWeight);
    }

    if (weightNumberInput) {
      weightNumberInput.value = String(normalizedWeight);
    }
  });

  applyRouteStyles();
}

function normalizeRouteWeight(value) {
  const weight = Number(value);
  if (!Number.isFinite(weight)) {
    return DEFAULT_ROUTE_WEIGHT;
  }

  return Math.min(20, Math.max(1, Math.round(weight)));
}

async function saveBikeGroupStyle(bikeName) {
  const routes = getGroupCards(bikeName)
    .map((card) => state.routes.get(card.dataset.routeId)?.route)
    .filter(Boolean);

  for (const route of routes) {
    const savedRoute = await sendRoutePatch(route);
    if (savedRoute) {
      Object.assign(route, savedRoute);
    }
  }
}

function buildLayerCard(route, stats) {
  const card = document.createElement("article");
  card.className = "layer-card";
  card.dataset.routeId = route.id;
  const routeDate = normalizeRouteDate(route.routeDate, route.originalName);
  const displayName = route.originalName || "Маршрут";
  const meta = getRouteMetaValues(route, stats);
  card.dataset.routeDate = routeDate;
  card.dataset.bikeGroup = String(getBikeGroupRank(route.bike));
  card.dataset.bikeName = route.bike || DEFAULT_BIKE;

  card.innerHTML = `
    <div class="layer-main">
      <div class="layer-distance" title="Дистанция маршрута">
        <div class="distance-line">
          <strong>${formatDistanceKm(stats.distanceKm)}</strong>
          <span>км</span>
        </div>
      </div>
      <div class="layer-info">
        <span class="layer-title" title="${escapeHtml(displayName)}">${escapeHtml(displayName)}</span>
        <p class="layer-meta">
          <span class="layer-date">${escapeHtml(meta.date)}</span>
          <span class="meta-dot" aria-hidden="true">·</span>
          <span class="layer-ride-time" title="Время езды">${escapeHtml(meta.rideTime)} rH</span>
          <span class="meta-dot" aria-hidden="true">·</span>
          <span class="layer-total-time" title="Общее время">${escapeHtml(meta.totalTime)} tH</span>
          <span class="meta-dot" aria-hidden="true">·</span>
          <span class="layer-average-speed" title="Средняя скорость">${escapeHtml(meta.averageSpeed)} kmh</span>
        </p>
      </div>
      ${getVisibilityButtonMarkup("layer-toggle", "Скрыть слой")}
      <div class="layer-menu-wrap">
        <button class="menu-button" type="button" aria-label="Настройки слоя">⋮</button>
        <div class="layer-menu route-menu" hidden>
          <div class="menu-heading">
            <span>Настройки слоя</span>
            <button class="menu-close-button" type="button" aria-label="Закрыть меню">×</button>
          </div>
          <label class="menu-control">
            Название слоя
            <input class="title-menu-input" type="text" value="${escapeHtml(displayName)}" placeholder="Текст">
          </label>
          <label class="menu-control">
            Велосипед
            <input class="bike-input" type="text" value="${escapeHtml(route.bike || DEFAULT_BIKE)}" placeholder="Twiter Gravel V1">
          </label>
          <label class="menu-control">
            Дата
            <input class="menu-date-input" type="text" value="${escapeHtml(formatDateForInput(routeDate))}" inputmode="numeric" maxlength="10" placeholder="__.__.____">
          </label>
          <label class="menu-control">
            Время езды rH
            <input class="ride-time-input" type="text" value="${escapeHtml(route.rideTime || formatClockDuration(stats.movingSeconds))}" inputmode="numeric" maxlength="5" placeholder="00:00">
          </label>
          <label class="menu-control">
            Общее время tH
            <input class="total-time-input" type="text" value="${escapeHtml(route.totalTime || formatClockDuration(stats.totalSeconds))}" inputmode="numeric" maxlength="5" placeholder="00:00">
          </label>
          <label class="menu-control">
            Средняя скорость kmh
            <input class="average-speed-input" type="text" value="${escapeHtml(route.averageSpeed || formatSpeedValue(stats.averageSpeedKmh))}" placeholder="12.3">
          </label>
          <label class="menu-control">
            Цвет линии
            <input class="color-input" type="color" value="${route.color}">
          </label>
          <label class="menu-control">
            Толщина линии
            <span class="weight-control-row">
              <input class="weight-input" type="range" min="1" max="20" value="${route.weight}" aria-label="Толщина линии">
              <span class="weight-number-wrap">
                <input class="weight-number-input" type="number" min="1" max="20" step="1" value="${route.weight}" aria-label="Толщина линии в пикселях">
                <span>px</span>
              </span>
            </span>
          </label>
          <button class="save-button" type="button">Сохранить</button>
          <button class="delete-button" type="button">Удалить слой</button>
        </div>
      </div>
    </div>
  `;

  const toggle = card.querySelector(".layer-toggle");
  const menuButton = card.querySelector(".menu-button");
  const menu = card.querySelector(".layer-menu");
  const menuCloseButton = card.querySelector(".menu-close-button");
  const title = card.querySelector(".layer-title");
  const titleMenuInput = card.querySelector(".title-menu-input");
  const bikeInput = card.querySelector(".bike-input");
  const dateText = card.querySelector(".layer-date");
  const menuDateInput = card.querySelector(".menu-date-input");
  const rideTimeInput = card.querySelector(".ride-time-input");
  const totalTimeInput = card.querySelector(".total-time-input");
  const averageSpeedInput = card.querySelector(".average-speed-input");
  const colorInput = card.querySelector(".color-input");
  const weightInput = card.querySelector(".weight-input");
  const weightNumberInput = card.querySelector(".weight-number-input");
  const saveButton = card.querySelector(".save-button");
  const deleteButton = card.querySelector(".delete-button");

  menuButton.addEventListener("click", (event) => {
    event.stopPropagation();
    if (menu.hidden) {
      closeLayerMenus(card);
      menu.hidden = false;
      card.classList.add("is-menu-open");
      positionLayerMenu(menu, menuButton);
    }
  });

  menu.addEventListener("click", (event) => event.stopPropagation());
  menuCloseButton.addEventListener("click", () => {
    menu.hidden = true;
    card.classList.remove("is-menu-open");
  });

  card.addEventListener("click", (event) => {
    if (isLayerCardAction(event)) {
      return;
    }

    selectRoute(route.id);
  });

  toggle.addEventListener("click", () => {
    const shouldShow = toggle.getAttribute("aria-pressed") !== "true";
    setRouteVisibility(route.id, shouldShow);
  });

  titleMenuInput.addEventListener("input", () => {
    const item = state.routes.get(route.id);
    if (!item) {
      return;
    }

    const nextTitle = titleMenuInput.value.trim() || "Маршрут";
    item.route.originalName = nextTitle;
    title.textContent = nextTitle;
    title.title = nextTitle;
    setStatus("Изменения готовы. Нажмите «Сохранить», чтобы записать их на сервер.");
  });

  titleMenuInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      titleMenuInput.blur();
    }
  });

  bikeInput.addEventListener("input", () => {
    const item = state.routes.get(route.id);
    if (!item) {
      return;
    }

    item.route.bike = bikeInput.value.trim() || DEFAULT_BIKE;
    card.dataset.bikeGroup = String(getBikeGroupRank(item.route.bike));
    card.dataset.bikeName = item.route.bike;
    sortLayerCards();
    setStatus("Изменения готовы. Нажмите «Сохранить», чтобы записать их на сервер.");
  });

  bindDateMask(menuDateInput);
  bindClockMask(rideTimeInput);
  bindClockMask(totalTimeInput);

  menuDateInput.addEventListener("change", () => {
    const item = state.routes.get(route.id);
    if (!item) {
      return;
    }

    updateRouteDate(item.route, menuDateInput.value, dateText, menuDateInput, card, stats);
  });

  rideTimeInput.addEventListener("input", () => {
    const item = state.routes.get(route.id);
    if (!item) {
      return;
    }

    item.route.rideTime = rideTimeInput.value.trim();
    updateLayerMetaText(card, item.route, stats);
    refreshTotalDistance();
    setStatus("Изменения готовы. Нажмите «Сохранить», чтобы записать их на сервер.");
  });

  totalTimeInput.addEventListener("input", () => {
    const item = state.routes.get(route.id);
    if (!item) {
      return;
    }

    item.route.totalTime = totalTimeInput.value.trim();
    updateLayerMetaText(card, item.route, stats);
    refreshTotalDistance();
    setStatus("Изменения готовы. Нажмите «Сохранить», чтобы записать их на сервер.");
  });

  averageSpeedInput.addEventListener("input", () => {
    const item = state.routes.get(route.id);
    if (!item) {
      return;
    }

    item.route.averageSpeed = averageSpeedInput.value.trim();
    updateLayerMetaText(card, item.route, stats);
    setStatus("Изменения готовы. Нажмите «Сохранить», чтобы записать их на сервер.");
  });

  colorInput.addEventListener("input", () => {
    const item = state.routes.get(route.id);
    if (!item) {
      return;
    }

    item.route.color = colorInput.value;
    applyRouteStyles();
    setStatus("Изменения готовы. Нажмите «Сохранить», чтобы записать их на сервер.");
  });

  function updateRouteWeight(nextValue) {
    const item = state.routes.get(route.id);
    if (!item) {
      return;
    }

    const normalizedWeight = normalizeRouteWeight(nextValue);
    item.route.weight = normalizedWeight;
    weightInput.value = String(normalizedWeight);
    weightNumberInput.value = String(normalizedWeight);
    applyRouteStyles();
    setStatus("Изменения готовы. Нажмите «Сохранить», чтобы записать их на сервер.");
  }

  weightInput.addEventListener("input", () => {
    updateRouteWeight(weightInput.value);
  });

  weightNumberInput.addEventListener("change", () => {
    updateRouteWeight(weightNumberInput.value);
  });

  weightNumberInput.addEventListener("input", () => {
    if (weightNumberInput.value !== "") {
      updateRouteWeight(weightNumberInput.value);
    }
  });

  saveButton.addEventListener("click", async () => {
    const item = state.routes.get(route.id);
    if (!item) {
      return;
    }

    try {
      clearTimeout(state.styleSaveTimers.get(route.id));
      state.styleSaveTimers.delete(route.id);
      saveButton.disabled = true;
      const savedRoute = await sendRoutePatch(item.route, true);
      if (savedRoute) {
        Object.assign(item.route, savedRoute);
        title.textContent = item.route.originalName;
        title.title = item.route.originalName;
        titleMenuInput.value = item.route.originalName;
      }
      menu.hidden = true;
      card.classList.remove("is-menu-open");
      setStatus("Изменения слоя сохранены.");
    } catch {
      setStatus("Не удалось сохранить изменения слоя на сервере.", true);
    } finally {
      saveButton.disabled = false;
    }
  });

  deleteButton.addEventListener("click", () => deleteRoute(route.id));

  return card;
}

function closeLayerMenus(exceptCard) {
  document.querySelectorAll(".layer-card, .bike-group-heading").forEach((item) => {
    if (item !== exceptCard) {
      item.querySelector(".layer-menu")?.setAttribute("hidden", "");
      item.classList.remove("is-menu-open");
    }
  });
}

function updateRouteDate(route, value, dateText, menuInput, card, stats) {
  const nextDate = parseDateInput(value);
  if (!nextDate) {
    setStatus("Введите дату цифрами в формате ДД.ММ.ГГГГ, например 03.06.2026.", true);
    return false;
  }

  route.routeDate = nextDate;
  dateText.textContent = formatShortDate(nextDate);
  menuInput.value = formatDateForInput(nextDate);
  card.dataset.routeDate = nextDate;
  updateLayerMetaText(card, route, stats);
  sortLayerCards();
  setStatus("Изменения готовы. Нажмите «Сохранить», чтобы записать их на сервер.");
  return true;
}

function insertLayerCardSorted(card) {
  elements.layersList.appendChild(card);
  sortLayerCards();
}

function compareLayerCards(left, right) {
  const leftGroup = Number(left.dataset.bikeGroup || 1);
  const rightGroup = Number(right.dataset.bikeGroup || 1);

  if (leftGroup !== rightGroup) {
    return leftGroup - rightGroup;
  }

  return (right.dataset.routeDate || "").localeCompare(left.dataset.routeDate || "");
}

function sortLayerCards() {
  const sortedCards = Array.from(elements.layersList.querySelectorAll(".layer-card"))
    .sort(compareLayerCards);

  elements.layersList.querySelectorAll(".bike-group-heading").forEach((heading) => heading.remove());

  let previousBikeName = "";
  sortedCards.forEach((card) => {
    const bikeName = getBikeGroupName(card);

    if (bikeName !== previousBikeName) {
      const heading = document.createElement("div");
      heading.className = "bike-group-heading";
      heading.dataset.bikeName = bikeName;
      const firstRoute = state.routes.get(card.dataset.routeId)?.route || {};
      const groupColor = firstRoute.color || DEFAULT_ROUTE_COLOR;
      const groupWeight = Number.isFinite(Number(firstRoute.weight)) ? Number(firstRoute.weight) : DEFAULT_ROUTE_WEIGHT;
      const groupDistanceKm = getBikeGroupDistanceKm(bikeName);
      const groupRouteCount = getGroupCards(bikeName).length;
      heading.innerHTML = `
        <span class="bike-group-title">
          <span>${escapeHtml(bikeName)}</span>
          <span class="bike-group-count">${formatRouteCountLabel(groupRouteCount)}</span>
          <span class="bike-group-distance">${formatDistanceKm(groupDistanceKm)} км</span>
        </span>
        <div class="bike-group-actions">
          ${getVisibilityButtonMarkup("group-toggle", `Скрыть группу ${bikeName}`)}
          <button class="group-menu-button" type="button" aria-label="Настройки группы">⋮</button>
          <div class="layer-menu group-menu" hidden>
            <label class="menu-control">
              Цвет группы
              <input class="group-color-input" type="color" value="${escapeHtml(groupColor)}">
            </label>
            <label class="menu-control">
              Толщина линии
              <span class="weight-control-row">
                <input class="group-weight-input" type="range" min="1" max="20" value="${groupWeight}" aria-label="Толщина линии группы">
                <span class="weight-number-wrap">
                  <input class="group-weight-number-input" type="number" min="1" max="20" step="1" value="${groupWeight}" aria-label="Толщина линии группы в пикселях">
                  <span>px</span>
                </span>
              </span>
            </label>
            <button class="group-save-button save-button" type="button">Сохранить группу</button>
          </div>
        </div>
      `;
      heading.querySelector(".group-toggle").addEventListener("click", (event) => {
        event.stopPropagation();
        const shouldShow = event.currentTarget.getAttribute("aria-pressed") !== "true";
        toggleBikeGroup(bikeName, shouldShow);
      });
      const groupMenuButton = heading.querySelector(".group-menu-button");
      const groupMenu = heading.querySelector(".group-menu");
      const groupColorInput = heading.querySelector(".group-color-input");
      const groupWeightInput = heading.querySelector(".group-weight-input");
      const groupWeightNumberInput = heading.querySelector(".group-weight-number-input");
      const groupSaveButton = heading.querySelector(".group-save-button");

      groupMenuButton.addEventListener("click", (event) => {
        event.stopPropagation();
        const shouldOpen = groupMenu.hidden;
        closeLayerMenus(heading);
        groupMenu.hidden = !shouldOpen;
        if (shouldOpen) {
          heading.classList.add("is-menu-open");
          positionLayerMenu(groupMenu, groupMenuButton);
        } else {
          heading.classList.remove("is-menu-open");
        }
      });

      groupMenu.addEventListener("click", (event) => event.stopPropagation());

      groupColorInput.addEventListener("input", () => {
        applyBikeGroupStyle(bikeName, groupColorInput.value, Number(groupWeightInput.value));
        setStatus("Изменения группы готовы. Нажмите «Сохранить группу», чтобы записать их на сервер.");
      });

      function updateGroupWeight(nextValue) {
        const normalizedWeight = normalizeRouteWeight(nextValue);
        groupWeightInput.value = String(normalizedWeight);
        groupWeightNumberInput.value = String(normalizedWeight);
        applyBikeGroupStyle(bikeName, groupColorInput.value, normalizedWeight);
        setStatus("Изменения группы готовы. Нажмите «Сохранить группу», чтобы записать их на сервер.");
      }

      groupWeightInput.addEventListener("input", () => {
        updateGroupWeight(groupWeightInput.value);
      });

      groupWeightNumberInput.addEventListener("change", () => {
        updateGroupWeight(groupWeightNumberInput.value);
      });

      groupWeightNumberInput.addEventListener("input", () => {
        if (groupWeightNumberInput.value !== "") {
          updateGroupWeight(groupWeightNumberInput.value);
        }
      });

      groupSaveButton.addEventListener("click", async () => {
        try {
          groupSaveButton.disabled = true;
          await saveBikeGroupStyle(bikeName);
          groupMenu.hidden = true;
          heading.classList.remove("is-menu-open");
          setStatus("Настройки группы сохранены.");
        } catch {
          setStatus("Не удалось сохранить настройки группы на сервере.", true);
        } finally {
          groupSaveButton.disabled = false;
        }
      });
      elements.layersList.appendChild(heading);
      previousBikeName = bikeName;
    }

    elements.layersList.appendChild(card);
  });

  renderGroupsOverview(sortedCards);
  updateAllGroupVisibilityControls();
}

function getGroupSummaries(sortedCards) {
  const summaries = [];
  const groupMap = new Map();

  sortedCards.forEach((card) => {
    const bikeName = getBikeGroupName(card);
    let summary = groupMap.get(bikeName);

    if (!summary) {
      summary = {
        bikeName,
        count: 0,
        distanceKm: 0
      };
      groupMap.set(bikeName, summary);
      summaries.push(summary);
    }

    const item = state.routes.get(card.dataset.routeId);
    summary.count += 1;
    summary.distanceKm += Number(item?.distanceKm) || 0;
  });

  return summaries;
}

function renderGroupsOverview(sortedCards) {
  if (!elements.groupsOverview) {
    return;
  }

  const summaries = getGroupSummaries(sortedCards);
  elements.groupsOverview.hidden = summaries.length === 0;

  if (!summaries.length) {
    elements.groupsOverview.innerHTML = "";
    return;
  }

  elements.groupsOverview.innerHTML = `
    <div class="groups-overview-heading">Группы</div>
    <div class="groups-overview-list">
      ${summaries.map((summary) => `
        <div class="group-overview-item">
          <span class="group-overview-name" title="${escapeHtml(summary.bikeName)}">${escapeHtml(summary.bikeName)}</span>
          <span class="group-overview-meta">${formatRouteCountLabel(summary.count)} · ${formatDistanceKm(summary.distanceKm)} км</span>
          ${getVisibilityButtonMarkup("group-overview-toggle", `Скрыть группу ${summary.bikeName}`)}
        </div>
      `).join("")}
    </div>
  `;

  elements.groupsOverview.querySelectorAll(".group-overview-toggle").forEach((button, index) => {
    const bikeName = summaries[index]?.bikeName || "";
    button.dataset.bikeName = bikeName;
    button.addEventListener("click", () => {
      const shouldShow = button.getAttribute("aria-pressed") !== "true";
      toggleBikeGroup(bikeName, shouldShow);
    });
  });
}

function positionLayerMenu(menu, button) {
  const buttonRect = button.getBoundingClientRect();
  const menuWidth = menu.offsetWidth || (menu.classList.contains("route-menu") ? 440 : 250);
  const gap = 8;
  const menuHeight = menu.offsetHeight || 320;

  const preferredLeft = buttonRect.right + gap;
  const fallbackLeft = buttonRect.right - menuWidth;
  const left = preferredLeft + menuWidth <= window.innerWidth - gap
    ? preferredLeft
    : Math.max(gap, Math.min(window.innerWidth - menuWidth - gap, fallbackLeft));
  const preferredTop = menu.classList.contains("route-menu")
    ? buttonRect.top - 8
    : buttonRect.bottom + gap;
  const fallbackTop = buttonRect.top - menuHeight - gap;
  const top = preferredTop + menuHeight > window.innerHeight - gap
    ? Math.max(gap, fallbackTop)
    : preferredTop;

  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function refreshEmptyState() {
  const count = state.routes.size;
  elements.routeCount.textContent = count;
  elements.emptyState.classList.toggle("hidden", count > 0);
  refreshTotalDistance();
}

function refreshTotalDistance() {
  const totals = Array.from(state.routes.values()).reduce((sum, item) => {
    const rideSeconds = parseClockDuration(item.route.rideTime) || Number(item.movingSeconds) || 0;
    const totalSeconds = parseClockDuration(item.route.totalTime) || Number(item.totalSeconds) || 0;

    return {
      distanceKm: sum.distanceKm + (Number(item.distanceKm) || 0),
      rideSeconds: sum.rideSeconds + rideSeconds,
      totalSeconds: sum.totalSeconds + totalSeconds
    };
  }, {
    distanceKm: 0,
    rideSeconds: 0,
    totalSeconds: 0
  });

  elements.totalDistance.textContent = formatDistanceKm(totals.distanceKm);
  elements.totalRideTime.textContent = formatTotalClockDuration(totals.rideSeconds);
  elements.totalTime.textContent = formatTotalClockDuration(totals.totalSeconds);
}

async function addRouteToMap(route, shouldFit = false) {
  route = normalizeRouteStyle(route);
  const geojson = await loadRouteGeometry(route);
  const distanceKm = getGeoJsonDistanceKm(geojson);
  const stats = {
    pointCount: getGeoJsonPointCount(geojson),
    distanceKm,
    ...getGeoJsonTimeStats(geojson, distanceKm)
  };

  const handleRouteMouseOver = () => setHoveredRoute(route.id);
  const handleRouteMouseOut = () => setHoveredRoute("");

  const layer = L.geoJSON(geojson, {
    renderer: state.routeRenderer,
    style: () => getRouteStyle(route),
    pointToLayer: (feature, latlng) => L.circleMarker(latlng, {
      radius: Math.max(4, route.weight + 1),
      fillColor: route.color,
      fillOpacity: 0.85,
      color: "#ffffff",
      weight: 2
    }),
    onEachFeature: (feature, leafletLayer) => {
      const name = feature.properties?.name || route.originalName;
      if (name) {
        leafletLayer.bindPopup(escapeHtml(name));
      }

      leafletLayer.on({
        mouseover: handleRouteMouseOver,
        mouseout: handleRouteMouseOut
      });
    }
  }).addTo(state.map);

  const hitboxLayer = L.geoJSON(geojson, {
    renderer: state.routeRenderer,
    style: getRouteHitboxStyle,
    pointToLayer: (feature, latlng) => L.circleMarker(latlng, {
      radius: Math.max(12, ROUTE_HITBOX_WEIGHT / 2),
      opacity: 0,
      fillOpacity: 0,
      interactive: true
    }),
    onEachFeature: (feature, leafletLayer) => {
      leafletLayer.on({
        mouseover: handleRouteMouseOver,
        mouseout: handleRouteMouseOut
      });
    }
  }).addTo(state.map);

  updateGlobalBounds(layer);
  state.routes.set(route.id, {
    route,
    layer,
    hitboxLayer,
    distanceKm: stats.distanceKm,
    movingSeconds: stats.movingSeconds,
    totalSeconds: stats.totalSeconds
  });
  insertLayerCardSorted(buildLayerCard(route, stats));
  refreshEmptyState();

  if (shouldFit) {
    fitAllRoutes();
  }
}

function getRoutePayload(route) {
  return {
    color: route.color,
    weight: route.weight,
    originalName: route.originalName,
    routeDate: route.routeDate,
    bike: route.bike,
    rideTime: route.rideTime,
    totalTime: route.totalTime,
    averageSpeed: route.averageSpeed
  };
}

async function sendRoutePatch(route, keepalive = false) {
  const response = await fetch(userApiUrl(`/api/routes/${encodeURIComponent(route.id)}`), {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    keepalive,
    body: JSON.stringify(getRoutePayload(route))
  });

  if (!response.ok) {
    throw new Error("Не удалось сохранить слой.");
  }

  const data = await response.json().catch(() => ({}));
  return data.route || null;
}

function persistRoute(route, delay = 220) {
  clearTimeout(state.styleSaveTimers.get(route.id));

  if (delay <= 0) {
    state.styleSaveTimers.delete(route.id);
    sendRoutePatch(route, true).catch(() => {
      setStatus("Изменения применены на карте, но не сохранились на сервере.", true);
    });
    return;
  }

  const timer = setTimeout(async () => {
    try {
      await sendRoutePatch(route);
    } catch {
      setStatus("Изменения применены на карте, но не сохранились на сервере.", true);
    } finally {
      state.styleSaveTimers.delete(route.id);
    }
  }, 220);

  state.styleSaveTimers.set(route.id, timer);
}

async function deleteRoute(id) {
  const item = state.routes.get(id);
  if (!item) {
    return;
  }

  const confirmed = window.confirm(`Удалить слой "${item.route.originalName}" и файл из папки?`);
  if (!confirmed) {
    return;
  }

  try {
    const response = await fetch(userApiUrl(`/api/routes/${encodeURIComponent(id)}`), { method: "DELETE" });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || "Не удалось удалить слой.");
    }

    state.map.removeLayer(item.layer);
    if (item.hitboxLayer) {
      state.map.removeLayer(item.hitboxLayer);
    }
    state.routes.delete(id);
    if (state.selectedRouteId === id) {
      state.selectedRouteId = "";
    }
    clearTimeout(state.styleSaveTimers.get(id));
    state.styleSaveTimers.delete(id);
    document.querySelector(`[data-route-id="${CSS.escape(id)}"]`)?.remove();
    sortLayerCards();
    recomputeBounds();
    refreshEmptyState();
    setStatus("Слой удалён.");
  } catch (error) {
    setStatus(error.message, true);
  }
}

function recomputeBounds() {
  state.bounds = null;
  state.routes.forEach(({ layer }) => updateGlobalBounds(layer));
}

function clearRoutes() {
  state.styleSaveTimers.forEach((timer) => clearTimeout(timer));
  state.styleSaveTimers.clear();
  state.routes.forEach((item) => {
    state.map.removeLayer(item.layer);
    if (item.hitboxLayer) {
      state.map.removeLayer(item.hitboxLayer);
    }
  });
  state.routes.clear();
  state.bounds = null;
  state.selectedRouteId = "";
  state.hoveredRouteId = "";
  elements.layersList.innerHTML = "";
  if (elements.groupsOverview) {
    elements.groupsOverview.hidden = true;
    elements.groupsOverview.innerHTML = "";
  }
  refreshEmptyState();
}

async function fetchRoutes() {
  const response = await fetch(userApiUrl("/api/routes"));
  if (!response.ok) {
    throw new Error("Не удалось получить список маршрутов.");
  }

  const data = await response.json();
  return Array.isArray(data.routes) ? data.routes : [];
}

async function loadSavedRoutes() {
  const routes = (await fetchRoutes()).sort((left, right) => {
    return normalizeRouteDate(right.routeDate, right.originalName)
      .localeCompare(normalizeRouteDate(left.routeDate, left.originalName));
  });

  for (const route of routes) {
    try {
      await addRouteToMap(route);
    } catch (error) {
      setStatus(error.message, true);
    }
  }

  if (routes.length) {
    fitAllRoutes();
    setStatus(`Загружено слоёв: ${routes.length}.`);
  } else {
    refreshEmptyState();
  }
}

async function uploadFiles(files) {
  const routeFiles = Array.from(files || []).filter((file) => {
    const name = file.name.toLowerCase();
    return name.endsWith(".gpx") || name.endsWith(".geojson") || name.endsWith(".json");
  });

  if (!routeFiles.length) {
    setStatus("Выберите или перетащите GPX / GeoJSON файл.", true);
    return;
  }

  elements.routeFile.disabled = true;
  setStatus(routeFiles.length === 1 ? "Загружаю маршрут..." : `Загружаю маршрутов: ${routeFiles.length}...`);

  try {
    let uploadedCount = 0;

    for (const file of routeFiles) {
      const formData = new FormData();
      formData.append("file", file);

      const response = await fetch(userApiUrl("/api/routes"), {
        method: "POST",
        body: formData
      });
      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(data.error || `Не удалось загрузить файл: ${file.name}`);
      }

      await addRouteToMap(normalizeRouteStyle(data.route, true), true);
      uploadedCount += 1;
    }

    elements.uploadForm.reset();
    setFileNameHint("или выберите GPX / GeoJSON");
    setStatus(uploadedCount === 1 ? "Маршрут загружен и сохранён." : `Маршруты загружены и сохранены: ${uploadedCount}.`);
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    elements.routeFile.disabled = false;
    elements.fileDrop.classList.remove("is-dragging");
  }
}

function bindEvents() {
  elements.routeFile.addEventListener("change", () => {
    const files = Array.from(elements.routeFile.files);
    setFileNameHint(files.length > 1 ? `Выбрано файлов: ${files.length}` : files[0]?.name || "или выберите GPX / GeoJSON");
    uploadFiles(files);
  });

  elements.uploadForm.addEventListener("submit", (event) => event.preventDefault());
  elements.fileDrop.addEventListener("dragover", (event) => {
    event.preventDefault();
    elements.fileDrop.classList.add("is-dragging");
  });
  elements.fileDrop.addEventListener("dragleave", () => {
    elements.fileDrop.classList.remove("is-dragging");
  });
  elements.fileDrop.addEventListener("drop", (event) => {
    event.preventDefault();
    elements.fileDrop.classList.remove("is-dragging");
    setFileNameHint(event.dataTransfer.files.length > 1
      ? `Выбрано файлов: ${event.dataTransfer.files.length}`
      : event.dataTransfer.files[0]?.name || "или выберите GPX / GeoJSON");
    uploadFiles(event.dataTransfer.files);
  });
  elements.fitAllButton.addEventListener("click", fitAllRoutes);
  elements.baseLayerSelect.addEventListener("change", () => {
    setBaseLayer(elements.baseLayerSelect.value);
  });
  elements.userMenuButton.addEventListener("click", (event) => {
    event.stopPropagation();
    toggleUserMenu();
  });
  elements.userMenu.addEventListener("click", (event) => event.stopPropagation());
  elements.userList.addEventListener("click", async (event) => {
    const button = event.target.closest(".user-menu-item");
    if (!button) {
      return;
    }

    try {
      await switchUser(button.dataset.userId);
    } catch (error) {
      setStatus(error.message, true);
    }
  });
  elements.createUserButton.addEventListener("click", async () => {
    try {
      await createUser();
    } catch (error) {
      setStatus(error.message, true);
    }
  });
  elements.renameUserButton.addEventListener("click", async () => {
    try {
      await renameCurrentUser();
    } catch (error) {
      setStatus(error.message, true);
    }
  });

  document.addEventListener("click", (event) => {
    if (!event.target.closest(".user-menu-wrap")) {
      closeUserMenu();
    }

    if (!event.target.closest(".layer-card, .layer-menu")) {
      clearSelectedRoute();
    }
  });
}

window.addEventListener("DOMContentLoaded", async () => {
  initMap();

  try {
    await initUsers();
    bindEvents();
    await loadSavedRoutes();
  } catch (error) {
    setStatus(error.message, true);
  }

  [80, 240, 700].forEach((delay) => setTimeout(invalidateMapSize, delay));
});
