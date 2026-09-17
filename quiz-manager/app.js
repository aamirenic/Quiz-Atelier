/* ═══════════════════════════════════════════════════════════════════
   Quiz Atelier — application script
   Vanilla JS, no dependencies. State lives in a single object, is
   persisted to localStorage, and every render is a full re-render of
   the affected region (small lists — no virtualization needed).

   Two role-personalised workspaces share one dataset:
     · teacher — subject ledger (conducted, avg marks, attendance),
       builder + roster, class-wide results, AI generator.
     · student — recently attended subjects, open quizzes, personal
       scores vs class average.

   Sections: utils · state · theme · persistence ·
             role gate & chrome · router · toast & dialogs · activity ·
             dashboard (teacher/student) · builder · results · player ·
             AI generator · data I/O · wiring · boot
   ═══════════════════════════════════════════════════════════════════ */
"use strict";

/* ─── utils ──────────────────────────────────────────────────────── */
const $  = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const el = (tag, attrs = {}, ...children) => {
  // svg + its children must be created in the SVG namespace — document.createElement
  // makes HTML-namespace elements the browser won't render (invisible icons bug)
  const SVG_NS = "http://www.w3.org/2000/svg";
  const SVG_TAGS = new Set(["svg", "use", "circle", "path", "rect", "line", "polyline", "polygon", "ellipse", "g", "defs", "symbol", "text", "tspan"]);
  const node = SVG_TAGS.has(tag)
    ? document.createElementNS(SVG_NS, tag)
    : document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null) continue;
    if (typeof v === "boolean") { if (v) node.setAttribute(k, ""); else node.removeAttribute(k); }
    else if (k === "class") node.setAttribute("class", v); // setAttribute: className is read-only on SVG
    else if (k === "text") node.textContent = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const child of children) if (child != null) node.append(child);
  return node;
};

const fmtDate = (ts) =>
  new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(ts));

const fmtDay = (ts) =>
  new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(ts));

/* a quiz is student-visible once it is actually open: published now, or a
   scheduled quiz whose go-live time has passed (private practice always is) */
function isLiveForStudents(q) {
  if (q.practice) return true;
  if (q.scheduledFor) return q.scheduledFor <= Date.now();
  return !!q.published;
}

const uid = () => Math.random().toString(36).slice(2, 10);

const choiceLetters = ["A", "B", "C", "D"];

const iconSvg = (id) =>
  `<svg class="ico" aria-hidden="true"><use href="#${id}"></use></svg>`;

const pctOf = (score, total) => Math.round((score / total) * 100);

/* ─── subjects & roster ──────────────────────────────────────────── */
/* No built-in subjects: create your own via the subject manager (+ New). */
const SUBJECTS = [];

/* No demo roster: the class list is empty until real students are added —
   via import, or derived automatically from attempt data. */
let ROSTER = [];

/* Real auth: sessions live on the server (HttpOnly cookie, 30 days),
   and the cloud workspace DB (server/data/db.json) syncs per user. */
const DEMO_ACCOUNTS = [
  { email: "teacher@quiz.dev", password: "teacher123", role: "teacher", name: "Prof. Meera" },
  { email: "student@quiz.dev", password: "student123", role: "student", name: "Demo Student" },
];

/* Cookie consent — accepted means "you may keep my login session".
   Rejected means no session cookie; the user signs in every visit.
   Nothing except the login decision is ever stored. */
const CONSENT_KEY = "qa-cookie-consent";
const REMEMBER_KEY = "qa-remember-email";
function consentState() {
  try { return localStorage.getItem(CONSENT_KEY); } catch { return null; }
}

/* Dashboard greetings — one is picked at sign-in, then the pool rotates
   on every return to the dashboard. */
const GREETINGS = [
  () => `${timeHello()}, ${state.user?.name ?? "there"}`,
  () => `How's the weather today, ${state.user?.name ?? "there"}?`,
  () => `Welcome back, ${state.user?.name ?? "there"}!`,
  () => `Back to it, ${state.user?.name ?? "there"}.`,
  () => `${state.user?.role === "student" ? "Ready to learn" : "Ready to teach"}, ${state.user?.name ?? "there"}?`,
  () => `Great to see you, ${state.user?.name ?? "there"}.`,
  () => `Let's make today count, ${state.user?.name ?? "there"}.`,
  () => `Quizzes await, ${state.user?.name ?? "there"}.`,
];
let greetIdx = 0;

function timeHello() {
  const h = new Date().getHours();
  return h < 12 ? "Good Morning" : h < 17 ? "Good Afternoon" : "Good Evening";
}

const subjectById = (id) => SUBJECTS.find((s) => s.id === id)
  || SUBJECTS[0]
  || { id: "", name: "No subject", short: "—", accent: "mustard", desc: "" }; // safe when no subjects exist yet

/* ─── state ──────────────────────────────────────────────────────── */
/* v2: one-time cutoff — v1 caches hold deleted demo seed data and must
   never be read again. Bump again only if saved data becomes unreadable. */
const STORE_KEY = "quiz-atelier-v2";
/* in-progress quiz run — device-local (localStorage), per user, so a page
   reload or app restart can resume the run instead of losing the answers */
const RUN_KEY = "quiz-atelier-run";

const state = {
  user: null,     // { id, role, name, username } — from the server session
  cloud: true,    // false when the backend is unreachable (offline demo fallback)
  quizzes: [],   // { id, title, desc, subjectId, published, origin, createdAt, updatedAt, questions: [{id,text,options[4],correct}] }
  attempts: [],  // { id, quizId, quizTitle, subjectId, student, score, total, answers[], ts }
  activity: [],  // { id, kind, text, ts }
  activitySeenTs: 0,  // last time the bell popup was opened (drives the red dot)
  view: "dashboard",
  builderQuizId: null,
  editingQuestionId: null,
  filter: "all",
  lastQuizId: null,
  player: null,  // { quizId, index, answers[] }
  gen: null,     // { source, file, url, draft } — AI generator state
  qTemplates: [], // { id, text, options, correct, ts } — saved question templates
  qFavs: [],     // { id, text, options, correct, ts } — saved favourite questions
  libSeen: { drafts: null, favs: null, bookmarks: null }, // item counts already viewed per library screen
  streak: null,  // { days: ["YYYY-MM-DD"…], lastDay } — quiz-activity streak (student free-tier perks)
  marginNotes: {}, // { [attemptId]: { [qIndex]: text } } — private review margin notes
  reminders: null, // { enabled: bool, time: "HH:MM", lastFired: "YYYY-MM-DD" }
  digest: null,    // { enabled: bool, day: 0-6, lastSent: "YYYY-MM-DD" }
  comebacks: [],   // [{ key, questions[], subjectId, due, title }] — scheduled spaced-repetition rounds
  roster: [],      // explicit student names (import/manager); ROSTER derives from this + attempts
};

const isStudent = () => state.user?.role === "student";

/* Gemini keys are NOT stored client-side anymore. All AI calls route
   through the server proxy (POST /api/ai/generate). To configure the AI:
   set GEMINI_API_KEYS in the server environment before starting server.js. */

/* ─── theme (light default; persisted) ───────────────────────────── */
const THEME_KEY = "quiz-atelier-theme";

function applyTheme(dark) {
  document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", dark ? "#15140f" : "#efe7d2");
  // Topbar button: two pre-rendered sun/moon SVGs, CSS flips visibility per theme.
  // (Older builds used a single <use> href swap — kept null-safe below.)
  const iconUse = $("#topbar-theme use");
  if (iconUse) iconUse.setAttribute("href", `#${dark ? "i-moon" : "i-sun"}`);
  // account-menu theme item: icon + label follow the current theme
  const menuTheme = $("#menu-theme");
  if (menuTheme) {
    menuTheme.querySelector("use")?.setAttribute("href", `#${dark ? "i-sun" : "i-moon"}`);
    const ml = $("#menu-theme-label");
    if (ml) ml.textContent = dark ? "Theme: Dark" : "Theme: Light";
  }
  const sw = $("#theme-switch");
  if (sw) sw.setAttribute("aria-checked", String(dark));
  const label = $("#theme-label");
  if (label) label.textContent = dark ? "Dark" : "Light";
}

function initTheme() {
  let saved = null;
  try { saved = localStorage.getItem(THEME_KEY); } catch { /* default light */ }
  applyTheme(saved === "dark");
}

// NOTE: the topbar theme button is wired inside wireAccountMenu() (toggleTheme).
// Do NOT add a second listener here — a duplicate makes each click toggle twice
// (on→off), which reads as "the button does nothing". That was the v1.6.5 bug.

/* Make sure that the databases for teacher-role and student-role are same for now. Diffrentiate it while making webapp go live.
/* ─── persistence ────────────────────────────────────────────────── */
/* Local cache (fast reloads) + cloud sync (debounced PUT /api/workspace).
   The local cache is PER-USER (keyed by username) so two accounts on the same
   browser never share favourites, templates, or any workspace data. */
function localStoreKey() {
  return state.user?.username ? `${STORE_KEY}:${state.user.username}` : STORE_KEY;
}
function runStoreKey() {
  return state.user?.username ? `${RUN_KEY}:${state.user.username}` : RUN_KEY;
}
function saveRunProgress() {
  const p = state.player;
  if (!p) return;
  try { localStorage.setItem(runStoreKey(), JSON.stringify({
    quizId: p.quizId, practiceQuiz: state.practiceQuiz || null,
    index: p.index, answers: p.answers, removedOptions: p.removedOptions,
    questions: p.questions, startedAt: p.startedAt, qTimes: p.qTimes,
  })); } catch { /* private mode — resume simply won't survive */ }
}
function clearRunProgress() {
  try { localStorage.removeItem(runStoreKey()); } catch { /* ignore */ }
}
/* restore a saved run if it still matches a playable quiz; returns true when resumed */
function resumeRunProgress() {
  let run = null;
  try { run = JSON.parse(localStorage.getItem(runStoreKey()) || "null"); } catch { /* fresh */ }
  if (!run || !run.quizId || !Array.isArray(run.answers)) return false;
  const quiz = run.quizId === state.practiceQuiz?.id ? state.practiceQuiz
    : state.quizzes.find((q) => q.id === run.quizId);
  if (!quiz || isStudent() && !isLiveForStudents(quiz)) { clearRunProgress(); return false; }
  // quiz was edited since the run started (question count changed) — stale
  const questions = Array.isArray(run.questions) && run.questions.length ? run.questions : quiz.questions;
  if (quiz.questions.length !== questions.length) { clearRunProgress(); return false; }
  if (!run.practiceQuiz) state.practiceQuiz = null;
  state.player = {
    quizId: run.quizId, index: Math.min(run.index || 0, questions.length - 1),
    answers: run.answers, removedOptions: run.removedOptions || {},
    questions, startedAt: run.startedAt || Date.now(),
    qStart: Date.now(), qTimes: Array.isArray(run.qTimes) ? run.qTimes : [],
  };
  const sub = subjectById(quiz.subjectId);
  $("#player-eyebrow").textContent = quiz.practice ? `${sub.name} — Practice`
    : isLiveForStudents(quiz) ? `${sub.name} — Now Playing` : `${sub.name} — Preview Draft`;
  $("#player-title").textContent = quiz.title;
  $("#player-body").textContent = "";
  renderQuestion();
  if (quiz.timed && quiz.timeLimit) {
    // remaining time shrinks by the time already spent
    const spent = Math.round((Date.now() - (run.startedAt || Date.now())) / 1000);
    const remaining = quiz.timeLimit - spent;
    if (remaining <= 0) { finishQuiz(quiz); return true; }
    startQuizTimer(quiz, remaining);
  } else {
    stopQuizTimer();
  }
  return true;
}
/* serializing megabytes to localStorage on every save() call blocked the
   main thread (~75ms at 5MB, and save() fires on every interaction) —
   debounce the actual write; flushSave covers unload/hide */
let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(doSave, 350);
  if (state.user && state.cloud) syncSaveSoon();
}
function doSave() {
  clearTimeout(saveTimer);
  try {
    localStorage.setItem(localStoreKey(), JSON.stringify({
      quizzes: state.quizzes,
      attempts: state.attempts,
      activity: state.activity,
      lastQuizId: state.lastQuizId,
      qTemplates: state.qTemplates,
      qFavs: state.qFavs,
      libSeen: state.libSeen,
      streak: state.streak,
      marginNotes: state.marginNotes,
      reminders: state.reminders,
      digest: state.digest,
      comebacks: state.comebacks,
      roster: ROSTER,
      customSubjects: SUBJECTS.filter((s) => s.custom),
      subjectNotices: SUBJECTS.filter((s) => s.notice).map((s) => ({ id: s.id, notice: s.notice })),
    }));
    markSaved();
  } catch {
    markSaved(true);
  }
}

let syncTimer = null;
let syncing = false;
let syncDirty = false;
function syncSaveSoon() {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(syncSave, 1200);
}
async function syncSave() {
  if (!state.user || !state.cloud) return;
  syncing = true;
  const snapshot = {
    quizzes: state.quizzes, attempts: state.attempts,
    activity: state.activity, lastQuizId: state.lastQuizId,
    qTemplates: state.qTemplates, qFavs: state.qFavs,
    roster: ROSTER,
    customSubjects: SUBJECTS.filter((s) => s.custom),
    subjectNotices: SUBJECTS.filter((s) => s.notice).map((s) => ({ id: s.id, notice: s.notice })),
    libSeen: state.libSeen,
    streak: state.streak,
    marginNotes: state.marginNotes,
    reminders: state.reminders,
    digest: state.digest,
    comebacks: state.comebacks,
    // plan membership belongs to the ACCOUNT, not the browser — sync it
    planMeta: { plan: currentPlanId(), planState: { ...planState } },
  };
  try {
    await api("/api/workspace", { method: "PUT", body: JSON.stringify({ workspace: snapshot }) });
    const node = $("#save-status");
    if (node) node.textContent = "Synced to cloud · just now";
  } catch {
    syncDirty = true; // retried on the next change
  } finally {
    syncing = false;
    if (syncDirty) { syncDirty = false; syncSaveSoon(); }
  }
}
function flushSave() {
  clearTimeout(syncTimer);
  doSave(); // write pending state now (page may be going away)
  if (state.user && state.cloud) syncSave(); // fire-and-forget; the PUT is idempotent
}
/* the debounced localStorage write must not die with the page */
addEventListener("beforeunload", flushSave);
document.addEventListener("visibilitychange", () => { if (document.hidden) flushSave(); });

function applyWorkspaceData(data) {
  state.quizzes = data.quizzes;
  state.attempts = data.attempts || [];
  state.activity = data.activity || [];
  state.lastQuizId = data.lastQuizId || state.quizzes[0]?.id || null;
  state.qTemplates = Array.isArray(data.qTemplates) ? data.qTemplates : [];
  state.qFavs = Array.isArray(data.qFavs) ? data.qFavs : [];
  if (data.libSeen && typeof data.libSeen === "object") {
    state.libSeen = { drafts: null, favs: null, bookmarks: null, ...data.libSeen };
  }
  state.streak = data.streak && typeof data.streak === "object" ? data.streak : { days: [], lastDay: null };
  state.marginNotes = data.marginNotes && typeof data.marginNotes === "object" ? data.marginNotes : {};
  state.reminders = data.reminders && typeof data.reminders === "object" ? data.reminders : { enabled: false, time: "18:00", lastFired: null };
  state.digest = data.digest && typeof data.digest === "object" ? data.digest : { enabled: false, day: 6, lastSent: null };
  state.comebacks = Array.isArray(data.comebacks) ? data.comebacks : [];
  state.roster = Array.isArray(data.roster) ? data.roster : [];
  syncRoster();
  for (const s of (Array.isArray(data.customSubjects) ? data.customSubjects : [])) {
    if (s?.id && !SUBJECTS.some((x) => x.id === s.id)) SUBJECTS.push(s);
  }
  // pinned notices can ride on built-in subjects too — restore by id
  for (const n of (Array.isArray(data.subjectNotices) ? data.subjectNotices : [])) {
    const sub = SUBJECTS.find((s) => s.id === n?.id);
    if (sub && n.notice?.name) sub.notice = n.notice;
  }
  migrateWorkspace();
  // subjects may have just arrived with the workspace — the builder/generator
  // <select>s were populated at boot when SUBJECTS was still empty
  refreshSubjectPickers();
}

function loadWorkspace(workspace) {
  if (workspace && Array.isArray(workspace.quizzes) && workspace.quizzes.length) {
    applyWorkspaceData(workspace);
    return;
  }
  // Cloud workspace exists but is EMPTY: honor it — wipe any stale local
  // cache so old data can't resurrect and re-upload to the server.
  if (workspace && Array.isArray(workspace.quizzes) && !workspace.quizzes.length) {
    try { localStorage.removeItem(localStoreKey()); } catch { /* private mode */ }
  }
  // No cloud workspace: use THIS user's local cache, else start empty.
  let data = null;
  try { data = JSON.parse(localStorage.getItem(localStoreKey()) || "null"); } catch { /* fresh */ }
  if (!data && state.user?.username) {
    // One-time migration: the pre-per-user build stored everything under the
    // shared legacy key — adopt it as this account's cache, then diverge.
    try { data = JSON.parse(localStorage.getItem(STORE_KEY) || "null"); } catch { /* fresh */ }
  }
  if (data && Array.isArray(data.quizzes) && data.quizzes.length) {
    applyWorkspaceData(data);
  } else {
    // Fresh workspace: start empty — no demo seed data.
    state.quizzes = [];
    state.attempts = [];
    state.activity = [];
    state.lastQuizId = null;
    save();
  }
}

let saveStatusTimer;
function markSaved(failed = false) {
  const node = $("#save-status");
  if (!node) return;
  clearTimeout(saveStatusTimer);
  node.textContent = failed
    ? "Storage unavailable — export JSON to keep data"
    : "Saved locally · just now";
  saveStatusTimer = setTimeout(() => {
    const t = state.activity[0]?.ts;
    node.textContent = state.cloud && state.user && t
      ? `Synced to cloud · ${fmtDay(t)}`
      : t ? `Saved locally · ${fmtDay(t)}` : "";
  }, 4000);
}

function load() {
  let data = null;
  try { data = JSON.parse(localStorage.getItem(STORE_KEY) || "null"); } catch { /* fresh start */ }

  if (data && Array.isArray(data.quizzes) && data.quizzes.length) {
    state.quizzes = data.quizzes;
    state.attempts = Array.isArray(data.attempts) ? data.attempts : [];
    state.activity = Array.isArray(data.activity) ? data.activity : [];
    state.lastQuizId = data.lastQuizId || state.quizzes[0]?.id || null;
    state.qTemplates = Array.isArray(data.qTemplates) ? data.qTemplates : [];
    state.qFavs = Array.isArray(data.qFavs) ? data.qFavs : [];
    for (const s of (Array.isArray(data.customSubjects) ? data.customSubjects : [])) {
      if (s?.id && !SUBJECTS.some((x) => x.id === s.id)) SUBJECTS.push(s);
    }
    // pinned notices can ride on built-in subjects too — restore by id
    for (const n of (Array.isArray(data.subjectNotices) ? data.subjectNotices : [])) {
      const sub = SUBJECTS.find((s) => s.id === n?.id);
      if (sub && n.notice?.name) sub.notice = n.notice;
    }
    if (data.libSeen && typeof data.libSeen === "object") {
      state.libSeen = { drafts: null, favs: null, bookmarks: null, ...data.libSeen };
    }
    state.comebacks = Array.isArray(data.comebacks) ? data.comebacks : [];
    state.roster = Array.isArray(data.roster) ? data.roster : [];
    syncRoster();
  } else {
    // Fresh workspace: start empty — no demo seed data.
    state.quizzes = [];
    state.attempts = [];
    state.activity = [];
    state.lastQuizId = null;
    save();
  }
  migrateWorkspace();
}

/* Older workspaces predate subjects — backfill the first known subject (if any). */
function migrateWorkspace() {
  const known = (id) => SUBJECTS.some((s) => s.id === id);
  const firstSubject = () => SUBJECTS[0]?.id || null;
  if (SUBJECTS.length) {
    state.quizzes.forEach((q) => {
      if (!known(q.subjectId)) q.subjectId = firstSubject();
    });
  }
  const byId = new Map(state.quizzes.map((q) => [q.id, q]));
  state.attempts.forEach((a) => {
    const q = byId.get(a.quizId);
    if (SUBJECTS.length && !known(a.subjectId)) a.subjectId = q?.subjectId || firstSubject();
    if (!a.student) a.student = a.player || state.user?.name || "Student";
  });
  // templates / favourites: dedupe exact copies and trim to the plan's allowance —
  // data saved before limits existed (or double-saves) can't outlive the tier cap.
  for (const key of ["qTemplates", "qFavs"]) {
    const list = state[key];
    if (!Array.isArray(list) || list.length <= 1) continue;
    const seen = new Set();
    const deduped = list.filter((e) => {
      const sig = `${e.text}|${e.correct}|${(e.options || []).join("|")}`;
      if (seen.has(sig)) return false;
      seen.add(sig);
      return true;
    });
    state[key] = deduped;
  }
}

/* ─── roster: explicit list + names derived from attempt data ────── */
function syncRoster() {
  // Union of the stored roster and every student name seen in attempts —
  // so imported workspaces populate the class list without extra config.
  const names = new Set(state.roster || []);
  for (const a of state.attempts) {
    const n = (a.student || "").trim();
    if (n && n !== "—") names.add(n);
  }
  ROSTER = [...names].sort((x, y) => x.localeCompare(y));
}

/* ─── auth (server-backed, with offline fallback) ─────────────────── */
/* Login gate is a two-step flow: choose Student/Teacher first, then the
   email sign-in form for that role (new emails become sign-ups). */
let loginRole = null; // "student" | "teacher" once chosen

function showLogin() {
  const gate = $("#login-gate");
  if (!gate) return;
  gate.hidden = false;
  syncScrollLock();
  loginRole = null;
  $("#login-title").textContent = "Welcome to Quiz Atelier";
  $("#login-note").textContent = "First, tell us who's here.";
  $("#gate-choices").hidden = false;
  $("#login-form").hidden = true;
  $("#login-error").hidden = true;
  $("#login-pass-error").hidden = true;
  $("#login-user").value = "";
  $("#login-name").value = "";
  $("#login-pass").value = "";
}

function chooseLoginRole(role) {
  loginRole = role;
  $("#login-title").textContent = role === "teacher" ? "Teacher Sign In" : "Student Sign In";
  $("#login-note").textContent =
    role === "teacher"
      ? "Sign in with your teacher email — new emails become teacher accounts."
      : "Sign in with your student email — new emails become student accounts.";
  $("#gate-choices").hidden = true;
  $("#login-form").hidden = false;
  try { $("#login-user").value = localStorage.getItem(REMEMBER_KEY) || ""; } catch { /* fresh */ }
  $("#login-user").focus();
}

async function api(pathname, opts = {}) {
  let res;
  try {
    res = await fetch(pathname, {
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      ...opts,
    });
  } catch {
    // fetch() throws TypeError("Failed to fetch") when offline — surface a
    // human message everywhere instead of leaking the raw browser error.
    const err = new Error("You're offline — changes will sync when you reconnect");
    err.offline = true; // status stays undefined: login's offline-demo fallback still triggers
    throw err;
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 502 || res.status === 503 || res.status === 504) {
      // the Android WebView serves a synthetic "503 Offline" response instead
      // of rejecting fetch when the network is gone — treat it identically
      const err = new Error("You're offline — changes will sync when you reconnect");
      err.offline = true; // status stays undefined: login's offline-demo fallback still triggers
      throw err;
    }
    const err = new Error(data.error || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

async function restoreSession() {
  let sess = null;
  try {
    sess = await api("/api/session");
    state.cloud = true;
  } catch { state.cloud = false; return; }
  if (sess?.user) signIn(sess.user, sess.workspace); // 200 + user:null = signed out
}

async function handleLogin(e) {
  e.preventDefault();
  const email = $("#login-user").value.trim().toLowerCase();
  const pass = $("#login-pass").value;
  const name = $("#login-name").value.trim();
  const err = $("#login-error");
  const passErr = $("#login-pass-error");

  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!EMAIL_RE.test(email)) {
    err.textContent = "Enter a valid email address.";
    err.hidden = false;
    $("#login-user").focus();
    return;
  }
  const knownDemo = DEMO_ACCOUNTS.some((a) => a.email === email);
  const isNew = !knownDemo && loginRole === "teacher"; // students never self-signup
  passErr.hidden = !(isNew && pass.length < 6);
  if (passErr.hidden === false) { $("#login-pass").focus(); return; }

  const btn = $("#btn-login");
  const authFail = (ex) => {
    if (ex.status === undefined) {
      // Server unreachable — fall back to offline demo mode.
      const acct = DEMO_ACCOUNTS.find((a) => a.email === email);
      if (acct && acct.password === pass && acct.role === loginRole) {
        state.cloud = false;
        err.hidden = true;
        signIn(acct);
        toast("Server unreachable — running in offline demo mode");
      } else {
        err.textContent = "Server unreachable — demo accounts: teacher@quiz.dev / teacher123 or student@quiz.dev / student123.";
        err.hidden = false;
        $("#login-pass").focus();
      }
    } else {
      err.textContent = ex.message;
      err.hidden = false;
      $("#login-pass").focus();
    }
    btn.disabled = false;
  };
  if (!knownDemo && loginRole === "student") {
    // Student accounts are teacher-issued only — no self-signup path.
    err.textContent = "No student account with that email. Your teacher creates student logins — ask them to issue your credentials.";
    err.hidden = false;
    $("#login-user").focus();
    return;
  }
  if (isNew) {
    // A login typo must never silently become a new account: confirm,
    // and never create one without a name.
    if (!name) {
      err.textContent = "Enter your full name to create a new account.";
      err.hidden = false;
      $("#login-name").focus();
      return;
    }
    askConfirm(
      "Create a new account?",
      `No account exists for ${email}. Create one as a ${loginRole} named “${name}”?`,
      "Yes, create it",
      async () => {
        btn.disabled = true;
        try {
          const consent = consentState();
          const data = await api("/api/signup", {
            method: "POST",
            body: JSON.stringify({ email, password: pass, role: loginRole, name, consent }),
          });
          state.cloud = true;
          err.hidden = true;
          try { localStorage.setItem(REMEMBER_KEY, email); } catch { /* private mode */ }
          signIn(data.user, data.workspace, "Created your account");
        } catch (ex) {
          authFail(ex);
        }
      },
      "No, go back",
    );
    return;
  }
  btn.disabled = true;
  try {
    const consent = consentState();
    const data = await api("/api/login", {
      method: "POST",
      body: JSON.stringify({ email, password: pass, role: loginRole, consent }),
    });
    state.cloud = true;
    err.hidden = true;
    signIn(data.user, data.workspace, null);
  } catch (ex) {
    authFail(ex);
  }
}

function signIn(user, workspace = null, note = null) {
  state.user = { id: user.id || user.email || user.username, role: user.role, name: user.name, username: user.email || user.username };
  loadPlanState();
  // plan is account-level: the server's synced planMeta wins over this browser's copy
  if (workspace?.planMeta?.plan) {
    try { localStorage.setItem(PLAN_KEY(state.user?.username), workspace.planMeta.plan); } catch { /* private mode */ }
    if (workspace.planMeta.planState && typeof workspace.planMeta.planState === "object") {
      planState = { ...planState, ...workspace.planMeta.planState };
      savePlanState();
    }
  }
  checkPlanTransition();
  maybeDailyDowngradeNotice();
  greetIdx = Math.floor(Math.random() * GREETINGS.length);
  $("#login-error").textContent = "";
  $("#login-gate").hidden = true;
  syncScrollLock();
  loadWorkspace(workspace);
  applyRoleChrome();
  updateAccountUI();
  renderAll();
  setView("dashboard");
  scrollPageTop();
  // an interrupted run from a previous session picks up where it left off
  if (resumeRunProgress()) {
    openModal("#player-modal");
    toast(`Resuming “${$("#player-title").textContent}” — your answers were kept`);
  } else {
    toast(note || `Welcome, ${user.name} — signed in as ${user.role}`);
  }
}

async function signOut() {
  try { await api("/api/logout", { method: "POST", body: "{}" }); } catch { /* already out */ }
  clearTimeout(syncTimer); // drop any pending sync — the session is gone
  state.user = null;
  state.quizzes = []; state.attempts = []; state.activity = []; state.lastQuizId = null;
  state.view = "dashboard";
  showLogin();
  toast("Signed out");
}

/* ─── account menu ──────────────────────────────────────────────── */
function updateAccountUI() {
  const u = state.user;
  if (!u) return;
  $("#account-name").textContent = u.name;
  $("#account-avatar").textContent = u.name.trim().charAt(0).toUpperCase();
  $("#account-menu-name").textContent = u.name;
  const plan = PLANS[isStudent() ? "student" : "teacher"].find((p) => p.id === currentPlanId());
  $("#account-menu-role").textContent =
    `${u.role.charAt(0).toUpperCase() + u.role.slice(1)} · @${u.username}${plan ? ` · ${plan.name}` : ""}${state.cloud ? "" : " · offline mode"}`;
}

function closeAccountMenu() {
  $("#account-menu").hidden = true;
  $("#account-btn").setAttribute("aria-expanded", "false");
}

/* ─── plans (membership tiers, shown in the account menu) ───────── */
const PLANS = {
  teacher: [
    {
      id: "lenient", name: "Lenient", price: null, tag: "For Memory", current: true,
      limits: ["15 quizzes per day", "10 subjects", "10 AI generations per day", "10 reusable templates", "50 favorite questions"],
      feats: [
        "Weekly class digest — auto-summary",
        "Student snapshot cards",
      ],
    },
    {
      id: "caring", name: "Caring", price: "$3", per: "/mo", tag: "For Understanding",
      limits: ["30 quizzes per day", "20 subjects", "20 AI generations per day", "20 reusable templates", "100 favorite questions"],
      feats: [
        "Everything in Lenient, plus:",
        "Advanced leaderboards — week / unit / section filters",
        "Printable completion certificates",
      ],
    },
    {
      id: "strict", name: "Strict", price: "$5", per: "/mo", tag: "For Reflection",
      limits: ["50 quizzes per day", "30 subjects", "30 AI generations per day", "50 reusable templates", "500 favorite questions"],
      feats: [
        "Everything in Caring, plus:",
        "Mastery heatmap — weak-topic analytics",
        "Co-teacher seat — bring somebody on board",
        ],
    },
  ],
  student: [
    {
      id: "backbencher", name: "Backbenchers", price: null, tag: "For Akko Kagaris", current: true,
      limits: ["10 AI practice generations per day", "10 reusable templates"],
      feats: [
        "Streaks & badges",
        "The Graveyard — every miss, resurrectable",
        "Bring wrong answers back tomorrow",
        "3 “explain simply” rewrites per day",
        "Margin notes while reviewing attempts",
        "Practice reminders",
        "Weekly self-digest email",
      ],
    },
    {
      id: "average", name: "Averages", price: "$3", per: "/mo", tag: "For Hitohito Tadanos",
      limits: ["20 AI practice generations per day", "20 reusable templates"],
      feats: [
        "Everything in Backbencher, plus:",
        "Daily warm-up — 5 weakest questions, every day",
        "Unlimited “explain simply” rewrites",
        "Flashcards auto-built from wrong answers",
        "Subject goals — target average & tracking",
        "Offline practice pack",
      ],
    },
    {
      id: "nerd", name: "Class Nerds", price: "$5", per: "/mo", tag: "For Kiyotaka Ayanokojis",
      limits: ["25 AI practice generations per day", "30 reusable templates"],
      feats: [
        "Everything in Average, plus:",
        "AI tutor mode — step-by-step explanations",
        "Exam simulator — timed mock from past quizzes",
        "Custom practice — difficulty & topic focus",
        "Full revision history — synced & searchable",
        "Achievement vault + printable progress report",
      ],
    },
  ],
};

const PLAN_KEY = (email) => `qa-plan-${email || "anon"}`;
function currentPlanId() {
  try { return localStorage.getItem(PLAN_KEY(state.user?.username)) || PLANS[isStudent() ? "student" : "teacher"][0].id; }
  catch { return PLANS[isStudent() ? "student" : "teacher"][0].id; }
}
function setPlan(id) {
  try { localStorage.setItem(PLAN_KEY(state.user?.username), id); } catch { /* private mode */ }
  checkPlanTransition();
  updateAccountUI();
  save(); // sync the plan change to the cloud so it follows the account
}

/* ─── plan limits & enforcement ──────────────────────────────────── */
const PLAN_LIMITS = {
  // teacher tiers
  lenient:   { quizzesPerDay: 15, subjects: 10, aiPerDay: 10, templates: 10, favs: 50 },
  caring:    { quizzesPerDay: 30, subjects: 20, aiPerDay: 20, templates: 20, favs: 100 },
  strict:    { quizzesPerDay: 50, subjects: 30, aiPerDay: 30, templates: 50, favs: 500 },
  // student tiers
  backbencher: { aiPerDay: 10, quizzesPerDay: 15, templates: 10, favs: 50, eli5PerDay: 3 },
  average:     { aiPerDay: 20, quizzesPerDay: 30, templates: 20, favs: 100 },
  nerd:        { aiPerDay: 25, quizzesPerDay: 50, templates: 30, favs: 500 },
};
const planLimit = (key) => PLAN_LIMITS[currentPlanId()]?.[key] ?? Infinity;
const planRank = (id) => PLANS[isStudent() ? "student" : "teacher"].findIndex((p) => p.id === id);

/* downgrade tracking: { planId, downgradedAt, downgradedFrom, lastNotifiedDay } */
const PLAN_STATE_KEY = (u) => `qa-plan-state-${u || "anon"}`;
let planState = { planId: null, downgradedAt: null, downgradedFrom: null, lastNotifiedDay: null };
function loadPlanState() {
  try { planState = { ...planState, ...(JSON.parse(localStorage.getItem(PLAN_STATE_KEY(state.user?.username)) || "null") || {}) }; }
  catch { /* fresh state */ }
}
function savePlanState() {
  try { localStorage.setItem(PLAN_STATE_KEY(state.user?.username), JSON.stringify(planState)); } catch { /* private mode */ }
}
function checkPlanTransition() {
  const cur = currentPlanId();
  if (planState.planId && planState.planId !== cur) {
    if (planRank(cur) < planRank(planState.planId)) {
      // downgrade — start a fresh 3-day grace window
      const fromName = PLANS[isStudent() ? "student" : "teacher"].find((p) => p.id === planState.planId)?.name || "previous";
      planState.downgradedAt = Date.now();
      planState.downgradedFrom = fromName;
      planState.lastNotifiedDay = null;
    } else {
      planState.downgradedAt = null; // upgrade clears the expired-plan state
      planState.downgradedFrom = null;
    }
  }
  planState.planId = cur;
  savePlanState();
}
const downgradeDays = () => planState.downgradedAt ? (Date.now() - planState.downgradedAt) / 86400000 : 0;
const planGraceOver = () => !!planState.downgradedAt && downgradeDays() >= 3;
const planHasEnded = () => !!planState.downgradedAt;

function maybeDailyDowngradeNotice() {
  if (!planHasEnded()) return;
  const day = new Date().toDateString();
  if (planState.lastNotifiedDay === day) return;
  planState.lastNotifiedDay = day;
  savePlanState();
  toast(`Your ${planState.downgradedFrom || "previous"} plan has ended. Upgrade now to retain your benefits.`);
}

/* per-day usage counters (AI generations, quizzes created) */
const USAGE_KEY = (u) => `qa-usage-${u || "anon"}`;
function todayUsage() {
  const d = new Date().toDateString();
  try {
    const u = JSON.parse(localStorage.getItem(USAGE_KEY(state.user?.username)) || "null");
    return u?.day === d ? (u.counts || {}) : {};
  } catch { return {}; }
}
function bumpUsage(key) {
  const d = new Date().toDateString();
  let u = null;
  try { u = JSON.parse(localStorage.getItem(USAGE_KEY(state.user?.username)) || "null"); } catch { /* fresh */ }
  const counts = u?.day === d ? (u.counts || {}) : {};
  counts[key] = (counts[key] || 0) + 1;
  try { localStorage.setItem(USAGE_KEY(state.user?.username), JSON.stringify({ day: d, counts })); } catch { /* private mode */ }
}

/* the little bottom-middle popup */
let upgradeTimer;
function showUpgradePopup() {
  let pop = document.querySelector(".upgrade-pop");
  if (!pop) {
    pop = el("button", { class: "upgrade-pop", type: "button", text: "Upgrade to continue.", title: "View plans" });
    pop.addEventListener("click", () => { pop.remove(); openPlans(); });
    document.body.append(pop);
  }
  clearTimeout(upgradeTimer);
  upgradeTimer = setTimeout(() => pop.remove(), 3000);
}

/* gate helper — false means blocked (popup already shown) */
function limitGate(key, currentCount) {
  if (currentCount < planLimit(key)) return true;
  showUpgradePopup();
  return false;
}

function renderPlans() {
  const grid = $("#plans-grid");
  grid.textContent = "";
  const activeId = currentPlanId();
  for (const plan of PLANS[isStudent() ? "student" : "teacher"]) {
    const isCurrent = plan.id === activeId;
    grid.append(el("article", { class: `plan${isCurrent ? " plan--current" : ""}` },
      el("div", { class: "plan__top" },
        el("span", { class: "plan__name", text: plan.name }),
        el("span", { class: "plan__price" },
          plan.price ? el("b", { text: plan.price }) : null,
          plan.price ? document.createTextNode(plan.per || "") : null,
          plan.price ? null : el("span", { class: "pill pill--live", text: "Current" }))),
      el("p", { class: "plan__tag", text: plan.tag }),
      el("ul", { class: "plan__limits" },
        ...plan.limits.map((f) => el("li", {},
          el("span", { class: "tick", text: "✓", "aria-hidden": "true" }),
          el("span", { text: f })))),
      el("ul", { class: "plan__feats" },
        ...plan.feats.map((f) => el("li", {},
          el("span", { class: "tick", text: "◆", "aria-hidden": "true" }),
          el("span", { text: f })))),
      isCurrent
        ? el("button", { class: "btn btn--outline", type: "button", disabled: true, text: "Your current plan" })
        : el("button", {
            class: "btn btn--primary", type: "button",
            text: `Switch to ${plan.name}${plan.price ? ` — ${plan.price}${plan.per || ""}` : ""}`,
            onclick: () => {
              askConfirm(`Switch to ${plan.name}?`,
                "",
                `Switch to ${plan.name}`,
                () => {
                  setPlan(plan.id);
                  renderPlans();
                  toast(`You're on ${plan.name}${plan.price ? ` — ${plan.price}${plan.per || ""} (billed at go-live)` : ""}`);
                });
            },
          }),
    ));
  }
}

function openPlans() {
  renderPlans();
  openModal("#plans-modal");
}

function wireAccountMenu() {
  $("#account-btn").addEventListener("click", (e) => {
    e.stopPropagation();
    const menu = $("#account-menu");
    const open = menu.hidden;
    menu.hidden = !open;
    $("#account-btn").setAttribute("aria-expanded", String(open));
  });
  document.addEventListener("click", (e) => {
    if (!$("#account-menu").hidden && !e.target.closest(".account")) closeAccountMenu();
    if (!$("#new-menu").hidden && !e.target.closest("#new-menu-wrap")) {
      $("#new-menu").hidden = true;
      $("#btn-new-menu").setAttribute("aria-expanded", "false");
    }
    if (!$("#bell-pop").hidden && !e.target.closest("#bell-pop, #bell-wrap")) closeBellPop();
    if (ctxSubjectId != null && !e.target.closest(".ctx-menu")) closeCtxMenu();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if (!$("#account-menu").hidden) { closeAccountMenu(); $("#account-btn").focus(); }
      if (!$("#new-menu").hidden) {
        $("#new-menu").hidden = true;
        $("#btn-new-menu").setAttribute("aria-expanded", "false");
        $("#btn-new-menu").focus();
      }
      closeBellPop();
      if (ctxSubjectId != null) closeCtxMenu();
    }
  });
  // theme toggle lives in the account menu — keeps the topbar to one clean row
  const toggleTheme = () => {
    const dark = document.documentElement.getAttribute("data-theme") !== "dark";
    applyTheme(dark);
    try { localStorage.setItem(THEME_KEY, dark ? "dark" : "light"); } catch { /* private mode */ }
  };
  $("#menu-theme").addEventListener("click", toggleTheme);
  $("#topbar-theme").addEventListener("click", toggleTheme);
  $("#menu-plans").addEventListener("click", () => { closeAccountMenu(); openPlans(); });
  $("#menu-signout").addEventListener("click", () => { closeAccountMenu(); signOut(); });
  // data I/O — mirrors the desktop rail's Data block (rail is hidden ≤640px,
  // so the Android app reaches Export/Import/Delete through this menu)
  $("#menu-export").addEventListener("click", () => { closeAccountMenu(); exportJSON(); });
  $("#menu-import").addEventListener("click", () => { closeAccountMenu(); openImport(); });
  $("#menu-reset").addEventListener("click", () => { closeAccountMenu(); resetDemo(); });
  $("#btn-close-plans").addEventListener("click", () => closeModal("#plans-modal"));
}

function wireLogin() {
  $("#login-form").addEventListener("submit", handleLogin);
  $("#gate-student").addEventListener("click", () => chooseLoginRole("student"));
  $("#gate-teacher").addEventListener("click", () => chooseLoginRole("teacher"));
  $("#btn-gate-back").addEventListener("click", showLogin);
  for (const btn of $$('[data-fill]')) {
    btn.addEventListener("click", () => {
      const acct = DEMO_ACCOUNTS.find((a) => a.role === btn.dataset.fill);
      if (!acct) return;
      loginRole = acct.role; // the demo chips fill the matching role directly
      $("#login-title").textContent = acct.role === "teacher" ? "Teacher Sign In" : "Student Sign In";
      $("#login-note").textContent = "Sign in with your email — new emails become new accounts.";
      $("#gate-choices").hidden = true;
      $("#login-form").hidden = false;
      $("#login-user").value = acct.email;
      $("#login-pass").value = acct.password;
      $("#login-error").hidden = true;
      $("#btn-login").focus();
    });
  }
}

/* ─── cookie consent ────────────────────────────────────────────── */
/* Only an explicit ACCEPT is remembered. Decline and X (close) are NOT
   persisted — the banner reappears on every visit until the user accepts,
   and no session cookie is kept, so they sign in each time. */
function showConsentIfNeeded() {
  if (consentState() !== "accepted") $("#consent-banner").hidden = false;
}
async function recordConsent(accepted) {
  if (accepted) {
    try { localStorage.setItem(CONSENT_KEY, "accepted"); } catch { /* private mode */ }
  } else {
    // nothing is stored — the banner returns next visit
    try { localStorage.removeItem(CONSENT_KEY); localStorage.removeItem(REMEMBER_KEY); } catch { /* ignore */ }
  }
  $("#consent-banner").hidden = true;
  try { await api("/api/consent", { method: "POST", body: JSON.stringify({ consent: accepted ? "accepted" : "rejected" }) }); }
  catch { /* offline — local choice still honored */ }
  if (accepted && state.cloud) { try { await restoreSession(); } catch { /* stays signed out */ } }
  toast(accepted ? "Cookies accepted — you'll stay signed in" : "Cookies rejected — you'll sign in each visit");
}

function applyRoleChrome() {
  const student = isStudent();
  document.body.classList.toggle("role-student", student);
  document.body.classList.toggle("role-teacher", !student);
  $("#role-badge").textContent = student ? "Student" : "Teacher";
  $("#rail-nav-eyebrow").textContent = student ? "Learn" : "Compose";
  $("#rail-results-label").textContent = student ? "My Scores" : "Results";
  $("#rail-gen-label").textContent = student ? "AI Practice" : "AI Generator";
  // phone tab bar: hide the Build tab for students, relabel Scores
  for (const btn of $$(".tabbar__btn[data-tab-teacher]")) btn.hidden = student;
  const tabResults = $("#tab-results-label");
  if (tabResults) tabResults.textContent = student ? "Scores" : "Results";
  $("#rail-teacher-only").hidden = student;
  $("#rail-student-only").hidden = !student;
  // account-menu Data items are teacher-only (they mirror the rail's Data block)
  // — but APK-only items stay hidden on the webapp regardless of role: the APK
  // needs them because its rail is hidden, the webapp's rail provides them.
  const onApk = location.hostname.includes("appassets");
  for (const item of $$("#account-menu [data-teacher-only]")) item.hidden = student || !onApk;
  // AI panel doubles as the student's practice generator
  $("#gen-form-title").textContent = student ? "Practice From Your Notes" : "From Your Notes";
  $("#gen-file-note").textContent = student
    ? "Class notes, textbook chapters — turn them into practice · up to 15\u00a0MB"
    : "Lecture notes, slides exports, chapters — up to 15\u00a0MB";
  $("#gen-save-label").textContent = student ? "Add to My Practice" : "Save to Workspace";
  $("#gen-idle .empty__title").textContent = student ? "Your practice set lands here" : "Generated questions land here";
  $("#gen-idle .empty__note").textContent = student
    ? "Drop a PDF or paste a YouTube link, pick the subject, and a practice quiz is drafted for you — nothing is shared with your teacher."
    : "Drop a PDF or paste a YouTube link, pick the subject, and the drafted quiz appears on the right for review before anything is saved.";
  if (student) renderNextUp();
  $("#gen-subject-field").hidden = student; // practice auto-targets the current subject
  $("#new-menu-wrap").hidden = student; // students create neither quizzes nor subjects
  // the bell serves both roles: teacher sees workspace activity, student sees recent scores
  $("#btn-open-last").hidden = !student;
}

/* ─── subjects: custom subjects persist with the workspace ───────── */
function refreshSubjectPickers() {
  for (const sel of ["#quiz-subject", "#gen-subject"]) {
    const node = $(sel);
    if (!node) continue;
    const current = node.value;
    node.textContent = "";
    for (const s of SUBJECTS) {
      node.append(el("option", { value: s.id, text: s.name }));
    }
    if ([...node.options].some((o) => o.value === current)) node.value = current;
  }
}

function promptNewSubject() {
  // themed centered modal instead of the browser prompt()
  subjectModalEditId = null;
  $("#subject-title").textContent = "New Subject";
  $("#btn-subject-ok").textContent = "Add Subject";
  $("#subject-name").value = "";
  $("#subject-short").value = "";
  $("#subject-desc").value = "";
  $("#subject-error").hidden = true;
  $$("#subject-accent-row .subject-accent").forEach((b, i) => {
    b.classList.toggle("is-active", i === 0);
    b.setAttribute("aria-pressed", String(i === 0));
  });
  openModal("#subject-modal");
  $("#subject-name").focus();
}

/* right-click → Edit subject details: same modal, prefilled */
function promptEditSubject(subId) {
  const sub = SUBJECTS.find((s) => s.id === subId);
  if (!sub) return;
  subjectModalEditId = subId;
  $("#subject-title").textContent = "Edit Subject Details";
  $("#btn-subject-ok").textContent = "Save Changes";
  $("#subject-name").value = sub.name;
  $("#subject-short").value = sub.short || "";
  $("#subject-desc").value = sub.desc || "";
  $("#subject-error").hidden = true;
  $$("#subject-accent-row .subject-accent").forEach((b) => {
    const active = b.dataset.accent === (sub.accent || "coral");
    b.classList.toggle("is-active", active);
    b.setAttribute("aria-pressed", String(active));
  });
  openModal("#subject-modal");
  $("#subject-name").focus();
}

/* right-click → Add pinned notice (blank form; saving replaces any previous notice) */
function promptAddNotice(subId) {
  const sub = SUBJECTS.find((s) => s.id === subId);
  if (!sub) return;
  noticeSubjectId = subId;
  $("#notice-title").textContent = `Add Pinned Notice — ${sub.name}`;
  $("#notice-name").value = "";
  $("#notice-desc").value = "";
  openModal("#notice-modal");
  $("#notice-name").focus();
}

function saveNoticeFromModal() {
  const sub = SUBJECTS.find((s) => s.id === noticeSubjectId);
  if (!sub) { closeModal("#notice-modal"); return; }
  const name = $("#notice-name").value.trim();
  if (!name) { $("#notice-name").focus(); return; }
  const desc = $("#notice-desc").value.trim();
  sub.notice = { name, desc };
  save();
  closeModal("#notice-modal");
  renderAll();
  toast("Notice pinned");
  logActivity("edit", `Pinned a notice on “${sub.name}”`);
}

/* right-click → Delete subject (confirm, red) */
function askDeleteSubject(subId) {
  const sub = SUBJECTS.find((s) => s.id === subId);
  if (!sub) return;
  askConfirm("Are you sure you want to DELETE this subject?",
    `“${sub.name}” and its subject entry will be removed. Logged attempts stay in the results ledger.`,
    "Delete",
    () => {
      const idx = SUBJECTS.findIndex((s) => s.id === subId);
      if (idx !== -1) SUBJECTS.splice(idx, 1);
      if (lbSubjectId === subId) lbSubjectId = SUBJECTS[0]?.id ?? "";
      save();
      refreshSubjectPickers();
      renderAll();
      toast(`Subject “${sub.name}” deleted`);
      logActivity("edit", `Deleted subject “${sub.name}”`);
    });
}

function currentSubjectAccent() {
  return $("#subject-accent-row .subject-accent.is-active")?.dataset.accent || "coral";
}

let subjectModalEditId = null;
let noticeSubjectId = null;

function addSubjectFromModal() {
  const name = $("#subject-name").value.trim();
  const short = $("#subject-short").value.trim() || name.slice(0, 4);
  const desc = $("#subject-desc").value.trim();
  const err = $("#subject-error");
  if (!name) { err.textContent = "Give the subject a name first."; err.hidden = false; $("#subject-name").focus(); return; }
  const id = short.toLowerCase().replace(/[^a-z0-9]+/g, "-");

  // editing an existing subject — update in place, keep its id
  if (subjectModalEditId) {
    const sub = SUBJECTS.find((s) => s.id === subjectModalEditId);
    if (sub) {
      sub.name = name; sub.short = short; sub.desc = desc; sub.accent = currentSubjectAccent();
      save(); refreshSubjectPickers();
      closeModal("#subject-modal"); renderAll();
      toast(`Subject “${name}” updated`);
      logActivity("edit", `Edited subject “${name}”`);
    }
    subjectModalEditId = null;
    return;
  }

  if (SUBJECTS.some((s) => s.id === id)) {
    err.textContent = `Short code “${short}” is already taken — pick another.`;
    err.hidden = false;
    $("#subject-short").focus();
    return;
  }
  if (!limitGate("subjects", SUBJECTS.length)) { closeModal("#subject-modal"); return; }
  SUBJECTS.push({ id, name, short, desc, accent: currentSubjectAccent(), custom: true });
  save();
  refreshSubjectPickers();
  closeModal("#subject-modal");
  renderAll();
  toast(`Subject “${name}” added`);
  logActivity("edit", `Added subject “${name}”`);
}

/* ─── student credentials: teacher issues & publishes accounts ──── */
function promptNewStudent() {
  $("#student-name").value = "";
  $("#student-email").value = "";
  $("#student-pass").value = "";
  $("#student-publish").checked = true;
  $("#student-error").hidden = true;
  openModal("#student-modal");
  $("#student-name").focus();
}

async function createStudentFromModal() {
  const name = $("#student-name").value.trim();
  const email = $("#student-email").value.trim().toLowerCase();
  const pass = $("#student-pass").value;
  const publish = $("#student-publish").checked;
  const err = $("#student-error");
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!name) { err.textContent = "Give the student a name first."; err.hidden = false; $("#student-name").focus(); return; }
  if (!EMAIL_RE.test(email)) { err.textContent = "Enter a valid email address."; err.hidden = false; $("#student-email").focus(); return; }
  if (pass.length < 6) { err.textContent = "Password must be at least 6 characters."; err.hidden = false; $("#student-pass").focus(); return; }
  const btn = $("#btn-student-ok");
  btn.disabled = true;
  try {
    const data = await api("/api/students", {
      method: "POST",
      body: JSON.stringify({ name, email, password: pass, publish }),
    });
    closeModal("#student-modal");
    const s = data.student;
    toast(publish
      ? `Student “${s.name}” created — credentials active`
      : `Student “${s.name}” saved as draft — publish when ready`);
    logActivity("edit", `Issued student credentials for “${s.name}”`);
  } catch (ex) {
    err.textContent = ex.message || "Could not create the student account.";
    err.hidden = false;
  } finally {
    btn.disabled = false;
  }
}

/* ─── router ─────────────────────────────────────────────────────── */
const VIEWS = ["dashboard", "leaderboard", "builder", "results", "generate", "drafts", "favs", "bookmarks"];
const VIEW_META = {
  leaderboard:        { eyebrow: "Rankings",    title: "Subject Leaderboard" },
  dashboard:          { eyebrow: "Overview",    title: "Dashboard" },
  "student.dashboard":{ eyebrow: "For You",      title: "My Dashboard" },
  builder:            { eyebrow: "Compose",     title: "Quiz Builder" },
  results:            { eyebrow: "Scoreboard",  title: "Results" },
  "student.results":  { eyebrow: "My Record",   title: "My Scores" },
  generate:           { eyebrow: "Assistant",   title: "AI Quiz Generator" },
  drafts:             { eyebrow: "Library",     title: "Drafts" },
  favs:               { eyebrow: "Library",     title: "Favourites" },
  bookmarks:          { eyebrow: "Library",     title: "Templates" },
};

const viewAllowed = (name) => !((isStudent() && ["builder", "drafts", "bookmarks"].includes(name))); // students get AI Practice + Favourites too

function setView(name) {
  if (!viewAllowed(name)) name = "dashboard";
  state.view = name;
  for (const v of VIEWS) $(`#view-${v}`).hidden = v !== name;
  // page entrance: re-trigger the staggered cascade on the visible view
  const shown = $(`#view-${name}`);
  shown.classList.remove("view-in");
  void shown.offsetWidth; // restart the animations
  shown.classList.add("view-in");
  if (name === "leaderboard") renderLeaderboard();
  if (name === "drafts") { renderDraftsScreen(); markLibrarySeen("drafts"); }
  if (name === "favs") { renderFavsScreen(); markLibrarySeen("favs"); }
  if (name === "bookmarks") { renderBookmarksScreen(); markLibrarySeen("bookmarks"); }
  // hidden views keep stale content (renderAll only refreshes the visible
  // one) — re-render on entry so nothing shown is out of date
  if (name === "dashboard") renderDashboard();
  if (name === "results") renderResults();
  if (name === "builder") syncBuilderInputs();
  for (const btn of $$(".rail__link")) {
    const active = btn.dataset.nav === name;
    btn.classList.toggle("is-active", active);
    if (active) btn.setAttribute("aria-current", "page");
    else btn.removeAttribute("aria-current");
  }
  // phone tab bar mirrors the same state
  for (const btn of $$(".tabbar__btn")) {
    btn.classList.toggle("is-active", btn.dataset.nav === name);
  }
  const meta = VIEW_META[isStudent() ? `student.${name}` : name] || VIEW_META[name];
  if (name === "dashboard") {
    $("#view-eyebrow").textContent = isStudent() ? "Study Room" : "Faculty Room";
    $("#view-title").textContent = GREETINGS[greetIdx % GREETINGS.length]();
    document.title = `${isStudent() ? "My Dashboard" : "Dashboard"} · Quiz Atelier`;
  } else {
    $("#view-eyebrow").textContent = meta.eyebrow;
    $("#view-title").textContent = meta.title;
    document.title = `${meta.title} · Quiz Atelier`;
  }
  if (name === "builder") syncBuilderInputs();
}

function nav(name) {
  setView(name);
  if (name === "dashboard") greetIdx = (greetIdx + 1) % GREETINGS.length; // rotate through the 7 phrases
  scrollPageTop();
}

/* ─── toast, confirm, modal plumbing ─────────────────────────────── */
let toastTimer;
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
}

function showUndoToast(msg, restoreFn, duration = 5000) {
  const existing = document.querySelector(".undo-toast");
  if (existing) existing.remove();
  const toast = document.createElement("div");
  toast.className = "undo-toast";
  const msgSpan = document.createElement("span");
  msgSpan.className = "undo-msg";
  msgSpan.textContent = msg;
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "undo-btn";
  btn.textContent = "Undo";
  btn.onclick = () => {
    restoreFn();
    toast.remove();
  };
  toast.append(msgSpan, btn);
  document.body.appendChild(toast);
  setTimeout(() => { if (toast.parentNode) toast.remove(); }, duration);
}

let lastFocused = null;
let confirmAction = null;

function openModal(sel) {
  lastFocused = document.activeElement;
  $(sel).hidden = false;
  syncScrollLock();
  const card = $(`${sel} .modal__card`);
  $("button, input, textarea, [tabindex]", card)?.focus();
}

function closeModal(sel) {
  $(sel).hidden = true;
  syncScrollLock();
  if (sel !== "#player-modal") lastFocused?.focus?.();
}

/* overlays (modals + login gate) lock the active scroll container so trackpad
   scrolling on the backdrop can't move the page behind them. The document scrolls
   on mobile; the main column scrolls on desktop — lock whichever is live.
   scrollbar-gutter: stable keeps the layout from shifting when it locks. */
let savedScrollY = 0;
function overlayOpenCount() {
  let n = 0;
  for (const sel of ["#player-modal", "#confirm-modal", "#import-modal", "#plans-modal", "#subject-modal", "#notice-modal"]) if (!$(sel).hidden) n++;
  if (!$("#login-gate").hidden) n++;
  return n;
}
function pageScroller() {
  return window.matchMedia("(min-width: 881px)").matches ? $(".main-col") : document.documentElement;
}
function scrollPageTop() {
  const sc = pageScroller();
  if (sc === document.documentElement) window.scrollTo({ top: 0 });
  else sc.scrollTo({ top: 0 });
}
function syncScrollLock() {
  const lock = overlayOpenCount() > 0;
  const col = $(".main-col");
  if (lock === document.body.classList.contains("no-scroll") && lock === col.classList.contains("no-scroll")) return;
  const sc = pageScroller();
  savedScrollY = sc === document.documentElement ? window.scrollY : sc.scrollTop;
  document.body.classList.toggle("no-scroll", lock);
  col.classList.toggle("no-scroll", lock); // freezes the desktop scroller too
  if (!lock) { if (sc === document.documentElement) window.scrollTo({ top: savedScrollY }); else sc.scrollTop = savedScrollY; }
}

function askConfirm(title, msg, okLabel, onOk, cancelLabel = "Cancel") {
  $("#confirm-title").textContent = title;
  $("#confirm-msg").textContent = msg;
  $("#btn-confirm-ok").textContent = okLabel;
  $("#btn-confirm-cancel").textContent = cancelLabel;
  confirmAction = onOk;
  openModal("#confirm-modal");
}

/* ─── activity log ───────────────────────────────────────────────── */
function logActivity(kind, text) {
  state.activity.unshift({ id: uid(), kind, text, ts: Date.now() });
  if (state.activity.length > 12) state.activity.length = 12;
  updateBellDot();
  if (!$("#bell-pop").hidden) renderActivity();
}

/* red dot on the bell while there are entries newer than the last time it was opened */
function updateBellDot() {
  const dot = $("#bell-dot");
  if (!dot) return;
  const unseen = activityItems().some((a) => a.ts > (state.activitySeenTs || 0));
  dot.hidden = !unseen;
}

/* the bell's feed: teachers see workspace activity, students see their recent scores */
function activityItems() {
  if (!isStudent()) return state.activity;
  return myAttempts().map((a) => ({
    id: a.id, ts: a.ts,
    kind: pctOf(a.score, a.total) >= 60 ? "live" : "accent",
    text: `${a.quizTitle} — ${a.score}/${a.total} (${pctOf(a.score, a.total)}%)`,
  }));
}

function openBellPop() {
  const pop = $("#bell-pop");
  const btn = $("#btn-activity-bell");
  // anchor the fixed popup under the bell, clamped inside the viewport,
  // flipping above the bell when there isn't room below
  const r = btn.getBoundingClientRect();
  renderActivity(); // fill the list first so the measured height is final
  pop.hidden = false; // measure at final width
  const w = pop.offsetWidth || 420;
  const h = pop.offsetHeight || 520;
  let left = r.right - w;                       // right-align with the bell
  left = Math.min(Math.max(12, left), window.innerWidth - w - 12);
  let top = r.bottom + 10;
  if (top + h > window.innerHeight - 12) top = Math.max(12, r.top - h - 10);
  pop.style.left = `${left}px`;
  pop.style.top = `${top}px`;
  btn.setAttribute("aria-expanded", "true");
  // opening clears the red dot and marks everything as seen
  state.activitySeenTs = Date.now();
  updateBellDot();
}

function closeBellPop() {
  const pop = $("#bell-pop");
  if (pop.hidden) return;
  pop.hidden = true;
  $("#btn-activity-bell").setAttribute("aria-expanded", "false");
}

/* ─── subject leaderboard ────────────────────────────────────────── */
let lbSubjectId = null; // defaults to the first known subject at render time

/* right-click context menu on subject rows in the Quiz Ledger (teacher only) */
let ctxSubjectId = null;
function closeCtxMenu() {
  $(".ctx-menu")?.remove();
  ctxSubjectId = null;
}
function svgUse(href) {
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", href);
  return use;
}
function openSubjectCtxMenu(subId, x, y, anchorRow = null) {
  closeCtxMenu();
  bindCtxScroll();
  const sub = SUBJECTS.find((s) => s.id === subId);
  if (!sub || isStudent()) return;
  ctxSubjectId = subId;
  ctxAnchorRow = anchorRow;
  const menu = el("div", { class: "ctx-menu", role: "menu", "aria-label": "Subject actions" },
    el("button", { class: "ctx-menu__item", type: "button", role: "menuitem", onclick: () => {
      const id = ctxSubjectId; closeCtxMenu(); promptEditSubject(id);
    } },
      el("svg", { class: "ico", "aria-hidden": "true" }, svgUse("#i-pen")),
      el("span", { text: "Edit subject details" })),
    el("button", { class: "ctx-menu__item", type: "button", role: "menuitem", onclick: () => {
      const id = ctxSubjectId; closeCtxMenu(); promptAddNotice(id);
    } },
      el("svg", { class: "ico", "aria-hidden": "true" }, svgUse("#i-pin")),
      el("span", { text: "Add pinned notice" })),
    el("button", { class: "ctx-menu__item ctx-menu__item--danger", type: "button", role: "menuitem", onclick: () => {
      const id = ctxSubjectId; closeCtxMenu(); askDeleteSubject(id);
    } },
      el("svg", { class: "ico", "aria-hidden": "true" }, svgUse("#i-trash")),
      el("span", { text: "Delete Subject" })));
  document.body.append(menu);
  positionCtxMenu(x, y);
}

/* keep the menu pinned to its subject row while the page scrolls */
let ctxAnchorRow = null;
function positionCtxMenu(x, y) {
  const menu = document.querySelector(".ctx-menu");
  if (!menu) return;
  if (ctxAnchorRow && document.contains(ctxAnchorRow)) {
    // track the row: place the menu at the row's right edge, vertically centered
    const rr = ctxAnchorRow.getBoundingClientRect();
    if (rr.bottom < 0 || rr.top > window.innerHeight) { closeCtxMenu(); return; } // row scrolled out of view
    x = rr.right - 4;
    y = rr.top + rr.height / 2;
  }
  const r = menu.getBoundingClientRect();
  menu.style.left = `${Math.min(Math.max(8, x), window.innerWidth - r.width - 8)}px`;
  menu.style.top = `${Math.min(Math.max(8, y), window.innerHeight - r.height - 8)}px`;
}
/* the ledger scrolls inside .main-col (desktop) or the document (mobile) */
function ctxScrollRoots() {
  const roots = [window];
  if (window.matchMedia("(min-width: 881px)").matches) roots.push($(".main-col"));
  else roots.push(document);
  return roots;
}
let ctxScrollBound = false;
function bindCtxScroll() {
  if (ctxScrollBound) return;
  ctxScrollBound = true;
  const onScroll = () => { if (document.querySelector(".ctx-menu")) positionCtxMenu(); };
  window.addEventListener("scroll", onScroll, true); // capture: catches inner scrollers too
  window.addEventListener("resize", () => { if (document.querySelector(".ctx-menu")) positionCtxMenu(); });
}

function lbPool() {
  const pool = classAttempts().filter((a) => a.subjectId === lbSubjectId);
  if (isStudent()) pool.push(...myAttempts().filter((a) => a.subjectId === lbSubjectId));
  return pool;
}

function lbRankings() {
  const byStudent = new Map();
  for (const a of lbPool()) {
    const cur = byStudent.get(a.student) || { student: a.student, n: 0, sum: 0, best: 0 };
    const p = a.score / a.total;
    cur.n += 1; cur.sum += p;
    if (p > cur.best) cur.best = p;
    byStudent.set(a.student, cur);
  }
  return [...byStudent.values()]
    .map((r) => ({ ...r, avg: Math.round((r.sum / r.n) * 100), bestPct: Math.round(r.best * 100) }))
    .sort((x, y) => (y.avg - x.avg) || (y.bestPct - x.bestPct) || (y.n - x.n) || x.student.localeCompare(y.student));
}

function renderLeaderboard() {
  if (!state.user) return;
  // default to the first known subject when none is selected (or selection vanished)
  if (!lbSubjectId || !SUBJECTS.some((s) => s.id === lbSubjectId)) lbSubjectId = SUBJECTS[0]?.id || null;
  const chips = $("#lb-subjects");
  chips.textContent = "";
  for (const s of SUBJECTS) {
    const chip = el("button", {
      class: `pill${s.id === lbSubjectId ? " is-active" : ""}`,
      type: "button", role: "tab",
      "aria-selected": String(s.id === lbSubjectId),
      text: s.name,
      onclick: () => { lbSubjectId = s.id; renderLeaderboard(); },
    });
    chips.append(chip);
  }
  const sub = subjectById(lbSubjectId);
  $("#lb-sub").textContent = isStudent()
    ? `How you stack up in ${sub.name} — your row is highlighted.`
    : `Class ranking in ${sub.name} — ranked by average accuracy.`;
  const tbody = $("#lb-tbody");
  tbody.textContent = "";
  const rows = lbRankings();
  $("#lb-empty").hidden = rows.length > 0;
  rows.forEach((r, i) => {
    const rank = i + 1;
    const medal = rank <= 3 ? `lb-rank--${rank}` : "";
    const me = isStudent() && r.student === state.user.name;
    tbody.append(el("tr", { class: me ? "is-me" : "" },
      el("td", { class: "num-col" },
        el("span", { class: `lb-rank ${medal}`, text: rank <= 3 ? ["🥇", "🥈", "🥉"][rank - 1] : String(rank) })),
      el("td", {},
        el("span", { class: "cell-title lb-me" }, r.student,
          me ? el("span", { class: "pill", text: "You" }) : null)),
      el("td", { class: "num-col", text: String(r.n) }),
      el("td", { class: "num-col" },
        el("span", { class: r.avg >= 75 ? "mark-good" : r.avg >= 50 ? "mark-warn" : "mark-bad", text: `${r.avg}%` })),
      el("td", { class: "num-col" },
        el("span", { class: "lb-best", text: `${r.bestPct}%` })),
    ));
  });
}

/* ─── shared stats helpers ───────────────────────────────────────── */
const myAttempts = () =>
  isStudent() ? state.attempts.filter((a) => a.student === state.user.name) : [];

/* Teacher-visible attempts — students' private practice stays out. */
const classAttempts = () => state.attempts.filter((a) => !a.practice);

function quizStats(quiz) {
  const attempts = classAttempts().filter((a) => a.quizId === quiz.id);
  const avg = attempts.length
    ? Math.round((attempts.reduce((s, a) => s + a.score / a.total, 0) / attempts.length) * 100)
    : null;
  const roster = new Set(attempts.map((a) => a.student)).size;
  return { attempts: attempts.length, avg, roster };
}

function subjectStats(subjectId) {
  const attempts = classAttempts().filter((a) => a.subjectId === subjectId);
  const avg = attempts.length
    ? Math.round((attempts.reduce((s, a) => s + a.score / a.total, 0) / attempts.length) * 100)
    : null;
  const roster = new Set(attempts.map((a) => a.student)).size;
  return {
    conducted: attempts.length,
    avg,
    roster,
    att: Math.min(100, Math.round((roster / ROSTER.length) * 100)),
  };
}

function classAvgFor(quizId) {
  const list = classAttempts().filter((a) => a.quizId === quizId);
  if (!list.length) return null;
  return Math.round((list.reduce((s, a) => s + a.score / a.total, 0) / list.length) * 100);
}

/* ─── streaks & badges (student free-tier perks) ─────────────────── */
const dayKey = (ts = Date.now()) => new Date(ts).toISOString().slice(0, 10);
function ensureStreak() {
  if (!state.streak || !Array.isArray(state.streak.days)) state.streak = { days: [], lastDay: null };
  return state.streak;
}
function recordActivityDay() {
  if (!isStudent()) return;
  const st = ensureStreak();
  const today = dayKey();
  if (!st.days.includes(today)) {
    st.days.push(today);
    st.days.sort();
    if (st.days.length > 400) st.days = st.days.slice(-400); // cap a year+ of history
  }
  st.lastDay = today;
}
/* current streak: consecutive days ending today or yesterday */
function streakCount() {
  const st = ensureStreak();
  if (!st.days.length) return 0;
  const set = new Set(st.days);
  let cursor = new Date();
  if (!set.has(dayKey(cursor.getTime()))) { // grace: yesterday still counts
    cursor.setDate(cursor.getDate() - 1);
    if (!set.has(dayKey(cursor.getTime()))) return 0;
  }
  let n = 0;
  while (set.has(dayKey(cursor.getTime()))) { n++; cursor.setDate(cursor.getDate() - 1); }
  return n;
}
const BADGES = [
  { id: "first",    name: "First Steps",    icon: "#i-play",  test: (m) => m.length >= 1,               note: "Complete your first quiz" },
  { id: "five",     name: "High Five",      icon: "#i-star",  test: (m) => m.length >= 5,               note: "Complete 5 quizzes" },
  { id: "ten",      name: "Double Digits",  icon: "#i-cap",   test: (m) => m.length >= 10,              note: "Complete 10 quizzes" },
  { id: "perfect",  name: "Flawless",       icon: "#i-spark", test: (m) => m.some((a) => a.score === a.total && a.total > 0), note: "Score 100% on any quiz" },
  { id: "streak3",  name: "Warm Up",        icon: "#i-clock", test: () => streakCount() >= 3,           note: "3-day practice streak" },
  { id: "streak7",  name: "On Fire",        icon: "#i-bell",  test: () => streakCount() >= 7,           note: "7-day practice streak" },
  { id: "avg80",    name: "Sharp Mind",     icon: "#i-gauge", test: (m) => m.length >= 3 && m.reduce((s, a) => s + a.score / a.total, 0) / m.length >= 0.8, note: "80%+ average over 3+ quizzes" },
  { id: "subjects3",name: "Explorer",      icon: "#i-book",  test: (m) => new Set(m.map((a) => a.subjectId)).size >= 3, note: "Take quizzes in 3 subjects" },
];
function earnedBadges() {
  const mine = myAttempts();
  return BADGES.map((b) => ({ ...b, earned: (() => { try { return !!b.test(mine); } catch { return false; } })() }));
}

function renderStreakBadges() {
  const host = $("#student-streak");
  if (!host || !isStudent()) return;
  const streak = streakCount();
  const mine = myAttempts();
  const badges = earnedBadges();
  const earnedCount = badges.filter((b) => b.earned).length;
  const pill = $("#streak-pill");
  if (pill) pill.textContent = `${streak} day${streak === 1 ? "" : "s"}`;
  host.textContent = "";
  host.append(
    el("div", { class: "streak-strip" },
      el("div", { class: "streak-stat" },
        el("span", { class: "streak-num num", text: String(streak) }),
        el("span", { class: "streak-label", text: streak === 1 ? "day streak" : "day streak" })),
      el("div", { class: "streak-note" },
        el("p", { class: "streak-line", text: streak > 0 ? `You've practiced ${streak} day${streak === 1 ? "" : "s"} in a row — keep it alive!` : "Take a quiz today to start a streak." }),
        el("p", { class: "streak-sub", text: `${mine.length} quiz${mine.length === 1 ? "" : "zes"} completed` })),
      el("span", { class: "pill streak-pill-accent", text: `${earnedCount}/${BADGES.length} badges` })),
    el("div", { class: "badge-progress" },
      el("span", { class: "badge-progress__fill", style: `width:${Math.round(earnedCount / BADGES.length * 100)}%` })),
    el("div", { class: "badge-grid" },
      ...badges.map((b) =>
        el("div", {
          class: `badge${b.earned ? " badge--earned" : ""}`,
          title: `${b.name} — ${b.note}`,
          "aria-label": `${b.name}${b.earned ? " — earned" : " — locked"}`,
        },
          el("svg", { class: "ico", "aria-hidden": "true" }, el("use", { href: b.icon })),
          el("span", { class: "badge__name", text: b.name }))),
    ),
  );
}

/* weekly self-digest: server-side email + in-app summary card */
function digestData() {
  const mine = myAttempts();
  const weekAgo = Date.now() - 7 * 86400000;
  const thisWeek = mine.filter((a) => a.ts >= weekAgo);
  const best = thisWeek.length ? thisWeek.reduce((b, a) => (a.score / a.total > b.score / b.total ? a : b)) : null;
  return {
    attempts: thisWeek.length,
    streak: streakCount(),
    badges: earnedBadges().filter((b) => b.earned).length,
    best: best ? `${best.quizTitle} — ${best.score}/${best.total}` : null,
    avg: thisWeek.length ? Math.round(thisWeek.reduce((s, a) => s + a.score / a.total, 0) / thisWeek.length * 100) : null,
  };
}

/* ─── spaced repetition: graveyard, warm-up & comeback rounds ────── */
/* The Graveyard: every question the student has ever missed, deduped by
   question text. A question is "resurrected" (leaves the graveyard) once a
   LATER attempt answers it correctly — miss, learn, prove it, move on. */
function graveyardQuestions() {
  const byText = new Map(); // text -> { text, options, correct, subjectId, misses, lastMissedTs, lastSeenTs }
  // chronological order matters: a correct answer only resurrects a question
  // if it came AFTER the last miss (attempts list is newest-first)
  for (const a of [...myAttempts()].sort((x, y) => x.ts - y.ts)) {
    for (const ans of (a.answers || [])) {
      const key = (ans.text || "").trim().toLowerCase();
      if (!key) continue;
      const g = byText.get(key) || {
        text: ans.text, options: ans.options || null, correct: null,
        subjectId: a.subjectId, misses: 0, lastMissedTs: 0, lastSeenTs: a.ts,
      };
      if (a.ts >= g.lastSeenTs) { // freshest copy of the question wins
        g.lastSeenTs = a.ts;
        if (ans.options?.length) { g.options = ans.options; g.correct = ans.correctIdx ?? null; }
      }
      if (!ans.correct) {
        g.misses++;
        if (a.ts > g.lastMissedTs) g.lastMissedTs = a.ts;
        byText.set(key, g);
      } else if (a.ts > g.lastMissedTs) {
        byText.delete(key); // answered right after the last miss — set it free
      }
    }
  }
  return [...byText.values()]
    .filter((g) => g.options?.length === 4 && Number.isInteger(g.correct))
    .sort((x, y) => y.misses - x.misses || y.lastMissedTs - x.lastMissedTs);
}

/* spin up a session-only practice round from raw questions (never saved to
   the workspace — mirrors startPracticeFromFav) */
function startPracticeRound(quiz) {
  const sub = subjectById(quiz.subjectId);
  $("#player-eyebrow").textContent = `${sub.name} — Practice`;
  $("#player-title").textContent = quiz.title;
  state.lastQuizId = quiz.id;
  state.practiceQuiz = quiz;
  startQuiz();
  if ($("#player-modal").hidden) openModal("#player-modal");
}

/* ─── Tearable paper: verlet-cloth reveal effect ───────────────────
   A small canvas overlays a hidden reveal; drag a finger/cursor across it
   and the cloth tears open like paper. Falls back to a plain tap-reveal
   when canvas/RAF are unavailable. Engine is shared by the score card,
   the daily warm-up seal, and answer patches. */
const TEAR = {
  COLS: 22, ROWS: 12,
  GRAVITY: 0.32, FRICTION: 0.985,
  TEAR_DIST: 22,   // constraint stretch beyond which a link snaps
  CUT_SCALE: 0.55, // cut radius as a fraction of the weave — a thin rip line
  START_RIP: 0.55, // fraction of tear-dist at spawn (a hairline crack)
};

function tearSupported() {
  // honour reduced-motion: those users get the content instantly, no ritual
  try { if (matchMedia("(prefers-reduced-motion: reduce)").matches) return false; } catch { /* keep going */ }
  return typeof window !== "undefined" && !!window.requestAnimationFrame &&
    !!document.createElement("canvas").getContext;
}

/* Build the cloth over `host` and reveal `revealEl` as it tears away.
   opts: { seed: number (0-1 rip strength on load), hint: string,
           onTorn: fn } */
function mountTearable(host, revealEl, opts = {}) {
  if (!tearSupported()) {
    // graceful fallback: tap the seal to remove it
    const fallback = el("button", { class: "tear-fallback", type: "button", "aria-label": "Reveal", text: opts.hint || "Tap to reveal",
      onclick: () => { host.remove(); opts.onTorn?.(); } });
    host.append(fallback);
    return { destroy() {} };
  }
  const W = host.clientWidth || host.offsetWidth || 300;
  const H = host.clientHeight || host.offsetHeight || 160;
  const canvas = el("canvas", { class: "tear-canvas", width: String(Math.round(W * devicePixelRatio)), height: String(Math.round(H * devicePixelRatio)), "aria-hidden": "true" });
  canvas.style.width = W + "px"; canvas.style.height = H + "px";
  host.append(canvas);
  const ctx = canvas.getContext("2d");
  ctx.scale(devicePixelRatio, devicePixelRatio);

  const cs = getComputedStyle(host);
  const paper = cs.getPropertyValue("--tear-paper").trim() || "#efe7d2";
  const ink = cs.getPropertyValue("--tear-ink").trim() || "#4a4238";
  const edge = cs.getPropertyValue("--tear-edge").trim() || "#c9b892";

  const COLS = opts.cols ?? TEAR.COLS, ROWS = opts.rows ?? TEAR.ROWS;
  const spacingX = W / COLS, spacingY = H / ROWS;
  // cut radius is a FRACTION of the weave: a thin, continuous rip line.
  // (A wide radius carves out whole bands of paper — loose-snippet tearing.)
  const cutRadius = Math.max(6, Math.min(spacingX, spacingY) * TEAR.CUT_SCALE);
  const pts = [], links = [];
  const seed = opts.seed ?? 0;

  for (let y = 0; y <= ROWS; y++) for (let x = 0; x <= COLS; x++) {
    const pin = y === 0 || x === 0 || x === COLS; // pin top + sides; bottom hangs
    pts.push({ x: x * spacingX, y: y * spacingY, px: x * spacingX, py: y * spacingY, pin });
  }
  const at = (x, y) => pts[y * (COLS + 1) + x];
  // link lookup by grid position so a quad knows when its edges are torn
  const hLinks = [], vLinks = [];
  for (let y = 0; y <= ROWS; y++) { hLinks[y] = []; vLinks[y] = []; }
  for (let y = 0; y <= ROWS; y++) for (let x = 0; x < COLS; x++) {
    hLinks[y][x] = { a: at(x, y), b: at(x + 1, y), len: spacingX };
    links.push(hLinks[y][x]);
  }
  for (let y = 0; y < ROWS; y++) for (let x = 0; x <= COLS; x++) {
    vLinks[y][x] = { a: at(x, y), b: at(x, y + 1), len: spacingY };
    links.push(vLinks[y][x]);
  }
  // diagonals brace each cell so it renders as two triangles — a tear then
  // eats triangles one by one along the rip line, not whole rectangles
  const diagLen = Math.hypot(spacingX, spacingY);
  const dLinks = [];
  for (let y = 0; y < ROWS; y++) { dLinks[y] = []; }
  for (let y = 0; y < ROWS; y++) for (let x = 0; x < COLS; x++) {
    dLinks[y][x] = { a: at(x, y), b: at(x + 1, y + 1), len: diagLen };
    links.push(dLinks[y][x]);
  }
  // seed a hairline crack down the middle so the tear has a starting point
  if (seed > 0) {
    const mid = Math.floor(COLS / 2);
    for (let y = 1; y < ROWS; y++) {
      const x = mid + (y % 2 ? 1 : 0);
      if (x < COLS) links.push({ a: at(x, y), b: at(x + 1, y), len: spacingX * (1 + TEAR.START_RIP), pre: true });
    }
  }

  let pointer = null, raf = 0, dead = false, falling = false, fallStart = 0;
  // the seal "opens" when a tear crosses the middle: either the horizontal
  // or the vertical center strip is severed (a full swipe kills every link
  // in the strip it crosses), or half the whole cloth is gone
  const hStrip = links.filter((L) => Math.abs((L.a.y + L.b.y) / 2 - H / 2) <= H * 0.16);
  const vStrip = links.filter((L) => Math.abs((L.a.x + L.b.x) / 2 - W / 2) <= W * 0.16);
  const aliveCount = (arr) => arr.reduce((n, L) => n + (L && !L.dead ? 1 : 0), 0);
  const pointerPos = (e) => {
    const r = canvas.getBoundingClientRect();
    const src = e.touches?.[0] || e;
    return { x: src.clientX - r.left, y: src.clientY - r.top };
  };
  // sever links whose midpoint lies within cutRadius of the SEGMENT the
  // pointer travelled — the rip follows the exact drag path, no skipped gaps
  const distToSeg = (px, py, ax, ay, bx, by) => {
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let t = len2 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
  };
  const cut = (from, to) => {
    for (const L of links) {
      if (!L || L.dead) continue;
      const { a, b } = L;
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      if (distToSeg(mx, my, from.x, from.y, to.x, to.y) < cutRadius) L.dead = true;
    }
  };
  let cutPath = 0; // accumulated drag length — a full swipe across opens the seal
  const onDown = (e) => {
    pointer = pointerPos(e);
    cutPath = 0;
    // small patches: a single tap rips the seal (too small to drag comfortably)
    if (opts.autoTear) { for (const L of hStrip) L.dead = true; for (const L of vStrip) L.dead = true; }
    cut(pointer, pointer);
  };
  const onMove = (e) => {
    if (!pointer) return;
    e.preventDefault?.();
    const next = pointerPos(e);
    cutPath += Math.hypot(next.x - pointer.x, next.y - pointer.y);
    const prev = pointer;
    pointer = next;
    cut(prev, next);
  };
  const onUp = () => { pointer = null; };
  canvas.addEventListener("pointerdown", onDown);
  canvas.addEventListener("pointermove", onMove);
  const endDrag = () => { pointer = null; };
  window.addEventListener("pointerup", endDrag);
  canvas.addEventListener("touchmove", (e) => e.preventDefault(), { passive: false });
  // single death path: stops the loop AND unregisters the window listener
  // (leaked pointerup listeners piled up with every mounted seal)
  const die = () => {
    if (dead) return;
    dead = true;
    cancelAnimationFrame(raf);
    window.removeEventListener("pointerup", endDrag);
    host.remove();
  };

  function step() {
    const g = falling ? TEAR.GRAVITY * 2.4 : TEAR.GRAVITY;
    for (const p of pts) {
      if (p.pin && !falling) { p.x = p.px = p.x; p.y = p.py = p.y; continue; }
      if (falling && p.pin) { p.pin = false; }
      const vx = (p.x - p.px) * TEAR.FRICTION, vy = (p.y - p.py) * TEAR.FRICTION;
      p.px = p.x; p.py = p.y;
      p.x += vx; p.y += vy + g;
    }
    for (let it = 0; it < (falling ? 2 : 3); it++) {
      for (const L of links) {
        if (!L || L.dead) continue;
        const dx = L.b.x - L.a.x, dy = L.b.y - L.a.y;
        const d = Math.hypot(dx, dy) || 0.0001;
        if (d > L.len * (TEAR.TEAR_DIST / 10)) { L.dead = true; continue; }
        const diff = ((d - L.len) / d) * 0.5;
        const ox = dx * diff, oy = dy * diff;
        if (!L.a.pin) { L.a.x += ox; L.a.y += oy; }
        if (!L.b.pin) { L.b.x -= ox; L.b.y -= oy; }
      }
    }
  }

  function draw() {
    ctx.clearRect(0, 0, W, H);
    ctx.strokeStyle = paper;
    ctx.fillStyle = paper;
    ctx.lineWidth = 1.2;
    // fill quads, stroke edges slightly darker for a fibre look
    // two triangles per cell, each drawn only while its three edges live —
    // the rip eats triangles along the drag line: a smooth continuous tear
    const live = (L) => !!L && !L.dead;
    for (let y = 0; y < ROWS; y++) for (let x = 0; x < COLS; x++) {
      const top = hLinks[y][x], bottom = hLinks[y + 1][x], left = vLinks[y][x], right = vLinks[y][x + 1], diag = dLinks[y][x];
      const p1 = at(x, y), p2 = at(x + 1, y), p3 = at(x + 1, y + 1), p4 = at(x, y + 1);
      if (live(top) && live(right) && live(diag)) {
        ctx.beginPath(); ctx.moveTo(p1.x, p1.y); ctx.lineTo(p2.x, p2.y); ctx.lineTo(p3.x, p3.y); ctx.closePath(); ctx.fill();
      }
      if (live(left) && live(bottom) && live(diag)) {
        ctx.beginPath(); ctx.moveTo(p1.x, p1.y); ctx.lineTo(p3.x, p3.y); ctx.lineTo(p4.x, p4.y); ctx.closePath(); ctx.fill();
      }
    }
    ctx.strokeStyle = edge;
    ctx.lineWidth = 0.7;
    for (const L of links) {
      if (!L || L.dead) continue;
      ctx.beginPath(); ctx.moveTo(L.a.x, L.a.y); ctx.lineTo(L.b.x, L.b.y); ctx.stroke();
    }
    // hint text etched on the paper while mostly intact
    if (opts.hint && !falling) {
      ctx.fillStyle = ink;
      ctx.font = "600 13px ui-monospace, monospace";
      ctx.textAlign = "center";
      ctx.fillText(opts.hint, W / 2, H / 2 + 4);
      ctx.font = "500 10px ui-monospace, monospace";
      ctx.fillText("drag to tear open", W / 2, H / 2 + 22);
    }
  }

  function checkTorn() {
    if (falling) {
      if (performance.now() - fallStart > 900) {
        die();
        opts.onTorn?.();
      }
      return;
    }
    const open = (hStrip.length && aliveCount(hStrip) / hStrip.length < 0.35) ||
      (vStrip.length && aliveCount(vStrip) / vStrip.length < 0.35) ||
      aliveCount(links) / links.length < 0.5 ||
      (!opts.autoTear && cutPath > W * 0.85); // a decisive swipe, any direction
    if (open) {
      // ripped open: drop the whole sheet, then hand over to the reveal
      falling = true; fallStart = performance.now();
    }
  }

  function loop() {
    if (dead) return;
    step(); draw(); checkTorn();
    raf = requestAnimationFrame(loop);
  }
  raf = requestAnimationFrame(loop);

  return { destroy() { die(); } };
}

const WARMUP_SIZE = 5;
function warmupUnlocked() { return planRank(currentPlanId()) > 0; } // Tadano & Ayanokoji

/* daily ritual: dashboard cards seal themselves once per day per kind.
   Session-only — a fresh visit re-seals today's card (the ritual), but
   re-renders within the visit never re-seal. */
const tornSeals = new Set();
function sealCard(host, card, kind, hint) {
  if (!tearSupported() || tornSeals.has(kind)) return;
  tornSeals.add(kind);
  const wrap = el("div", { class: "tear-wrap tear-wrap--card" });
  const seal = el("div", { class: "tear-host tear-host--card" });
  host.append(wrap);
  wrap.append(seal, card);
  mountTearable(seal, card, { hint, onTorn: () => card.classList.add("tear-revealed") });
}

function dueComeback() {
  const today = dayKey();
  return state.comebacks.find((c) => c.due <= today) || null;
}

function renderSpacedRepetition() {
  if (!isStudent()) return;
  /* ── Today's Warm-up card (or a due Comeback Round, which wins) ── */
  const host = $("#warmup-host");
  const pill = $("#warmup-pill");
  const sub = $("#warmup-sub");
  if (host) {
    host.textContent = "";
    const comeback = dueComeback();
    const graves = graveyardQuestions();
    const count = comeback ? comeback.questions.length : Math.min(WARMUP_SIZE, graves.length);
    if (pill) pill.textContent = comeback ? "comeback ready" : `${count} question${count === 1 ? "" : "s"}`;
    if (sub) sub.textContent = comeback
      ? "The questions you asked to see again are waiting."
      : "Five questions from your weakest topics — ready before you've finished your coffee.";
    if (comeback) {
      const card = el("div", { class: "warmup-card" },
        el("div", { class: "warmup-card__text" },
          el("p", { class: "warmup-card__line", text: "Your Comeback Round is ready." }),
          el("p", { class: "warmup-card__sub", text: `${comeback.questions.length} question${comeback.questions.length === 1 ? "" : "s"} you missed — prove them wrong this time.` })),
        el("button", { class: "btn btn--primary", type: "button", text: "Take It On",
          onclick: () => startPracticeRound({
            id: comeback.key, title: "Comeback Round", practice: true, origin: "ai",
            subjectId: comeback.subjectId, comebackKey: comeback.key,
            questions: comeback.questions,
          }) }));
      host.append(card);
      sealCard(host, card, `comeback-${comeback.key}`, "comeback round sealed");
    } else if (!graves.length) {
      host.append(el("div", { class: "grave-empty" },
        el("span", {}, el("b", { text: "Nothing to warm up on. " }),
          el("span", { text: "Take a class quiz and your weak spots will land here." }))));
    } else if (!warmupUnlocked()) {
      host.append(el("div", { class: "warmup-card" },
        el("div", { class: "warmup-card__text" },
          el("p", { class: "warmup-card__line", text: `${graves.length} weak spot${graves.length === 1 ? "" : "s"} found` }),
          el("p", { class: "warmup-card__sub", text: "Daily warm-ups are part of the paid plans — your weak spots are waiting." })),
        el("button", { class: "btn btn--outline", type: "button", text: "View Plans", onclick: openPlans })));
    } else {
      const warm = graves.slice(0, WARMUP_SIZE);
      const card = el("div", { class: "warmup-card" },
        el("div", { class: "warmup-card__text" },
          el("p", { class: "warmup-card__line", text: `${warm.length} question${warm.length === 1 ? "" : "s"} from your roughest patches.` }),
          el("p", { class: "warmup-card__sub", text: warm.map((g) => subjectById(g.subjectId).short).filter((v, i, arr) => arr.indexOf(v) === i).join(" · ") })),
        el("button", { class: "btn btn--primary", type: "button", text: "Warm Up",
          onclick: () => startPracticeRound({
            id: `warmup-${dayKey()}`, title: "Daily Warm-up", practice: true, origin: "ai",
            subjectId: warm[0].subjectId,
            questions: warm.map((g) => ({ id: uid(), text: g.text, options: g.options, correct: g.correct })),
          }) }));
      host.append(card);
      sealCard(host, card, `warmup-${dayKey()}`, "today's warm-up sealed");
    }
  }

  /* ── The Graveyard ── */
  const gHost = $("#graveyard-host");
  const gPill = $("#graveyard-pill");
  if (gHost) {
    const graves = graveyardQuestions();
    if (gPill) gPill.textContent = `${graves.length} resting`;
    gHost.textContent = "";
    if (!graves.length) {
      gHost.append(el("div", { class: "grave-empty" },
        el("span", {}, el("b", { text: "The graveyard is empty. " }),
          el("span", { text: "Every question you've missed has been answered right since. Keep it that way." }))));
    } else {
      gHost.append(el("div", { class: "graveyard-list" },
        ...graves.slice(0, 8).map((g) =>
          el("div", { class: "grave-row" },
            el("span", { class: "grave-row__mark", text: g.misses === 1 ? "missed" : `×${g.misses}` }),
            el("span", { class: "grave-row__text", text: g.text }),
            el("span", { class: "grave-row__meta", text: subjectById(g.subjectId).short }))),
      ));
      if (graves.length > 8) {
        gHost.append(el("p", { class: "grave-foot", text: `…and ${graves.length - 8} more resting six feet under.` }));
      }
      gHost.append(el("p", { class: "grave-foot", text: "Answer one of these correctly on any round and it leaves the graveyard for good." }));
    }
  }
}

/* results-screen toggle: schedule today's wrong answers for tomorrow */
function tomorrowKey() { return dayKey(Date.now() + 86400000); }
function isComebackScheduled(attempt) {
  const wrong = (attempt.answers || []).filter((a) => !a.correct);
  if (!wrong.length) return false;
  const round = state.comebacks.find((c) => c.due === tomorrowKey());
  if (!round) return false;
  const roundTexts = new Set(round.questions.map((q) => q.text.trim().toLowerCase()));
  return wrong.every((a) => roundTexts.has(a.text.trim().toLowerCase()));
}
function toggleComeback(attempt) {
  const wrong = (attempt.answers || []).filter((a) => !a.correct);
  const due = tomorrowKey();
  let round = state.comebacks.find((c) => c.due === due);
  const scheduled = isComebackScheduled(attempt);
  if (scheduled) {
    // unschedule just this attempt's questions; drop the round if it empties
    const texts = new Set(wrong.map((a) => a.text.trim().toLowerCase()));
    round.questions = round.questions.filter((q) => !texts.has(q.text.trim().toLowerCase()));
    if (!round.questions.length) state.comebacks = state.comebacks.filter((c) => c !== round);
    toast("Comeback unscheduled");
  } else {
    const questions = wrong.map((a) => ({
      id: uid(), text: a.text, options: a.options || null, correct: a.correctIdx ?? null,
    })).filter((q) => q.options?.length === 4 && Number.isInteger(q.correct));
    if (!questions.length) return;
    if (round) {
      const seen = new Set(round.questions.map((q) => q.text.trim().toLowerCase()));
      for (const q of questions) if (!seen.has(q.text.trim().toLowerCase())) round.questions.push(q);
    } else {
      round = { key: `comeback-${due}`, due, subjectId: attempt.subjectId, questions };
      state.comebacks.push(round);
    }
    toast("Brought back from the dead tomorrow — your Comeback Round will be waiting.");
  }
  save();
  renderSpacedRepetition();
  showResult(state.quizzes.find((q) => q.id === attempt.quizId) || attempt, attempt, true);
}/* ─── ELI5: one tap rewrites a missed question in plain words ─────── */
const ELI5_SCHEMA = {
  type: "object",
  properties: { explanation: { type: "string" } },
  required: ["explanation"],
};
async function explainSimply(btn, ans) {
  if (btn.disabled) return;
  const holder = btn.closest(".b-eli5")?.querySelector(".b-eli5__out");
  if (!holder) return;
  // once fetched, the button just toggles visibility — no repeat API spend
  if (holder.dataset.fetched) {
    holder.hidden = !holder.hidden;
    btn.textContent = holder.hidden ? "Explain simply" : "Hide";
    return;
  }
  btn.disabled = true;
  holder.hidden = false;
  holder.textContent = "Thinking…";
  try {
    if (!limitGate("eli5PerDay", todayUsage().eli5 || 0)) { holder.hidden = true; btn.disabled = false; return; }
    bumpUsage("eli5");
    const prompt = [
      `A student answered this quiz question incorrectly. Explain the concept so simply that anyone can understand it — like explaining to a curious friend, no jargon, 2-3 short sentences.`,
      ``,
      `Question: ${ans.text}`,
      `They answered: ${ans.chosenText}`,
      `Correct answer: ${ans.correctText}`,
      ``,
      `End with one short line that makes the correct answer memorable.`,
    ].join("\n");
    const out = await callGemini([{ text: prompt }], ELI5_SCHEMA, "eli5");
    holder.dataset.fetched = "1";
    holder.textContent = out.explanation || "No explanation came back — try again.";
    btn.textContent = "Hide";
  } catch (err) {
    holder.hidden = true;
    toast(err.message || "Could not explain — try again in a moment.");
  } finally {
    btn.disabled = false;
  }
}

/* ─── study habits: reminder toggle + digest toggle ──────────────── */
function renderPerksPanel() {
  if (!isStudent()) return;
  const perks = $("#student-perks");
  if (perks) perks.hidden = false;
  if (!state.reminders || typeof state.reminders !== "object") state.reminders = { enabled: false, time: "18:00", lastFired: null };
  if (!state.digest || typeof state.digest !== "object") state.digest = { enabled: false, day: 6, lastSent: null };
  const rT = $("#reminder-toggle"), rTime = $("#reminder-time"), rDesc = $("#reminder-desc");
  if (rT) rT.setAttribute("aria-checked", String(!!state.reminders.enabled));
  if (rTime && !rTime.matches(":focus")) rTime.value = state.reminders.time || "18:00";
  if (rDesc) rDesc.textContent = state.reminders.enabled
    ? `On — we'll nudge you daily at ${state.reminders.time || "18:00"}.`
    : "We'll nudge you at your chosen time.";
  const dT = $("#digest-toggle"), dDesc = $("#digest-desc");
  if (dT) dT.setAttribute("aria-checked", String(!!state.digest.enabled));
  if (dDesc) dDesc.textContent = state.digest.enabled
    ? `On — emailed every Sunday to ${state.user?.email || "your mail"}.`
    : "A summary of your week, emailed every Sunday.";
  // in-app digest card mirrors the email for transparency
  const card = $("#digest-card"), grid = $("#digest-grid");
  if (card && grid) {
    card.hidden = !state.digest.enabled;
    if (state.digest.enabled) {
      const d = digestData();
      grid.textContent = "";
      grid.append(
        el("div", {}, el("p", { class: "digest-cell__num num", text: String(d.attempts) }), el("p", { class: "digest-cell__label", text: "quizzes this week" })),
        el("div", {}, el("p", { class: "digest-cell__num num", text: d.avg == null ? "—" : `${d.avg}%` }), el("p", { class: "digest-cell__label", text: "avg score" })),
        el("div", {}, el("p", { class: "digest-cell__num num", text: String(d.streak) }), el("p", { class: "digest-cell__label", text: "day streak" })),
        el("div", {}, el("p", { class: "digest-cell__num num", text: String(d.badges) }), el("p", { class: "digest-cell__label", text: "badges earned" })),
      );
    }
  }
}

$("#reminder-toggle")?.addEventListener("click", async () => {
  if (!state.reminders) state.reminders = { enabled: false, time: "18:00", lastFired: null };
  state.reminders.enabled = !state.reminders.enabled;
  if (state.reminders.enabled) {
    // browser notifications need the user's blessing once
    try { if ("Notification" in window && Notification.permission === "default") await Notification.requestPermission(); } catch { /* denied */ }
    toast(`Reminder on — daily at ${state.reminders.time}`);
  } else toast("Reminder off");
  save();
  renderPerksPanel();
});
$("#reminder-time")?.addEventListener("change", (e) => {
  if (!state.reminders) state.reminders = { enabled: false, time: "18:00", lastFired: null };
  state.reminders.time = e.target.value || "18:00";
  state.reminders.lastFired = null; // re-arm for the new time
  save();
  renderPerksPanel();
  if (state.reminders.enabled) toast(`Reminder set for ${state.reminders.time} daily`);
});
$("#digest-toggle")?.addEventListener("click", async () => {
  if (!state.digest) state.digest = { enabled: false, day: 6, lastSent: null };
  state.digest.enabled = !state.digest.enabled;
  if (state.digest.enabled) {
    try {
      await api("/api/digest/enable", { method: "POST", body: JSON.stringify({ enabled: true }) });
      toast("Weekly digest on — first one arrives Sunday");
    } catch (ex) {
      state.digest.enabled = false;
      toast(ex.message || "Could not enable the digest");
    }
  } else {
    try { await api("/api/digest/enable", { method: "POST", body: JSON.stringify({ enabled: false }) }); } catch { /* offline — local off is enough */ }
    toast("Weekly digest off");
  }
  save();
  renderPerksPanel();
});

/* reminder engine: check every 30s while the app is open; fires once per day */
setInterval(() => {
  if (!isStudent() || !state.reminders?.enabled) return;
  const now = new Date();
  const today = dayKey();
  const want = state.reminders.time || "18:00";
  const [h, m] = want.split(":").map(Number);
  if (now.getHours() !== h || now.getMinutes() !== m) return;
  if (state.reminders.lastFired === today) return;
  state.reminders.lastFired = today;
  save();
  toast("Time to practice — take a quiz to keep your streak alive!");
  try {
    if ("Notification" in window && Notification.permission === "granted") {
      new Notification("Quiz Atelier — practice time", { body: "A short quiz keeps your streak alive. 5 minutes is enough." });
    }
  } catch { /* notifications unavailable */ }
}, 30000);

function setStat(i, label, num, note, accent = false) {
  $(`#stat-${i}-label`).textContent = label;
  $(`#stat-${i}-num`).textContent = num;
  $(`#stat-${i}-note`).textContent = note;
  $(`#stat-${i}`).classList.toggle("stat--accent", accent);
}

function setRStat(i, label, num, note) {
  $(`#rstat-${i}-label`).textContent = label;
  $(`#rstat-${i}-num`).textContent = num;
  const noteEl = $(`#rstat-${i}-note`);
  // the strip hides the note line — keep the context as a tooltip instead
  noteEl.textContent = note;
  $(`#rstat-${i}`)?.setAttribute("title", `${label} — ${note}`);
}

function attMeter(pct, accent) {
  return el("span", { class: "att-cell" },
    el("span", { class: "att-track", role: "img", "aria-label": `${pct}% of the class attended` },
      el("span", { class: "att-fill", "data-accent": accent, style: `width:${pct}%` })),
    el("span", { class: "att-num", text: `${pct}%` }));
}

/* ─── dashboard — teacher ────────────────────────────────────────── */
function renderTeacherStats() {
  const nQ = state.quizzes.filter((q) => !q.practice).length;
  const drafts = state.quizzes.filter((q) => !q.published && !q.practice).length;
  const classAtt = classAttempts();
  const nA = classAtt.length;
  const avg = nA
    ? Math.round((classAtt.reduce((s, a) => s + a.score / a.total, 0) / nA) * 100)
    : null;
  const conducted = state.quizzes.filter((q) => !q.practice && classAtt.some((a) => a.quizId === q.id)).length;

  setStat(1, "Quizzes", String(nQ), nQ ? (drafts ? `${drafts} in draft` : "all published") : "—");
  setStat(2, "Students Enrolled", String(ROSTER.length), "registered this term");
  setStat(3, "Quizzes Conducted", String(conducted), nA ? `latest ${fmtDay(state.attempts[0].ts)}` : "no plays yet");
  setStat(4, "Average Score", avg == null ? "—" : `${avg}%`, nA ? "mean accuracy, all subjects" : "play a quiz to see data", true);
}

function toggleSubject(btn, id, prefix = "detail") {
  const row = $(`#${prefix}-${id}`);
  if (!row) return;
  const open = row.hidden;
  // accordion: collapse any other expanded subject so only one is open at a time
  if (open) {
    for (const other of $$(`.tr-detail[id^="${prefix}-"]:not([hidden])`)) {
      if (other === row) continue;
      other.hidden = true;
      const otherBtn = document.querySelector(`[aria-controls="${other.id}"]`);
      if (otherBtn) {
        otherBtn.setAttribute("aria-expanded", "false");
        otherBtn.closest("tr")?.classList.remove("is-open");
      }
    }
  }
  row.hidden = !open;
  btn.setAttribute("aria-expanded", String(open));
  btn.closest("tr").classList.toggle("is-open", open);
}

function renderQuizTable() {
  const tbody = $("#quiz-tbody");
  tbody.textContent = "";
  $("#quiz-empty").hidden = true;

  for (const sub of SUBJECTS) {
    const quizzes = state.quizzes.filter((q) => q.subjectId === sub.id && !q.practice);
    const stats = subjectStats(sub.id);
    const last = classAttempts().find((a) => a.subjectId === sub.id);

    tbody.append(el("tr", { class: "tr-sub",
      oncontextmenu: (e) => { e.preventDefault(); openSubjectCtxMenu(sub.id, e.clientX, e.clientY, e.currentTarget); } },
      el("td", {},
        el("button", {
          class: "expand-btn", type: "button",
          "aria-expanded": "false", "aria-controls": `detail-${sub.id}`,
          onclick: (e) => toggleSubject(e.currentTarget, sub.id),
        },
          el("span", { class: "chev", "aria-hidden": "true", text: "▸" }),
          el("span", { class: "sub-dot", "data-accent": sub.accent, "aria-hidden": "true" }),
          el("span", { class: "sub-name", text: sub.name })),
        el("span", { class: "cell-sub", text: sub.desc }),
        sub.notice ? el("span", { class: "sub-notice" },
          el("svg", { class: "ico", "aria-hidden": "true" }, svgUse("#i-pin")),
          el("span", { text: sub.notice.desc ? `${sub.notice.name} — ${sub.notice.desc}` : sub.notice.name })) : null),
      el("td", { class: "num-col", text: String(quizzes.length) }),
      el("td", { class: "num-col", text: String(stats.conducted) }),
      el("td", { class: "num-col", text: stats.avg == null ? "—" : `${stats.avg}%` }),
      el("td", {}, attMeter(stats.att, sub.accent)),
      el("td", { class: "num-col", text: last ? fmtDay(last.ts) : "—" }),
    ));

    const detailRows = quizzes.map((quiz) => {
      const st = quizStats(quiz);
      const pill = quiz.published
        ? el("span", { class: "pill pill--live", text: "Published" })
        : el("span", { class: "pill pill--draft", text: "Draft" });
      return el("tr", {},
        el("td", {},
          el("span", { class: "cell-title", text: quiz.title }),
          quiz.origin === "ai" ? el("span", { class: "pill pill--ai", text: "AI" }) : null,
          quiz.desc ? el("span", { class: "cell-sub", text: quiz.desc }) : null),
        el("td", {}, pill),
        el("td", { class: "num-col", text: String(quiz.questions.length) }),
        el("td", { class: "num-col", text: st.avg == null ? "—" : `${st.avg}%` }),
        el("td", { class: "num-col", text: `${st.roster} of ${ROSTER.length}` }),
        el("td", { class: "cell-actions" },
          el("button", { class: "btn btn--outline btn--sm", type: "button", text: "Play", onclick: () => openPlayer(quiz.id) }),
          el("button", {
            class: "btn btn--ghost btn--sm", type: "button", text: "Edit", "aria-label": `Edit ${quiz.title}`,
            onclick: () => { loadQuizIntoBuilder(quiz.id); nav("builder"); },
          }),
          el("button", {
            class: "btn btn--ghost btn--sm", type: "button", text: "Delete", "aria-label": `Delete ${quiz.title}`,
            onclick: () => askConfirm(`Delete “${quiz.title}”?`,
              "The quiz and its questions will be removed. Logged attempts stay in the results ledger.",
              "Delete Quiz", () => {
                state.quizzes = state.quizzes.filter((q) => q.id !== quiz.id);
                logActivity("edit", `Deleted “${quiz.title}”`);
                if (state.lastQuizId === quiz.id) state.lastQuizId = state.quizzes[0]?.id ?? null;
                if (state.builderQuizId === quiz.id) resetBuilder();
                save(); renderAll();
                toast("Quiz deleted");
              }),
          }),
        ),
      );
    });
    if (!detailRows.length) {
      detailRows.push(el("tr", {}, el("td", { colspan: "6" }, el("span", { class: "meta", text: "No quizzes in this subject yet." }))));
    }

    tbody.append(el("tr", { class: "tr-detail", id: `detail-${sub.id}`, hidden: true },
      el("td", { colspan: "6" },
        el("table", { class: "table table--detail" },
          el("caption", { class: "visually-hidden", text: `Quizzes in ${sub.name}` }),
          el("thead", {}, el("tr", {},
            el("th", { scope: "col", text: "Quiz" }),
            el("th", { scope: "col", text: "Status" }),
            el("th", { scope: "col", class: "num-col", text: "Qs" }),
            el("th", { scope: "col", class: "num-col", text: "Avg Marks" }),
            el("th", { scope: "col", class: "num-col", text: "Attended" }),
            el("th", { scope: "col", text: "" }))),
          el("tbody", {}, ...detailRows)))));
  }
}

function renderActivity() {
  const list = $("#activity-list");
  list.textContent = "";
  const expiryNote = $("#activity-expiry");
  const empty = $("#activity-empty");
  const items = activityItems();

  if (empty) empty.hidden = items.length > 0;

  if (items.length === 0) {
    if (expiryNote) expiryNote.hidden = true;
    if (empty) empty.querySelector(".empty__note").textContent =
      isStudent() ? "Take a quiz — scores land here." : "Nothing logged yet.";
    return;
  }

  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  for (const item of items) {
    if (item.ts < cutoff) continue; // entries expire after 24 hours
    list.append(el("li", {},
      el("span", { class: `act-dot act-dot--${item.kind}`, "aria-hidden": "true" }),
      el("div", { class: "act-text" },
        el("span", { text: item.text }),
        el("time", { datetime: new Date(item.ts).toISOString(), text: fmtDay(item.ts) }),
      ),
    ));
  }

  if (expiryNote) expiryNote.hidden = list.children.length === 0;
  if (list.children.length === 0 && empty) {
    empty.hidden = false;
  }
}

function renderRoster() {
  const list = $("#roster-list");
  list.textContent = "";
  $("#roster-count").textContent = String(ROSTER.length);
  for (const name of ROSTER) {
    const n = classAttempts().filter((a) => a.student === name).length;
    list.append(el("li", {},
      el("span", { class: "r-name", text: name }),
      el("span", { class: "r-meta", text: n ? `${n} attempt${n === 1 ? "" : "s"}` : "no attempts yet" })));
  }
}

/* ─── rail library (teacher): Drafts screen + Fav/Bookmark flyouts ── */
/* per-screen UI state: search keyword + subject filter */
const libState = {
  favs: { q: "", subject: "all" },
  bookmarks: { q: "", subject: "all" },
};

/* rail count badges (drafts/favs/bookmarks) kept fresh on every render */
function libTotals() {
  return {
    drafts: state.quizzes.filter((q) => !q.practice && !q.published).length,
    favs: state.qFavs.length,
    bookmarks: state.qTemplates.length,
  };
}

/* badges show UNSEEN items: opening a screen marks everything on it seen; items
   added afterwards count up from 1. Tracked as seen-id sets so deletions and
   re-adds can't corrupt the arithmetic (count snapshots drift after removes). */
function libItems(kind) {
  if (kind === "drafts") return state.quizzes.filter((q) => !q.practice && !q.published);
  if (kind === "favs") return state.qFavs;
  return state.qTemplates;
}
function unseenCount(kind) {
  const seen = state.libSeen[kind];
  if (seen == null) return libItems(kind).length; // never opened: everything is unseen
  if (typeof seen === "number") return 0; // legacy count marker — treat as fully seen
  const ids = new Set(seen.ids || []);
  return libItems(kind).filter((it) => !ids.has(it.id)).length;
}
function updateLibraryBadges() {
  for (const kind of ["drafts", "favs", "bookmarks"]) {
    const unseen = unseenCount(kind);
    // the favourites badge lives on BOTH role rails — teacher and student
    for (const id of (kind === "favs" ? ["#rail-favs-count", "#rail-student-favs-count"] : [`#rail-${kind}-count`])) {
      const badge = $(id);
      if (!badge) continue;
      badge.textContent = String(unseen);
      badge.hidden = unseen === 0;
    }
  }
}

function markLibrarySeen(kind) {
  if (!(kind in libTotals())) return;
  const ids = libItems(kind).map((it) => it.id);
  const prev = state.libSeen[kind];
  const prevIds = Array.isArray(prev?.ids) ? prev.ids : [];
  const merged = new Set([...prevIds, ...ids]); // keep history: old seen ids stay seen
  state.libSeen[kind] = { ids: [...merged] };
  updateLibraryBadges();
}

function renderRailDrafts() { updateLibraryBadges(); }

/* dedicated Drafts screen — one row per drafted quiz */
function renderDraftsScreen() {
  const host = $("#drafts-rows");
  const empty = $("#drafts-empty");
  const count = $("#drafts-count");
  if (!host || isStudent()) return;

  const drafts = state.quizzes
    .filter((q) => !q.practice && !q.published)
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));

  updateLibraryBadges();
  if (count) count.textContent = String(drafts.length);
  if (empty) empty.hidden = drafts.length > 0;
  host.textContent = "";
  for (const quiz of drafts) {
    const sub = subjectById(quiz.subjectId);
    host.append(el("div", { class: "draft-row" },
      el("div", { class: "draft-row__info" },
        el("span", { class: "draft-row__title", text: quiz.title }),
        el("span", { class: "draft-row__sub", text: quiz.scheduledFor
          ? `Scheduled — ${fmtDay(quiz.scheduledFor)}`
          : `${sub.name} · ${quiz.questions.length} question${quiz.questions.length === 1 ? "" : "s"}` })),
      el("button", {
        class: "btn btn--outline btn--sm", type: "button",
        "aria-label": `Continue editing ${quiz.title}`,
        onclick: () => {
          // confirm first when the builder holds unsaved work that would be replaced
          if (builderHasUnsaved()) {
            askConfirm("Load quiz into quiz builder?", "Unsaved quiz will be lost.", "Yes", () => {
              loadQuizIntoBuilder(quiz.id);
              nav("builder");
            }, "No");
          } else {
            loadQuizIntoBuilder(quiz.id);
            nav("builder");
          }
        },
      }, "Continue editing")));
  }
}

/* saved-question library screens — search + funnel + rows */
function libList(kind) {
  const st = libState[kind];
  const src = kind === "favs" ? state.qFavs : state.qTemplates;
  const kw = st.q.trim().toLowerCase();
  return src.filter((entry) => {
    // subject filter: entries saved before subjects were tracked have no id —
    // they only show under "All subjects"
    if (st.subject !== "all" && (entry.subjectId || null) !== st.subject) return false;
    if (!kw) return true;
    // keyword search matches ONLY what the row visibly shows: the question text
    // plus the CORRECT answer (as displayed in the row meta) — not the hidden
    // wrong options, which caused "no k anywhere" rows to match.
    const hay = `${entry.text} ${entry.options[entry.correct] || ""}`.toLowerCase();
    return hay.includes(kw);
  });
}

function renderLibFilter(kind) {
  const host = kind === "favs" ? $("#favs-filter-opts") : $("#bookmarks-filter-opts");
  if (!host) return;
  const st = libState[kind];
  host.textContent = "";
  const mk = (value, label, accent) => {
    host.append(el("button", {
      class: `lib-filter-opt${st.subject === value ? " is-active" : ""}`, type: "button",
      onclick: () => { st.subject = value; renderLibFilter(kind); renderLibScreen(kind); },
    },
      accent ? el("span", { class: "sub-dot", "data-accent": accent }) : null,
      el("span", { text: label })));
  };
  mk("all", "All subjects", null);
  for (const s of SUBJECTS) mk(s.id, s.name, s.accent); // rebuilt per render — picks up future subjects
}

function renderLibScreen(kind) {
  const host = kind === "favs" ? $("#favs-rows") : $("#bookmarks-rows");
  const empty = kind === "favs" ? $("#favs-empty") : $("#bookmarks-empty");
  const count = kind === "favs" ? $("#favs-count") : $("#bookmarks-count");
  if (!host) return;
  if (isStudent() && kind !== "favs") return; // templates are teacher-only
  updateLibraryBadges();
  // student favs badge is driven by the shared unseen logic — no raw-count override

  const src = kind === "favs" ? state.qFavs : state.qTemplates;
  const rows = libList(kind);
  if (count) count.textContent = String(rows.length);
  if (empty) empty.hidden = src.length > 0;
  host.textContent = "";

  if (src.length && !rows.length) {
    host.append(el("p", { class: "lib-empty-note", text: "No questions match your search or filter." }));
    appendPlanEndedNote(host, kind);
    return;
  }
  const label = kind === "favs" ? "favourites" : "templates";
  const limitKey = kind === "favs" ? "favs" : "templates";
  const allowance = planLimit(limitKey); // entries beyond this blur once the 3-day grace is over
  const lockExcess = planGraceOver() && !isStudent();
  for (const entry of rows) {
    const globalIdx = src.findIndex((s) => s.id === entry.id);
    const locked = lockExcess && globalIdx >= allowance;
    const sub = SUBJECTS.find((s) => s.id === entry.subjectId);
    const student = isStudent();
    host.append(el("div", { class: `qrow${locked ? " lib-row--locked" : ""}` },
      el("div", {
        class: "qrow__body", role: "button", tabindex: "0",
        "aria-label": student ? `Practice this favourite question` : `Load question into the builder form`,
        onclick: () => {
          if (student) {
            // students practice the favourited question right in the AI practice flow
            startPracticeFromFav(entry);
            return;
          }
          if (!currentBuilderQuiz()) { toast("Save the quiz first — give it a title in the builder."); nav("builder"); return; }
          nav("builder");
          state.editingQuestionId = null;
          $("#qeditor-title").textContent = "Add a Question";
          $("#btn-save-question").textContent = "Add Question";
          $("#btn-clear-question").hidden = false;
          $("#q-text").value = entry.text;
          buildChoiceRow();
          entry.options.forEach((opt, i) => { $(`#choice-${i}`).value = opt; });
          $(`input[name="correct-choice"][value="${entry.correct}"]`).checked = true;
          updateChoiceTags();
          updateQSaveButtons();
          $("#q-text").focus();
          toast(`Loaded from ${label} — press Add Question to attach it`);
        },
        onkeydown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.target.click(); } },
      },
        el("span", { class: "qrow__text", text: entry.text }),
        el("span", { class: "qrow__meta", text: `${sub ? `${sub.name} · ` : ""}Correct: ${String.fromCharCode(65 + entry.correct)} · ${entry.options[entry.correct]}` })),
      el("button", {
        class: "qrow__remove", type: "button",
        "aria-label": `Remove from ${label}`,
        onclick: (e) => {
          e.stopPropagation();
          const arr = kind === "favs" ? state.qFavs : state.qTemplates;
          const idx = arr.findIndex((x) => x.id === entry.id);
          if (idx >= 0) arr.splice(idx, 1);
          save();
          renderLibScreen(kind);
          updateQSaveButtons();
          toast(`Removed from ${label}`);
        },
      }, el("svg", { class: "ico", "aria-hidden": "true" }, el("use", { href: "#i-trash" })))));
  }
  appendPlanEndedNote(host, kind);
}

/* faint line at the very end of Favourites / Templates while a paid plan has lapsed */
function appendPlanEndedNote(host, kind) {
  if (!host || !planHasEnded()) return;
  const label = kind === "favs" ? "favourites" : "templates";
  const note = el("p", { class: "plan-ended-note" },
    document.createTextNode("Your plan has ended. "));
  note.append(el("button", {
    type: "button", text: "Upgrade now to retain your benefits.",
    onclick: () => openPlans(),
  }));
  host.append(note);
}

function renderFavsScreen() { renderLibFilter("favs"); renderLibScreen("favs"); }
function renderBookmarksScreen() { renderLibFilter("bookmarks"); renderLibScreen("bookmarks"); }

for (const kind of ["favs", "bookmarks"]) {
  $(`#${kind}-filter-btn`)?.addEventListener("click", (e) => {
    e.stopPropagation();
    const panel = $(`#${kind}-filter`);
    panel.hidden = !panel.hidden;
    $(`#${kind}-filter-btn`).setAttribute("aria-expanded", String(!panel.hidden));
  });
  $(`#${kind}-search`)?.addEventListener("input", (e) => {
    libState[kind].q = e.target.value;
    renderLibScreen(kind);
  });
}
document.addEventListener("click", (e) => {
  for (const kind of ["favs", "bookmarks"]) {
    const panel = $(`#${kind}-filter`);
    if (!panel || panel.hidden) continue;
    if (!panel.contains(e.target) && !$(`#${kind}-filter-btn`).contains(e.target)) {
      panel.hidden = true;
      $(`#${kind}-filter-btn`).setAttribute("aria-expanded", "false");
    }
  }
});

/* ─── dashboard — student ────────────────────────────────────────── */
/* "Next Up" rail card — the next unattempted class quiz, one click to resume. */
function renderNextUp() {
  const host = $("#student-nextup");
  if (!host || !isStudent()) return;
  const mine = myAttempts();
  const next = state.quizzes
    .filter((q) => isLiveForStudents(q) && !mine.some((a) => a.quizId === q.id))
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0] || null;
  host.textContent = "";
  if (!next) {
    host.append(el("div", { class: "rail-card is-stale" },
      el("span", { class: "rail-card__title", text: "All caught up" }),
      el("span", { class: "rail-card__sub", text: "No open class quizzes — new ones land here." })));
    return;
  }
  const sub = subjectById(next.subjectId);
  host.append(el("button", {
    class: "rail-card rail-card--accent", type: "button",
    onclick: () => openPlayer(next.id),
  },
    el("span", { class: "rail-card__title" },
      el("span", { "aria-hidden": "true", text: "→" }),
      el("span", { text: next.title })),
    el("span", { class: "rail-card__sub", text: `${sub.name} · ${next.questions.length} questions` }),      el("span", { class: "rail-card__meta", text: `Due: ${fmtDay(next.updatedAt || next.createdAt)}` })));
}

function renderStudentStats() {
  const mine = myAttempts();
  const avg = mine.length
    ? Math.round((mine.reduce((s, a) => s + a.score / a.total, 0) / mine.length) * 100)
    : null;
  const cls = state.attempts.length
    ? Math.round((state.attempts.reduce((s, a) => s + a.score / a.total, 0) / state.attempts.length) * 100)
    : null;
  const subjects = new Set(mine.map((a) => a.subjectId)).size;

  setStat(1, "Subjects", String(subjects), mine.length ? "with quizzes attended" : "attend a quiz to start");
  setStat(2, "Quizzes Taken", String(mine.length), mine.length ? `latest ${fmtDay(mine[0].ts)}` : "no plays yet");
  setStat(3, "Your Average", avg == null ? "—" : `${avg}%`, mine.length ? "mean accuracy" : "—");
  setStat(4, "Class Average", cls == null ? "—" : `${cls}%`, "how the whole batch is doing", true);
}

function renderMySubjects() {
  const tbody = $("#subjects-tbody");
  tbody.textContent = "";

  // Most recently attended subject first.
  const order = SUBJECTS
    .map((sub) => ({ sub, last: myAttempts().find((a) => a.subjectId === sub.id) }))
    .sort((a, b) => (b.last?.ts ?? 0) - (a.last?.ts ?? 0));

  $("#subjects-count").textContent = String(order.length);
  $("#subjects-empty").hidden = order.length > 0;

  for (const { sub, last } of order) {
    const mine = myAttempts().filter((a) => a.subjectId === sub.id);
    const avg = mine.length
      ? Math.round((mine.reduce((s, a) => s + a.score / a.total, 0) / mine.length) * 100)
      : null;
    const taken = new Set(mine.map((a) => a.quizId)).size;
    // student ledger: teacher quizzes + the student's own AI practice for this subject
    const quizzes = state.quizzes.filter((q) => isLiveForStudents(q) && q.subjectId === sub.id && (!q.practice || q.origin === "ai"));
    const openCount = quizzes.length;

    tbody.append(el("tr", { class: "tr-sub" },
      el("td", {},
        el("button", {
          class: "expand-btn", type: "button",
          "aria-expanded": "false", "aria-controls": `sdetail-${sub.id}`,
          onclick: (e) => toggleSubject(e.currentTarget, sub.id, "sdetail"),
        },
          el("span", { class: "chev", "aria-hidden": "true", text: "▸" }),
          el("span", { class: "sub-dot", "data-accent": sub.accent, "aria-hidden": "true" }),
          el("span", { class: "sub-name", text: sub.name })),
        el("span", {
          class: "cell-sub",
          text: mine.length
            ? `${taken} quiz${taken === 1 ? "" : "zes"} attended${last ? ` · last ${fmtDay(last.ts)}` : ""}`
            : "No quizzes attended yet",
        })),
      el("td", { class: "num-col", text: String(taken) }),
      el("td", { class: "num-col", text: last ? fmtDay(last.ts) : "—" }),
      el("td", { class: "num-col" },
        el("span", { class: avg == null ? "meta" : avg >= 60 ? "mark-good" : "mark-warn",
                     text: avg == null ? "—" : `${avg}%` })),
      el("td", { class: "num-col", text: String(openCount) }),
    ));

    const detailRows = quizzes.map((quiz) => {
      const mineQ = myAttempts().filter((a) => a.quizId === quiz.id);
      const best = mineQ.length ? Math.max(...mineQ.map((a) => pctOf(a.score, a.total))) : null;
      const nextUp = !mineQ.length;
      // retakes are only for AI practice quizzes — teacher quizzes are one-shot
      const retakeAllowed = !!quiz.practice;
      const done = mineQ.length > 0 && !retakeAllowed;
      return el("tr", {},
        el("td", {},
          el("span", { class: "cell-title", text: quiz.title }),
          quiz.desc ? el("span", { class: "cell-sub", text: quiz.desc }) : null),
        el("td", { class: "num-col", text: String(quiz.questions.length) }),
        el("td", { class: "num-col", text: done ? "Completed" : mineQ.length ? `${mineQ.length} taken` : "Not taken" }),
        el("td", { class: "num-col", text: best == null ? "—" : `${best}%` }),
        el("td", { class: "cell-actions" },
          done
            ? el("span", { class: "meta", text: "Completed ✓" })
            : !quiz.questions.length
              ? el("span", { class: "meta", text: "Empty" })
              : el("button", {
                  class: `btn ${nextUp ? "btn--primary" : "btn--outline"} btn--sm`, type: "button",
                  text: mineQ.length ? "Retake" : "Take",
                  onclick: () => openPlayer(quiz.id),
                })),
      );
    });
    if (!detailRows.length) {
      detailRows.push(el("tr", {}, el("td", { colspan: "5" }, el("span", { class: "meta", text: "No open quizzes in this subject yet." }))));
    }

    tbody.append(el("tr", { class: "tr-detail", id: `sdetail-${sub.id}`, hidden: true },
      el("td", { colspan: "5" },
        el("table", { class: "table table--detail" },
          el("caption", { class: "visually-hidden", text: `Quizzes in ${sub.name}` }),
          el("thead", {}, el("tr", {},
            el("th", { scope: "col", text: "Quiz" }),
            el("th", { scope: "col", class: "num-col", text: "Qs" }),
            el("th", { scope: "col", class: "num-col", text: "Status" }),
            el("th", { scope: "col", class: "num-col", text: "Your Best" }),
            el("th", { scope: "col", text: "" }))),
          el("tbody", {}, ...detailRows)))));
  }
}

function renderAvailable() {
  const tbody = $("#avail-tbody");
  tbody.textContent = "";
  const quizzes = state.quizzes.filter(isLiveForStudents);
  $("#avail-count").textContent = `${quizzes.length} open`;
  $("#avail-empty").hidden = quizzes.length > 0;

  for (const quiz of quizzes) {
    const sub = subjectById(quiz.subjectId);
    const mine = myAttempts().filter((a) => a.quizId === quiz.id);
    const best = mine.length ? Math.max(...mine.map((a) => pctOf(a.score, a.total))) : null;
    tbody.append(el("tr", {},
      el("td", {},
        el("span", { class: "cell-title", text: quiz.title }),
        quiz.desc ? el("span", { class: "cell-sub", text: quiz.desc }) : null),
      el("td", {}, el("span", { class: "pill", "data-accent": sub.accent, text: sub.short })),
      el("td", { class: "num-col", text: String(quiz.questions.length) }),
      el("td", { class: "num-col", text: mine.length ? `${mine.length} taken` : "Not taken" }),
      el("td", { class: "num-col", text: best == null ? "—" : `${best}%` }),
      el("td", { class: "cell-actions" },
        !quiz.questions.length
          ? el("span", { class: "meta", text: "Empty" })
          : el("button", {
              class: "btn btn--outline btn--sm", type: "button",
              text: mine.length ? "Retake" : "Take",
              onclick: () => openPlayer(quiz.id),
            })),
    ));
  }
}

function renderRecent() {
  const list = $("#recent-list");
  list.textContent = "";
  const expiryNote = $("#recent-expiry");
  const mine = myAttempts();
  $("#recent-empty").hidden = mine.length > 0;

  if (mine.length === 0) {
    if (expiryNote) expiryNote.hidden = true;
    return;
  }

  for (const a of mine) {
    list.append(el("li", {},
      el("span", { class: `act-dot act-dot--${pctOf(a.score, a.total) >= 60 ? "live" : "accent"}`, "aria-hidden": "true" }),
      el("div", { class: "act-text" },
        el("span", { text: `${a.quizTitle} — ${a.score}/${a.total} (${pctOf(a.score, a.total)}%)` }),
        el("time", { datetime: new Date(a.ts).toISOString(), text: fmtDay(a.ts) }),
      ),
    ));
  }

  if (expiryNote) expiryNote.hidden = false;
}

function renderDashboard() {
  if (isStudent()) {
    renderStudentStats();
    renderMySubjects();
    renderStreakBadges();
    renderPerksPanel();
    renderSpacedRepetition();
    updateBellDot();
  } else {
    renderTeacherStats();
    renderQuizTable();
    renderTeacherPerks();
    updateBellDot();
    renderRoster();
  }
}

/* ─── teacher perks: weekly class digest + student snapshots ─────── */
function weeklyClassDigest() {
  const weekAgo = Date.now() - 7 * 86400000;
  const week = classAttempts().filter((a) => a.ts >= weekAgo);
  const quizzes = new Set(week.map((a) => a.quizId)).size;
  const students = new Set(week.map((a) => a.student));
  const avg = week.length ? Math.round(week.reduce((s, a) => s + a.score / a.total, 0) / week.length * 100) : null;
  const roster = ROSTER.length || 1;
  const attendance = Math.round((students.size / roster) * 100);
  // most-missed question this week
  const missTally = new Map();
  for (const a of week) {
    (a.answers || []).forEach((ans) => {
      if (ans.correct) return;
      const cur = missTally.get(ans.text) || { text: ans.text, misses: 0, seen: 0 };
      cur.misses++;
      missTally.set(ans.text, cur);
    });
  }
  const mostMissed = [...missTally.values()].sort((x, y) => y.misses - x.misses)[0] || null;
  // per-student week stats for top/struggling
  const perStudent = new Map();
  for (const a of week) {
    const cur = perStudent.get(a.student) || { name: a.student, n: 0, sum: 0 };
    cur.n++; cur.sum += a.score / a.total;
    perStudent.set(a.student, cur);
  }
  const ranked = [...perStudent.values()]
    .map((r) => ({ ...r, pct: Math.round((r.sum / r.n) * 100) }))
    .sort((x, y) => y.pct - x.pct);
  return {
    quizzes, students: students.size, avg, attendance, week,
    top: ranked[0] || null,
    struggling: ranked.length > 1 ? ranked[ranked.length - 1] : null,
    mostMissed,
  };
}

function renderWeeklyDigest() {
  const grid = $("#digest-week-grid");
  const lows = $("#digest-week-lows");
  if (!grid || !lows || isStudent()) return;
  const d = weeklyClassDigest();
  grid.textContent = "";
  const cell = (num, label, accent = false) =>
    el("div", { class: `digest-week-cell${accent ? " digest-week-cell--accent" : ""}` },
      el("p", { class: "digest-week-cell__num num", text: num }),
      el("p", { class: "digest-week-cell__label", text: label }));
  grid.append(
    cell(String(d.quizzes), "quizzes conducted"),
    cell(d.avg == null ? "—" : `${d.avg}%`, "class average", true),
    cell(`${d.attendance}%`, "class participation"),
    cell(String(d.students), "students active"),
  );
  lows.textContent = "";
  const low = (tag, text) => el("div", { class: "digest-low" },
    el("span", { class: "digest-low__tag", text: tag }),
    el("span", { class: "digest-low__text", text }));
  if (d.week.length === 0) {
    lows.append(low("quiet week", "No class attempts in the last 7 days — publish a quiz to get things moving."));
    return;
  }
  if (d.top) lows.append(low("top of the week", `${d.top.name} — ${d.top.pct}% across ${d.top.n} attempt${d.top.n === 1 ? "" : "s"}`));
  if (d.struggling && d.struggling.name !== d.top?.name) lows.append(low("needs a nudge", `${d.struggling.name} — ${d.struggling.pct}%; a quick 1:1 or practice quiz might help`));
  if (d.mostMissed) lows.append(low("most missed", `“${d.mostMissed.text}” — missed by ${d.mostMissed.misses} student${d.mostMissed.misses === 1 ? "" : "s"}; worth a re-cap`));
}

/* trend: compare this week's avg vs prior week's (last 7 vs previous 7 days) */
function studentTrend(name) {
  const mine = state.attempts.filter((a) => a.student === name && !a.practice);
  const now = Date.now();
  const thisWeek = mine.filter((a) => a.ts >= now - 7 * 86400000);
  const prevWeek = mine.filter((a) => a.ts >= now - 14 * 86400000 && a.ts < now - 7 * 86400000);
  const pctOfList = (list) => list.length ? list.reduce((s, a) => s + a.score / a.total, 0) / list.length : null;
  const cur = pctOfList(thisWeek), prev = pctOfList(prevWeek);
  if (cur == null && prev == null) return { dir: "flat", label: "no activity" };
  if (prev == null) return { dir: "up", label: `new this week · ${Math.round(cur * 100)}%` };
  if (cur == null) return { dir: "flat", label: "quiet this week" };
  const delta = Math.round((cur - prev) * 100);
  if (delta > 0) return { dir: "up", label: `▲ ${delta}% vs last week` };
  if (delta < 0) return { dir: "down", label: `▼ ${Math.abs(delta)}% vs last week` };
  return { dir: "flat", label: "steady vs last week" };
}

function studentSnapshot(name) {
  const mine = state.attempts.filter((a) => a.student === name && !a.practice);
  const avg = mine.length ? Math.round(mine.reduce((s, a) => s + a.score / a.total, 0) / mine.length * 100) : null;
  const best = mine.length ? Math.max(...mine.map((a) => pctOf(a.score, a.total))) : null;
  const last = mine.length ? mine.reduce((b, a) => (a.ts > b.ts ? a : b)) : null;
  const subjects = new Set(mine.map((a) => a.subjectId)).size;
  return { name, taken: mine.length, avg, best, last, subjects, trend: studentTrend(name) };
}

function renderSnapshots() {
  const strip = $("#snap-strip");
  const cards = $("#snap-cards");
  if (!strip || !cards || isStudent()) return;
  const snaps = snapshotList();
  const count = $("#snap-count");
  if (count) count.textContent = String(snaps.length);
  const trendCls = (t) => t.dir === "up" ? "snap-row__trend snap-row__trend--up"
    : t.dir === "down" ? "snap-row__trend snap-row__trend--down" : "snap-row__trend snap-row__trend--flat";
  // compact strip
  strip.textContent = "";
  for (const s of snaps) {
    strip.append(el("div", { class: "snap-row" },
      el("span", { class: "snap-row__name", text: s.name }),
      el("span", { class: "snap-row__meta", text: s.taken ? `${s.taken} taken` : "—" }),
      el("span", { class: "snap-row__meta", text: s.avg == null ? "—" : `${s.avg}% avg` }),
      el("span", { class: trendCls(s.trend), text: s.trend.label })));
  }
  // full cards
  cards.textContent = "";
  for (const s of snaps) {
    cards.append(el("div", { class: "snap-card" },
      el("div", { class: "snap-card__head" },
        el("p", { class: "snap-card__name", text: s.name }),
        el("span", { class: trendCls(s.trend), text: s.trend.label })),
      el("div", { class: "snap-card__grid" },
        el("span", {}, "Quizzes: ", el("b", { text: String(s.taken) })),
        el("span", {}, "Average: ", el("b", { text: s.avg == null ? "—" : `${s.avg}%` })),
        el("span", {}, "Best: ", el("b", { text: s.best == null ? "—" : `${s.best}%` })),
        el("span", {}, "Subjects: ", el("b", { text: String(s.subjects) }))),
      el("p", { class: "snap-card__foot", text: s.last ? `Last active ${fmtDay(s.last.ts)} — ${s.last.quizTitle}` : "No attempts yet" })));
  }
  const noMatch = snaps.length === 0 && ROSTER.length > 0;
  const showCards = $("#btn-snap-mode").getAttribute("aria-pressed") === "true";
  strip.hidden = showCards;
  cards.hidden = !showCards;
  const noteHost = noMatch ? (showCards ? cards : strip) : null;
  if (noteHost) noteHost.append(el("p", { class: "lib-empty-note", text: "No students match your search or filter." }));
}

/* search + funnel state for Student Snapshots */
const snapFilterState = { q: "", takenMin: null, takenMax: null, avgMin: null, avgMax: null, attended: false, unattended: false };
/* sort order for snapshots — cycles through SNAP_SORTS on each press of the Sort button */
const SNAP_SORTS = ["name-asc", "name-desc", "taken-asc", "taken-desc", "avg-asc", "avg-desc"];
const SNAP_SORT_LABELS = {
  "name-asc": "Name (A-Z)", "name-desc": "Name (Z-A)",
  "taken-asc": "Least Taken", "taken-desc": "Most Taken",
  "avg-asc": "Least Average", "avg-desc": "Most Average",
};
let snapSortIdx = 0;

function snapSortCompare(a, b) {
  const mode = SNAP_SORTS[snapSortIdx];
  if (!mode) return 0; // unreachable — SNAP_SORTS never holds null
  switch (mode) {
    case "name-asc": return a.name.localeCompare(b.name);
    case "name-desc": return b.name.localeCompare(a.name);
    case "taken-asc": return a.taken - b.taken || a.name.localeCompare(b.name);
    case "taken-desc": return b.taken - a.taken || a.name.localeCompare(b.name);
    case "avg-asc": return (a.avg ?? -1) - (b.avg ?? -1) || a.name.localeCompare(b.name);
    case "avg-desc": return (b.avg ?? -1) - (a.avg ?? -1) || a.name.localeCompare(b.name);
  }
  return 0;
}

function snapshotList() {
  const kw = snapFilterState.q.trim().toLowerCase();
  const f = snapFilterState;
  return ROSTER.map(studentSnapshot).filter((s) => {
    if (kw && !s.name.toLowerCase().includes(kw)) return false;
    if (f.attended !== f.unattended) {
      if (f.attended && s.taken === 0) return false;
      if (f.unattended && s.taken > 0) return false;
    }
    if (f.takenMin != null && s.taken < f.takenMin) return false;
    if (f.takenMax != null && s.taken > f.takenMax) return false;
    // students with no attempts have no average — they only survive an
    // average filter when the unattended box is also ticked
    if ((f.avgMin != null || f.avgMax != null) && s.avg == null) return false;
    if (f.avgMin != null && s.avg < f.avgMin) return false;
    if (f.avgMax != null && s.avg > f.avgMax) return false;
    return true;
  }).sort(snapSortCompare);
}

function readSnapFilter() {
  const num = (id) => {
    const v = $(id).value.trim();
    return v === "" ? null : Math.max(0, Number(v));
  };
  snapFilterState.takenMin = num("#snap-flt-taken-min");
  snapFilterState.takenMax = num("#snap-flt-taken-max");
  snapFilterState.avgMin = num("#snap-flt-avg-min");
  snapFilterState.avgMax = num("#snap-flt-avg-max");
  snapFilterState.attended = $("#snap-flt-attended").checked;
  snapFilterState.unattended = $("#snap-flt-unattended").checked;
}

function clearSnapFilter() {
  for (const id of ["#snap-flt-taken-min", "#snap-flt-taken-max", "#snap-flt-avg-min", "#snap-flt-avg-max"]) $(id).value = "";
  $("#snap-flt-attended").checked = false;
  $("#snap-flt-unattended").checked = false;
  Object.assign(snapFilterState, { takenMin: null, takenMax: null, avgMin: null, avgMax: null, attended: false, unattended: false });
}

/* sort cycler — each press advances Name A-Z → Name Z-A → Least Taken →
   Most Taken → Least Average → Most Average → back to Name A-Z */
$("#snap-sort-btn")?.addEventListener("click", () => {
  snapSortIdx = (snapSortIdx + 1) % SNAP_SORTS.length;
  $("#snap-sort-value").textContent = SNAP_SORT_LABELS[SNAP_SORTS[snapSortIdx]];
  renderSnapshots();
});

/* attendance checkboxes apply immediately — no Apply press needed */
for (const id of ["#snap-flt-attended", "#snap-flt-unattended"]) {
  $(id)?.addEventListener("change", () => {
    snapFilterState.attended = $("#snap-flt-attended").checked;
    snapFilterState.unattended = $("#snap-flt-unattended").checked;
    renderSnapshots();
  });
}

$("#snap-search")?.addEventListener("input", (e) => {
  snapFilterState.q = e.target.value;
  renderSnapshots();
});
$("#snap-filter-btn")?.addEventListener("click", (e) => {
  e.stopPropagation();
  const panel = $("#snap-filter");
  panel.hidden = !panel.hidden;
  $("#snap-filter-btn").setAttribute("aria-expanded", String(!panel.hidden));
});
$("#snap-flt-apply")?.addEventListener("click", () => {
  readSnapFilter();
  renderSnapshots();
  $("#snap-filter").hidden = true;
  $("#snap-filter-btn").setAttribute("aria-expanded", "false");
});
$("#snap-flt-clear")?.addEventListener("click", () => {
  clearSnapFilter();
  renderSnapshots();
});
document.addEventListener("click", (e) => {
  const panel = $("#snap-filter");
  if (!panel || panel.hidden) return;
  if (!panel.contains(e.target) && !$("#snap-filter-btn").contains(e.target)) {
    panel.hidden = true;
    $("#snap-filter-btn").setAttribute("aria-expanded", "false");
  }
});

function renderTeacherPerks() {
  if (isStudent()) return;
  const host = $("#teacher-perks");
  if (host) host.hidden = false;
  renderWeeklyDigest();
  renderSnapshots();
}

$("#btn-snap-mode")?.addEventListener("click", (e) => {
  const btn = e.currentTarget;
  const showCards = btn.getAttribute("aria-pressed") !== "true";
  btn.setAttribute("aria-pressed", String(showCards));
  btn.textContent = showCards ? "Compact list" : "Full cards";
  $("#snap-cards").hidden = !showCards;
  $("#snap-strip").hidden = showCards;
});

/* ─── builder ────────────────────────────────────────────────────── */
function currentBuilderQuiz() {
  return state.quizzes.find((q) => q.id === state.builderQuizId) || null;
}

function syncBuilderInputs() {
  const quiz = currentBuilderQuiz();
  $("#meta-form-title").textContent = quiz ? "Quiz Details" : "New Quiz";
  $("#btn-save-quiz").textContent = quiz ? "Update Details" : "Save Quiz";
  $("#btn-play-current").hidden = !quiz;
  const timed = $("#quiz-timed").getAttribute("aria-checked") === "true";
  $("#quiz-time-limit-field").hidden = !timed;
  const scheduled = $("#quiz-schedule").getAttribute("aria-checked") === "true";
  $("#quiz-schedule-field").hidden = !scheduled;
  // Publish immediately is a mode — it excludes Schedule (and vice versa).
  // Timed quiz is independent of both.
  const pubOn = $("#quiz-publish").getAttribute("aria-checked") === "true";
  $("#quiz-schedule").classList.toggle("is-locked", pubOn);
  $("#quiz-schedule").setAttribute("aria-disabled", String(pubOn));
  $("#quiz-publish").classList.toggle("is-locked", scheduled);
  $("#quiz-publish").setAttribute("aria-disabled", String(scheduled));
}

/* true when the builder form holds work that isn't saved yet: a new quiz
   half-typed (no quiz loaded but fields filled), or edits that diverge
   from the loaded quiz's stored details */
function builderHasUnsaved() {
  const title = $("#quiz-title").value.trim();
  const desc = $("#quiz-desc").value.trim();
  if (!state.builderQuizId) return !!(title || desc);
  const quiz = currentBuilderQuiz();
  if (!quiz) return false;
  return title !== quiz.title || desc !== (quiz.desc || "");
}

function resetBuilder() {
  state.builderQuizId = null;
  state.editingQuestionId = null;
  $("#quiz-title").value = "";
  $("#quiz-desc").value = "";
  $("#quiz-subject").value = SUBJECTS[0]?.id || "";
  $("#quiz-publish").setAttribute("aria-checked", "false");
  $("#quiz-timed").setAttribute("aria-checked", "false");
  $("#quiz-time-limit").value = "300";
  $("#quiz-hints").setAttribute("aria-checked", "false");
  resetQuestionForm();
  renderQuestionList();
  syncBuilderInputs();
}

function loadQuizIntoBuilder(id) {
  const quiz = state.quizzes.find((q) => q.id === id);
  if (!quiz) return;
  state.builderQuizId = id;
  state.editingQuestionId = null;
  $("#quiz-title").value = quiz.title;
  $("#quiz-desc").value = quiz.desc;
  $("#quiz-subject").value = quiz.subjectId;
  $("#quiz-publish").setAttribute("aria-checked", quiz.published ? "true" : "false");
  const scheduledOn = !!quiz.scheduledFor;
  $("#quiz-schedule").setAttribute("aria-checked", scheduledOn ? "true" : "false");
  if (quiz.scheduledFor) {
    const d = new Date(quiz.scheduledFor);
    $("#quiz-schedule-at").value = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}T${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  } else {
    $("#quiz-schedule-at").value = "";
  }
  $("#quiz-schedule-error").hidden = true;
  $("#quiz-timed").setAttribute("aria-checked", quiz.timed ? "true" : "false");
  $("#quiz-time-limit").value = String(quiz.timeLimit || 300);
  $("#quiz-hints").setAttribute("aria-checked", quiz.hints ? "true" : "false");
  resetQuestionForm();
  renderQuestionList();
  syncBuilderInputs();
}

/* meta form */
$("#meta-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const title = $("#quiz-title").value.trim();
  const desc = $("#quiz-desc").value.trim();
  const subjectId = $("#quiz-subject").value;
  const published = $("#quiz-publish").getAttribute("aria-checked") === "true";
  const scheduledOn = $("#quiz-schedule").getAttribute("aria-checked") === "true";
  const scheduleErr = $("#quiz-schedule-error");
  let scheduledFor = null;
  if (scheduledOn) {
    const when = new Date($("#quiz-schedule-at").value);
    if (!$("#quiz-schedule-at").value || isNaN(when) || when.getTime() <= Date.now()) {
      scheduleErr.hidden = false;
      $("#quiz-schedule-at").focus();
      return;
    }
    scheduleErr.hidden = true;
    scheduledFor = when.getTime();
  }
  const timed = $("#quiz-timed").getAttribute("aria-checked") === "true";
  const timeLimit = timed ? Number($("#quiz-time-limit").value) : null;
  const hints = $("#quiz-hints").getAttribute("aria-checked") === "true";
  const shuffle = $("#quiz-shuffle").getAttribute("aria-checked") === "true";

  const titleErr = $("#quiz-title-error");
  if (!title) {
    titleErr.hidden = false;
    $("#quiz-title").setAttribute("aria-invalid", "true");
    $("#quiz-title").focus();
    return;
  }
  titleErr.hidden = true;
  $("#quiz-title").removeAttribute("aria-invalid");

  const existing = currentBuilderQuiz();
  if (existing) {
    existing.title = title;
    existing.desc = desc;
    existing.subjectId = subjectId;
    existing.published = published;
    existing.scheduledFor = scheduledFor;
    existing.timed = timed;
    existing.timeLimit = timeLimit;
    existing.hints = hints;
    existing.shuffle = shuffle;
    existing.updatedAt = Date.now();
    logActivity(published ? "live" : scheduledFor ? "draft" : "draft", `${published ? "Published" : scheduledFor ? "Scheduled " : "Updated "}“${title}”${scheduledFor ? ` — goes live ${fmtDay(scheduledFor)}` : ""}`);
    toast(published ? "Quiz details saved" : scheduledFor ? `Scheduled — students see it ${fmtDay(scheduledFor)}` : "Quiz details saved");
  } else {
    const quiz = {
      id: uid(), title, desc, subjectId, published, origin: "manual",
      scheduledFor, timed, timeLimit, hints, shuffle,
      createdAt: Date.now(), updatedAt: Date.now(),
      questions: [],
    };
    state.quizzes.unshift(quiz);
    state.builderQuizId = quiz.id;
    state.lastQuizId = quiz.id;
    logActivity(published ? "live" : "draft", `Created ${published ? "“" : scheduledFor ? "scheduled quiz “" : "draft “"}${title}”`);
    toast(scheduledFor ? `Quiz created — goes live ${fmtDay(scheduledFor)}` : "Quiz created — add some questions");
  }
  save();
  renderQuestionList();
  syncBuilderInputs();
  renderAll();
});

$("#quiz-title").addEventListener("input", () => {
  $("#quiz-title-error").hidden = true;
  $("#quiz-title").removeAttribute("aria-invalid");
});

const wireSwitch = (id, excludes) => {
  $(id).addEventListener("click", () => {
    const sw = $(id);
    sw.setAttribute("aria-checked", sw.getAttribute("aria-checked") === "true" ? "false" : "true");
    if (excludes && sw.getAttribute("aria-checked") === "true") {
      $(excludes).setAttribute("aria-checked", "false"); // auto-deselect the excluded mode
    }
    syncBuilderInputs();
  });
};
wireSwitch("#quiz-publish", "#quiz-schedule");
wireSwitch("#quiz-schedule", "#quiz-publish");
wireSwitch("#quiz-timed");
wireSwitch("#quiz-hints");
wireSwitch("#quiz-shuffle");

$("#quiz-shuffle").addEventListener("change", () => {
  const note = $("#shuffle-note");
  if (note) note.hidden = !$("#quiz-shuffle").checked;
});

/* question list */
function renderQuestionList() {
  const quiz = currentBuilderQuiz();
  const list = $("#question-list");
  list.textContent = "";

  if (!quiz) {
    $("#qlist-count").textContent = "0";
    $("#qlist-empty").hidden = false;
    $("#qlist-empty .empty__note").textContent = "Save a quiz first — then add questions →";
    return;
  }

  $("#qlist-count").textContent = String(quiz.questions.length);
  $("#qlist-empty").hidden = quiz.questions.length > 0;
  $("#qlist-empty .empty__note").textContent = "No questions yet — add the first one →";

  quiz.questions.forEach((q, i) => {
    list.append(el("li", {},
      el("span", { class: "q-index", text: String(i + 1) }),
      el("div", { class: "q-body" },
        el("p", { class: "q-text", text: q.text }),
        el("p", { class: "q-meta", text: `Answer ${choiceLetters[q.correct]} · ${q.options[q.correct]}` })),
      el("div", { class: "q-acts" },
        el("button", {
          class: "iconbtn iconbtn--edit", type: "button", "aria-label": `Edit question ${i + 1}`,
          onclick: () => startEditQuestion(q.id),
        }, el("svg", { class: "ico", "aria-hidden": "true" }, el("use", { href: "#i-pen" }))),
        el("button", {
          class: "iconbtn iconbtn--del", type: "button", "aria-label": `Delete question ${i + 1}`,
          onclick: () => {
            const removed = { ...q, options: [...q.options] };
            quiz.questions = quiz.questions.filter((x) => x.id !== q.id);
            quiz.updatedAt = Date.now();
            logActivity("edit", `Removed a question from “${quiz.title}”`);
            if (state.editingQuestionId === q.id) resetQuestionForm();
            save(); renderQuestionList(); renderAll();
            showUndoToast("Question removed", () => {
              quiz.questions.push(removed);
              quiz.updatedAt = Date.now();
              renderQuestionList();
              renderAll();
              save();
              toast("Question restored");
            }, 5000);
          },
        }, el("svg", { class: "ico", "aria-hidden": "true" }, el("use", { href: "#i-trash" })))),
    ));
  });
}

/* question editor */
function buildChoiceRow() {
  const row = $("#choices-row");
  row.textContent = "";
  choiceLetters.forEach((letter, i) => {
    row.append(el("div", { class: "choice" },
      el("label", {},
        el("input", {
          class: "choice__radio", type: "radio",
          name: "correct-choice", value: String(i),
        }),
        el("span", { class: "choice__mark", "aria-hidden": "true", text: letter }),
      ),
      el("input", {
        class: "choice__input", type: "text",
        id: `choice-${i}`, name: `choice-${i}`,
        autocomplete: "off", spellcheck: "false",
        placeholder: `Option ${letter}…`,
        "aria-label": `Option ${letter} text`,
        oninput: () => { $("#q-choices-error").hidden = true; },
      }),
      el("span", { class: "choice__tag", hidden: true, text: "Correct" }),
    ));
  });
}

function resetQuestionForm() {
  state.editingQuestionId = null;
  $("#q-text").value = "";
  $("#qeditor-title").textContent = "Add a Question";
  $("#btn-save-question").textContent = "Add Question";
  $("#btn-clear-question").hidden = true;
  buildChoiceRow();
  $("#q-choices-error").hidden = true;
  $("#q-text-error").hidden = true;
  $("#qeditor-count").textContent = `Question ${currentBuilderQuiz()?.questions.length ?? 0}`;
  updateQSaveButtons();
}

function startEditQuestion(id) {
  const quiz = currentBuilderQuiz();
  const q = quiz?.questions.find((x) => x.id === id);
  if (!q) return;
  state.editingQuestionId = id;
  $("#q-text").value = q.text;
  $("#qeditor-title").textContent = "Edit Question";
  $("#btn-save-question").textContent = "Save Question";
  $("#btn-clear-question").hidden = false;
  buildChoiceRow();
  q.options.forEach((opt, i) => { $(`#choice-${i}`).value = opt; });
  $(`input[name="correct-choice"][value="${q.correct}"]`).checked = true;
  updateChoiceTags();
  $("#qeditor-count").textContent = `Question ${quiz.questions.indexOf(q) + 1}`;
  updateQSaveButtons();
  $("#q-text").focus();
}

function updateChoiceTags() {
  $$("#choices-row .choice").forEach((cell) => {
    const checked = $("input[type=radio]", cell)?.checked;
    $(".choice__tag", cell).hidden = !checked;
  });
}

$("#choices-row").addEventListener("change", updateChoiceTags);

$("#question-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const quiz = currentBuilderQuiz();
  const text = $("#q-text").value.trim();
  const options = choiceLetters.map((_, i) => $(`#choice-${i}`).value.trim());
  const correct = Number($('input[name="correct-choice"]:checked')?.value ?? NaN);

  const textErr = $("#q-text-error");
  if (!quiz) {
    textErr.hidden = false;
    textErr.textContent = "Save the quiz first — give it a title on the left.";
    $("#quiz-title").focus();
    return;
  }
  if (!text) {
    textErr.hidden = false;
    textErr.textContent = "Enter the question text first.";
    $("#q-text").focus();
    return;
  }
  textErr.hidden = true;
  if (options.some((o) => !o) || Number.isNaN(correct)) {
    $("#q-choices-error").hidden = false;
    const firstEmpty = options.findIndex((o) => !o);
    (firstEmpty >= 0 ? $(`#choice-${firstEmpty}`) : $("#q-text")).focus();
    return;
  }

  if (state.editingQuestionId) {
    const q = quiz.questions.find((x) => x.id === state.editingQuestionId);
    if (q) { q.text = text; q.options = options; q.correct = correct; }
    toast("Question saved");
  } else {
    quiz.questions.push({ id: uid(), text, options, correct });
    toast("Question added");
  }
  quiz.updatedAt = Date.now();
  logActivity("edit", `${state.editingQuestionId ? "Edited" : "Added"} a question on “${quiz.title}”`);
  resetQuestionForm();
  save();
  renderQuestionList();
  renderAll();
});

$("#btn-clear-question").addEventListener("click", resetQuestionForm);

/* ─── save-as-template / save-as-favourite (question editor head) ────
   Both act as toggles: if the form content exactly matches a saved entry,
   pressing removes it; otherwise it adds. Icons reflect the saved state. */
function readQuestionForm() {
  const text = $("#q-text").value.trim();
  const options = choiceLetters.map((_, i) => $(`#choice-${i}`).value.trim());
  const correct = Number($('input[name="correct-choice"]:checked')?.value ?? NaN);
  return { text, options, correct };
}

const sameQuestion = (a, b) =>
  a && b && a.text === b.text && a.correct === b.correct &&
  Array.isArray(a.options) && Array.isArray(b.options) &&
  a.options.length === b.options.length &&
  a.options.every((o, i) => o === b.options[i]);

function findSaved(kind, form) {
  const list = kind === "template" ? state.qTemplates : state.qFavs;
  return list.find((entry) => sameQuestion(entry, form));
}

function updateQSaveButtons() {
  const form = readQuestionForm();
  for (const [id, kind] of [["#btn-save-template", "template"], ["#btn-save-fav", "fav"]]) {
    const btn = $(id);
    if (!btn) continue;
    const saved = !!findSaved(kind, form);
    btn.classList.toggle("is-active", saved);
    btn.setAttribute("aria-pressed", String(saved));
    btn.title = saved
      ? (kind === "template" ? "Remove from templates" : "Remove from favourites")
      : (kind === "template" ? "Save as template" : "Save as favourite");
  }
}

function toggleQuestion(kind) {
  const list = kind === "template" ? state.qTemplates : state.qFavs;
  const label = kind === "template" ? "template" : "favourite";
  const form = readQuestionForm();
  if (!form.text) { toast(`Type the question first to save it as a ${label}`); $("#q-text").focus(); return; }
  if (form.options.some((o) => !o) || Number.isNaN(form.correct)) {
    toast(`Fill all options and mark one correct to save the ${label}`);
    return;
  }
  const short = form.text.length > 40 ? form.text.slice(0, 40) + "…" : form.text;
  const existing = findSaved(kind, form);
  if (existing) {
    state[kind === "template" ? "qTemplates" : "qFavs"] = list.filter((e) => e.id !== existing.id);
    toast(`Removed from ${label}s — ${list.length - 1} saved`);
    logActivity("edit", `Removed a question ${label}: ${short}`);
  } else {
    // plan limit — no new saves beyond the tier's allowance
    if (!limitGate(kind === "template" ? "templates" : "favs", list.length)) return;
    // remember the subject so the library subject-filter can find it
    const subjectId = currentBuilderQuiz()?.subjectId || $("#quiz-subject")?.value || null;
    list.unshift({ id: uid(), ...form, subjectId, ts: Date.now() });
    toast(`Saved as ${label} — ${list.length} saved`);
    logActivity("edit", `Saved a question ${label}: ${short}`);
  }
  save();
  updateQSaveButtons();
}

$("#btn-save-template").addEventListener("click", () => toggleQuestion("template"));
$("#btn-save-fav").addEventListener("click", () => toggleQuestion("fav"));
$("#q-text").addEventListener("input", updateQSaveButtons);
$("#choices-row").addEventListener("input", updateQSaveButtons);
$("#choices-row").addEventListener("change", updateQSaveButtons);

/* ─── results ────────────────────────────────────────────────────── */
function renderResultsStats() {
  if (isStudent()) {
    const mine = myAttempts();
    const n = mine.length;
    const best = n ? Math.max(...mine.map((a) => pctOf(a.score, a.total))) : null;
    let weak = null;
    for (const sub of SUBJECTS) {
      const list = mine.filter((a) => a.subjectId === sub.id);
      if (!list.length) continue;
      const avg = Math.round((list.reduce((s, a) => s + a.score / a.total, 0) / list.length) * 100);
      if (!weak || avg < weak.avg) weak = { name: sub.name, avg };
    }
    setRStat(1, "Quizzes Taken", String(n), n ? `latest ${fmtDay(mine[0].ts)}` : "no quizzes yet");
    setRStat(2, "Your Best", best == null ? "—" : `${best}%`, n ? "top accuracy across attempts" : "—");
    setRStat(3, "Weakest Subject", weak ? `${weak.avg}%` : "—", weak ? `${weak.name} — focus here` : "take one quiz per subject");
  } else {
    const list = classAttempts();
    const n = list.length;
    const best = n ? Math.max(...list.map((a) => pctOf(a.score, a.total))) : null;
    setRStat(1, "Attempts", String(n), n ? `latest ${fmtDay(list[0].ts)}` : "no plays yet");
    setRStat(2, "Best Score", best == null ? "—" : `${best}%`, n ? "top accuracy across attempts" : "—");

    // hardest question: highest miss rate among questions answered in recorded attempts
    const tally = new Map();
    for (const a of list) {
      for (const ans of a.answers || []) {
        const t = tally.get(ans.text) || { misses: 0, total: 0 };
        t.total += 1;
        if (!ans.correct) t.misses += 1;
        tally.set(ans.text, t);
      }
    }
    let hardest = null;
    for (const [text, t] of tally) {
      if (!hardest || t.misses / t.total > hardest.misses / hardest.total) hardest = { text, ...t };
    }
    const hardNum = $("#rstat-3-num");
    hardNum.textContent = hardest ? `${Math.round((hardest.misses / hardest.total) * 100)}%` : "—";
    hardNum.title = hardest ? hardest.text : "";
    setRStat(3, "Hardest Question", hardest ? `${Math.round((hardest.misses / hardest.total) * 100)}%` : "—",
      hardest ? "miss rate on most-missed question" : "most-missed across attempts");
  }
}

const fmtDayFull = (ts) =>
  new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric", year: "numeric" }).format(new Date(ts));

const fmtDur = (sec) => {
  if (sec == null) return "—";
  const m = Math.floor(sec / 60), s = sec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
};

const PASS_PCT = 40;
/* results filter combines two independent picks — attendance (all/present/
   absent) and result (any/pass/fail) — so e.g. Present+Fail is selectable */
let resultsFilter = { att: "all", res: "any", marksMin: null, marksMax: null, timeMin: null, timeMax: null };
let resultsOpenQuizId = null;
let resultsSearchQuery = "";
const rollOf = (name) => {
  const i = ROSTER.indexOf(name);
  return i >= 0 ? String(i + 1) : "—";
};

function attemptMatchesFilter(a, present) {
  const f = resultsFilter;
  if (f.att === "absent" && present) return false;
  if (f.att === "present" && !present) return false;
  if (!present) return true; // absentees pass the result/marks/time checks
  const pct = pctOf(a.score, a.total);
  if (f.res === "pass" && pct < PASS_PCT) return false;
  if (f.res === "fail" && pct >= PASS_PCT) return false;
  if (f.marksMin != null && a.score < f.marksMin) return false;
  if (f.marksMax != null && a.score > f.marksMax) return false;
  if (f.timeMax != null && (a.timeTaken == null || a.timeTaken > f.timeMax * 60)) return false;
  if (f.timeMin != null && (a.timeTaken == null || a.timeTaken < f.timeMin * 60)) return false;
  return true;
}

function renderResults() {
  renderResultsStats();
  // return the Filter/CSV toolbar to its home slot before rebuilding the groups,
  // otherwise it would be destroyed along with the old group rows
  const toolbar = $("#results-toolbar");
  if (toolbar) {
    $("#results-groups").after(toolbar);
    toolbar.hidden = true;
  }
  const host = $("#results-groups");
  const empty = $("#results-empty");
  host.textContent = "";

  if (isStudent()) {
    $("#results-table-title").textContent = "My Scores";
    $("#btn-results-filter").hidden = true;
    $("#results-empty-title").textContent = "No scores yet";
    $("#results-empty-note").textContent = "Take a quiz from your dashboard — results land here.";
    const mine = myAttempts();
    for (const a of mine) {      const sub = subjectById(a.subjectId);
    const q = resultsSearchQuery.trim().toLowerCase();
    if (q && !`${a.quizTitle} ${sub.name} ${sub.short}`.toLowerCase().includes(q)) continue;
      const pct = pctOf(a.score, a.total);
      const cls = classAvgFor(a.quizId);
      const good = cls == null || pct >= cls;
      const detail = a.answers?.length
        ? el("div", { class: "rg-detail" }, buildAttemptReview(a))
        : null;
      const row = el("button", {
        class: "rg-row", type: "button", "aria-expanded": "false",
        onclick: (e) => { if (detail) toggleGroup(e.currentTarget); },
      },
        el("span", { class: "rg-chev", "aria-hidden": "true", text: "▸" }),
        el("span", { class: "rg-title" },
          el("span", { text: a.quizTitle }),
          el("span", { class: "pill", "data-accent": sub.accent, text: sub.short })),
        el("span", { class: good ? "rg-meta mark-good" : "rg-meta mark-warn", text: `${a.score}/${a.total} · ${pct}%` }),
        el("span", { class: "rg-meta", text: cls == null ? "" : `class avg ${cls}%` }),
        el("span", { class: "rg-count", text: fmtDayFull(a.ts) }));
      host.append(el("div", { class: "rg" }, row, detail));
    }
    empty.hidden = host.children.length > 0;
    if (!empty.hidden && resultsSearchQuery.trim()) {
      $("#results-empty-title").textContent = "No matching quizzes";
      $("#results-empty-note").textContent = `Nothing in your scores matches “${resultsSearchQuery.trim()}”.`;
    }
    return;
  }

  $("#results-table-title").textContent = "Scoreboard";
  $("#btn-results-filter").hidden = false;
  $("#results-empty-title").textContent = "No attempts yet";
  $("#results-empty-note").textContent = "Play a quiz to see scores land in the ledger.";
  empty.hidden = classAttempts().length > 0;

  // one group per quiz that has at least one attempt — newest attempt first
  const groups = new Map();
  for (const a of classAttempts()) {
    if (!groups.has(a.quizId)) groups.set(a.quizId, []);
    groups.get(a.quizId).push(a);
  }
  const ordered = [...groups.entries()]
    .map(([quizId, attempts]) => ({ quizId, attempts: [...attempts].sort((x, y) => y.ts - x.ts) }))
    .sort((a, b) => b.attempts[0].ts - a.attempts[0].ts);

  for (const { quizId, attempts } of ordered) {
    const quiz = state.quizzes.find((q) => q.id === quizId);
    const sub = subjectById(attempts[0].subjectId);
    const q = resultsSearchQuery.trim().toLowerCase();
    // search matches quiz, subject, and the students sitting in the table
    if (q && !`${quiz?.title || attempts[0].quizTitle} ${sub.name} ${sub.short} ${attempts.map((a) => a.student).join(" ")}`.toLowerCase().includes(q)) continue;
    const byStudent = new Map(attempts.map((a) => [a.student, a]));
    const presentNames = [...byStudent.keys()];
    const absentNames = ROSTER.filter((n) => !byStudent.has(n));
    const avg = Math.round(attempts.reduce((s, a) => s + a.score / a.total, 0) / attempts.length * 100);
    const latest = attempts[0];

    // rows: every present attempt + every absent roster student;
    // best marks first, then quickest time; absentees sink to the bottom.
    let rows = presentNames.map((name) => ({ name, attempt: byStudent.get(name), present: true }));
    if (resultsFilter.att === "all" || resultsFilter.att === "absent") {
      rows = rows.concat(absentNames.map((name) => ({ name, attempt: null, present: false })));
    }
    rows = rows.filter((r) => attemptMatchesFilter(r.attempt, r.present));
    rows.sort((x, y) => {
      if (x.present !== y.present) return x.present ? -1 : 1;
      if (!x.present || !y.present) return x.name.localeCompare(y.name);
      if (y.attempt.score !== x.attempt.score) return y.attempt.score - x.attempt.score;
      return (x.attempt.timeTaken ?? Infinity) - (y.attempt.timeTaken ?? Infinity);
    });
    if (!rows.length) continue;

    const detail = el("div", { class: "rg-detail" },
      el("div", { class: "rg-tools" }));
    if (presentNames.length) {
      detail.append(el("table", { class: "rg-table" },
        el("thead", {}, el("tr", {},
          el("th", { text: "Roll" }),
          el("th", { text: "Student" }),
          el("th", { class: "num", text: "Marks" }),
          el("th", { class: "num", text: "Accuracy" }),
          el("th", { class: "num", text: "Time" }),
          el("th", { text: "Result" }),
          el("th", { text: "" }))),
        el("tbody", {},
          ...rows.map((r) => {
            if (!r.present) {
              return el("tr", {},
                el("td", { class: "num", text: rollOf(r.name) }),
                el("td", { text: r.name }),
                el("td", { class: "num", text: "—" }),
                el("td", { class: "num", text: "—" }),
                el("td", { class: "num", text: "—" }),
                el("td", {}, el("span", { class: "pill", text: "Absent" })),
                el("td"));
            }
            const a = r.attempt;
            const pct = pctOf(a.score, a.total);
            return el("tr", {},
              el("td", { class: "num", text: rollOf(r.name) }),
              el("td", { text: r.name }),
              el("td", { class: `num ${pct >= PASS_PCT ? "mark-good" : "mark-warn"}`, text: `${a.score}/${a.total}` }),
              el("td", { class: "num", text: `${pct}%` }),
              el("td", { class: "num", text: fmtDur(a.timeTaken) }),
              el("td", {}, el("span", { class: `pill ${pct >= PASS_PCT ? "pill--live" : "pill--draft"}`, text: pct >= PASS_PCT ? "Pass" : "Fail" })),
              el("td", { class: "cell-actions" },
                el("button", { class: "btn btn--ghost btn--sm", type: "button", text: "Review",
                  "aria-label": `Review attempt by ${r.name}`,
                  onclick: () => reviewAttempt(a.id) })));
          }))));
    } else {
      detail.append(el("p", { class: "rg-empty", text: "No one has taken this quiz yet." }));
    }

    const row = el("button", {
      class: "rg-row", type: "button", "aria-expanded": "false",
      onclick: (e) => { resultsOpenQuizId = quizId; toggleGroup(e.currentTarget); },
    },
      el("span", { class: "rg-chev", "aria-hidden": "true", text: "▸" }),
      el("span", { class: "rg-title" },
        el("span", { text: quiz?.title || latest.quizTitle }),
        el("span", { class: "pill", "data-accent": sub.accent, text: sub.short })),
      el("span", { class: "rg-meta", text: `avg ${avg}% · ${fmtDayFull(latest.ts)}` }),
      el("span", { class: "rg-meta", text: `${presentNames.length}/${ROSTER.length} present` }),
      el("span", { class: "rg-count", text: `${attempts.length} attempt${attempts.length === 1 ? "" : "s"}` }));

    host.append(el("div", { class: "rg", "data-quiz-id": quizId }, row, detail));
  }
  empty.hidden = host.children.length > 0;
  if (!empty.hidden) {
    // distinguish "nothing ever happened" from "the active view excludes everything"
    const filterActive = resultsFilter.att !== "all" || resultsFilter.res !== "any"
      || resultsFilter.marksMin != null || resultsFilter.marksMax != null
      || resultsFilter.timeMin != null || resultsFilter.timeMax != null;
    if (resultsSearchQuery.trim()) {
      $("#results-empty-title").textContent = "No matching quizzes";
      $("#results-empty-note").textContent = `Nothing in the scoreboard matches “${resultsSearchQuery.trim()}”.`;
    } else if (filterActive) {
      $("#results-empty-title").textContent = "No rows match the filter";
      $("#results-empty-note").textContent = "Attempts exist, but none match the active filter — press Filter → Clear all to reset.";
    }
  }
}

/* expand one scoreboard group and collapse any other open one (accordion);
   the Filter/CSV toolbar docks into whichever group is expanded */
function toggleGroup(rowBtn) {
  const g = rowBtn.closest(".rg");
  const wasOpen = g.classList.contains("is-open");
  const tb = $("#results-toolbar");
  // the toolbar is MOVED into whichever group is open; park it back at its
  // home slot before closing anything — wiping the slot with replaceChildren
  // would destroy the element and break every later toggle (null deref)
  if (tb) $("#results-groups").after(tb);
  $$("#results-groups .rg.is-open").forEach((other) => {
    other.classList.remove("is-open");
    other.querySelector(".rg-row")?.setAttribute("aria-expanded", "false");
  });
  if (tb) tb.hidden = true;
  if (!wasOpen) {
    g.classList.add("is-open");
    rowBtn.setAttribute("aria-expanded", "true");
    // only the teacher's group rows carry the Filter/CSV toolbar slot
    const tools = g.querySelector(".rg-tools");
    if (tools && tb && !isStudent()) {
      tools.replaceChildren(tb);
      tb.hidden = false;
    }
  }
}

/* per-question review for an attempt: question text + time taken, then the options —
   the correct one highlighted green, the student's wrong pick highlighted red */
function buildAttemptReview(a) {
  // older attempts lack per-question snapshots — fall back to the quiz's own
  // question data so students always see all 4 options with green/red marks
  const quiz = state.quizzes.find((q) => q.id === a.quizId);
  return el("div", { class: "qreview" },
    ...a.answers.map((ans, i) => {
      const live = quiz?.questions?.[i]?.text === ans.text ? quiz.questions[i] : null;
      const opts = ans.options?.length
        ? ans.options
        : live?.options?.length
          ? live.options
          : [ans.correctText, ...[ans.chosenText].filter(Boolean)].filter((v, ix, arr) => v && arr.indexOf(v) === ix);
      const correctIdx = ans.correctIdx != null ? ans.correctIdx : live?.correct;
      const canMark = opts.length > 2 && correctIdx != null && correctIdx < opts.length;
      return el("div", { class: "qreview__card" },
        el("div", { class: "qreview__head" },
          el("p", { class: "qreview__q", text: `${i + 1}. ${ans.text}` }),
          ans.qSecs != null
            ? el("span", { class: "qreview__time", text: `${fmtDur(ans.qSecs)} on this question`, title: "Time spent on this question" })
            : null),
        el("ul", { class: "qreview__opts" },
          ...opts.map((opt, oi) => {
            const isRight = canMark && oi === correctIdx;
            const isWrongPick = canMark && ans.chosen === oi && oi !== correctIdx;
            return el("li", { class: `qreview__opt${isRight ? " qreview__opt--right" : ""}${isWrongPick ? " qreview__opt--wrong" : ""}` },
              el("span", { class: "qreview__key", text: choiceLetters[oi] ?? "·" }),
              el("span", { text: opt }),
              isRight ? el("span", { class: "qreview__flag", text: ans.correct ? "Your answer" : "Correct answer" }) : null,
              isWrongPick ? el("span", { class: "qreview__flag", text: "Your answer" }) : null);
          })),
        !canMark
          ? el("p", { class: "qreview__missed", text: `Answer: ${ans.correctText}${ans.chosenText && !ans.correct ? ` · You picked: ${ans.chosenText}` : ""}` })
          : null,
        marginNoteWidget(a.id, i, ans.text));
    }));
}

/* margin notes: a private note pinned to one question of one attempt.
   The dashed box is always there — just type; it saves itself on blur.
   No toggle button (removed: hover-focus made it redundant). */
function marginNoteWidget(attemptId, qIndex, qText) {
  if (!state.marginNotes || typeof state.marginNotes !== "object") state.marginNotes = {};
  const store = (state.marginNotes[attemptId] ||= {});
  const ta = el("textarea", { class: "qnote__input", placeholder: "Margin note — why did this trip you up? What to remember next time…",
    rows: "2", maxlength: "400",
    "aria-label": `Margin note for question ${qIndex + 1}` });
  ta.value = store[qIndex] || "";
  let lastSaved = ta.value;
  const commit = () => {
    const val = ta.value.trim();
    if (val === lastSaved.trim()) return; // no-op blurs don't rewrite the workspace
    if (val) store[qIndex] = val; else delete store[qIndex];
    lastSaved = val;
    save();
  };
  ta.addEventListener("blur", commit);
  ta.addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) ta.blur(); });
  return el("div", { class: "qnote" }, ta);
}

function reviewAttempt(id) {
  const a = state.attempts.find((x) => x.id === id);
  if (!a) return;
  if (!a.answers?.length) {
    toast("Sample attempt — per-question answers weren't recorded");
    return;
  }
  const lines = a.answers
    .map((ans, i) => `${i + 1}. ${ans.correct ? "✓" : "✗"} ${ans.text} — ${ans.correct ? "correct" : `answered “${ans.chosenText}”, answer is “${ans.correctText}”`}`)
    .join("\n");
  $("#confirm-title").textContent = `Review — ${a.student}, ${a.score}/${a.total}`;
  $("#confirm-msg").textContent = lines;
  $("#btn-confirm-ok").textContent = "Close";
  confirmAction = null;
  openModal("#confirm-modal");
}

function exportCSV() {
  if (isStudent()) {
    const mine = myAttempts();
    if (!mine.length) { toast("No scores to export yet"); return; }
    const head = "Quiz,Subject,My Mark,Class Avg %,Date";
    const rows = mine.map((a) =>
      [a.quizTitle, subjectById(a.subjectId).name, `${a.score}/${a.total}`, classAvgFor(a.quizId) ?? "—", new Date(a.ts).toISOString()]
        .map(csvCell).join(","));
    downloadFile("quiz-atelier-my-scores.csv", [head, ...rows].join("\n"), "text/csv");
  } else {
    const all = classAttempts();
    if (!all.length) { toast("No attempts to export yet"); return; }
    const rows = all
      .filter((a) => attemptMatchesFilter(a, true))
      .map((a) =>
        [rollOf(a.student), a.student, a.quizTitle, subjectById(a.subjectId).name, a.score, a.total, pctOf(a.score, a.total),
         a.timeTaken == null ? "" : fmtDur(a.timeTaken), new Date(a.ts).toISOString()]
          .map(csvCell).join(","));
    const head = "Roll No,Student,Quiz,Subject,Score,Total,Accuracy %,Time Taken,Date";
    downloadFile("quiz-atelier-results.csv", [head, ...rows].join("\n"), "text/csv");
  }
  toast("CSV downloaded");
}

const csvCell = (v) => `"${String(v).replace(/"/g, '""')}"`;

function downloadFile(name, content, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/* ─── player ─────────────────────────────────────────────────────── */
function openPlayer(quizId) {
  const quiz = state.quizzes.find((q) => q.id === quizId);
  if (!quiz) return;
  if (isStudent() && !isLiveForStudents(quiz)) {
    toast("This quiz isn't open yet — your teacher hasn't published it.");
    return;
  }
  const questions = state.player?.questions || quiz.questions;
  if (!questions.length) {
    if (isStudent()) {
      toast("This quiz isn't ready yet — ask your teacher to add questions.");
      return;
    }
    toast("This quiz has no questions yet — add some in the builder");
    return;
  }
  state.lastQuizId = quiz.id;
  save();

  const sub = subjectById(quiz.subjectId);
  $("#player-eyebrow").textContent = quiz.practice ? `${sub.name} — Practice`
    : isLiveForStudents(quiz) ? `${sub.name} — Now Playing` : `${sub.name} — Preview Draft`;
  $("#player-title").textContent = quiz.title;
  $("#player-body").textContent = "";
  $("#player-body").append(playerIntro(quiz));
  $("#player-step-label").textContent = "Introduction";
  setProgress(0);
  renderPlayerActions("intro", quiz);
  updatePlayerCloseBtn(quiz); // intro always offers ✕
  stopQuizTimer();
  openModal("#player-modal");
}

function playerIntro(quiz) {
  return el("div", { class: "player-intro" },
    el("p", { class: "player-intro__desc", text: quiz.desc || "Answer every question, then review your score." }),
    el("div", { class: "player-intro__facts" },
      el("div", { class: "factbox" },
        el("p", { class: "factbox__num", text: String(quiz.questions.length) }),
        el("p", { class: "factbox__label", text: "Questions" })),
      el("div", { class: "factbox" },
        el("p", { class: "factbox__num", text: String(quiz.questions.length) }),
        el("p", { class: "factbox__label", text: "Points" })),
      el("div", { class: "factbox" },
        el("p", { class: "factbox__num", text: "—" }),
        el("p", { class: "factbox__label", text: "Your Score" })),
    ),
  );
}

/* the quiz currently being played — real workspace quiz or a session-only favourite-practice round */
function activePlayQuiz() {
  return state.practiceQuiz?.id === state.player?.quizId ? state.practiceQuiz
    : state.quizzes.find((q) => q.id === state.player?.quizId);
}

/* student taps a favourited question → spins up a one-question private practice round */
function startPracticeFromFav(entry) {
  const quiz = {
    id: `fav-${entry.id}`, title: "Favourite Practice", practice: true, origin: "ai",
    subjectId: entry.subjectId || SUBJECTS[0]?.id || "",
    questions: [{ id: uid(), text: entry.text, options: entry.options, correct: entry.correct }],
  };
  const sub = subjectById(quiz.subjectId);
  $("#player-eyebrow").textContent = `${sub.name} — Practice`;
  $("#player-title").textContent = "Favourite Practice";
  state.lastQuizId = quiz.id;
  state.practiceQuiz = quiz; // session-only: not saved to the workspace
  startQuiz();
  if (document.querySelector("#player-modal").hidden) openModal("#player-modal");
}

function startQuiz() {
  const quiz = activePlayQuiz() || state.practiceQuiz
    || state.quizzes.find((q) => q.id === state.lastQuizId);
  if (!quiz) return;
  // Shuffle questions for this play session if the quiz has shuffle enabled.
  let questions = quiz.questions;
  if (quiz.shuffle && questions.length > 1) {
    questions = [...questions];
    for (let i = questions.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [questions[i], questions[j]] = [questions[j], questions[i]];
    }
  }
  state.player = { quizId: quiz.id, index: 0, answers: [], removedOptions: {}, questions, startedAt: Date.now(), qStart: Date.now(), qTimes: [] };
  saveRunProgress();
  renderQuestion();
  // Timed quiz: the countdown starts when the first question appears.
  if (quiz.timed && quiz.timeLimit) {
    startQuizTimer(quiz);
  } else {
    stopQuizTimer();
  }
}

/* ─── quiz timer (teacher sets it per quiz — basic feature, not paywalled) ── */
let quizTimerInt = null;
function startQuizTimer(quiz, secondsLeft = null) {
  stopQuizTimer();
  const deadline = Date.now() + (secondsLeft ?? quiz.timeLimit) * 1000;
  state.player.deadline = deadline;
  const chip = document.createElement("span");
  chip.className = "timer";
  chip.id = "quiz-timer";
  document.querySelector(".player__head > div")?.prepend(chip);
  const tick = () => {
    const left = Math.max(0, Math.round((deadline - Date.now()) / 1000));
    chip.textContent = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`;
    chip.classList.toggle("is-low", left <= 30);
    if (left <= 0) {
      stopQuizTimer();
      finishQuiz(quiz); // auto-submit at zero
    }
  };
  tick();
  quizTimerInt = setInterval(tick, 1000);
}
function stopQuizTimer() {
  if (quizTimerInt) { clearInterval(quizTimerInt); quizTimerInt = null; }
  $("#quiz-timer")?.remove();
}

/* ─── 50/50 hint lifeline (teacher enables per quiz — basic feature) ────── */
function removedForThisQuestion() {
  return state.player.removedOptions[state.player.index] || [];
}
function useHint(quiz) {
  const questions = state.player.questions || quiz.questions;
  const q = questions[state.player.index];
  const already = removedForThisQuestion();
  const wrong = q.options.map((_, i) => i).filter((i) => i !== q.correct && !already.includes(i));
  if (wrong.length < 2) return;
  // remove two wrong options, keep the correct one and one wrong one
  const toRemove = wrong.sort(() => Math.random() - 0.5).slice(0, Math.max(0, wrong.length - 1));
  state.player.removedOptions[state.player.index] = [...already, ...toRemove];
  renderQuestion();
}
function optionsForDisplay(q) {
  const removed = state.player ? removedForThisQuestion() : [];
  return q.options.map((opt, i) => ({ opt, i, removed: removed.includes(i) }))
    .filter((o) => !o.removed);
}

/* favourite-star inside the player: every question can be starred (students
   AND teachers); teacher-arranged quizzes show ONLY the star (no close X —
   the quiz must be finished once), AI practice shows star + X. */
function playQuizQuestion() {
  const questions = state.player?.questions || activePlayQuiz()?.questions || [];
  return questions[state.player?.index ?? -1] || null;
}
function isFavQuestion(q) {
  if (!q) return false;
  const probe = { text: q.text, options: q.options, correct: q.correct };
  return state.qFavs.some((f) => sameQuestion(f, probe));
}
function togglePlayFav(q) {
  if (!q) return;
  const probe = { text: q.text, options: q.options, correct: q.correct };
  const idx = state.qFavs.findIndex((f) => sameQuestion(f, probe));
  if (idx >= 0) {
    state.qFavs.splice(idx, 1);
    toast("Removed from favourites");
  } else {
    if (!limitGate("favs", state.qFavs.length)) return;
    state.qFavs.unshift({ id: uid(), ...probe, subjectId: activePlayQuiz()?.subjectId || null, ts: Date.now() });
    toast("Saved as favourite");
    logActivity("edit", `Saved a question favourite: ${q.text.slice(0, 40)}`);
  }
  save();
  renderQuestion();
  updateQSaveButtons?.();
}

/* ✕ visibility rule: teacher-arranged quizzes are one-shot — the student must
   finish (or abandon via Escape) — so the header shows just the favourite star.
   AI practice keeps both. The intro/results screens always offer Close. */
function quizIsPractice(quiz) { return !!quiz?.practice || quiz?.origin === "ai"; }
function updatePlayerCloseBtn(quiz) {
  const btn = $("#btn-close-player");
  if (!btn) return;
  // hide ✕ only when actually mid-question on a teacher-arranged quiz
  btn.hidden = !!state.player && !!quiz && !quizIsPractice(quiz);
}

function renderQuestion() {
  const quiz = activePlayQuiz();
  const questions = state.player.questions || quiz.questions;
  const q = questions[state.player.index];
  const total = questions.length;
  const showHints = !!quiz.hints;

  const opts = optionsForDisplay(q);
  const chosen = state.player.answers[state.player.index];
  const hintUsed = showHints && removedForThisQuestion().length > 0;

  $("#player-body").textContent = "";
  $("#player-body").append(
    el("div", { class: "qcard" },
      el("div", { class: "qcard__top" },
        el("p", { class: "qcard__num", text: `Question ${state.player.index + 1} of ${total}` }),
        el("button", {
          class: "iconbtn qcard__fav", type: "button",
          "aria-label": isFavQuestion(q) ? "Remove from favourites" : "Save as favourite",
          "aria-pressed": String(isFavQuestion(q)),
          title: isFavQuestion(q) ? "Remove from favourites" : "Save as favourite",
          onclick: () => togglePlayFav(q),
        }, el("svg", { class: "ico", "aria-hidden": "true" }, el("use", { href: "#i-star" })))),
      el("p", { class: "qcard__text", text: q.text }),
      el("div", { class: "hintrow" },
        hintUsed ? el("p", { class: "hint-note", text: "50/50 used — two options were removed for this question." }) : null,
        showHints && !hintUsed && !q.hintLock ? el("button", {
          class: "btn btn--outline btn--sm", type: "button", text: "50/50 Hint",
          onclick: () => useHint(quiz),
        }) : null,
      ),
      el("div", { class: "choices" },
        ...opts.map(({ opt, i }) =>
          el("label", { class: "choice" },
            el("input", {
              class: "choice__radio", type: "radio", name: "player-choice", value: String(i),
              ...(chosen === i ? { checked: true } : {}),
              onchange: () => { state.player.answers[state.player.index] = i; enableSubmit(); saveRunProgress(); },
            }),
            el("span", { class: "choice__mark", "aria-hidden": "true", text: choiceLetters[i] }),
            el("span", { class: "choice__input", text: opt }),
          )),
      ),
    ),
  );

  setProgress(Math.round((state.player.index / total) * 100));
  $("#player-step-label").textContent = `Question ${state.player.index + 1} of ${total}`;
  renderPlayerActions("question", quiz);
  updatePlayerCloseBtn(quiz);
  $("#player-body").scrollTop = 0;
}

function enableSubmit() {
  const btn = $("#player-next");
  if (btn) btn.disabled = false;
}

function renderPlayerActions(mode, quiz) {
  const actions = $("#player-actions");
  actions.textContent = "";

  if (mode === "intro") {
    actions.append(
      el("button", { class: "btn btn--outline", type: "button", text: "Close", onclick: closePlayer }),
      el("button", { class: "btn btn--primary", type: "button", id: "player-start", text: "Start Quiz", onclick: startQuiz }),
    );
  } else if (mode === "question") {
    const last = state.player.index === quiz.questions.length - 1;
    const answered = state.player.answers[state.player.index] != null;
    if (state.player.index > 0) {
      actions.append(el("button", {
        class: "btn btn--outline", type: "button", text: "Back",
        onclick: () => { state.player.index--; renderQuestion(); saveRunProgress(); },
      }));
    }
    actions.append(el("button", {
      class: "btn btn--primary", type: "button", id: "player-next",
      text: last ? "Finish" : "Next Question",
      ...(answered ? {} : { disabled: true }),
      onclick: () => nextQuestion(quiz),
    }));
  } else if (mode === "done") {
    // Official class quizzes happen once; only private AI practice can be retaken.
    const canRetake = isStudent() && quiz.origin === "ai";
    actions.append(
      el("button", { class: "btn btn--outline", type: "button", text: "Close", onclick: closePlayer }),
      ...(canRetake
        ? [el("button", { class: "btn btn--primary", type: "button", text: "Retake Quiz", onclick: startQuiz })]
        : []),
    );
  }
}

function nextQuestion(quiz) {
  // null player: Finish was already handled (rapid double-click) — nothing to advance
  if (!state.player || state.player.answers[state.player.index] == null) return;
  // close out the current question's time bucket before moving on
  const p = state.player;
  p.qTimes[p.index] = Math.max(1, Math.round((Date.now() - (p.qStart ?? p.startedAt)) / 1000));
  if (p.index < (p.questions || quiz.questions).length - 1) {
    p.index++;
    p.qStart = Date.now();
    saveRunProgress();
    renderQuestion();
  } else {
    finishQuiz(quiz);
  }
}

function finishQuiz(quiz) {
  // map answers back over the PLAYED question order (shuffling may have reordered them)
  const played = state.player.questions || quiz.questions;
  const p = state.player;
  p.qTimes[p.index] = Math.max(1, Math.round((Date.now() - (p.qStart ?? p.startedAt)) / 1000));
  const answers = played.map((q, i) => ({
    qId: q.id, text: q.text,
    options: [...q.options], correctIdx: q.correct,
    chosen: p.answers[i],
    chosenText: q.options[p.answers[i]],
    correctText: q.options[q.correct],
    correct: p.answers[i] === q.correct,
    qSecs: p.qTimes?.[i] ?? null,
  }));
  const score = answers.filter((a) => a.correct).length;

  const attempt = {
    id: uid(), quizId: quiz.id, quizTitle: quiz.title, subjectId: quiz.subjectId,
    student: state.user?.name || "You", score, total: played.length,
    answers, ts: Date.now(), practice: !!quiz.practice,
    timeTaken: p.startedAt ? Math.max(1, Math.round((Date.now() - p.startedAt) / 1000)) : null,
  };
  state.attempts.unshift(attempt);
  recordActivityDay(); // student streak: any completed quiz counts
  logActivity("score", `${attempt.student} scored ${score}/${quiz.questions.length} on “${quiz.title}”`);
  // a scheduled Comeback Round is consumed once it's been faced — misses
  // automatically return to the graveyard via the attempt record
  if (quiz.comebackKey) {
    state.comebacks = state.comebacks.filter((c) => c.key !== quiz.comebackKey);
  }
  state.player = null;
  clearRunProgress();
  save();
  renderAll();

  showResult(quiz, attempt);
}

function showResult(quiz, attempt, keepPlayer = false) {
  const pct = pctOf(attempt.score, attempt.total);
  const r = 62;
  const circumference = 2 * Math.PI * r;
  const offset = circumference * (1 - pct / 100);
  const verdict = pct === 100 ? "Flawless run."
    : pct >= 80 ? "Sharp work."
    : pct >= 50 ? "Solid attempt."
    : "Room to grow.";
  const cls = classAvgFor(quiz.id);
  const note = isStudent() && cls != null
    ? `Your attempt is logged. Class average on this quiz: ${cls}%.`
    : "Your attempt is logged in the results ledger.";
  const wrong = (attempt.answers || []).filter((a) => !a.correct);
  const scheduled = isStudent() && isComebackScheduled(attempt);
  const canSchedule = isStudent() && wrong.length > 0;

  $("#player-body").textContent = "";
  const resultBody = el("div", { class: "resultwrap" });
  $("#player-body").append(resultBody);
  // NOTE: resultBody.append is the NATIVE DOM append — it stringifies null
  // (a perfect run has no comeback row). Filter nulls ourselves.
  resultBody.append(...[
      el("div", { class: "score-ring" , "data-score-ring": "", role: "img", "aria-label": `Score ${attempt.score} out of ${attempt.total}, ${pct} percent` },
        el("svg", { viewBox: "0 0 140 140", "aria-hidden": "true" },
          el("circle", { class: "score-ring__track", cx: "70", cy: "70", r: String(r), fill: "none", "stroke-width": "10" }),
          el("circle", {
            class: "score-ring__fill", cx: "70", cy: "70", r: String(r), fill: "none",
            "stroke-width": "10", "stroke-linecap": "round",
            "stroke-dasharray": String(circumference), "stroke-dashoffset": String(offset),
          }),
        ),
        el("span", { class: "score-ring__value num" },
          el("span", { class: "score-ring__frac", text: `${attempt.score}/${attempt.total}` }),
          el("span", { class: "score-ring__pct", text: `${pct}%` })),
      ),
      el("p", { class: "resultwrap__verdict", text: verdict }),
      el("p", { class: "resultwrap__note", text: note }),
      // spaced repetition: bring today's wrong answers back tomorrow (students only)
      canSchedule ? el("div", { class: "comeback-row" },
        el("div", { class: "comeback-row__text" },
          el("p", { class: "comeback-row__line", text: scheduled
            ? `Scheduled — ${wrong.length} question${wrong.length === 1 ? "" : "s"} come back tomorrow.`
            : `${wrong.length} question${wrong.length === 1 ? "" : "s"} didn't survive this round.` }),
          el("p", { class: "comeback-row__sub", text: scheduled
            ? "They'll be waiting on your dashboard tomorrow."
            : "Miss them again tomorrow if you don't face them now." })),
        el("button", { class: "toggle", type: "button",
          role: "switch", "aria-checked": String(scheduled),
          "aria-label": "Bring my wrong answers back tomorrow",
          onclick: () => toggleComeback(attempt) },
          el("span", { class: "toggle__knob" }))) : null,
      el("ul", { class: "breakdown" },
        ...attempt.answers.map((a) =>
          el("li", {},
            el("span", { class: `b-mark b-mark--${a.correct ? "ok" : "no"}`, "aria-hidden": "true", text: a.correct ? "✓" : "✗" }),
            el("span", { class: "visually-hidden", text: a.correct ? "Correct —" : "Incorrect —" }),
            el("span", { class: "b-q", text: a.text }),
            // wrong answers hide the correct one behind a small tearable patch
            // (replaces the passive read — checking your work becomes an action)
            !a.correct && a.chosenText
              ? el("span", { class: "b-ans b-ans--sealed-row" },
                  el("span", { class: "b-ans__you", text: `You: ${a.chosenText} · Ans: ` }),
                  el("span", { class: "b-ans__sealed", text: a.correctText }))
              : el("span", { class: "b-ans", text: a.correct ? a.correctText : `You: ${a.chosenText} · Ans: ${a.correctText}` }),
            // ELI5: students can rewrite any missed question in plain words
            isStudent() && !a.correct && a.chosenText ? el("div", { class: "b-eli5" },
              el("button", { class: "btn btn--outline btn--sm", type: "button", text: "Explain simply",
                onclick: (e) => explainSimply(e.currentTarget, a) }),
              el("p", { class: "b-eli5__out", hidden: true })) : null,
          )),
      ),
  ].filter(Boolean));

  // score seal — a paper sheet covers the score ring; tear or tap it open.
  // Skipped on re-renders (comeback toggle) so the score doesn't re-seal.
  if (!keepPlayer && tearSupported()) {
    const ring = resultBody.querySelector("[data-score-ring]");
    if (ring) {
      const wrap = el("div", { class: "tear-wrap" });
      const seal = el("div", { class: "tear-host tear-host--score" });
      ring.before(wrap);
      wrap.append(seal, ring);
      mountTearable(seal, ring, {
        hint: "your score is sealed",
        onTorn: () => ring.classList.add("score-ring--revealed"),
      });
    }
  }

  // small tearable patches over each wrong answer's correct text — a tap
  // rips the patch and shows the answer (checking your work becomes an action)
  if (!tearSupported()) {
    // no-canvas fallback: reveal the answer text immediately
    for (const sealed of resultBody.querySelectorAll(".b-ans__sealed")) sealed.classList.add("b-ans__sealed--open");
  } else {
    for (const sealed of resultBody.querySelectorAll(".b-ans__sealed")) {
      const patch = el("span", { class: "tear-host tear-host--patch" });
      sealed.append(patch);
      mountTearable(patch, sealed, {
        cols: 7, rows: 3, autoTear: true,
        onTorn: () => sealed.classList.add("b-ans__sealed--open"),
      });
    }
  }

  setProgress(100);
  $("#player-step-label").textContent = "Complete";
  renderPlayerActions("done", quiz);
  updatePlayerCloseBtn(quiz); // results screen brings ✕ back
}

function setProgress(pct) {
  $("#player-progress").setAttribute("aria-valuenow", String(pct));
  $("#player-progress-bar").style.width = `${pct}%`;
}

/* backdrop click during a quiz in progress: leaving mid-quiz discards the
   attempt, so confirm first — the ✕ button (when visible) stays instant. */
function backdropClosePlayer() {
  const modal = $("#player-modal");
  if (!modal || modal.hidden) return;
  const midQuiz = !!state.player && !!$(".qcard"); // question screen, not intro/results
  if (midQuiz) {
    askConfirm(
      "Leave this quiz?",
      "Your progress is saved on this device — you'll pick up where you left off next time you sign in.",
      "Leave Quiz",
      closePlayer,
    );
    return;
  }
  closePlayer();
}

function closePlayer() {
  stopQuizTimer();
  // run progress stays on this device — the next sign-in resumes it
  state.player = null;
  state.practiceQuiz = null;
  closeModal("#player-modal");
  renderAll();
}

/* ─── AI generator (Gemini) ────────────────────────────────────── */
/* ─── AI access — all Gemini traffic goes through the server proxy ── */
/* Keys live ONLY in the server env (GEMINI_API_KEYS). The client sends
   { kind, parts } to POST /api/ai/generate and gets structured JSON back.
   The proxy base auto-detects: same-origin when served by server.js,
   host-loopback when running inside the Android emulator's WebView. */
const QA_API_BASE = (() => {
  if (location.hostname === "appassets.androidplatform.net") return "http://10.0.2.2:8790"; // emulator → host loopback
  return ""; // same origin
})();
const GEN_MAX_BYTES = 15 * 1024 * 1024;

let genAbort = null;

function genSetSource(source) {
  state.gen = state.gen || { source: "pdf", file: null, url: "", draft: null };
  state.gen.source = source;
  for (const b of $$(".seg--block .seg__btn")) {
    const active = b.dataset.source === source;
    b.classList.toggle("is-active", active);
    b.setAttribute("aria-pressed", String(active));
  }
  // "From Your Notes" ↔ "From Online Notes" follows the chosen source.
  const baseTitle = source === "youtube" ? "From Online Notes" : "From Your Notes";
  $("#gen-form-title").textContent = isStudent() ? `Practice ${baseTitle}` : baseTitle;
  $("#gen-dropzone").hidden = source !== "pdf";
  $("#gen-url-field").hidden = source !== "youtube";
  if (source === "youtube") setTimeout(() => $("#gen-url").focus(), 0);
}

function genSetFile(file) {
  if (!file) return;
  if (file.type && file.type !== "application/pdf") {
    genShowError("Only PDF files are supported — export other formats to PDF first.");
    return;
  }
  if (file.size > GEN_MAX_BYTES) {
    genShowError("That PDF is over 15 MB — split it or extract the chapters you need.");
    return;
  }
  state.gen.file = file;
  const zone = $("#gen-dropzone");
  zone.classList.add("has-file");
  $("#gen-drop-title").textContent = file.name;
  $("#gen-file-note").textContent = `${(file.size / 1024 / 1024).toFixed(1)} MB — click to replace`;
  genHideError();
}

function genShowError(msg) { const n = $("#gen-error"); n.textContent = msg; n.hidden = false; }
function genHideError() { const n = $("#gen-error"); n.textContent = ""; n.hidden = true; }

function genLoading(on, title, note) {
  $("#gen-idle").hidden = on || !!state.gen?.draft;
  $("#gen-loading").hidden = !on;
  $("#gen-fail").hidden = true;
  $("#gen-review").hidden = !state.gen?.draft;
  if (on) {
    $("#gen-loading-title").textContent = title || "Reading your notes…";
    $("#gen-loading-note").textContent = note || "This usually takes 10–30 seconds.";
  }
  $("#btn-generate").disabled = on;
}

function genFail(msg) {
  genLoading(false);
  state.gen.draft = null;
  $("#gen-review").hidden = true;
  $("#gen-idle").hidden = true;
  $("#gen-fail").hidden = false;
  $("#gen-fail-note").textContent = msg;
}

async function fileToBase64(file) {
  const buf = await new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(new Uint8Array(r.result));
    r.onerror = () => reject(new Error("Could not read the file"));
    r.readAsArrayBuffer(file);
  });
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < buf.length; i += chunk) {
    binary += String.fromCharCode(...buf.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function youTubeId(raw) {
  const m = String(raw).match(
    /(?:youtube\.com\/(?:watch\?(?:.*&)?v=|embed\/|shorts\/)|youtu\.be\/)([A-Za-z0-9_-]{6,})/
  );
  return m ? m[1] : null;
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

function genPrompt(count, subject) {
  return [
    `You are a study-quiz writer for a ${state.user.role} in the subject “${subject.name}”. Using ONLY the source material provided,`,
    `write a multiple-choice quiz with exactly ${count} questions.`,
    `Rules:`,
    `- Every question must be answerable from the source; no outside knowledge.`,
    `- Exactly 4 options per question; exactly one is correct.`,
    `- Plausible distractors: common misconceptions or nearby facts from the source.`,
    `- No "all of the above" or "none of the above" options.`,
    `- Vary difficulty: recall, understanding, and one or two that need connecting ideas.`,
    `- Keep questions under 200 characters, options under 80 characters.`,
    `- Title: max 8 words. Description: one sentence on what the quiz covers.`,
    ...(isStudent()
      ? [`- This is private practice for one student: pitch it just below exam level so it builds confidence.`]
      : [`- This quiz will be conducted for a whole class, so keep the difficulty fair and balanced.`]),
    `Return only the structured JSON.`,
  ].join("\n");
}

/* One call path for everything AI: quiz generation AND ELI5. The server
   picks the model and rotates keys; it also enforces the per-identity daily
   budget (40 signed-in / 10 anonymous per day) on top of the plan limits. */
async function callGemini(parts, schema = GEN_SCHEMA, kind = "quiz") {
  const res = await fetch(`${QA_API_BASE}/api/ai/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind, parts }),
    signal: genAbort?.signal,
  });
  if (!res.ok) {
    let detail = "";
    try { detail = (await res.json())?.error || ""; } catch { /* keep empty */ }
    const err = new Error(detail || `AI request failed (${res.status}).`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

function normalizeQuiz(data, meta) {
  const questions = (data.questions || [])
    .map((q) => ({
      text: String(q.question || "").trim(),
      options: (q.options || []).map((o) => String(o).trim()),
      correct: Number(q.answer_index),
    }))
    .filter((q) => q.text && q.options.length === 4 && q.options.every(Boolean) &&
                    Number.isInteger(q.correct) && q.correct >= 0 && q.correct < 4);

  if (questions.length < 3) throw new Error(`Only ${questions.length} usable question(s) came back — try a richer source.`);

  const title = String(data.title || "").trim() || meta.titleFallback;
  return {
    id: uid(),
    title: title.slice(0, 80),
    desc: String(data.description || "").trim().slice(0, 200),
    subjectId: meta.subjectId,
    published: false,
    origin: "ai",
    createdAt: Date.now(), updatedAt: Date.now(),
    questions: questions.map((q) => ({ id: uid(), ...q })),
  };
}

async function runGeneration() {
  // plan limit — AI generations are counted per day
  if (!limitGate("aiPerDay", todayUsage().ai || 0)) return;
  bumpUsage("ai");
  genAbort = new AbortController();
  genLoading(true, "Reading your notes…", "This usually takes 10–30 seconds.");
  const src = state.gen.source;
  try {
    let subjectId = $("#gen-subject").value;
    let sourceTag = null;
    if (isStudent()) {
      // Private practice: derive the subject from the student's most recent class quiz.
      const mine = myAttempts().slice().sort((a, b) => b.ts - a.ts);
      const next = state.quizzes.find((q) =>
        isLiveForStudents(q) && q.subjectId && !mine.some((a) => a.quizId === q.id));
      subjectId = next?.subjectId || mine[0]?.subjectId || SUBJECTS[0]?.id || "";
      sourceTag = { text: "Private study session — the student's attempt is kept personal." };
    }
    let parts;
    if (src === "pdf") {
      const file = state.gen.file;
      const b64 = await fileToBase64(file);
      genLoading(true, "Understanding the material…", "Larger PDFs can take up to a minute.");
      parts = [
        { text: genPrompt(Number($("#gen-count").value), subjectById(subjectId)) },
        { inline_data: { mime_type: "application/pdf", data: b64 } },
      ];
    } else {
      const id = youTubeId(state.gen.url);
      genLoading(true, "Watching the video…", "Long videos can take up to a minute.");
      parts = [
        { text: genPrompt(Number($("#gen-count").value), subjectById(subjectId)) },
        { file_data: { file_uri: `https://www.youtube.com/watch?v=${id}` } },
      ];
    }
    if (sourceTag) parts.push(sourceTag);
    const data = await callGemini(parts);
    const fallbackTitle = src === "pdf" && state.gen.file
      ? state.gen.file.name.replace(/\.pdf$/i, "").slice(0, 60)
      : isStudent() ? `Practice — ${subjectById(subjectId).short}` : "YouTube Quiz";
    state.gen.draft = normalizeQuiz(data, { titleFallback: fallbackTitle, subjectId });
    renderGenReview();
    genLoading(false);
  } catch (err) {
    if (err.name === "AbortError") return; // user left the view
    genFail(err.message || "Something went wrong while generating.");
  }
}

function renderGenReview() {
  const draft = state.gen.draft;
  if (!draft) return;
  $("#gen-review").hidden = false;
  $("#gen-idle").hidden = true;
  $("#gen-fail").hidden = true;
  const pill = $("#gen-status-pill");
  pill.hidden = false;
  pill.textContent = isStudent()
    ? `Practice draft · ${subjectById(draft.subjectId).short} — not saved`
    : `Draft · ${subjectById(draft.subjectId).short} — not saved`;
  pill.className = "pill";
  pill.setAttribute("data-accent", subjectById(draft.subjectId).accent);
  $("#gen-review-title").textContent = draft.title;
  $("#gen-review-meta").textContent =
    `${draft.questions.length} questions · review before saving`;
  const list = $("#gen-list");
  list.textContent = "";
  draft.questions.forEach((q, i) => {
    list.append(el("li", {},
      el("span", { class: "g-index", text: String(i + 1) }),
      el("div", { class: "g-body" },
        el("p", { class: "g-q", text: q.text }),
        el("ul", { class: "g-opts" },
          ...q.options.map((opt, j) =>
            el("li", { class: `g-opt${j === q.correct ? " is-correct" : ""}` },
              el("span", { class: "g-letter", text: `${choiceLetters[j]} ·` }),
              el("span", { text: opt }),
              j === q.correct ? el("span", { class: "visually-hidden", text: " (correct answer)" }) : null,
            )),
        ),
      ),
    ));
  });
}

function saveGenDraft() {
  const draft = state.gen.draft;
  if (!draft) return;
  if (isStudent()) draft.practice = true; // private — never shown in the teacher's ledger
  state.quizzes.unshift(draft);
  state.lastQuizId = draft.id;
  state.gen.draft = null;
  logActivity("live", isStudent()
    ? `Added “${draft.title}” to my practice`
    : `Generated “${draft.title}” with Gemini`);
  save(); renderAll();
  toast(isStudent()
    ? `“${draft.title}” added to My Practice — ${draft.questions.length} questions`
    : `Saved “${draft.title}” — ${draft.questions.length} questions`);
  genResetPanel();
  if (isStudent()) {
    nav("dashboard");
  } else {
    nav("builder");
    loadQuizIntoBuilder(draft.id);
  }
}

function discardGenDraft() {
  askConfirm("Discard this draft?",
    "The generated questions will be gone — you'd need to generate again.",
    "Discard Draft", () => {
      state.gen.draft = null;
      genResetPanel();
      toast("Draft discarded");
    });
}

function genResetPanel() {
  state.gen.draft = null;
  $("#gen-review").hidden = true;
  $("#gen-fail").hidden = true;
  $("#gen-loading").hidden = true;
  $("#gen-idle").hidden = false;
  $("#gen-status-pill").hidden = true;
}

function onGenSubmit(e) {
  e.preventDefault();
  genHideError();
  if (!state.gen) genSetSource("pdf");
  if (state.gen.source === "pdf" && !state.gen.file) { genShowError("Choose a PDF first — drop it in the panel on the left."); $("#gen-dropzone").focus(); return; }
  if (state.gen.source === "youtube") {
    const id = youTubeId($("#gen-url").value.trim());
    $("#gen-url-error").hidden = !!id;
    if (!id) { $("#gen-url").focus(); return; }
    state.gen.url = $("#gen-url").value.trim();
  }
  runGeneration();
}

function wireGenerator() {
  if (!state.gen) state.gen = { source: "pdf", file: null, url: "", draft: null };

  for (const b of $$(".seg--block .seg__btn")) {
    b.addEventListener("click", () => genSetSource(b.dataset.source));
  }

  const zone = $("#gen-dropzone");
  const input = $("#gen-file-input");
  zone.addEventListener("click", () => input.click());
  zone.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); input.click(); }
  });
  input.addEventListener("change", () => genSetFile(input.files[0]));

  let dragDepth = 0;
  zone.addEventListener("dragover", (e) => { e.preventDefault(); zone.classList.add("is-drag"); });
  zone.addEventListener("dragenter", () => { dragDepth++; zone.classList.add("is-drag"); });
  zone.addEventListener("dragleave", () => { if (--dragDepth <= 0) { dragDepth = 0; zone.classList.remove("is-drag"); } });
  zone.addEventListener("drop", (e) => {
    e.preventDefault(); dragDepth = 0; zone.classList.remove("is-drag");
    genSetFile(e.dataTransfer.files?.[0]);
  });

  $("#gen-form").addEventListener("submit", onGenSubmit);
  $("#btn-gen-retry").addEventListener("click", () => { genResetPanel(); });
  $("#btn-gen-discard").addEventListener("click", discardGenDraft);
  $("#btn-gen-save").addEventListener("click", saveGenDraft);

  // interrupt an in-flight request when the user navigates away mid-generation
  document.addEventListener("click", (e) => {
    const navBtn = e.target.closest("[data-nav]");
    if (navBtn && navBtn.dataset.nav !== "generate" && genAbort && !genAbort.signal.aborted && !$("#gen-loading").hidden) {
      genAbort.abort();
      genResetPanel();
    }
  }, true);
}

/* ─── data I/O ───────────────────────────────────────────────────── */
function exportJSON() {
  const payload = {
    app: "quiz-atelier", version: 2, exportedAt: new Date().toISOString(),
    quizzes: state.quizzes, attempts: state.attempts,
  };
  downloadFile("quiz-atelier-workspace.json", JSON.stringify(payload, null, 2), "application/json");
  toast("Workspace exported");
}

function openImport() {
  $("#import-error").hidden = true;
  $("#import-file-name").textContent = "";
  $("#import-file").value = "";
  openModal("#import-modal");
  $("#btn-import-file").focus();
}

/* upload path: pick a .json file → contents land in the textarea and import immediately */
$("#btn-import-file").addEventListener("click", () => $("#import-file").click());
$("#import-file").addEventListener("change", (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  $("#import-file-name").textContent = file.name;
  const reader = new FileReader();
  reader.onload = () => {
    $("#import-text").value = String(reader.result || "");
    doImport(); // validate + import right away; doImport shows the error line if the file is bad
  };
  reader.onerror = () => { $("#import-error").hidden = false; };
  reader.readAsText(file);
});

function doImport() {
  try {
    const data = JSON.parse($("#import-text").value);
    if (!data || !Array.isArray(data.quizzes)) throw new Error("bad shape");
    for (const q of data.quizzes) {
      if (!q.title || !Array.isArray(q.questions)) throw new Error("bad quiz");
    }
    state.quizzes = data.quizzes;
    state.attempts = Array.isArray(data.attempts) ? data.attempts : [];
    if (Array.isArray(data.qTemplates)) state.qTemplates = data.qTemplates;
    if (Array.isArray(data.qFavs)) state.qFavs = data.qFavs;

    // subjects: accept either the app's customSubjects or a generic subjects array
    const subjectList = Array.isArray(data.customSubjects) ? data.customSubjects : Array.isArray(data.subjects) ? data.subjects : [];
    for (const s of subjectList) {
      if (s?.id && s?.name && !SUBJECTS.some((x) => x.id === s.id)) {
        SUBJECTS.push({ id: String(s.id), name: String(s.name), short: String(s.short || s.name.slice(0, 4).toUpperCase()), accent: s.accent || "mustard", desc: s.desc || "", custom: true });
      }
    }

    // students: explicit roster key, students array ({name}), or derived from attempts
    let importedRoster = [];
    if (Array.isArray(data.roster)) importedRoster = data.roster.filter((n) => typeof n === "string");
    else if (Array.isArray(data.students)) importedRoster = data.students.map((s) => typeof s === "string" ? s : s?.name).filter(Boolean);
    else importedRoster = [...new Set(state.attempts.map((a) => (a.student || "").trim()).filter(Boolean))];
    state.roster = [...new Set([...(state.roster || []), ...importedRoster])];
    syncRoster();

    state.activity = [{ id: uid(), kind: "edit", text: "Imported workspace from JSON", ts: Date.now() }];
    state.lastQuizId = state.quizzes[0]?.id ?? null;
    migrateWorkspace();
    refreshSubjectPickers();
    save(); resetBuilder(); renderAll(); closeModal("#import-modal");
    $("#import-text").value = "";
    $("#import-file-name").textContent = "";
    toast(`Imported ${state.quizzes.length} quizzes · ${ROSTER.length} students · ${SUBJECTS.length} subjects`);
  } catch {
    $("#import-error").hidden = false;
  }
}

/* ─── delete account (replaces the old reset-demo flow) ──────────── */
function resetDemo() {
  askConfirm("Your account will be deleted?",
    "All your quizzes, scores and saved questions are permanently removed.",
    "Confirm", () => showDeleteOtpScreen());
}

function showDeleteOtpScreen() {
  closeModal("#confirm-modal");
  const gate = $("#login-gate");
  if (!gate) return;
  gate.hidden = false;
  syncScrollLock();
  const email = state.user?.email || state.user?.username || "your email";
  // reuse the gate card: OTP panel replaces the login controls
  const card = gate.querySelector(".gate-card") || gate.firstElementChild;
  if (!card) return;
  gate.querySelectorAll(".gate-otp-host").forEach((n) => n.remove());
  const panel = el("div", { class: "gate-otp-host", style: "display:flex;flex-direction:column;gap:12px;margin-top:8px" },
    el("p", { class: "confirm-msg", text: `Enter the OTP sent to your mail ${email}` }),
    el("input", { class: "input", id: "otp-input", type: "text", inputmode: "numeric",
      maxlength: "6", placeholder: "6-digit code", autocomplete: "one-time-code",
      style: "letter-spacing:0.4em;text-align:center;font-size:20px" }),
    el("p", { class: "field-error", id: "otp-error", hidden: true }),
    el("div", { class: "btnrow btnrow--end" },
      el("button", { class: "btn btn--outline", type: "button", text: "Cancel",
        onclick: () => { panel.remove(); showLogin(); } }),
      el("button", { class: "btn btn--danger", type: "button", text: "Delete Account",
        onclick: () => confirmDeleteAccount(panel) })));
  card.append(panel);
  // request the OTP from the server as the panel appears
  api("/api/delete/request-otp", { method: "POST", body: "{}" })
    .then((r) => {
      if (r.demo) toast("Demo mode: the OTP is in the server console");
      else toast(`OTP sent to ${email}`);
    })
    .catch((ex) => {
      const e = $("#otp-error");
      if (e) { e.textContent = ex.message || "Could not send the OTP — try again."; e.hidden = false; }
    });
  $("#otp-input")?.focus();
}

async function confirmDeleteAccount(panel) {
  const code = ($("#otp-input")?.value || "").trim();
  const errNode = $("#otp-error");
  if (!/\d{6}/.test(code)) {
    if (errNode) { errNode.textContent = "Enter the 6-digit code."; errNode.hidden = false; }
    return;
  }
  try {
    await api("/api/delete/confirm", { method: "POST", body: JSON.stringify({ code }) });
    panel?.remove();
    // account is gone: clear every local trace and return to the login gate
    clearTimeout(syncTimer);
    try {
      localStorage.removeItem(localStoreKey());          // per-user cache
      localStorage.removeItem(PLAN_KEY(state.user?.username));
      localStorage.removeItem(PLAN_STATE_KEY(state.user?.username));
      localStorage.removeItem(USAGE_KEY(state.user?.username));
      localStorage.removeItem(REMEMBER_KEY);
    } catch { /* private mode */ }
    state.user = null;
    state.quizzes = []; state.attempts = []; state.activity = [];
    state.qTemplates = []; state.qFavs = []; state.lastQuizId = null;
    state.view = "dashboard";
    showLogin();
    toast("Account deleted — sorry to see you go");
  } catch (ex) {
    if (errNode) { errNode.textContent = ex.message || "Verification failed."; errNode.hidden = false; }
  }
}

/* ─── global wiring ──────────────────────────────────────────────── */
$("#results-filter-att").addEventListener("click", (e) => {
  const btn = e.target.closest(".seg__btn");
  if (!btn) return;
  $$("#results-filter-att .seg__btn").forEach((b) => b.classList.toggle("is-active", b === btn));
});
$("#results-filter-res").addEventListener("click", (e) => {
  const btn = e.target.closest(".seg__btn");
  if (!btn) return;
  const wasActive = btn.classList.contains("is-active");
  $$("#results-filter-res .seg__btn").forEach((b) => b.classList.toggle("is-active", b === btn && !wasActive));
});
$("#results-search").addEventListener("input", (e) => {
  resultsSearchQuery = e.target.value;
  renderResults();
});

document.addEventListener("click", (e) => {
  // close the results filter popover on outside click
  const panel = $("#results-filters");
  if (panel && !panel.hidden && !e.target.closest(".res-filters-wrap")) {
    panel.hidden = true;
    $("#btn-results-filter").setAttribute("aria-expanded", "false");
  }

  const navBtn = e.target.closest("[data-nav]");
  if (navBtn) { nav(navBtn.dataset.nav); return; }

  const map = [
    ["#btn-open-last", () => {
      if (state.lastQuizId && state.quizzes.some((q) => q.id === state.lastQuizId)) openPlayer(state.lastQuizId);
      else toast("No quiz to open yet");
    }],
    ["#btn-new-menu", () => {
      const menu = $("#new-menu");
      const open = menu.hidden;
      menu.hidden = !open;
      $("#btn-new-menu").setAttribute("aria-expanded", String(open));
    }],
    ["#menu-new-quiz", () => {
      $("#new-menu").hidden = true;
      $("#btn-new-menu").setAttribute("aria-expanded", "false");
      nav("builder"); resetBuilder(); $("#quiz-title").focus();
    }],
    ["#menu-new-subject", () => {
      $("#new-menu").hidden = true;
      $("#btn-new-menu").setAttribute("aria-expanded", "false");
      promptNewSubject();
    }],
    ["#menu-new-student", () => {
      $("#new-menu").hidden = true;
      $("#btn-new-menu").setAttribute("aria-expanded", "false");
      promptNewStudent();
    }],
    ["#btn-student-ok", createStudentFromModal],
    ["#btn-student-cancel", () => closeModal("#student-modal")],
    ["[data-close-student]", () => closeModal("#student-modal")],
    ["#btn-play-current", () => {
      const quiz = currentBuilderQuiz();
      if (quiz?.questions.length) openPlayer(quiz.id);
      else toast("Add at least one question first");
    }],
    ["#btn-activity-bell", () => {
      const pop = $("#bell-pop");
      if (pop.hidden) openBellPop(); else closeBellPop();
    }],
    ["#btn-export", exportJSON],
    ["#btn-import", openImport],
    ["#btn-reset", resetDemo],
    ["#btn-export-csv", exportCSV],
    ["#btn-results-filter", () => {
      const panel = $("#results-filters");
      const open = panel.hidden;
      panel.hidden = !open;
      $("#btn-results-filter").setAttribute("aria-expanded", String(open));
    }],
    ["#flt-apply", () => {
      resultsFilter = {
        att: $("#results-filter-att .is-active")?.dataset.att || "all",
        res: $("#results-filter-res .is-active")?.dataset.res || "any",
        marksMin: $("#flt-marks-min").value === "" ? null : Number($("#flt-marks-min").value),
        marksMax: $("#flt-marks-max").value === "" ? null : Number($("#flt-marks-max").value),
        timeMin: $("#flt-time-min").value === "" ? null : Number($("#flt-time-min").value),
        timeMax: $("#flt-time-max").value === "" ? null : Number($("#flt-time-max").value),
      };
      $("#results-filters").hidden = true;
      $("#btn-results-filter").setAttribute("aria-expanded", "false");
      renderResults();
      // Apply re-renders every group — re-expand the row the teacher was
      // reading and re-dock the toolbar so it doesn't look like a collapse
      const open = resultsOpenQuizId ? $("#results-groups .rg[data-quiz-id=" + JSON.stringify(resultsOpenQuizId) + "] .rg-row") : null;
      if (open) toggleGroup(open);
      toast("Filters applied");
    }],
    ["#flt-clear", () => {
      $("#flt-marks-min").value = ""; $("#flt-marks-max").value = "";
      $("#flt-time-min").value = ""; $("#flt-time-max").value = "";
      $$("#results-filter-att .seg__btn").forEach((b) => b.classList.toggle("is-active", b.dataset.att === "all"));
      $$("#results-filter-res .seg__btn").forEach((b) => b.classList.toggle("is-active", false));
      resultsFilter = { att: "all", res: "any", marksMin: null, marksMax: null, timeMin: null, timeMax: null };
      renderResults();
      const open = resultsOpenQuizId ? $("#results-groups .rg[data-quiz-id=" + JSON.stringify(resultsOpenQuizId) + "] .rg-row") : null;
      if (open) toggleGroup(open);
    }],
    ["#btn-import-ok", doImport],
    ["#btn-import-cancel", () => closeModal("#import-modal")],
    ["#btn-subject-ok", addSubjectFromModal],
    ["#btn-subject-cancel", () => { subjectModalEditId = null; closeModal("#subject-modal"); }],
    ["[data-close-subject]", () => { subjectModalEditId = null; closeModal("#subject-modal"); }],
    ["#btn-notice-ok", saveNoticeFromModal],
    ["#btn-notice-cancel", () => closeModal("#notice-modal")],
    ["[data-close-notice]", () => closeModal("#notice-modal")],
    [".subject-accent", (e) => {
      const btn = e.target.closest(".subject-accent");
      $$("#subject-accent-row .subject-accent").forEach((b) => {
        b.classList.toggle("is-active", b === btn);
        b.setAttribute("aria-pressed", String(b === btn));
      });
    }],
    ["#btn-confirm-cancel", () => closeModal("#confirm-modal")],
    ["#btn-confirm-ok", () => { const fn = confirmAction; confirmAction = null; closeModal("#confirm-modal"); fn?.(); }],
    ["#btn-close-player", closePlayer],
    ["[data-close-player]", backdropClosePlayer],
    ["[data-close-confirm]", () => closeModal("#confirm-modal")],
    ["[data-close-import]", () => closeModal("#import-modal")],
    ["[data-close-plans]", () => closeModal("#plans-modal")],
  ];
  for (const [sel, fn] of map) {
    if (e.target.closest(sel)) { fn(e); return; }
  }
  // click-retargeting fix: when a press starts on the backdrop and ends on the
  // card (or vice versa), the browser fires the click on their common ancestor
  // (.modal), which matches no attribute above. If that click landed on the
  // modal shell — outside the actual card — treat it as a backdrop click.
  if (e.target.classList?.contains("modal") && !e.target.querySelector(".modal__card")?.contains(document.elementFromPoint(e.clientX, e.clientY))) {
    if (e.target.id === "player-modal") { backdropClosePlayer(); return; }
    if (["confirm-modal", "import-modal", "plans-modal", "subject-modal", "notice-modal"].includes(e.target.id)) {
      closeModal(`#${e.target.id}`);
      if (e.target.id === "subject-modal") subjectModalEditId = null;
      return;
    }
  }
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    if (!$("#player-modal").hidden) { backdropClosePlayer(); return; }
    if (!$("#confirm-modal").hidden) { closeModal("#confirm-modal"); return; }
    if (!$("#import-modal").hidden) closeModal("#import-modal");
    if (!$("#plans-modal").hidden) closeModal("#plans-modal");
    return;
  }
  if (e.key === "Tab") {
    for (const sel of ["#player-modal", "#confirm-modal", "#import-modal", "#plans-modal", "#subject-modal"]) {
      if (!$(sel).hidden) { trapTab(e, sel); return; }
    }
  }
});

function trapTab(e, sel) {
  const focusables = $$(`button, [href], input, textarea, [tabindex]:not([tabindex="-1"])`, $(sel))
    .filter((n) => !n.disabled && n.offsetParent !== null);
  if (!focusables.length) return;
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
}

/* PERF: re-rendering every view on every change made big workspaces feel
   dead (~5s at 400 quizzes). Views are hidden with [hidden] — only the
   visible one needs fresh content; hidden views re-render on entry via
   setView, and the ones below always affect what's currently on screen. */
function renderAll() {
  if (!state.user) { showLogin(); return; }
  applyRoleChrome();
  const v = state.view;
  if (v === "dashboard") renderDashboard();
  else if (v === "results") renderResults();
  else if (v === "leaderboard") renderLeaderboard();
  else if (v === "drafts") renderDraftsScreen();
  else if (v === "favs") renderFavsScreen();
  else if (v === "bookmarks") renderBookmarksScreen();
  else if (v === "builder") syncBuilderInputs();
  // cross-view chrome that must stay fresh
  renderRailDrafts();
}

/* ─── boot ───────────────────────────────────────────────────────── */
/* PWA: register the service worker only on http(s) origins served by the
   Node server — never inside the Android APK (asset-loader origin) where
   the app is already offline-complete and SW registration would fail. */
if ("serviceWorker" in navigator &&
    (location.protocol === "http:" || location.protocol === "https:") &&
    !location.hostname.includes("appassets")) {
  addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => { /* offline-first still works */ });
  });
}
initTheme();
/* APK-only menu items: Export/Import/Delete Account live in the account menu
   because the APK hides the desktop rail (its only Data block). On the webapp
   the rail provides them, so these stay hidden there. data-apk-only="1"
   marks them; reveal when running inside the WebView asset-loader origin. */
if (location.hostname.includes("appassets")) {
  document.querySelectorAll("[data-apk-only]").forEach((el) => { el.hidden = false; });
}
buildChoiceRow();
resetQuestionForm();
wireLogin();
wireAccountMenu();
wireGenerator();
$("#btn-consent-accept").addEventListener("click", () => recordConsent(true));
$("#btn-consent-reject").addEventListener("click", () => recordConsent(false));
$("#btn-consent-close").addEventListener("click", () => { $("#consent-banner").hidden = true; }); // X = ask again next visit
showConsentIfNeeded();
// one-time sweep: pre-cutoff (v1) caches hold deleted demo seed data — purge them
try {
  for (const k of Object.keys(localStorage)) if (k.startsWith("quiz-atelier-v1")) localStorage.removeItem(k);
} catch { /* private mode */ }
load();                 // restore workspace + custom subjects before first render
refreshSubjectPickers();
renderAll();          // shows the login gate until a session is restored
restoreSession();     // persistent session: /api/session → auto sign-in
