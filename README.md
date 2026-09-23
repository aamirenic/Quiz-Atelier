<div align="center">

# 🎓 Quiz Atelier

**A full-stack quiz platform — create, take, and analyze quizzes.**

Web · Node API · Android

[Features](#-features) · [Quick start](#-quick-start) · [Architecture](#-architecture) · [API](#-api-overview) · [Deploy](#-deploying) · [Design](#-the-design-system)

</div>

> *Quiz Atelier wears its palette on its sleeve: warm parchment surfaces, ink typography, and a coral accent — the look of an artisan's notebook, in light and dark themes alike.*

---

## ✦ Features

**🧑‍🏫 For teachers**
- **Quiz builder** — multi-question quizzes with subjects, marks, and time limits
- **Scoreboard** — per-quiz results with attendance + pass/fail filters, search, and CSV export
- **Student snapshots** — per-student stats with instant filters and a six-mode sort cycler
- **Leaderboard** — ranked averages with best-score tracking
- **Issue student logins** — students can't self-signup; the teacher creates and publishes their credentials from the **+ New → Student** menu. Unpublished or revoked logins are locked out at the gate, live sessions included.

**🧑‍🎓 For students**
- **Quiz player** with resume-on-reload (progress survives restarts)
- **Streaks & badges** — daily practice tracking with a collectible badge set
- **ELI5 & AI assistance** — plain-language explainers powered by Gemini
- **My Scores, favorites, and bookmarks**

**⚙️ Platform**
- 🌗 Light / dark theme (parchment ↔ ink)
- 📶 PWA — installable, offline-first with a service worker
- 📱 Android app (WebView wrapper, offline-first)
- 🔐 Server-side auth with rate limiting; Gemini keys never touch the client
- ⚡ Tuned rendering + debounced persistence — stays fast as data grows

## ✦ Quick start

Requires [Node.js 18+](https://nodejs.org). No `npm install` — there are zero dependencies.

```bash
git clone https://github.com/aamirenic/Quiz-Atelier.git
cd Quiz-Atelier/server
node server.js        # serves the webapp + API on http://localhost:8790
```

**Sign in** — a fresh database seeds two demo accounts automatically:

| Role | Email | Password |
|---|---|---|
| Teacher | `teacher@quiz.dev` | `teacher123` |
| Student | `student@quiz.dev` | `student123` |

> The login form doubles as signup for **teachers** (unknown email → confirm dialog → account created). Students can only sign in with teacher-issued credentials.

**Optional — AI features.** Quiz generation and ELI5 explainers need a [Gemini API key](https://aistudio.google.com/apikey):

```bash
# server/.env
GEMINI_API_KEYS=key1,key2     # comma-separated pool; rotates on quota errors
```

**Build the Android APK** (optional — the web app is fully usable on its own)

<details>
<summary>Gradle release build</summary>

Requires JDK 17 + Android SDK, and a release keystore at `android/app/release.keystore` (alias `quizatelier`):

```bash
export JAVA_HOME="<path to JDK 17>"
export ANDROID_HOME="<path to Android SDK>"
export QA_STORE_PASSWORD=... QA_KEY_PASSWORD=...
cd android && ./gradlew assembleRelease
# → app/build/outputs/apk/release/app-release.apk
```

The APK bundles the web app from `android/app/src/main/assets/www/` —
copy `quiz-manager/index.html styles.css app.js sw.js` there before building.

</details>

## ✦ Architecture

```
┌─────────────────────┐      ┌──────────────────────┐
│   quiz-manager/     │ HTTP │   server/            │
│   static web app    │─────▶│   zero-dependency    │
│   (PWA)             │      │   Node 18+ API       │
└─────────────────────┘      └──────────┬───────────┘
         ▲                              │
     bundled as                    db.json on disk
┌─────────────────────┐
│   android/          │
│   WebView wrapper   │
└─────────────────────┘
```

| Piece | Tech |
|---|---|
| **Web app** | Vanilla JS, hand-rolled CSS design system, service-worker PWA |
| **API server** | Node 18+, zero npm dependencies (`http`, `fs`, `crypto`) |
| **Database** | Single JSON file with atomic, serialized writes |
| **AI** | Gemini 3.6 Flash via server-side key pool (`/api/ai/generate`) |
| **Android** | Kotlin WebView + `WebViewAssetLoader`, bundled web app |

One codebase serves all three surfaces: the webapp is responsive (rail on desktop, tab bar on phones), and the APK is the same app with a couple of origin-gated extras (export/import/delete-account) — divergence is deliberate and minimal.

## ✦ Project Layout

```
├── quiz-manager/        # the web app (index.html is generated — see python/)
│   ├── python/          # build_html.py — regenerates index.html; don't hand-edit it
│   ├── app.js           # application logic
│   ├── styles.css       # the design system & palette
│   └── sw.js            # service worker (bump CACHE_VERSION on every release)
├── server/              # zero-dependency Node API
│   └── data/            # db.json lives here (gitignored — user data)
└── android/             # Kotlin WebView wrapper
```

## ✦ API overview

All routes are JSON over HTTP; auth is a session cookie from `POST /api/login`.

| Area | Routes |
|---|---|
| Auth | `POST /api/login` · `POST /api/logout` · `POST /api/signup` (teachers only) |
| Workspace | `GET/PUT /api/workspace` — per-user quizzes, subjects, attempts, streaks |
| Students (teacher) | `GET/POST /api/students` · `POST /api/students/publish` · `POST /api/students/delete` |
| AI | `POST /api/ai/generate` — `{ kind: "quiz" \| "eli5", parts: [...] }`, server-side key pool |

Rate limits: logins are limited per-IP **and** per-account, so scripted retries get 429s quickly.

## ✦ Deploying

Any Node host works. On [Render](https://render.com) (free tier):

| Setting | Value |
|---|---|
| Runtime | Node |
| Build command | `echo "no build needed"` |
| Start command | `node server/server.js` |
| Env | `GEMINI_API_KEYS` (optional, enables AI) |

## ✦ The Design System

All colors live as raw hex in one place — `quiz-manager/styles.css :root` —
and everything else derives from them with `color-mix()`. The dark theme
rebinds the same semantic tokens (`--bg`, `--surface`, `--fg`, `--accent`…),
so components never know which theme they're in:

| Token | Light | Dark |
|---|---|---|
| `--bg` | paper `#efe7d2` | ink `#15140f` |
| `--surface` | bone `#f7f1de` | `#221f18` |
| `--fg` | ink `#15140f` | bone `#f7f1de` |
| `--accent` | coral `#ed6f5c` | coral `#ed6f5c` |

Type pairing: an old-style serif for display (Iowan/Palatino stack),
system sans for UI, monospace for numerals.

## ✦ License

Released under the [MIT License](LICENSE).
