const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { pipeline } = require("node:stream/promises");
const { DatabaseSync } = require("node:sqlite");
const express = require("express");
const multer = require("multer");

const ROOT = __dirname;
function resolveDataPath(value, fallback) {
  const configuredPath = value || fallback;
  return path.isAbsolute(configuredPath) ? configuredPath : path.resolve(ROOT, configuredPath);
}
const DATA_DIR = resolveDataPath(process.env.DATA_DIR, "data");
const UPLOAD_DIR = resolveDataPath(process.env.UPLOAD_DIR, "uploads");
const MAX_UPLOAD_MB = Number.parseInt(process.env.MAX_UPLOAD_MB || "500", 10);
const IS_PRODUCTION = process.env.NODE_ENV === "production";

if (!Number.isInteger(MAX_UPLOAD_MB) || MAX_UPLOAD_MB < 1 || MAX_UPLOAD_MB > 4096) {
  throw new Error("MAX_UPLOAD_MB must be an integer between 1 and 4096.");
}

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, "vault.sqlite"));
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS admin (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    password_salt TEXT NOT NULL,
    must_change_password INTEGER NOT NULL DEFAULT 1
  );
  CREATE TABLE IF NOT EXISTS tools (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    original_name TEXT NOT NULL,
    storage_name TEXT NOT NULL UNIQUE,
    size INTEGER NOT NULL,
    sha256 TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    created_at TEXT NOT NULL,
    tags TEXT NOT NULL DEFAULT '[]',
    favorite INTEGER NOT NULL DEFAULT 0
  );
`);

const toolColumns = new Set(db.prepare("PRAGMA table_info(tools)").all().map((column) => column.name));
if (!toolColumns.has("tags")) db.exec("ALTER TABLE tools ADD COLUMN tags TEXT NOT NULL DEFAULT '[]'");
if (!toolColumns.has("favorite")) db.exec("ALTER TABLE tools ADD COLUMN favorite INTEGER NOT NULL DEFAULT 0");

const adminExists = db.prepare("SELECT id FROM admin WHERE id = 1").get();
if (!adminExists) {
  const email = process.env.ADMIN_EMAIL?.trim() || (IS_PRODUCTION ? "" : "admin@toolvault.local");
  const password = process.env.ADMIN_PASSWORD || (IS_PRODUCTION ? "" : "VaultStart!2026");
  if (!email || !password) {
    throw new Error("Set ADMIN_EMAIL and ADMIN_PASSWORD before the first production startup.");
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
    throw new Error("ADMIN_EMAIL must be a valid email address.");
  }
  if (password.length < (IS_PRODUCTION ? 16 : 12) || password.length > 256) {
    throw new Error(`ADMIN_PASSWORD must be between ${IS_PRODUCTION ? 16 : 12} and 256 characters.`);
  }
  const salt = crypto.randomBytes(16).toString("hex");
  const passwordHash = crypto.scryptSync(password, salt, 64).toString("hex");
  db.prepare(`
    INSERT INTO admin (id, email, password_hash, password_salt, must_change_password)
    VALUES (1, ?, ?, ?, 1)
  `).run(email, passwordHash, salt);
}

const app = express();
const sessions = new Map();
const loginAttempts = new Map();
const SESSION_MS = 8 * 60 * 60 * 1000;
const MAX_LOGIN_ATTEMPTS = 8;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const trustProxy = process.env.TRUST_PROXY || (process.env.RENDER ? "1" : "0");

if (!/^\d+$/.test(trustProxy)) {
  throw new Error("TRUST_PROXY must be a non-negative integer.");
}
app.set("trust proxy", Number(trustProxy));

app.disable("x-powered-by");
app.use(express.json({ limit: "16kb" }));
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self'; style-src-attr 'unsafe-inline'; img-src 'self' blob:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'"
  );
  if (IS_PRODUCTION && req.secure) {
    res.setHeader("Strict-Transport-Security", "max-age=31536000");
  }
  if (["POST", "PUT", "PATCH", "DELETE"].includes(req.method)) {
    const origin = req.get("origin");
    const expectedOrigin = `${req.protocol}://${req.get("host")}`;
    if (!origin || origin !== expectedOrigin) {
      return res.status(403).json({ error: "Request origin could not be verified." });
    }
  }
  next();
});

app.get("/healthz", (_req, res) => {
  try {
    db.prepare("SELECT 1").get();
    res.status(200).type("text/plain").send("ok");
  } catch (error) {
    console.error("Health check failed:", error);
    res.status(503).type("text/plain").send("unavailable");
  }
});

function getAdmin() {
  return db.prepare("SELECT * FROM admin WHERE id = 1").get();
}

function safeEqual(left, right) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function getSession(req) {
  const match = /^vault_session=([a-f0-9]{64})$/.exec(req.get("cookie") || "");
  if (!match) return null;
  const session = sessions.get(match[1]);
  if (!session || session.expiresAt <= Date.now()) {
    sessions.delete(match[1]);
    return null;
  }
  return { id: match[1], ...session };
}

function requireSession(req, res, next) {
  const session = getSession(req);
  if (!session) return res.status(401).json({ error: "Please sign in to continue." });
  req.vaultSession = session;
  const isCredentialUpdate = req.method === "POST" && req.path === "/api/settings";
  const isCurrentUserLookup = req.method === "GET" && req.path === "/api/me";
  if (session.mustChangePassword && !isCredentialUpdate && !isCurrentUserLookup) {
    return res.status(403).json({
      error: "Update your starter credentials before using the vault.",
      code: "PASSWORD_CHANGE_REQUIRED"
    });
  }
  if (["POST", "PUT", "PATCH", "DELETE"].includes(req.method)) {
    if (!safeEqual(req.get("x-csrf-token") || "", session.csrfToken)) {
      return res.status(403).json({ error: "Request verification failed. Refresh and try again." });
    }
  }
  next();
}

app.get("/api/config", (_req, res) => {
  res.json({ maxUploadMb: MAX_UPLOAD_MB });
});

function sanitizeOriginalName(name) {
  const basename = path.basename(name).replace(/[\x00-\x1f\x7f]/g, "").trim();
  return (basename || "download").slice(0, 255);
}

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (_req, _file, callback) => callback(null, `${crypto.randomUUID()}.upload`)
  }),
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024, files: 1, fields: 1, fieldSize: 120 }
});

app.post("/api/login", (req, res) => {
  const ip = req.ip;
  const now = Date.now();
  const attempt = loginAttempts.get(ip);
  if (attempt && attempt.resetAt > now && attempt.count >= MAX_LOGIN_ATTEMPTS) {
    return res.status(429).json({ error: "Too many sign-in attempts. Try again in 15 minutes." });
  }
  const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
  const password = typeof req.body?.password === "string" ? req.body.password : "";
  const admin = getAdmin();
  const candidate = crypto.scryptSync(password, admin.password_salt, 64).toString("hex");
  if (email !== admin.email.toLowerCase() || !safeEqual(candidate, admin.password_hash)) {
    const next = attempt && attempt.resetAt > now
      ? { count: attempt.count + 1, resetAt: attempt.resetAt }
      : { count: 1, resetAt: now + LOGIN_WINDOW_MS };
    loginAttempts.set(ip, next);
    return res.status(401).json({ error: "That email and password do not match." });
  }
  loginAttempts.delete(ip);
  const id = crypto.randomBytes(32).toString("hex");
  const csrfToken = crypto.randomBytes(32).toString("hex");
  const mustChangePassword = Boolean(admin.must_change_password);
  sessions.set(id, { csrfToken, expiresAt: now + SESSION_MS, mustChangePassword });
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  res.setHeader(
    "Set-Cookie",
    `vault_session=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MS / 1000}${secure}`
  );
  res.json({ email: admin.email, csrfToken, mustChangePassword });
});

app.post("/api/logout", requireSession, (req, res) => {
  sessions.delete(req.vaultSession.id);
  res.setHeader("Set-Cookie", "vault_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0");
  res.status(204).end();
});

app.get("/api/me", requireSession, (req, res) => {
  res.json({
    email: getAdmin().email,
    csrfToken: req.vaultSession.csrfToken,
    mustChangePassword: req.vaultSession.mustChangePassword
  });
});

app.post("/api/settings", requireSession, (req, res) => {
  const { currentPassword, email: newEmail, password: newPassword } = req.body || {};
  if (typeof currentPassword !== "string" || typeof newEmail !== "string" || typeof newPassword !== "string") {
    return res.status(400).json({ error: "Enter your current password, email, and new password." });
  }
  const normalizedEmail = newEmail.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail) || normalizedEmail.length > 254) {
    return res.status(400).json({ error: "Enter a valid email address." });
  }
  if (newPassword.length < 12 || newPassword.length > 256) {
    return res.status(400).json({ error: "Choose a password between 12 and 256 characters." });
  }
  const admin = getAdmin();
  const currentHash = crypto.scryptSync(currentPassword, admin.password_salt, 64).toString("hex");
  if (!safeEqual(currentHash, admin.password_hash)) {
    return res.status(401).json({ error: "Your current password is incorrect." });
  }
  const salt = crypto.randomBytes(16).toString("hex");
  const passwordHash = crypto.scryptSync(newPassword, salt, 64).toString("hex");
  try {
    db.prepare(`
      UPDATE admin
      SET email = ?, password_hash = ?, password_salt = ?, must_change_password = 0
      WHERE id = 1
    `).run(normalizedEmail, passwordHash, salt);
  } catch (error) {
    if (error.code === "SQLITE_CONSTRAINT_UNIQUE") {
      return res.status(409).json({ error: "That email is already in use." });
    }
    throw error;
  }
  for (const sessionId of sessions.keys()) {
    if (sessionId !== req.vaultSession.id) sessions.delete(sessionId);
  }
  req.vaultSession.mustChangePassword = false;
  sessions.set(req.vaultSession.id, req.vaultSession);
  res.json({ email: normalizedEmail });
});

app.get("/api/tools", requireSession, (_req, res) => {
  const tools = db.prepare(`
    SELECT id, name, original_name AS originalName, size, sha256, mime_type AS mimeType,
      created_at AS createdAt, tags, favorite
    FROM tools ORDER BY created_at DESC
  `).all();
  res.json(tools.map((tool) => ({ ...tool, tags: JSON.parse(tool.tags), favorite: Boolean(tool.favorite) })));
});

app.post("/api/tools", requireSession, upload.single("file"), async (req, res, next) => {
  if (!req.file) return res.status(400).json({ error: "Choose a file to upload." });
  const id = crypto.randomUUID();
  const originalName = sanitizeOriginalName(req.file.originalname);
  const nameInput = typeof req.body.name === "string" ? req.body.name.trim() : "";
  const name = (nameInput || path.parse(originalName).name || "Untitled tool").slice(0, 120);
  const extension = path.extname(originalName).replace(/[^a-zA-Z0-9.]/g, "").slice(0, 20);
  const storageName = `${id}${extension}`;
  const destination = path.join(UPLOAD_DIR, storageName);
  try {
    await fs.promises.rename(req.file.path, destination);
    const hash = crypto.createHash("sha256");
    await pipeline(fs.createReadStream(destination), hash);
    db.prepare(`
      INSERT INTO tools (id, name, original_name, storage_name, size, sha256, mime_type, created_at, tags, favorite)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, '[]', 0)
    `).run(
      id,
      name,
      originalName,
      storageName,
      req.file.size,
      hash.digest("hex"),
      req.file.mimetype || "application/octet-stream",
      new Date().toISOString()
    );
    res.status(201).json({ id, name, originalName, size: req.file.size });
  } catch (error) {
    await fs.promises.rm(destination, { force: true }).catch(() => {});
    next(error);
  }
});

app.patch("/api/tools/:id", requireSession, (req, res) => {
  const tool = db.prepare("SELECT id, name, tags, favorite FROM tools WHERE id = ?").get(req.params.id);
  if (!tool) return res.status(404).json({ error: "That tool could not be found." });
  const updates = req.body;
  if (!updates || typeof updates !== "object" || Array.isArray(updates)) {
    return res.status(400).json({ error: "Provide tool details to update." });
  }
  const allowedFields = new Set(["name", "tags", "favorite"]);
  if (Object.keys(updates).some((field) => !allowedFields.has(field))) {
    return res.status(400).json({ error: "Only the name, tags, and favorite status can be updated." });
  }

  let name = tool.name;
  let tags;
  let favorite = Boolean(tool.favorite);
  if (Object.hasOwn(updates, "name")) {
    if (typeof updates.name !== "string" || !updates.name.trim() || updates.name.trim().length > 120) {
      return res.status(400).json({ error: "A name must be between 1 and 120 characters." });
    }
    name = updates.name.trim();
  }
  if (Object.hasOwn(updates, "tags")) {
    if (!Array.isArray(updates.tags) || updates.tags.length > 8 ||
        updates.tags.some((tag) => typeof tag !== "string" || !tag.trim() || tag.trim().length > 24)) {
      return res.status(400).json({ error: "Use up to 8 tags, each between 1 and 24 characters." });
    }
    tags = [...new Set(updates.tags.map((tag) => tag.trim().toLowerCase()))];
  } else {
    tags = JSON.parse(tool.tags);
  }
  if (Object.hasOwn(updates, "favorite")) {
    if (typeof updates.favorite !== "boolean") {
      return res.status(400).json({ error: "Favorite status must be true or false." });
    }
    favorite = updates.favorite;
  }
  db.prepare("UPDATE tools SET name = ?, tags = ?, favorite = ? WHERE id = ?")
    .run(name, JSON.stringify(tags), Number(favorite), req.params.id);
  res.json({ id: tool.id, name, tags, favorite });
});

app.post("/api/tools/bulk-delete", requireSession, async (req, res, next) => {
  const { ids } = req.body || {};
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > 100 ||
      ids.some((id) => typeof id !== "string" || id.length > 64)) {
    return res.status(400).json({ error: "Select between 1 and 100 tools to remove." });
  }
  const deleted = [];
  const failed = [];
  for (const id of new Set(ids)) {
    const tool = db.prepare("SELECT storage_name FROM tools WHERE id = ?").get(id);
    if (!tool) {
      failed.push({ id, error: "This tool no longer exists." });
      continue;
    }
    try {
      await fs.promises.rm(path.join(UPLOAD_DIR, tool.storage_name), { force: true });
      db.prepare("DELETE FROM tools WHERE id = ?").run(id);
      deleted.push(id);
    } catch (error) {
      console.error(`Could not remove tool ${id}:`, error);
      failed.push({ id, error: "The file could not be removed. Check the server log." });
    }
  }
  res.json({ deleted, failed });
});

app.get("/api/tools/:id/download", requireSession, async (req, res, next) => {
  const tool = db.prepare("SELECT * FROM tools WHERE id = ?").get(req.params.id);
  if (!tool) return res.status(404).json({ error: "That tool could not be found." });
  const filePath = path.join(UPLOAD_DIR, tool.storage_name);
  try {
    await fs.promises.access(filePath, fs.constants.R_OK);
  } catch (error) {
    if (error.code === "ENOENT") {
      console.error(`Stored file is missing: ${filePath}`);
      return res.status(404).json({ error: "The stored file is missing from the upload directory." });
    }
    return next(error);
  }
  res.setHeader("Content-Type", "application/octet-stream");
  res.download(filePath, tool.original_name, (error) => {
    if (error && !res.headersSent) next(error);
  });
});

app.delete("/api/tools/:id", requireSession, async (req, res, next) => {
  const tool = db.prepare("SELECT storage_name FROM tools WHERE id = ?").get(req.params.id);
  if (!tool) return res.status(404).json({ error: "That tool could not be found." });
  try {
    await fs.promises.rm(path.join(UPLOAD_DIR, tool.storage_name), { force: true });
    db.prepare("DELETE FROM tools WHERE id = ?").run(req.params.id);
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

app.use(express.static(path.join(ROOT, "public"), {
  dotfiles: "deny",
  index: "index.html",
  maxAge: process.env.NODE_ENV === "production" ? "1h" : 0
}));

app.use((error, _req, res, _next) => {
  if (res.headersSent) return;
  if (error instanceof multer.MulterError) {
    const message = error.code === "LIMIT_FILE_SIZE"
      ? `That file is too large. The upload limit is ${MAX_UPLOAD_MB} MB.`
      : "The upload could not be completed.";
    return res.status(error.code === "LIMIT_FILE_SIZE" ? 413 : 400).json({ error: message });
  }
  console.error(error);
  res.status(500).json({ error: "Something went wrong. Check the server log for details." });
});

setInterval(() => {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (session.expiresAt <= now) sessions.delete(id);
  }
  for (const [ip, attempt] of loginAttempts) {
    if (attempt.resetAt <= now) loginAttempts.delete(ip);
  }
}, 15 * 60 * 1000).unref();

const host = process.env.HOST || (process.env.RENDER ? "0.0.0.0" : "127.0.0.1");
const portValue = process.env.PORT || "3000";
if (!/^\d+$/.test(portValue)) throw new Error("PORT must be an integer between 1 and 65535.");
const port = Number(portValue);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PORT must be between 1 and 65535.");
app.listen(port, host, () => {
  console.log(`Tool Vault is ready at http://${host}:${port}`);
  console.log("Sign in with the starter credentials and update them in Settings.");
});
