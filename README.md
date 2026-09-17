<div align="center">

# 🎓 Quiz Atelier

**A full-stack quiz platform — create, take, and analyze quizzes.**

Web · Node API · Android

</div>

<div align="center">

&nbsp;

</div>

&nbsp;

> *Quiz Atelier wears its palette on its sleeve: warm parchment surfaces, ink typography, and a coral accent — the look of an artisan's notebook, in light and dark themes alike.*

## ✦ Features

**🧑‍🏫 For teachers**
- **Quiz builder** — multi-question quizzes with subjects, marks, and time limits
- **Scoreboard** — per-quiz results with attendance + pass/fail filters, search, and CSV export
- **Student snapshots** — per-student stats with instant filters and a six-mode sort cycler
- **Leaderboard** — ranked averages with best-score tracking

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
| **AI** | Gemini 2.5 Flash via server-side key pool (`/api/ai/generate`) |
| **Android** | Kotlin WebView + `WebViewAssetLoader`, bundled web app |

## ✦ Getting Started

**Run the server**

```bash
cd server
node server.js          # serves the webapp + API on :8790
```

**Optional — AI features**

```bash
# server/.env
GEMINI_API_KEYS=key1,key2,...   # comma-separated pool, rotates on quota errors
```

**Open the app** — `http://localhost:8790` (demo accounts ship in `content.json`).

**Build the Android APK**

```bash
export JAVA_HOME="<path to JDK 17>"
export ANDROID_HOME="<path to Android SDK>"
export QA_STORE_PASSWORD=... QA_KEY_PASSWORD=...
cd android && ./gradlew assembleRelease
# → app/build/outputs/apk/release/app-release.apk
```

## ✦ Project Layout

```
├── quiz-manager/        # the web app (index.html is generated — see python/)
│   ├── python/          # build_html.py — generates index.html
│   ├── app.js           # application logic
│   └── styles.css       # the design system & palette
├── server/              # zero-dependency Node API
│   └── data/            # db.json (gitignored)
├── android/             # Kotlin WebView wrapper
└── content.json         # demo seed data
```

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
