const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const http = require("node:http");
const path = require("node:path");

const PORT = Number(process.env.PORT || 3000);
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const STORAGE_DIR = path.join(ROOT, "storage");
const LEGACY_UPLOAD_DIR = path.join(STORAGE_DIR, "routes");
const LEGACY_META_PATH = path.join(STORAGE_DIR, "routes.json");
const USERS_DIR = path.join(STORAGE_DIR, "users");
const USERS_META_PATH = path.join(STORAGE_DIR, "users.json");
const TILE_CACHE_DIR = path.join(STORAGE_DIR, "tile-cache");
const LOG_DIR = path.join(STORAGE_DIR, "logs");
const LOG_PATH = path.join(LOG_DIR, "server.log");
const MAX_UPLOAD_SIZE = 50 * 1024 * 1024;
const DEFAULT_USER_ID = "default";
const DEFAULT_USER_NAME = "Default";

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".geojson": "application/geo+json; charset=utf-8",
  ".gpx": "application/gpx+xml; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon"
};

const DEFAULT_ROUTE_COLOR = "#ff3300";
const DEFAULT_ROUTE_WEIGHT = 2;
const DEFAULT_BIKE = "Twiter Gravel V1";

const TILE_SOURCES = {
  light: {
    fallbackColor: "#edf2ef",
    urls: [
      "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png",
      "https://tile.openstreetmap.org/{z}/{x}/{y}.png"
    ],
    attribution: "OpenStreetMap contributors, CARTO"
  },
  dark: {
    fallbackColor: "#111827",
    urls: [
      "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png"
    ],
    attribution: "OpenStreetMap contributors, CARTO"
  }
};

const TILE_SUBDOMAINS = ["a", "b", "c", "d"];
const tileFetches = new Map();

function getUserStorage(userId = DEFAULT_USER_ID) {
  const safeUserId = String(userId || DEFAULT_USER_ID).replace(/[^a-z0-9_-]/gi, "") || DEFAULT_USER_ID;
  const userRoot = path.join(USERS_DIR, safeUserId);

  return {
    id: safeUserId,
    root: userRoot,
    uploadDir: path.join(userRoot, "routes"),
    metaPath: path.join(userRoot, "routes.json")
  };
}

async function readUsers() {
  await ensureStorage();
  const raw = await fsp.readFile(USERS_META_PATH, "utf8");
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.length
      ? parsed
      : [{ id: DEFAULT_USER_ID, name: DEFAULT_USER_NAME }];
  } catch {
    return [{ id: DEFAULT_USER_ID, name: DEFAULT_USER_NAME }];
  }
}

async function writeUsers(users) {
  await fsp.writeFile(USERS_META_PATH, `${JSON.stringify(users, null, 2)}\n`, "utf8");
}

async function ensureUserStorage(userId = DEFAULT_USER_ID) {
  const storage = getUserStorage(userId);
  await fsp.mkdir(storage.uploadDir, { recursive: true });

  if (!await pathExists(storage.metaPath)) {
    await fsp.writeFile(storage.metaPath, "[]\n", "utf8");
  }

  return storage;
}

async function copyLegacyRoutesToDefaultUser() {
  const defaultStorage = await ensureUserStorage(DEFAULT_USER_ID);

  if (!await pathExists(LEGACY_META_PATH) || await pathExists(defaultStorage.metaPath) && (await fsp.readFile(defaultStorage.metaPath, "utf8")).trim() !== "[]") {
    return;
  }

  await fsp.copyFile(LEGACY_META_PATH, defaultStorage.metaPath);

  if (!await pathExists(LEGACY_UPLOAD_DIR)) {
    return;
  }

  const files = await fsp.readdir(LEGACY_UPLOAD_DIR).catch(() => []);
  await Promise.all(files.map(async (fileName) => {
    const sourcePath = path.join(LEGACY_UPLOAD_DIR, fileName);
    const targetPath = path.join(defaultStorage.uploadDir, fileName);
    const stat = await fsp.stat(sourcePath).catch(() => null);

    if (stat?.isFile() && !await pathExists(targetPath)) {
      await fsp.copyFile(sourcePath, targetPath);
    }
  }));
}

async function ensureStorage() {
  await fsp.mkdir(STORAGE_DIR, { recursive: true });
  await fsp.mkdir(USERS_DIR, { recursive: true });
  await fsp.mkdir(TILE_CACHE_DIR, { recursive: true });
  await fsp.mkdir(LOG_DIR, { recursive: true });

  if (!await pathExists(USERS_META_PATH)) {
    await writeUsers([{ id: DEFAULT_USER_ID, name: DEFAULT_USER_NAME }]);
  }

  await ensureUserStorage(DEFAULT_USER_ID);
  await copyLegacyRoutesToDefaultUser();
}

async function getRequestUser(url) {
  const users = await readUsers();
  const requestedUserId = url.searchParams.get("user") || DEFAULT_USER_ID;
  return users.find((user) => user.id === requestedUserId) || users[0] || { id: DEFAULT_USER_ID, name: DEFAULT_USER_NAME };
}

async function readRoutes(userId = DEFAULT_USER_ID) {
  const storage = await ensureUserStorage(userId);
  const raw = await fsp.readFile(storage.metaPath, "utf8");
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function writeRoutes(routes, userId = DEFAULT_USER_ID) {
  const storage = await ensureUserStorage(userId);
  await fsp.writeFile(storage.metaPath, `${JSON.stringify(routes, null, 2)}\n`, "utf8");
}

function sanitizeLogMeta(meta = {}) {
  return Object.fromEntries(Object.entries(meta).filter(([, value]) => {
    return typeof value !== "undefined" && value !== null && value !== "";
  }));
}

function appendLog(level, message, meta = {}) {
  const entry = {
    time: new Date().toISOString(),
    level,
    message,
    ...sanitizeLogMeta(meta)
  };
  const line = `${JSON.stringify(entry)}\n`;

  fsp.mkdir(LOG_DIR, { recursive: true })
    .then(() => fsp.appendFile(LOG_PATH, line, "utf8"))
    .catch((error) => {
      console.error("Log write failed:", error.message);
    });
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body)
  });
  res.end(body);
}

function sendText(res, status, body) {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(body);
}

function safeBaseName(fileName) {
  const parsed = path.parse(fileName || "route");
  const base = parsed.name
    .normalize("NFKD")
    .replace(/[^\w.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return base || "route";
}

function sanitizeStorageNamePart(value) {
  const name = String(value || "Маршрут")
    .normalize("NFKC")
    .replace(/[<>:"/\\|?*\x00-\x1F]+/g, "-")
    .replace(/\s+/g, " ")
    .replace(/^[.\s-]+|[.\s-]+$/g, "")
    .slice(0, 120);

  return name || "Маршрут";
}

function getTodayIsoDate() {
  const today = new Date();
  const year = today.getFullYear();
  const month = String(today.getMonth() + 1).padStart(2, "0");
  const day = String(today.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function extractRouteDate(fileName) {
  const name = fileName || "";
  const isoMatch = name.match(/(20\d{2})[-_./](\d{2})[-_./](\d{2})/);
  if (isoMatch) {
    return `${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}`;
  }

  const ruMatch = name.match(/(\d{1,2})[-_./\s](\d{1,2})[-_./\s](20\d{2})/);
  if (ruMatch) {
    return `${ruMatch[3]}-${ruMatch[2].padStart(2, "0")}-${ruMatch[1].padStart(2, "0")}`;
  }

  return getTodayIsoDate();
}

function formatRouteDateForFileName(routeDate) {
  const date = typeof routeDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(routeDate)
    ? routeDate
    : getTodayIsoDate();

  return date.replaceAll("-", "_");
}

async function pathExists(targetPath) {
  try {
    await fsp.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function getAvailableRouteFileName(route, storedExt, currentFileName = "", userId = DEFAULT_USER_ID) {
  if (storedExt !== ".gpx") {
    return `${Date.now()}-${safeBaseName(route.originalName || "route")}-${route.id.slice(0, 8)}${storedExt}`;
  }

  const storage = await ensureUserStorage(userId);
  const routeDate = route.routeDate || extractRouteDate(route.originalName || route.fileName);
  const layerName = sanitizeStorageNamePart(path.parse(route.originalName || "Маршрут").name);
  const baseName = `${formatRouteDateForFileName(routeDate)}_${layerName}`;
  let candidate = `${baseName}${storedExt}`;
  let suffix = 2;

  while (candidate !== currentFileName && await pathExists(path.join(storage.uploadDir, candidate))) {
    candidate = `${baseName}_${suffix}${storedExt}`;
    suffix += 1;
  }

  return candidate;
}

async function findExistingRouteFileName(route, userId = DEFAULT_USER_ID) {
  if (!route.fileName) {
    return "";
  }

  const storage = await ensureUserStorage(userId);

  if (await pathExists(path.join(storage.uploadDir, route.fileName))) {
    return route.fileName;
  }

  const routeDate = route.routeDate || extractRouteDate(route.originalName || route.fileName);
  const datePrefix = `${formatRouteDateForFileName(routeDate)}_`;
  let files = [];

  try {
    files = await fsp.readdir(storage.uploadDir);
  } catch {
    return "";
  }

  const matches = files.filter((fileName) => {
    return fileName !== route.fileName
      && fileName.startsWith(datePrefix)
      && path.extname(fileName).toLowerCase() === ".gpx";
  });

  return matches.length === 1 ? matches[0] : "";
}

async function renameGpxToStoragePattern(route, { strict = false, userId = DEFAULT_USER_ID } = {}) {
  if (route.type !== "gpx" || !route.fileName) {
    return false;
  }

  const storage = await ensureUserStorage(userId);
  const existingFileName = await findExistingRouteFileName(route, userId);
  if (!existingFileName) {
    return false;
  }

  const nextFileName = await getAvailableRouteFileName(route, ".gpx", existingFileName, userId);
  if (nextFileName === existingFileName) {
    const changed = route.fileName !== existingFileName;
    route.fileName = existingFileName;
    return changed;
  }

  if (nextFileName === route.fileName) {
    if (existingFileName !== route.fileName) {
      route.fileName = existingFileName;
      return true;
    }

    return false;
  }

  const currentPath = path.join(storage.uploadDir, existingFileName);
  const nextPath = path.join(storage.uploadDir, nextFileName);

  try {
    await fsp.rename(currentPath, nextPath);
    route.fileName = nextFileName;
    return true;
  } catch (error) {
    if (strict) {
      throw error;
    }

    return false;
  }
}

async function normalizeStoredGpxFileNames() {
  const users = await readUsers();

  for (const user of users) {
    const routes = await readRoutes(user.id);
    let changed = false;

    for (const route of routes) {
      changed = await renameGpxToStoragePattern(route, { userId: user.id }) || changed;
    }

    if (changed) {
      await writeRoutes(routes, user.id);
    }
  }
}

function routePublicData(route, userId = DEFAULT_USER_ID) {
  const weight = Number(route.weight);
  const distanceKm = Number(route.distanceKm);
  const ascentM = Number(route.ascentM);
  const descentM = Number(route.descentM);
  const routeDate = route.routeDate || extractRouteDate(route.originalName || route.fileName);

  return {
    id: route.id,
    originalName: route.originalName || routeDate,
    fileName: route.fileName,
    type: route.type,
    routeDate,
    description: route.description || "",
    bike: route.bike || DEFAULT_BIKE,
    rideTime: route.rideTime || "",
    totalTime: route.totalTime || "",
    averageSpeed: route.averageSpeed || "",
    distanceKm: Number.isFinite(distanceKm) && distanceKm > 0 ? distanceKm : undefined,
    ascentM: Number.isFinite(ascentM) && ascentM > 0 ? ascentM : undefined,
    descentM: Number.isFinite(descentM) && descentM > 0 ? descentM : undefined,
    color: route.color || DEFAULT_ROUTE_COLOR,
    weight: Number.isFinite(weight) ? weight : DEFAULT_ROUTE_WEIGHT,
    uploadedAt: route.uploadedAt,
    url: `/storage/users/${encodeURIComponent(userId)}/routes/${encodeURIComponent(route.fileName)}`
  };
}

function isInsideDirectory(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function getTileCachePath(style, z, x, y) {
  return path.join(TILE_CACHE_DIR, style, String(z), String(x), `${y}.png`);
}

function buildTileUrl(template, z, x, y) {
  const subdomain = TILE_SUBDOMAINS[Math.abs(x + y + z) % TILE_SUBDOMAINS.length];
  return template
    .replace("{s}", subdomain)
    .replace("{z}", String(z))
    .replace("{x}", String(x))
    .replace("{y}", String(y));
}

function isValidTile(style, z, x, y) {
  const maxIndex = 2 ** z;
  return Boolean(TILE_SOURCES[style])
    && Number.isInteger(z)
    && Number.isInteger(x)
    && Number.isInteger(y)
    && z >= 0
    && z <= 20
    && x >= 0
    && y >= 0
    && x < maxIndex
    && y < maxIndex;
}

function sendTile(res, status, body, contentType = "image/png", cacheSeconds = 86400) {
  res.writeHead(status, {
    "Content-Type": contentType,
    "Cache-Control": `public, max-age=${cacheSeconds}`,
    "Content-Length": Buffer.byteLength(body)
  });
  res.end(body);
}

function fallbackTile(style, z, x, y) {
  const source = TILE_SOURCES[style] || TILE_SOURCES.light;
  const isDark = style === "dark";
  const grid = isDark ? "#233044" : "#d7ded9";
  const text = isDark ? "#6b7280" : "#94a39a";
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256">
    <rect width="256" height="256" fill="${source.fallbackColor}"/>
    <path d="M0 64H256M0 128H256M0 192H256M64 0V256M128 0V256M192 0V256" stroke="${grid}" stroke-width="1"/>
    <text x="128" y="132" text-anchor="middle" font-family="Arial, sans-serif" font-size="11" fill="${text}">${z}/${x}/${y}</text>
  </svg>`;
  return {
    body: Buffer.from(svg),
    contentType: "image/svg+xml; charset=utf-8"
  };
}

async function fetchTileFromSource(style, z, x, y) {
  const source = TILE_SOURCES[style];

  for (const template of source.urls) {
    const upstreamUrl = buildTileUrl(template, z, x, y);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 9000);

    try {
      const response = await fetch(upstreamUrl, {
        signal: controller.signal,
        headers: {
          "User-Agent": "MapRoutesLocal/1.0",
          "Accept": "image/png,image/*;q=0.8,*/*;q=0.5"
        }
      });

      if (response.ok) {
        return {
          body: Buffer.from(await response.arrayBuffer()),
          contentType: response.headers.get("content-type") || "image/png"
        };
      }
    } catch {
      // Try the next source before falling back to a generated placeholder tile.
    } finally {
      clearTimeout(timeout);
    }
  }

  return fallbackTile(style, z, x, y);
}

async function handleTileRequest(res, style, zRaw, xRaw, yRaw) {
  const z = Number(zRaw);
  const x = Number(xRaw);
  const y = Number(yRaw);

  if (!isValidTile(style, z, x, y)) {
    sendText(res, 404, "Tile not found");
    return;
  }

  const cachePath = getTileCachePath(style, z, x, y);
  const cacheKey = `${style}/${z}/${x}/${y}`;

  try {
    const cached = await fsp.readFile(cachePath);
    sendTile(res, 200, cached, "image/png", 60 * 60 * 24 * 30);
    return;
  } catch {
    // Cache miss, fetch below.
  }

  if (!tileFetches.has(cacheKey)) {
    tileFetches.set(cacheKey, (async () => {
      const tile = await fetchTileFromSource(style, z, x, y);
      if (tile.contentType.startsWith("image/png")) {
        await fsp.mkdir(path.dirname(cachePath), { recursive: true });
        await fsp.writeFile(cachePath, tile.body);
      }
      return tile;
    })().finally(() => tileFetches.delete(cacheKey)));
  }

  const tile = await tileFetches.get(cacheKey);
  sendTile(res, 200, tile.body, tile.contentType, 60 * 60 * 24 * 30);
}

function collectRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;

    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_UPLOAD_SIZE) {
        reject(new Error("Файл слишком большой. Максимум 50 МБ."));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function parseMultipart(body, boundary) {
  const boundaryBuffer = Buffer.from(`--${boundary}`);
  const headerSeparator = Buffer.from("\r\n\r\n");
  const parts = [];
  let cursor = body.indexOf(boundaryBuffer);

  while (cursor !== -1) {
    cursor += boundaryBuffer.length;

    if (body[cursor] === 45 && body[cursor + 1] === 45) {
      break;
    }

    if (body[cursor] === 13 && body[cursor + 1] === 10) {
      cursor += 2;
    }

    const headerEnd = body.indexOf(headerSeparator, cursor);
    if (headerEnd === -1) {
      break;
    }

    const headers = body.slice(cursor, headerEnd).toString("utf8");
    const contentStart = headerEnd + headerSeparator.length;
    const nextBoundary = body.indexOf(boundaryBuffer, contentStart);
    if (nextBoundary === -1) {
      break;
    }

    let contentEnd = nextBoundary;
    if (body[contentEnd - 2] === 13 && body[contentEnd - 1] === 10) {
      contentEnd -= 2;
    }

    const nameMatch = headers.match(/name="([^"]+)"/);
    const fileNameMatch = headers.match(/filename="([^"]*)"/);

    parts.push({
      name: nameMatch ? nameMatch[1] : "",
      fileName: fileNameMatch ? fileNameMatch[1] : "",
      headers,
      content: body.slice(contentStart, contentEnd)
    });

    cursor = nextBoundary;
  }

  return parts;
}

const FIT_EPOCH_MS = Date.UTC(1989, 11, 31);

const FIT_BASE_TYPE_SIZES = {
  0x00: 1,
  0x01: 1,
  0x02: 1,
  0x83: 2,
  0x84: 2,
  0x85: 4,
  0x86: 4,
  0x07: 1,
  0x88: 4,
  0x89: 8,
  0x0a: 1,
  0x8b: 2,
  0x8c: 4,
  0x0d: 1,
  0x8e: 8,
  0x8f: 8,
  0x90: 8
};

const FIT_SPORTS = {
  0: "generic",
  1: "running",
  2: "cycling",
  3: "transition",
  4: "fitness_equipment",
  5: "swimming",
  6: "basketball",
  7: "soccer",
  8: "tennis",
  9: "american_football",
  10: "training",
  11: "walking",
  12: "cross_country_skiing",
  13: "alpine_skiing",
  14: "snowboarding",
  15: "rowing",
  16: "mountaineering",
  17: "hiking",
  18: "multisport",
  19: "paddling",
  21: "elliptical",
  23: "all"
};

const FIT_RECORD_FIELDS = {
  0: { key: "positionLat", label: "position_lat", transform: semicirclesToDegrees },
  1: { key: "positionLong", label: "position_long", transform: semicirclesToDegrees },
  2: { key: "altitude", label: "altitude", transform: (value) => value / 5 - 500 },
  3: { key: "heartRate", label: "heart_rate" },
  4: { key: "cadence", label: "cadence" },
  5: { key: "distance", label: "distance", transform: (value) => value / 100 },
  6: { key: "speed", label: "speed", transform: (value) => value / 1000 },
  13: { key: "temperature", label: "temperature" },
  73: { key: "enhancedAltitude", label: "enhanced_altitude", transform: (value) => value / 5 - 500 },
  78: { key: "enhancedSpeed", label: "enhanced_speed", transform: (value) => value / 1000 },
  253: { key: "timestamp", label: "timestamp", transform: fitTimestampToIso }
};

const FIT_SESSION_FIELDS = {
  2: { key: "startTime", label: "start_time", transform: fitTimestampToIso },
  5: { key: "sport", label: "sport", transform: (value) => FIT_SPORTS[value] || String(value) },
  6: { key: "subSport", label: "sub_sport" },
  7: { key: "totalElapsedTime", label: "total_elapsed_time", transform: (value) => value / 1000 },
  8: { key: "totalTimerTime", label: "total_timer_time", transform: (value) => value / 1000 },
  9: { key: "totalDistance", label: "total_distance", transform: (value) => value / 100 },
  14: { key: "totalCalories", label: "total_calories" },
  16: { key: "avgSpeed", label: "avg_speed", transform: (value) => value / 1000 },
  17: { key: "maxSpeed", label: "max_speed", transform: (value) => value / 1000 },
  18: { key: "avgHeartRate", label: "avg_heart_rate" },
  19: { key: "maxHeartRate", label: "max_heart_rate" },
  20: { key: "avgCadence", label: "avg_cadence" },
  21: { key: "maxCadence", label: "max_cadence" },
  22: { key: "totalAscent", label: "total_ascent" },
  23: { key: "totalDescent", label: "total_descent" },
  124: { key: "enhancedAvgSpeed", label: "enhanced_avg_speed", transform: (value) => value / 1000 },
  125: { key: "enhancedMaxSpeed", label: "enhanced_max_speed", transform: (value) => value / 1000 }
};

const FIT_LAP_FIELDS = {
  2: { key: "startTime", label: "start_time", transform: fitTimestampToIso },
  5: { key: "startPositionLat", label: "start_position_lat", transform: semicirclesToDegrees },
  6: { key: "startPositionLong", label: "start_position_long", transform: semicirclesToDegrees },
  7: { key: "totalElapsedTime", label: "total_elapsed_time", transform: (value) => value / 1000 },
  8: { key: "totalTimerTime", label: "total_timer_time", transform: (value) => value / 1000 },
  9: { key: "totalDistance", label: "total_distance", transform: (value) => value / 100 },
  11: { key: "totalCalories", label: "total_calories" },
  13: { key: "avgSpeed", label: "avg_speed", transform: (value) => value / 1000 },
  14: { key: "maxSpeed", label: "max_speed", transform: (value) => value / 1000 },
  15: { key: "avgHeartRate", label: "avg_heart_rate" },
  16: { key: "maxHeartRate", label: "max_heart_rate" },
  17: { key: "avgCadence", label: "avg_cadence" },
  18: { key: "maxCadence", label: "max_cadence" },
  21: { key: "totalAscent", label: "total_ascent" },
  22: { key: "totalDescent", label: "total_descent" },
  25: { key: "sport", label: "sport", transform: (value) => FIT_SPORTS[value] || String(value) },
  110: { key: "enhancedAvgSpeed", label: "enhanced_avg_speed", transform: (value) => value / 1000 },
  111: { key: "enhancedMaxSpeed", label: "enhanced_max_speed", transform: (value) => value / 1000 }
};

function semicirclesToDegrees(value) {
  return value * (180 / 2147483648);
}

function fitTimestampToIso(value) {
  if (!Number.isFinite(value)) {
    return "";
  }

  return new Date(FIT_EPOCH_MS + value * 1000).toISOString();
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

function formatFitNumber(value, digits = 1) {
  return Number.isFinite(value) ? value.toFixed(digits) : "";
}

function readFitValue(buffer, offset, size, baseType, littleEndian) {
  const normalizedType = baseType & 0x9f;
  const baseSize = FIT_BASE_TYPE_SIZES[normalizedType] || 1;
  const count = Math.max(1, Math.floor(size / baseSize));
  const values = [];

  for (let index = 0; index < count; index += 1) {
    const cursor = offset + index * baseSize;
    let value;

    switch (normalizedType) {
      case 0x00:
      case 0x02:
      case 0x0a:
      case 0x0d:
        value = buffer.readUInt8(cursor);
        break;
      case 0x01:
        value = buffer.readInt8(cursor);
        break;
      case 0x83:
        value = littleEndian ? buffer.readInt16LE(cursor) : buffer.readInt16BE(cursor);
        break;
      case 0x84:
      case 0x8b:
        value = littleEndian ? buffer.readUInt16LE(cursor) : buffer.readUInt16BE(cursor);
        break;
      case 0x85:
        value = littleEndian ? buffer.readInt32LE(cursor) : buffer.readInt32BE(cursor);
        break;
      case 0x86:
      case 0x8c:
        value = littleEndian ? buffer.readUInt32LE(cursor) : buffer.readUInt32BE(cursor);
        break;
      case 0x88:
        value = littleEndian ? buffer.readFloatLE(cursor) : buffer.readFloatBE(cursor);
        break;
      case 0x89:
        value = littleEndian ? buffer.readDoubleLE(cursor) : buffer.readDoubleBE(cursor);
        break;
      case 0x07:
        return buffer
          .slice(offset, offset + size)
          .toString("utf8")
          .replace(/\0+$/, "");
      default:
        value = buffer.readUInt8(cursor);
    }

    values.push(value);
  }

  return values.length === 1 ? values[0] : values;
}

function isFitInvalidValue(value, baseType) {
  const normalizedType = baseType & 0x9f;
  if (Array.isArray(value)) {
    return value.every((item) => isFitInvalidValue(item, baseType));
  }

  return (normalizedType === 0x00 || normalizedType === 0x02 || normalizedType === 0x0d) && value === 0xff
    || normalizedType === 0x01 && value === 0x7f
    || normalizedType === 0x83 && value === 0x7fff
    || normalizedType === 0x84 && value === 0xffff
    || normalizedType === 0x85 && value === 0x7fffffff
    || normalizedType === 0x86 && value === 0xffffffff
    || normalizedType === 0x0a && value === 0
    || normalizedType === 0x8b && value === 0
    || normalizedType === 0x8c && value === 0;
}

function decodeFitField(decoded, availableFields, field, fieldMap) {
  const config = fieldMap[field.number];
  if (!config || isFitInvalidValue(field.value, field.baseType)) {
    return;
  }

  const rawValue = Array.isArray(field.value) ? field.value[0] : field.value;
  const value = config.transform ? config.transform(rawValue) : rawValue;
  if (value === "" || value === null || typeof value === "undefined" || Number.isNaN(value)) {
    return;
  }

  decoded[config.key] = value;
  availableFields.add(config.label);
}

function parseFitFile(buffer) {
  const headerSize = buffer.readUInt8(0);
  if (headerSize < 12 || buffer.slice(8, 12).toString("ascii") !== ".FIT") {
    throw new Error("FIT файл поврежден или имеет неподдерживаемый формат.");
  }

  const dataSize = buffer.readUInt32LE(4);
  const dataEnd = headerSize + dataSize;
  const definitions = new Map();
  const records = [];
  const sessions = [];
  const laps = [];
  const availableRecordFields = new Set();
  const availableSessionFields = new Set();
  const availableLapFields = new Set();
  const messageCounts = {};
  let offset = headerSize;
  let lastTimestamp = 0;

  while (offset < dataEnd) {
    const recordHeader = buffer.readUInt8(offset);
    offset += 1;

    if (recordHeader & 0x80) {
      const localType = (recordHeader >> 5) & 0x03;
      const timeOffset = recordHeader & 0x1f;
      const definition = definitions.get(localType);
      if (!definition) {
        continue;
      }

      let timestamp = (lastTimestamp & ~0x1f) + timeOffset;
      if (timestamp <= lastTimestamp) {
        timestamp += 0x20;
      }
      lastTimestamp = timestamp;

      const message = readFitDataMessage(buffer, offset, definition);
      offset = message.offset;
      message.values.timestamp = fitTimestampToIso(timestamp);
      records.push(message.values);
      continue;
    }

    const localType = recordHeader & 0x0f;
    const hasDeveloperData = Boolean(recordHeader & 0x20);

    if (recordHeader & 0x40) {
      offset += 1;
      const littleEndian = buffer.readUInt8(offset) === 0;
      offset += 1;
      const globalMessageNumber = littleEndian ? buffer.readUInt16LE(offset) : buffer.readUInt16BE(offset);
      offset += 2;
      const fieldsCount = buffer.readUInt8(offset);
      offset += 1;
      const fields = [];

      for (let index = 0; index < fieldsCount; index += 1) {
        const number = buffer.readUInt8(offset);
        const size = buffer.readUInt8(offset + 1);
        const baseType = buffer.readUInt8(offset + 2);
        fields.push({ number, size, baseType });
        offset += 3;
      }

      const developerFields = [];
      if (hasDeveloperData) {
        const developerFieldsCount = buffer.readUInt8(offset);
        offset += 1;

        for (let index = 0; index < developerFieldsCount; index += 1) {
          developerFields.push({ size: buffer.readUInt8(offset + 1) });
          offset += 3;
        }
      }

      definitions.set(localType, { globalMessageNumber, fields, developerFields, littleEndian });
      continue;
    }

    const definition = definitions.get(localType);
    if (!definition) {
      continue;
    }

    const message = readFitDataMessage(buffer, offset, definition);
    offset = message.offset;
    messageCounts[definition.globalMessageNumber] = (messageCounts[definition.globalMessageNumber] || 0) + 1;

    if (definition.globalMessageNumber === 20) {
      records.push(message.values);
      if (message.values.timestamp) {
        lastTimestamp = Math.round((Date.parse(message.values.timestamp) - FIT_EPOCH_MS) / 1000);
      }
    } else if (definition.globalMessageNumber === 19) {
      laps.push(message.values);
    } else if (definition.globalMessageNumber === 18) {
      sessions.push(message.values);
    }
  }

  return { records, sessions, laps, availableRecordFields, availableSessionFields, availableLapFields, messageCounts };

  function readFitDataMessage(source, cursor, definition) {
    const values = {};

    for (const field of definition.fields) {
      const rawValue = readFitValue(source, cursor, field.size, field.baseType, definition.littleEndian);
      cursor += field.size;
      const decodedField = { ...field, value: rawValue };

      if (definition.globalMessageNumber === 20) {
        decodeFitField(values, availableRecordFields, decodedField, FIT_RECORD_FIELDS);
      } else if (definition.globalMessageNumber === 19) {
        decodeFitField(values, availableLapFields, decodedField, FIT_LAP_FIELDS);
      } else if (definition.globalMessageNumber === 18) {
        decodeFitField(values, availableSessionFields, decodedField, FIT_SESSION_FIELDS);
      }
    }

    for (const field of definition.developerFields) {
      cursor += field.size;
    }

    return { values, offset: cursor };
  }
}

function getFitRecordAltitude(record) {
  const enhancedAltitude = Number(record.enhancedAltitude);
  if (Number.isFinite(enhancedAltitude)) {
    return enhancedAltitude;
  }

  const altitude = Number(record.altitude);
  return Number.isFinite(altitude) ? altitude : null;
}

function computeFitElevationTotals(trackRecords) {
  let ascent = 0;
  let descent = 0;
  let previousAltitude = null;

  for (const record of trackRecords) {
    const altitude = getFitRecordAltitude(record);
    if (altitude === null) {
      continue;
    }

    if (previousAltitude !== null) {
      const delta = altitude - previousAltitude;
      if (delta > 0.3) {
        ascent += delta;
      } else if (delta < -0.3) {
        descent += Math.abs(delta);
      }
    }

    previousAltitude = altitude;
  }

  return {
    ascent: Math.round(ascent),
    descent: Math.round(descent)
  };
}

function aggregateFitLaps(laps = []) {
  return laps.reduce((totals, lap) => {
    totals.elapsedSeconds += Number(lap.totalElapsedTime) || 0;
    totals.timerSeconds += Number(lap.totalTimerTime) || 0;
    totals.distanceM += Number(lap.totalDistance) || 0;
    totals.totalAscent += Number(lap.totalAscent) || 0;
    totals.totalDescent += Number(lap.totalDescent) || 0;
    totals.totalCalories += Number(lap.totalCalories) || 0;
    totals.maxSpeed = Math.max(totals.maxSpeed, Number(lap.enhancedMaxSpeed) || Number(lap.maxSpeed) || 0);
    return totals;
  }, {
    elapsedSeconds: 0,
    timerSeconds: 0,
    distanceM: 0,
    totalAscent: 0,
    totalDescent: 0,
    totalCalories: 0,
    maxSpeed: 0
  });
}

function summarizeFitActivity(parsed) {
  const session = parsed.sessions[parsed.sessions.length - 1] || {};
  const lapTotals = aggregateFitLaps(parsed.laps);
  const trackRecords = parsed.records.filter((record) => {
    return Number.isFinite(record.positionLat)
      && Number.isFinite(record.positionLong)
      && Math.abs(record.positionLat) <= 90
      && Math.abs(record.positionLong) <= 180;
  });
  const elevationTotals = computeFitElevationTotals(trackRecords);
  const firstRecord = trackRecords[0] || parsed.records[0] || {};
  const lastRecord = trackRecords[trackRecords.length - 1] || parsed.records[parsed.records.length - 1] || {};
  const distanceM = Number(session.totalDistance) || lapTotals.distanceM || Number(lastRecord.distance) || 0;
  const timerSeconds = Number(session.totalTimerTime) || lapTotals.timerSeconds || 0;
  const elapsedSeconds = Number(session.totalElapsedTime) || lapTotals.elapsedSeconds || 0;
  const sessionAvgSpeed = Number(session.enhancedAvgSpeed) || Number(session.avgSpeed) || 0;
  const avgSpeed = sessionAvgSpeed || (distanceM > 0 && timerSeconds > 0 ? distanceM / timerSeconds : 0);
  const totalAscent = Number(session.totalAscent) || lapTotals.totalAscent || elevationTotals.ascent || 0;
  const totalDescent = Number(session.totalDescent) || lapTotals.totalDescent || elevationTotals.descent || 0;

  return {
    startTime: session.startTime || firstRecord.timestamp || "",
    sport: session.sport || "",
    subSport: session.subSport,
    elapsedSeconds,
    timerSeconds,
    distanceM,
    avgSpeed,
    maxSpeed: Number(session.enhancedMaxSpeed) || Number(session.maxSpeed) || lapTotals.maxSpeed || 0,
    avgHeartRate: Number(session.avgHeartRate) || 0,
    maxHeartRate: Number(session.maxHeartRate) || 0,
    avgCadence: Number(session.avgCadence) || 0,
    maxCadence: Number(session.maxCadence) || 0,
    totalAscent,
    totalDescent,
    totalCalories: Number(session.totalCalories) || lapTotals.totalCalories || 0,
    pointsCount: trackRecords.length,
    recordFields: Array.from(parsed.availableRecordFields).sort(),
    sessionFields: Array.from(parsed.availableSessionFields).sort(),
    lapFields: Array.from(parsed.availableLapFields).sort(),
    messageCounts: parsed.messageCounts
  };
}

function buildFitGeoJson(trackRecords, summary, originalName) {
  const coordinates = [];
  const times = [];
  const heartRates = [];
  const cadences = [];
  const distances = [];
  const speeds = [];
  const temperatures = [];

  for (const record of trackRecords) {
    const altitude = getFitRecordAltitude(record);
    const coordinate = [record.positionLong, record.positionLat];
    if (altitude !== null) {
      coordinate.push(Math.round(altitude * 10) / 10);
    }

    coordinates.push(coordinate);
    if (record.timestamp) times.push(record.timestamp);
    if (Number.isFinite(Number(record.heartRate))) heartRates.push(record.heartRate);
    if (Number.isFinite(Number(record.cadence))) cadences.push(record.cadence);
    if (Number.isFinite(Number(record.distance))) distances.push(record.distance);
    if (Number.isFinite(Number(record.enhancedSpeed || record.speed))) speeds.push(record.enhancedSpeed || record.speed);
    if (Number.isFinite(Number(record.temperature))) temperatures.push(record.temperature);
  }

  return {
    type: "FeatureCollection",
    features: [{
      type: "Feature",
      properties: {
        name: path.parse(originalName).name,
        times,
        heartRates,
        cadences,
        distances,
        speeds,
        temperatures,
        fitSummary: summary
      },
      geometry: {
        type: "LineString",
        coordinates
      }
    }]
  };
}

function formatFitSummary(summary) {
  const lines = ["FIT данные тренировки:"];

  if (summary.startTime) lines.push(`Старт: ${summary.startTime}`);
  if (summary.sport) lines.push(`Спорт: ${summary.sport}`);
  if (summary.distanceM) lines.push(`Дистанция: ${formatFitNumber(summary.distanceM / 1000)} км`);
  if (summary.timerSeconds) lines.push(`rH: ${formatClockDuration(summary.timerSeconds)}`);
  if (summary.elapsedSeconds) lines.push(`tH: ${formatClockDuration(summary.elapsedSeconds)}`);
  if (summary.avgSpeed) lines.push(`Средняя скорость: ${formatFitNumber(summary.avgSpeed * 3.6)} км/ч`);
  if (summary.maxSpeed) lines.push(`Макс. скорость: ${formatFitNumber(summary.maxSpeed * 3.6)} км/ч`);
  if (summary.avgHeartRate) lines.push(`Средний пульс: ${Math.round(summary.avgHeartRate)} bpm`);
  if (summary.maxHeartRate) lines.push(`Макс. пульс: ${Math.round(summary.maxHeartRate)} bpm`);
  if (summary.avgCadence) lines.push(`Средний каденс: ${Math.round(summary.avgCadence)} rpm`);
  if (summary.maxCadence) lines.push(`Макс. каденс: ${Math.round(summary.maxCadence)} rpm`);
  if (summary.totalAscent) lines.push(`Набор: ${Math.round(summary.totalAscent)} м`);
  if (summary.totalDescent) lines.push(`Сброс: ${Math.round(summary.totalDescent)} м`);
  if (summary.totalCalories) lines.push(`Калории: ${Math.round(summary.totalCalories)} kcal`);
  lines.push(`Точек трека: ${summary.pointsCount}`);
  if (summary.recordFields.length) lines.push(`Поля record: ${summary.recordFields.join(", ")}`);
  if (summary.sessionFields.length) lines.push(`Поля session: ${summary.sessionFields.join(", ")}`);
  if (summary.lapFields.length) lines.push(`Поля lap: ${summary.lapFields.join(", ")}`);

  return lines.join("\n").slice(0, 1000);
}

function parseFitActivity(buffer, originalName) {
  const parsed = parseFitFile(buffer);
  const trackRecords = parsed.records.filter((record) => {
    return Number.isFinite(record.positionLat)
      && Number.isFinite(record.positionLong)
      && Math.abs(record.positionLat) <= 90
      && Math.abs(record.positionLong) <= 180;
  });

  if (trackRecords.length < 2) {
    throw new Error("В FIT файле не найден трек с координатами.");
  }

  const summary = summarizeFitActivity(parsed);
  const geojson = buildFitGeoJson(trackRecords, summary, originalName);

  return { geojson, summary, description: formatFitSummary(summary) };
}

async function handleUpload(req, res, userId = DEFAULT_USER_ID) {
  const contentType = req.headers["content-type"] || "";
  const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/);

  if (!boundaryMatch) {
    sendJson(res, 400, { error: "Не найден multipart boundary." });
    return;
  }

  const body = await collectRequestBody(req);
  const parts = parseMultipart(body, boundaryMatch[1] || boundaryMatch[2]);
  const uploadedFile = parts.find((part) => part.name === "file" && part.fileName);

  if (!uploadedFile) {
    sendJson(res, 400, { error: "Выберите GPX, FIT или GeoJSON файл." });
    return;
  }

  const originalName = path.basename(uploadedFile.fileName);
  const ext = path.extname(originalName).toLowerCase();
  const allowed = new Set([".gpx", ".fit", ".geojson", ".json"]);

  if (!allowed.has(ext)) {
    sendJson(res, 400, { error: "Можно загружать только .gpx, .fit, .geojson или .json." });
    return;
  }

  const id = crypto.randomUUID();
  const fitData = ext === ".fit" ? parseFitActivity(uploadedFile.content, originalName) : null;
  const storedExt = ext === ".json" || ext === ".fit" ? ".geojson" : ext;
  const storage = await ensureUserStorage(userId);
  const routes = await readRoutes(userId);
  const type = storedExt === ".gpx" ? "gpx" : "geojson";
  const routeDate = fitData?.summary.startTime
    ? fitData.summary.startTime.slice(0, 10)
    : extractRouteDate(originalName);
  const originalDisplayName = ext === ".fit" ? path.parse(originalName).name : originalName;
  const routeDraft = {
    id,
    originalName: originalDisplayName,
    routeDate
  };
  const fileName = await getAvailableRouteFileName(routeDraft, storedExt, "", userId);
  const filePath = path.join(storage.uploadDir, fileName);

  await fsp.writeFile(
    filePath,
    fitData ? `${JSON.stringify(fitData.geojson, null, 2)}\n` : uploadedFile.content
  );

  const route = {
    id,
    originalName: originalDisplayName,
    fileName,
    type,
    routeDate,
    description: fitData?.description || "",
    bike: DEFAULT_BIKE,
    rideTime: formatClockDuration(fitData?.summary.timerSeconds || 0),
    totalTime: formatClockDuration(fitData?.summary.elapsedSeconds || 0),
    averageSpeed: fitData?.summary.avgSpeed ? formatFitNumber(fitData.summary.avgSpeed * 3.6) : "",
    distanceKm: fitData?.summary.distanceM ? Math.round((fitData.summary.distanceM / 1000) * 10) / 10 : undefined,
    ascentM: fitData?.summary.totalAscent ? Math.round(fitData.summary.totalAscent) : undefined,
    descentM: fitData?.summary.totalDescent ? Math.round(fitData.summary.totalDescent) : undefined,
    color: DEFAULT_ROUTE_COLOR,
    weight: DEFAULT_ROUTE_WEIGHT,
    uploadedAt: new Date().toISOString()
  };

  routes.push(route);
  await writeRoutes(routes, userId);
  appendLog("info", "route_uploaded", {
    userId,
    routeId: route.id,
    originalName,
    storedName: route.fileName,
    sourceType: ext.slice(1),
    storedType: route.type,
    distanceKm: route.distanceKm,
    ascentM: route.ascentM,
    descentM: route.descentM
  });
  sendJson(res, 201, { route: routePublicData(route, userId) });
}

async function handleRoutePatch(req, res, id, userId = DEFAULT_USER_ID) {
  const body = await collectRequestBody(req);
  let patch;

  try {
    patch = JSON.parse(body.toString("utf8"));
  } catch {
    sendJson(res, 400, { error: "Некорректный JSON." });
    return;
  }

  const routes = await readRoutes(userId);
  const route = routes.find((item) => item.id === id);

  if (!route) {
    sendJson(res, 404, { error: "Слой не найден." });
    return;
  }

  if (typeof patch.color === "string" && /^#[0-9a-f]{6}$/i.test(patch.color)) {
    route.color = patch.color;
  }

  if (Number.isFinite(Number(patch.weight))) {
    route.weight = Math.min(20, Math.max(1, Math.round(Number(patch.weight))));
  }

  if (typeof patch.originalName === "string") {
    route.originalName = patch.originalName.trim().slice(0, 180) || route.originalName;
  }

  if (typeof patch.routeDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(patch.routeDate)) {
    route.routeDate = patch.routeDate;
  }

  if (typeof patch.description === "string") {
    route.description = patch.description.trim().slice(0, 500);
  }

  if (typeof patch.bike === "string") {
    route.bike = patch.bike.trim().slice(0, 120) || DEFAULT_BIKE;
  }

  if (typeof patch.rideTime === "string") {
    route.rideTime = patch.rideTime.trim().slice(0, 24);
  }

  if (typeof patch.totalTime === "string") {
    route.totalTime = patch.totalTime.trim().slice(0, 24);
  }

  if (typeof patch.averageSpeed === "string") {
    route.averageSpeed = patch.averageSpeed.trim().slice(0, 24);
  }

  if (Number.isFinite(Number(patch.distanceKm))) {
    route.distanceKm = Math.max(0, Math.round(Number(patch.distanceKm) * 10) / 10);
  }

  if (patch.ascentM === null || patch.ascentM === "") {
    delete route.ascentM;
  } else if (Number.isFinite(Number(patch.ascentM))) {
    route.ascentM = Math.max(0, Math.round(Number(patch.ascentM)));
  }

  if (patch.descentM === null || patch.descentM === "") {
    delete route.descentM;
  } else if (Number.isFinite(Number(patch.descentM))) {
    route.descentM = Math.max(0, Math.round(Number(patch.descentM)));
  }

  await renameGpxToStoragePattern(route, { userId });
  await writeRoutes(routes, userId);
  appendLog("info", "route_updated", {
    userId,
    routeId: route.id,
    originalName: route.originalName,
    routeDate: route.routeDate,
    bike: route.bike,
    distanceKm: route.distanceKm,
    ascentM: route.ascentM,
    descentM: route.descentM
  });
  sendJson(res, 200, { route: routePublicData(route, userId) });
}

async function handleRouteDelete(res, id, userId = DEFAULT_USER_ID) {
  const storage = await ensureUserStorage(userId);
  const routes = await readRoutes(userId);
  const route = routes.find((item) => item.id === id);

  if (!route) {
    sendJson(res, 404, { error: "Слой не найден." });
    return;
  }

  const nextRoutes = routes.filter((item) => item.id !== id);
  await writeRoutes(nextRoutes, userId);

  try {
    await fsp.unlink(path.join(storage.uploadDir, route.fileName));
  } catch {
    // Metadata removal is still useful even if the file was already absent.
  }

  appendLog("info", "route_deleted", {
    userId,
    routeId: route.id,
    originalName: route.originalName,
    fileName: route.fileName
  });
  sendJson(res, 200, { ok: true });
}

async function handleCreateUser(req, res) {
  const body = await collectRequestBody(req);
  let payload;

  try {
    payload = JSON.parse(body.toString("utf8"));
  } catch {
    sendJson(res, 400, { error: "Некорректный JSON." });
    return;
  }

  const name = String(payload.name || "").trim().slice(0, 80);
  if (!name) {
    sendJson(res, 400, { error: "Введите имя пользователя." });
    return;
  }

  const users = await readUsers();
  const duplicate = users.some((user) => user.name.toLowerCase() === name.toLowerCase());
  if (duplicate) {
    sendJson(res, 409, { error: "Пользователь с таким именем уже есть." });
    return;
  }

  let id = `user-${crypto.randomUUID().slice(0, 8)}`;
  while (users.some((user) => user.id === id)) {
    id = `user-${crypto.randomUUID().slice(0, 8)}`;
  }

  const user = {
    id,
    name,
    createdAt: new Date().toISOString()
  };

  users.push(user);
  await ensureUserStorage(id);
  await writeUsers(users);
  appendLog("info", "user_created", {
    userId: user.id,
    name: user.name
  });
  sendJson(res, 201, { user });
}

async function handleUserPatch(req, res, id) {
  const body = await collectRequestBody(req);
  let payload;

  try {
    payload = JSON.parse(body.toString("utf8"));
  } catch {
    sendJson(res, 400, { error: "Некорректный JSON." });
    return;
  }

  const name = String(payload.name || "").trim().slice(0, 80);
  if (!name) {
    sendJson(res, 400, { error: "Введите имя пользователя." });
    return;
  }

  const users = await readUsers();
  const user = users.find((item) => item.id === id);

  if (!user) {
    sendJson(res, 404, { error: "Пользователь не найден." });
    return;
  }

  const duplicate = users.some((item) => item.id !== id && item.name.toLowerCase() === name.toLowerCase());
  if (duplicate) {
    sendJson(res, 409, { error: "Пользователь с таким именем уже есть." });
    return;
  }

  const previousName = user.name;
  user.name = name;
  user.updatedAt = new Date().toISOString();
  await writeUsers(users);
  appendLog("info", "user_renamed", {
    userId: user.id,
    previousName,
    name: user.name
  });
  sendJson(res, 200, { user });
}

async function serveStatic(req, res, pathname) {
  const isStorage = pathname.startsWith("/storage/routes/")
    || pathname.startsWith("/storage/users/");
  const root = isStorage ? STORAGE_DIR : PUBLIC_DIR;
  const relative = isStorage
    ? pathname.replace(/^\/storage\//, "")
    : pathname === "/" ? "index.html" : pathname.slice(1);

  const requestedPath = path.normalize(path.join(root, decodeURIComponent(relative)));
  if (!isInsideDirectory(root, requestedPath)) {
    sendText(res, 403, "Forbidden");
    return;
  }

  try {
    const stat = await fsp.stat(requestedPath);
    if (!stat.isFile()) {
      sendText(res, 404, "Not found");
      return;
    }

    const ext = path.extname(requestedPath).toLowerCase();
    res.writeHead(200, { "Content-Type": MIME_TYPES[ext] || "application/octet-stream" });
    fs.createReadStream(requestedPath).pipe(res);
  } catch {
    sendText(res, 404, "Not found");
  }
}

function shouldLogRequest(pathname) {
  return pathname.startsWith("/api/");
}

async function handleRequest(req, res) {
  const startedAt = Date.now();
  const requestId = crypto.randomUUID().slice(0, 8);
  let url;
  let statusCode = 200;
  const originalWriteHead = res.writeHead;

  res.writeHead = function patchedWriteHead(status, ...args) {
    statusCode = status;
    return originalWriteHead.call(this, status, ...args);
  };

  res.on("finish", () => {
    const pathname = url?.pathname || req.url || "";
    if (!shouldLogRequest(pathname)) {
      return;
    }

    appendLog(statusCode >= 500 ? "error" : "info", "request", {
      requestId,
      method: req.method,
      path: pathname,
      status: statusCode,
      durationMs: Date.now() - startedAt
    });
  });

  try {
    url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const tileMatch = url.pathname.match(/^\/tiles\/(light|dark)\/(\d+)\/(\d+)\/(\d+)\.png$/);

    if (req.method === "GET" && tileMatch) {
      await handleTileRequest(res, tileMatch[1], tileMatch[2], tileMatch[3], tileMatch[4]);
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/users") {
      const users = await readUsers();
      sendJson(res, 200, { users });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/users") {
      await handleCreateUser(req, res);
      return;
    }

    const userMatch = url.pathname.match(/^\/api\/users\/([^/]+)$/);
    if (userMatch && req.method === "PATCH") {
      await handleUserPatch(req, res, decodeURIComponent(userMatch[1]));
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/routes") {
      const user = await getRequestUser(url);
      const routes = await readRoutes(user.id);
      sendJson(res, 200, { user, routes: routes.map((route) => routePublicData(route, user.id)) });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/routes") {
      const user = await getRequestUser(url);
      await handleUpload(req, res, user.id);
      return;
    }

    const routeMatch = url.pathname.match(/^\/api\/routes\/([^/]+)$/);
    if (routeMatch && req.method === "PATCH") {
      const user = await getRequestUser(url);
      await handleRoutePatch(req, res, decodeURIComponent(routeMatch[1]), user.id);
      return;
    }

    if (routeMatch && req.method === "DELETE") {
      const user = await getRequestUser(url);
      await handleRouteDelete(res, decodeURIComponent(routeMatch[1]), user.id);
      return;
    }

    if (req.method === "GET" || req.method === "HEAD") {
      await serveStatic(req, res, url.pathname);
      return;
    }

    sendText(res, 405, "Method not allowed");
  } catch (error) {
    appendLog("error", "request_failed", {
      requestId,
      method: req.method,
      path: url?.pathname || req.url,
      error: error.message || "Server error"
    });
    sendJson(res, 500, { error: error.message || "Server error" });
  }
}

ensureStorage()
  .then(normalizeStoredGpxFileNames)
  .then(() => {
    http.createServer(handleRequest).listen(PORT, () => {
      console.log(`Map routes server: http://localhost:${PORT}`);
      appendLog("info", "server_started", {
        port: PORT
      });
    });
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
