/* ============================================================
   Quiz Atelier — backend server
   Real auth + cloud DB + workspace sync + static serving.
   Zero external dependencies (Node 18+ built-ins only).

   Cloud DB layout:
     data/db.json          — the live database (atomic writes)
     data/backups/*.json   — rolling snapshots on every write
   ============================================================ */
"use strict";

const http = require("http");
const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const crypto = require("crypto");

const ROOT = path.join(__dirname, "..");
const STATIC_DIR = path.join(ROOT, "quiz-manager");
const DATA_DIR = path.join(__dirname, "data");
const DB_FILE = path.join(DATA_DIR, "db.json");
const BACKUP_DIR = path.join(DATA_DIR, "backups");
const MAX_BACKUPS = 10;

const PORT = Number(process.env.PORT) || 8790;
const HOST = process.env.HOST || "0.0.0.0"; // bind all interfaces so hosts like Render/Fly can route traffic

/* ─── database ─────────────────────────────────────────────────── */
/* db.json shape:
   {
     users: [{ id, role, name, username(email or legacy), email, passSalt, passHash }],
     sessions: { sid: { userId, createdAt, expiresAt } },
     workspaces: { [userId]: { quizzes, attempts, activity, lastQuizId } },
     consent: { [userId]: { consent: "accepted"|"rejected", at } }  — the ONLY thing
       we persist per the cookie notice: auth cookies (sessions) when accepted,
       nothing when rejected.
   } */
let db = { users: [], sessions: {}, workspaces: {}, consent: {} };
let dbWriteChain = Promise.resolve();
let backupsSinceCompact = 0;

function initDb() {
  let loaded = null;
  try { loaded = JSON.parse(fs.readFileSync(DB_FILE, "utf8")); } catch { /* fresh */ }
  if (loaded && Array.isArray(loaded.users)) {
    db = loaded;
    if (!db.consent) db.consent = {};
    // Legacy usernames → email identities.
    for (const u of db.users) {
      if (!u.email && u.username && u.username.includes("@")) u.email = u.username;
      else if (!u.email) u.email = `${u.username}@quiz.dev`;
      if (u.username && !u.username.includes("@")) u.username = u.email; // login by email
    }
  } else {
    db = { users: [], sessions: {}, workspaces: {}, consent: {} };
    db.users.push(makeUser("teacher@quiz.dev", "teacher123", "teacher", "Prof. Meera"));
    db.users.push(makeUser("student@quiz.dev", "student123", "student", "Aarav"));
    persistDb();
  }
  // Expire stale sessions from previous runs.
  const now = Date.now();
  for (const sid of Object.keys(db.sessions)) {
    if (db.sessions[sid].expiresAt < now) delete db.sessions[sid];
  }
}

function makeUser(email, password, role, name) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return { id: email, role, name, username: email, email, passSalt: salt, passHash: hash };
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function persistDb() {
  // Serialize writes; snapshot to a timestamped backup first.
  dbWriteChain = dbWriteChain.then(async () => {
    await fsp.mkdir(DATA_DIR, { recursive: true });
    await fsp.mkdir(BACKUP_DIR, { recursive: true });
    const tmp = DB_FILE + ".tmp";
    await fsp.writeFile(tmp, JSON.stringify(db));
    await fsp.rename(tmp, DB_FILE);
    backupsSinceCompact++;
    if (backupsSinceCompact >= 3) {
      backupsSinceCompact = 0;
      try {
        await fsp.copyFile(DB_FILE, path.join(BACKUP_DIR, `db-${Date.now()}.json`));
        const files = (await fsp.readdir(BACKUP_DIR)).filter((f) => f.startsWith("db-")).sort();
        while (files.length > MAX_BACKUPS) {
          await fsp.unlink(path.join(BACKUP_DIR, files.shift()));
        }
      } catch { /* backup failure is non-fatal */ }
    }
  }).catch((err) => console.error("[db] write failed:", err.message));
}

/* ─── helpers ──────────────────────────────────────────────────── */
const MIME = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8", ".json": "application/json",
  ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8", ".pdf": "application/pdf",
};

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function readBody(req, limit = 1_000_000) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) { reject(new Error("payload too large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function parseCookies(req) {
  const header = req.headers.cookie || "";
  const out = {};
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function sessionFromReq(req) {
  const sid = parseCookies(req).qa_session;
  if (!sid) return null;
  const sess = db.sessions[sid];
  if (!sess || sess.expiresAt < Date.now()) { if (sess) delete db.sessions[sid]; return null; }
  const user = db.users.find((u) => u.id === sess.userId);
  return user ? { user, sid } : null;
}

/* ─── rate limiting (login brute-force + AI abuse) ──────────────── */
/* In-memory sliding windows; resets on restart — fine for this scale,
   and the DB file stays clean of security bookkeeping. */
const rateBuckets = new Map(); // key -> [timestamps]
function rateLimit(key, max, windowMs) {
  const now = Date.now();
  const arr = (rateBuckets.get(key) || []).filter((t) => now - t < windowMs);
  if (arr.length >= max) { rateBuckets.set(key, arr); return false; }
  arr.push(now);
  rateBuckets.set(key, arr);
  // opportunistic GC so the map can't grow forever
  if (rateBuckets.size > 5000) {
    for (const [k, v] of rateBuckets) {
      if (v.every((t) => now - t > windowMs)) rateBuckets.delete(k);
    }
  }
  return true;
}
const clientIp = (req) =>
  (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket?.remoteAddress || "?";

/* ─── Gemini proxy (keys NEVER touch the client) ────────────────── */
/* Configure the pool before starting the server:
     GEMINI_API_KEYS=key1,key2,...   (rotates on quota/free-tier errors)
   The webapp calls POST /api/ai/generate with a session cookie; anonymous
   callers get a tighter budget than signed-in users. */
const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/models";
const GEMINI_KEYS = (process.env.GEMINI_API_KEYS || "")
  .split(",").map((s) => s.trim()).filter(Boolean);
let geminiKeyIdx = 0;

async function callGeminiServer(parts, schema, generation = {}) {
  if (!GEMINI_KEYS.length) throw Object.assign(new Error("AI service not configured"), { status: 503 });
  const attempt = async (key) => {
    const res = await fetch(`${GEMINI_BASE}/gemini-2.5-flash:generateContent?key=${encodeURIComponent(key)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts }],
        generationConfig: {
          temperature: 0.7,
          responseMimeType: "application/json",
          responseSchema: schema,
          ...generation,
        },
      }),
    });
    if (!res.ok) {
      let detail = "";
      try { detail = (await res.json())?.error?.message || ""; } catch { /* empty */ }
      const err = new Error(detail || `Gemini ${res.status}`);
      err.status = res.status;
      throw err;
    }
    const data = await res.json();
    const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join("");
    if (!text) throw new Error("Gemini returned an empty response");
    return JSON.parse(text);
  };
  // rotate through the pool on quota/capacity errors, like the old client code
  for (let tries = 0; tries < GEMINI_KEYS.length + 1; tries++) {
    const key = GEMINI_KEYS[geminiKeyIdx];
    try {
      const out = await attempt(key);
      return out;
    } catch (err) {
      if (err.status === 429 || err.status === 503) {
        geminiKeyIdx = (geminiKeyIdx + 1) % GEMINI_KEYS.length;
        if (tries < GEMINI_KEYS.length - 1) continue;
      }
      throw err;
    }
  }
  throw Object.assign(new Error("All AI keys are rate-limited — try later"), { status: 429 });
}

const GEN_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string" },
    description: { type: "string" },
    questions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          question: { type: "string" },
          options: { type: "array", items: { type: "string" } },
          answer_index: { type: "integer" },
        },
        required: ["question", "options", "answer_index"],
      },
    },
  },
  required: ["title", "description", "questions"],
};
const ELI5_SCHEMA = {
  type: "object",
  properties: { explanation: { type: "string" } },
  required: ["explanation"],
};

/* ─── API routes ───────────────────────────────────────────────── */
async function handleApi(req, res, url) {
  const route = `${req.method} ${url.pathname}`;

  if (route === "POST /api/login") {
    const body = JSON.parse((await readBody(req)).toString("utf8") || "{}");
    const email = String(body.email || "").trim().toLowerCase();
    const password = String(body.password || "");
    // brute-force guard: 10 attempts / 10 min per IP and 6 / 10 min per account
    if (!rateLimit(`login-ip:${clientIp(req)}`, 10, 10 * 60_000)) {
      return sendJson(res, 429, { error: "Too many sign-in attempts from this network — wait 10 minutes." });
    }
    if (!rateLimit(`login-acct:${email}`, 6, 10 * 60_000)) {
      return sendJson(res, 429, { error: "Too many attempts on this account — wait 10 minutes." });
    }
    const role = body.role ? String(body.role) : null;
    const user = db.users.find((u) => u.email === email || u.username === email);
    if (!user) return sendJson(res, 401, { error: "No account with that email — ask your teacher for access." });
    const hash = crypto.scryptSync(password, user.passSalt, 64);
    const ok = hash.length === user.passHash.length / 2 &&
      crypto.timingSafeEqual(hash, Buffer.from(user.passHash, "hex"));
    if (!ok) return sendJson(res, 401, { error: "Incorrect password for that account." });
    // students can only sign in with credentials a teacher has issued AND published
    if (user.role === "student" && user.createdBy && !user.published) {
      return sendJson(res, 403, { error: "These credentials haven't been activated yet — ask your teacher to publish them." });
    }
    if (role && user.role !== role) {
      return sendJson(res, 403, { error: `This account is registered as a ${user.role}. Pick ${user.role} on the gate to continue.` });
    }
    // A session cookie is set ONLY if the browser accepted the cookie notice.
    // The banner's choice lives in the browser (localStorage) and is sent along;
    // the server mirrors it and refuses to persist a cookie on "rejected".
    const clientConsent = body.consent === "accepted" ? "accepted"
      : body.consent === "rejected" ? "rejected" : null;
    const accepted = clientConsent === "rejected" ? false
      : (clientConsent === "accepted"
        || db.consent.__pending === "accepted"
        || db.consent[user.id]?.consent === "accepted");
    if (clientConsent) {
      if (clientConsent === "accepted") delete db.consent.__pending;
      db.consent[user.id] = { consent: clientConsent, at: Date.now() };
      persistDb();
    }
    if (accepted) {
      const sid = crypto.randomBytes(24).toString("hex");
      db.sessions[sid] = { userId: user.id, createdAt: Date.now(), expiresAt: Date.now() + SESSION_TTL };
      persistDb();
      res.setHeader("Set-Cookie",
        `qa_session=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(SESSION_TTL / 1000)}`);
    }
    return sendJson(res, 200, {
      user: { id: user.id, role: user.role, name: user.name, username: user.email, email: user.email },
      workspace: db.workspaces[user.id] || null,
    });
  }

  if (route === "POST /api/signup") {
    const body = JSON.parse((await readBody(req)).toString("utf8") || "{}");
    const email = String(body.email || "").trim().toLowerCase();
    const password = String(body.password || "");
    // student accounts are teacher-issued only — no self-signup
    if (body.role !== "teacher") {
      return sendJson(res, 403, { error: "Student accounts are created by your teacher. Ask them to set up your credentials." });
    }
    const name = String(body.name || "").trim().slice(0, 60)
      || email.split("@")[0].replace(/(^|[-_.])(\w)/g, (_, s, c) => (s ? " " : "") + c.toUpperCase());
    if (!EMAIL_RE.test(email)) return sendJson(res, 400, { error: "Enter a valid email address." });
    if (password.length < 6) return sendJson(res, 400, { error: "Password must be at least 6 characters." });
    if (db.users.some((u) => u.email === email)) {
      return sendJson(res, 409, { error: "An account with that email already exists — sign in instead." });
    }
    const user = makeUser(email, password, role, name);
    db.users.push(user);
    persistDb();
    // Signup happens right after the consent choice; mirror it if accepted.
    if (body.consent === "rejected") {
      db.consent[user.id] = { consent: "rejected", at: Date.now() };
      persistDb();
    } else if (body.consent === "accepted" || db.consent.__pending === "accepted") {
      db.consent[user.id] = { consent: "accepted", at: Date.now() };
      delete db.consent.__pending;
      const sid = crypto.randomBytes(24).toString("hex");
      db.sessions[sid] = { userId: user.id, createdAt: Date.now(), expiresAt: Date.now() + SESSION_TTL };
      persistDb();
      res.setHeader("Set-Cookie",
        `qa_session=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(SESSION_TTL / 1000)}`);
    }
    return sendJson(res, 200, {
      user: { id: user.id, role: user.role, name: user.name, username: user.email, email: user.email },
      workspace: null,
    });
  }

  if (route === "POST /api/consent") {
    // Records the cookie-banner decision. "accepted" → we may keep the auth
    // session cookie. "rejected" → the server destroys any session now and
    // refuses to persist one later; nothing but this decision marker is stored.
    const body = JSON.parse((await readBody(req)).toString("utf8") || "{}");
    const value = body.consent === "accepted" ? "accepted" : "rejected";
    const sess = sessionFromReq(req);
    if (sess) db.consent[sess.user.id] = { consent: value, at: Date.now() };
    else db.consent.__pending = value;
    if (value === "rejected" && sess) { delete db.sessions[sess.sid]; }
    persistDb();
    if (value === "rejected") {
      res.setHeader("Set-Cookie", "qa_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0");
    }
    return sendJson(res, 200, { ok: true, consent: value });
  }

  if (route === "POST /api/logout") {
    const sess = sessionFromReq(req);
    if (sess) { delete db.sessions[sess.sid]; persistDb(); }
    res.setHeader("Set-Cookie", "qa_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0");
    return sendJson(res, 200, { ok: true });
  }

  if (route === "POST /api/delete/request-otp") {
    const sess = sessionFromReq(req);
    if (!sess) return sendJson(res, 401, { error: "no session" });
    try { await otpSend(sess.user.email); }
    catch (err) { return sendJson(res, 502, { error: `Could not send the email: ${err.message}` }); }
    return sendJson(res, 200, { ok: true, demo: !emailConfigured() });
  }

  if (route === "POST /api/delete/confirm") {
    const sess = sessionFromReq(req);
    if (!sess) return sendJson(res, 401, { error: "no session" });
    const body = JSON.parse((await readBody(req)).toString("utf8") || "{}");
    const code = String(body.code || "").trim();
    const err = otpVerify(sess.user.email, code);
    if (err) return sendJson(res, 400, { error: err });
    // delete the account: user, sessions, workspace, consent
    delete db.workspaces[sess.user.id];
    delete db.consent[sess.user.id];
    for (const [sid, s] of Object.entries(db.sessions)) if (s.userId === sess.user.id) delete db.sessions[sid];
    db.users = db.users.filter((u) => u.id !== sess.user.id);
    persistDb();
    res.setHeader("Set-Cookie", "qa_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0");
    return sendJson(res, 200, { ok: true, deleted: sess.user.email });
  }

  if (route === "GET /api/session") {
    // 200 with user:null when signed out — avoids console 401 noise on every
    // fresh load; the client treats a missing user as "not signed in".
    const sess = sessionFromReq(req);
    if (!sess) return sendJson(res, 200, { user: null });
    const { user } = sess;
    return sendJson(res, 200, {
      user: { id: user.id, role: user.role, name: user.name, username: user.email, email: user.email },
      workspace: db.workspaces[user.id] || null,
    });
  }

  if (route === "PUT /api/workspace") {
    const sess = sessionFromReq(req);
    if (!sess) return sendJson(res, 401, { error: "no session" });
    const body = JSON.parse((await readBody(req, 5_000_000)).toString("utf8") || "{}");
    const ws = body.workspace;
    if (!ws || !Array.isArray(ws.quizzes) || !Array.isArray(ws.attempts)) {
      return sendJson(res, 400, { error: "workspace must include quizzes and attempts arrays" });
    }
    db.workspaces[sess.user.id] = {
      quizzes: ws.quizzes, attempts: ws.attempts,
      activity: Array.isArray(ws.activity) ? ws.activity : [],
      lastQuizId: ws.lastQuizId ?? null,
      // per-user library: favourites & templates belong to the account that made them
      qFavs: Array.isArray(ws.qFavs) ? ws.qFavs : [],
      qTemplates: Array.isArray(ws.qTemplates) ? ws.qTemplates : [],
      customSubjects: Array.isArray(ws.customSubjects) ? ws.customSubjects : [],
      subjectNotices: Array.isArray(ws.subjectNotices) ? ws.subjectNotices : [],
      libSeen: ws.libSeen && typeof ws.libSeen === "object" ? ws.libSeen : {},
      streak: ws.streak && typeof ws.streak === "object" ? ws.streak : null,
      marginNotes: ws.marginNotes && typeof ws.marginNotes === "object" ? ws.marginNotes : {},
      reminders: ws.reminders && typeof ws.reminders === "object" ? ws.reminders : null,
      digest: ws.digest && typeof ws.digest === "object" ? ws.digest : null,
      // spaced-repetition rounds scheduled by the client ("bring my wrong answers back tomorrow")
      comebacks: Array.isArray(ws.comebacks) ? ws.comebacks : [],
      roster: Array.isArray(ws.roster) ? ws.roster : [],
      // account-level plan membership + downgrade/grace tracking
      planMeta: ws.planMeta && typeof ws.planMeta === "object" ? ws.planMeta : null,
    };
    persistDb();
    return sendJson(res, 200, { ok: true, savedAt: Date.now() });
  }

  if (route === "POST /api/digest/enable") {
    const sess = sessionFromReq(req);
    if (!sess) return sendJson(res, 401, { error: "no session" });
    const body = JSON.parse((await readBody(req)).toString("utf8") || "{}");
    const ws = db.workspaces[sess.user.id] || (db.workspaces[sess.user.id] = { quizzes: [], attempts: [] });
    ws.digest = { enabled: body.enabled === true, day: 6, lastSent: ws.digest?.lastSent || null };
    persistDb();
    if (body.enabled && !emailConfigured()) {
      return sendJson(res, 200, { ok: true, note: "Email service not configured — the digest will appear in-app only." });
    }
    return sendJson(res, 200, { ok: true });
  }

  if (route === "POST /api/ai/generate") {
    // Gemini proxy: keys stay server-side; per-identity budget (tighter for anon)
    const sess = sessionFromReq(req);
    const identity = sess ? `u:${sess.user.id}` : `ip:${clientIp(req)}`;
    const budgetMax = sess ? 40 : 10;              // requests per day
    if (!rateLimit(`ai:${identity}:${new Date().toISOString().slice(0, 10)}`, budgetMax, 86_400_000)) {
      return sendJson(res, 429, { error: sess
        ? "Daily AI limit reached — back tomorrow."
        : "Sign in for a higher AI budget." });
    }
    let body;
    try { body = JSON.parse((await readBody(req, 20_000_000)).toString("utf8") || "{}"); }
    catch { return sendJson(res, 400, { error: "bad JSON" }); }
    const parts = Array.isArray(body.parts) ? body.parts : null;
    if (!parts || !parts.length) return sendJson(res, 400, { error: "parts[] required" });
    const kind = body.kind === "eli5" ? "eli5" : "quiz";
    const schema = kind === "eli5" ? ELI5_SCHEMA : GEN_SCHEMA;
    // prompt-injection guard: cap inline data size (PDFs arrive as base64 parts)
    const serialized = JSON.stringify(parts);
    if (serialized.length > 18_000_000) return sendJson(res, 413, { error: "source too large" });
    try {
      const out = await callGeminiServer(parts, schema);
      return sendJson(res, 200, out);
    } catch (err) {
      console.error("[ai]", err.status || "", err.message);
      return sendJson(res, err.status && err.status >= 400 && err.status < 600 ? err.status : 502,
        { error: err.message || "AI request failed" });
    }
  }

  /* ─── student credentials: teacher-issued accounts ─────────────── */
  /* Students can no longer self-signup: a teacher creates each student
     account with a name, email and password, and it only works once
     published. Unpublished = created but not yet active (draft). */
  if (route === "GET /api/students") {
    const sess = sessionFromReq(req);
    if (!sess || sess.user.role !== "teacher") return sendJson(res, 403, { error: "Teacher only" });
    const students = db.users
      .filter((u) => u.role === "student" && u.createdBy)
      .map((u) => ({ id: u.id, name: u.name, email: u.email, published: !!u.published, createdAt: u.createdAt || null }));
    return sendJson(res, 200, { students });
  }

  if (route === "POST /api/students") {
    const sess = sessionFromReq(req);
    if (!sess || sess.user.role !== "teacher") return sendJson(res, 403, { error: "Teacher only" });
    const body = JSON.parse((await readBody(req)).toString("utf8") || "{}");
    const email = String(body.email || "").trim().toLowerCase();
    const password = String(body.password || "");
    const name = String(body.name || "").trim().slice(0, 60);
    const publish = body.publish !== false;
    if (!name) return sendJson(res, 400, { error: "Student name is required." });
    if (!EMAIL_RE.test(email)) return sendJson(res, 400, { error: "Enter a valid email address." });
    if (password.length < 6) return sendJson(res, 400, { error: "Password must be at least 6 characters." });
    if (db.users.some((u) => u.email === email)) {
      return sendJson(res, 409, { error: "An account with that email already exists." });
    }
    const user = makeUser(email, password, "student", name);
    user.createdBy = sess.user.id;   // teacher-issued (self-signup students have no createdBy)
    user.published = !!publish;
    user.createdAt = Date.now();
    db.users.push(user);
    persistDb();
    return sendJson(res, 200, { student: { id: user.id, name: user.name, email: user.email, published: user.published } });
  }

  if (route === "POST /api/students/publish") {
    const sess = sessionFromReq(req);
    if (!sess || sess.user.role !== "teacher") return sendJson(res, 403, { error: "Teacher only" });
    const body = JSON.parse((await readBody(req)).toString("utf8") || "{}");
    const user = db.users.find((u) => u.id === String(body.id || "") && u.role === "student");
    if (!user || !user.createdBy) return sendJson(res, 404, { error: "Student not found." });
    user.published = !!body.published;
    // unpublishing also kills any live sessions for that student
    if (!user.published) {
      for (const [sid, s] of Object.entries(db.sessions)) if (s.userId === user.id) delete db.sessions[sid];
    }
    persistDb();
    return sendJson(res, 200, { ok: true, published: user.published });
  }

  if (route === "POST /api/students/delete") {
    const sess = sessionFromReq(req);
    if (!sess || sess.user.role !== "teacher") return sendJson(res, 403, { error: "Teacher only" });
    const body = JSON.parse((await readBody(req)).toString("utf8") || "{}");
    const user = db.users.find((u) => u.id === String(body.id || "") && u.role === "student" && u.createdBy);
    if (!user) return sendJson(res, 404, { error: "Student not found." });
    delete db.workspaces[user.id];
    delete db.consent[user.id];
    for (const [sid, s] of Object.entries(db.sessions)) if (s.userId === user.id) delete db.sessions[sid];
    db.users = db.users.filter((u) => u.id !== user.id);
    persistDb();
    return sendJson(res, 200, { ok: true, deleted: user.email });
  }

  // 404 for unknown API routes
  return sendJson(res, 404, { error: "not found" });
}

/* ─── weekly digest sender (students, Sundays) ──────────────────── */
async function sendWeeklyDigests() {
  if (!emailConfigured()) return; // email not configured
  const today = new Date();
  if (today.getDay() !== 0) return; // Sundays only
  const todayKey = today.toISOString().slice(0, 10);
  for (const user of db.users) {
    if (user.role !== "student") continue;
    const ws = db.workspaces[user.id];
    if (!ws?.digest?.enabled || ws.digest.lastSent === todayKey) continue;
    const attempts = Array.isArray(ws.attempts) ? ws.attempts : [];
    const weekAgo = Date.now() - 7 * 86400000;
    const week = attempts.filter((a) => a.ts >= weekAgo);
    const avg = week.length ? Math.round(week.reduce((s, a) => s + a.score / a.total, 0) / week.length * 100) : null;
    // streak: consecutive days ending today/yesterday in this week's activity
    const days = new Set(week.map((a) => new Date(a.ts).toISOString().slice(0, 10)));
    let streak = 0, cur = new Date();
    if (!days.has(cur.toISOString().slice(0, 10))) { cur.setDate(cur.getDate() - 1); }
    while (days.has(cur.toISOString().slice(0, 10))) { streak++; cur.setDate(cur.getDate() - 1); }
    const best = week.length ? week.reduce((b, a) => (a.score / a.total > b.score / b.total ? a : b)) : null;
    const lines = [
      `Hi ${user.name},`,
      ``,
      `Here's your Quiz Atelier week:`,
      `  • Quizzes completed: ${week.length}`,
      `  • Average score: ${avg == null ? "—" : avg + "%"}`,
      `  • Practice streak: ${streak} day${streak === 1 ? "" : "s"}`,
      best ? `  • Best result: ${best.quizTitle} (${best.score}/${best.total})` : null,
      ``,
      week.length ? "Keep the streak alive — see you next week!" : "No quizzes this week — a 5-minute quiz counts.",
    ].filter((l) => l !== null);
    try {
      await smtpSend(user.email, "Your Quiz Atelier week", lines.join("\n"));
      ws.digest.lastSent = todayKey;
      persistDb();
      console.log(`[digest] sent to ${user.email}`);
    } catch (err) { console.error(`[digest] ${user.email}: ${err.message}`); }
  }
}
// check hourly; sends at most once per Sunday per student
setInterval(() => { sendWeeklyDigests().catch(() => {}); }, 3600 * 1000);

/* ─── email (raw SMTP over TLS — Gmail) ────────────────────────── */
/* Two setup modes, tried in this order:

   Production Setup (OAuth 2.0) — recommended for deployment:
     GMAIL_USER=yourname@gmail.com
     CLIENT_ID=...        (Google Cloud OAuth 2.0 client ID)
     CLIENT_SECRET=...    (Google Cloud OAuth 2.0 client secret)
     REFRESH_TOKEN=...    (long-lived refresh token; scope https://mail.google.com/)

   Quick Setup (App Password) — requires 2-Step Verification on the account:
     GMAIL_USER=yourname@gmail.com
     GMAIL_APP_PASS=xxxxxxxxxxxxxxxx   (16-char Google App Password)

   Without either, the server runs in demo mode: mail is printed to the
   server console instead of sent (fine for local testing). */
const net = require("net");
const tls = require("tls");
const GMAIL_USER = process.env.GMAIL_USER || "";
const GMAIL_APP_PASS = process.env.GMAIL_APP_PASS || "";
const OAUTH_CLIENT_ID = process.env.CLIENT_ID || "";
const OAUTH_CLIENT_SECRET = process.env.CLIENT_SECRET || "";
const OAUTH_REFRESH_TOKEN = process.env.REFRESH_TOKEN || "";

function emailConfigured() {
  return Boolean(
    GMAIL_USER &&
    (GMAIL_APP_PASS ||
     (OAUTH_CLIENT_ID && OAUTH_CLIENT_SECRET && OAUTH_REFRESH_TOKEN))
  );
}

/* OAuth 2.0 access tokens: exchange the refresh token at Google's token
   endpoint with the built-in fetch (Node 18+). Cached until 60 s before
   expiry so consecutive sends don't re-refresh. */
let oauthToken = null; // { accessToken, expiresAt }
async function getAccessToken() {
  if (oauthToken && oauthToken.expiresAt > Date.now() + 60_000) return oauthToken.accessToken;
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: OAUTH_CLIENT_ID,
      client_secret: OAUTH_CLIENT_SECRET,
      refresh_token: OAUTH_REFRESH_TOKEN,
      grant_type: "refresh_token",
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    oauthToken = null;
    throw new Error(`Google token refresh failed: ${data.error_description || data.error || res.status}`);
  }
  oauthToken = { accessToken: data.access_token, expiresAt: Date.now() + (Number(data.expires_in) || 3600) * 1000 };
  return oauthToken.accessToken;
}

function smtpSend(to, subject, text) {
  return (async () => {
    if (!emailConfigured()) {
      console.log(`[mail:demo] To:${to} Subject:${subject}\n${text}`);
      return { demo: true };
    }
    // XOAUTH2 (Production Setup) when OAuth creds are present, PLAIN (App Password) otherwise
    let authCmd;
    if (OAUTH_CLIENT_ID && OAUTH_CLIENT_SECRET && OAUTH_REFRESH_TOKEN) {
      const accessToken = await getAccessToken();
      const xoauth2 = Buffer.from(`user=${GMAIL_USER}\x01auth=Bearer ${accessToken}\x01\x01`).toString("base64");
      authCmd = `AUTH XOAUTH2 ${xoauth2}`;
    } else {
      const plain = Buffer.from(`\x00${GMAIL_USER}\x00${GMAIL_APP_PASS}`).toString("base64");
      authCmd = `AUTH PLAIN ${plain}`;
    }
    const message =
      `From: Quiz Atelier <${GMAIL_USER}>\r\n` +
      `To: <${to}>\r\n` +
      `Subject: ${subject}\r\n` +
      `Content-Type: text/plain; charset=utf-8\r\n` +
      `\r\n` +
      text.replace(/\r?\n/g, "\r\n") + "\r\n.";
    // ordered conversation: each step waits for the expected reply code
    const steps = [
      { expect: 220 },                                            // greeting
      { expect: 250, cmd: "EHLO localhost" },
      { expect: 235, cmd: authCmd },                              // authenticated
      { expect: 250, cmd: `MAIL FROM:<${GMAIL_USER}>` },
      { expect: 250, cmd: `RCPT TO:<${to}>` },
      { expect: 354, cmd: "DATA" },
      { expect: 250, cmd: message },
      { expect: 221, cmd: "QUIT", done: true },
    ];
    let i = 0;
    let buffer = "";
    return await new Promise((resolve, reject) => {
      const socket = tls.connect({ host: "smtp.gmail.com", port: 465 }, () => {
        // greeting arrives asynchronously; nothing to send yet
      });
      socket.on("data", (d) => {
        buffer += d.toString("utf8");
        if (!/\r?\n$/.test(buffer)) return; // wait for the final reply line
        const reply = buffer; buffer = "";
        const code = parseInt(reply.slice(0, 3), 10);
        const step = steps[i];
        if (!step || code !== step.expect) {
          socket.destroy();
          return reject(new Error(`SMTP ${code} (wanted ${step?.expect}): ${reply.trim().slice(0, 200)}`));
        }
        i++;
        if (step.done) { socket.end(); return resolve({ ok: true }); }
        socket.write(step.cmd + "\r\n");
      });
      socket.on("error", reject);
    });
  })();
}

/* ─── OTP for account deletion ──────────────────────────────────── */
const OTP_TTL = 10 * 60 * 1000; // 10 minutes
let pendingOtp = null; // { email, codeHash, expiresAt, attempts }
function otpSend(email) {
  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
  pendingOtp = {
    email,
    codeHash: crypto.scryptSync(code, "qa-otp", 32).toString("hex"),
    expiresAt: Date.now() + OTP_TTL,
    attempts: 0,
  };
  return smtpSend(email, "Your Quiz Atelier verification code",
    `Your verification code is: ${code}\n\nIt expires in 10 minutes.\nIf you didn't request account deletion, ignore this email.`);
}
function otpVerify(email, code) {
  if (!pendingOtp) return "No code requested.";
  if (pendingOtp.email !== email) return "No code requested for this account.";
  if (pendingOtp.expiresAt < Date.now()) { pendingOtp = null; return "Code expired — request a new one."; }
  if (++pendingOtp.attempts > 5) { pendingOtp = null; return "Too many attempts — request a new code."; }
  const hash = crypto.scryptSync(String(code), "qa-otp", 32).toString("hex");
  if (hash !== pendingOtp.codeHash) return "Incorrect code.";
  pendingOtp = null;
  return null; // ok
}

const SESSION_TTL = 1000 * 60 * 60 * 24 * 30; // 30 days

/* ─── static files ─────────────────────────────────────────────── */
function serveStatic(req, res, url) {
  let p = url.pathname === "/" ? "/index.html" : url.pathname;
  const file = path.normalize(path.join(STATIC_DIR, p));
  if (!file.startsWith(STATIC_DIR)) { res.writeHead(403); res.end(); return; }
  fs.readFile(file, (err, buf) => {
    if (err) {
      // SPA-ish fallback: unknown non-file routes get the app shell.
      if (!path.extname(p)) {
        fs.readFile(path.join(STATIC_DIR, "index.html"), (err2, buf2) => {
          if (err2) { res.writeHead(404); res.end("Not found"); return; }
          res.writeHead(200, { "Content-Type": MIME[".html"], "Cache-Control": "no-store" });
          res.end(buf2);
        });
        return;
      }
      res.writeHead(404); res.end("Not found"); return;
    }
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream",
      "Cache-Control": "no-store",
    });
    res.end(buf);
  });
}

/* ─── server ───────────────────────────────────────────────────── */
initDb();
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  if (url.pathname.startsWith("/api/")) {
    handleApi(req, res, url).catch((err) => {
      console.error("[api]", err.message);
      try { sendJson(res, 500, { error: err.message || "server error" }); } catch { /* headers sent */ }
    });
    return;
  }
  serveStatic(req, res, url);
});

server.listen(PORT, HOST, () => {
  console.log(`Quiz Atelier server → http://${HOST}:${PORT}  (db: ${DB_FILE})`);
});
