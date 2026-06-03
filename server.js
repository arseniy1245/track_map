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
    sendJson(res, 400, { error: "Выберите GPX или GeoJSON файл." });
    return;
  }

  const originalName = path.basename(uploadedFile.fileName);
  const ext = path.extname(originalName).toLowerCase();
  const allowed = new Set([".gpx", ".geojson", ".json"]);

  if (!allowed.has(ext)) {
    sendJson(res, 400, { error: "Можно загружать только .gpx, .geojson или .json." });
    return;
  }

  const id = crypto.randomUUID();
  const storedExt = ext === ".json" ? ".geojson" : ext;
  const storage = await ensureUserStorage(userId);
  const routes = await readRoutes(userId);
  const type = storedExt === ".gpx" ? "gpx" : "geojson";
  const routeDate = extractRouteDate(originalName);
  const routeDraft = {
    id,
    originalName,
    routeDate
  };
  const fileName = await getAvailableRouteFileName(routeDraft, storedExt, "", userId);
  const filePath = path.join(storage.uploadDir, fileName);

  await fsp.writeFile(filePath, uploadedFile.content);

  const route = {
    id,
    originalName,
    fileName,
    type,
    routeDate,
    description: "",
    bike: DEFAULT_BIKE,
    rideTime: "",
    totalTime: "",
    averageSpeed: "",
    color: DEFAULT_ROUTE_COLOR,
    weight: DEFAULT_ROUTE_WEIGHT,
    uploadedAt: new Date().toISOString()
  };

  routes.push(route);
  await writeRoutes(routes, userId);
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

  await renameGpxToStoragePattern(route, { userId });
  await writeRoutes(routes, userId);
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

  user.name = name;
  user.updatedAt = new Date().toISOString();
  await writeUsers(users);
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

async function handleRequest(req, res) {
  try {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
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
    sendJson(res, 500, { error: error.message || "Server error" });
  }
}

ensureStorage()
  .then(normalizeStoredGpxFileNames)
  .then(() => {
    http.createServer(handleRequest).listen(PORT, () => {
      console.log(`Map routes server: http://localhost:${PORT}`);
    });
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
