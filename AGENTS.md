# AGENTS.md — Quiz Atelier

Guidance for AI coding agents (and new human contributors) working in this
repository. Read it before making changes: it describes how the project is
structured, which rules are non-negotiable, and which pitfalls previous work
has already hit.

## Project overview

Quiz Atelier is a web-based quiz management system for classroom use. A role
gate adapts the interface to the signed-in user: teachers author, publish and
grade quizzes (manually or with AI-assisted question generation); students
take quizzes, track personal score history and compare against class
averages. The codebase is deliberately zero-build and zero-dependency:

- `quiz-manager/` — the webapp: `index.html` (generated), `styles.css` and
  `app.js` (hand-maintained), `sw.js` + `manifest.webmanifest` (PWA layer).
- `server/server.js` — a single-file Node.js 18+ HTTP server (static file
  serving, REST API, session auth, Gemini proxy, JSON persistence). It must
  bind `0.0.0.0` (the `HOST` fallback) so cloud port-scan health checks pass.
- `android/` — a WebView wrapper that bundles the webapp as a signed APK.
- AI features call `POST /api/ai/generate` on the server; Gemini API keys
  live only in the server's `GEMINI_API_KEYS` environment variable, never in
  client code or the repository.

## Build & run commands

```sh
# Serve locally (no npm install required — the server has zero dependencies)
node server/server.js            # listens on PORT, default 8790

# Regenerate index.html after editing markup
python quiz-manager/python/build_html.py
```

There is no build step, test suite, or package manager. Verification is done
by running the server and exercising the real UI.

## Architecture rules

### index.html is generated — never hand-edit it

`quiz-manager/index.html` is produced by `quiz-manager/python/build_html.py`
(one function per page section). To change markup:

1. Edit the matching section function in `build_html.py`.
2. Run `python quiz-manager/python/build_html.py`, which rewrites index.html.

Hand edits are silently overwritten on the next run. `app.js` and
`styles.css` are hand-maintained and are the right place for behavioural and
styling changes.

### Theme-aware styling

Raw palette tokens such as `--ink-soft` do **not** rebind in dark mode. Text
colours inside panels must use theme-aware tokens (`--muted`, `--fg`) or
dark-mode text becomes invisible. The app's signature cloth-tear reveal
animations are required UI — do not simplify them to plain buttons; they
respect `prefers-reduced-motion` with an instant reveal.

### Service-worker caching

`sw.js` uses cache-first for the app shell and network-only for the API.
Bump `CACHE_VERSION` in `sw.js` on every webapp release; stale caches are the
most common reason a "shipped fix" isn't visible to clients or live-testing
tools (an already-open page keeps running the previous release until
reloaded).

## Deployment

The app deploys to Render as a Node Web Service (build command
`echo "no build needed"`, start command `node server/server.js`) and
auto-deploys on push to `master`. The free tier sleeps after ~15 minutes of
idleness and has an ephemeral disk — `server/data/db.json` resets on every
redeploy/restart. This is a known, accepted limitation; do not "fix" it by
committing the database.

## Android (APK) release policy

The APK bundles the webapp as static assets and releases are **opt-in**:
ship the webapp first, then ask the user before building or shipping any
APK, even if the bundled assets already contain the change. When an APK
release *is* approved:

1. Copy all web files (not just index.html) into
   `android/app/src/main/assets/www/`.
2. Bump `versionCode` / `versionName` in `android/app/build.gradle.kts`.
3. Build with the JDK 17 + Android SDK toolchain (local, untracked
   `android-build-tools/`), signing via the `QA_STORE_PASSWORD` /
   `QA_KEY_PASSWORD` environment variables. Signing credentials and the
   keystore are never committed.
4. Verify the served asset is fresh: the WebView loads
   `assets/www/index.html`; prove the new code is inside the APK
   (`unzip -p <apk> assets/www/index.html | grep <new-marker>`) rather than
   trusting a bundled copy.

Webapp and APK diverge intentionally in places (topbar layout, account-menu
contents, controlled by an origin check). Do not "fix" one to match the
other.

## Data model notes

- Attempts live in whichever workspace wrote them (per-user JSON blobs PUT
  to `/api/workspace`). A student's attempt is not visible to the teacher
  unless it reaches the teacher's workspace; "Attempts 0" after a student
  plays is a data-model symptom, not a rendering bug.
- Student self-signup is blocked by design. Students sign in only with
  teacher-issued, published credentials (the `/api/students*` routes are
  teacher-session-only). The `student@quiz.dev` demo account is a deliberate
  exception.
- The server serializes writes and rewrites `db.json` wholesale — stop the
  server before hand-editing the database file.

## Conventions

### Commit messages (non-negotiable, applies to every project)

- Never append `Co-Authored-By:` or "Generated with …" trailers — for AI,
  bots, or any other contributor. GitHub counts co-author trailers as
  contributions.
- Author and committer must be the repository owner's configured identity
  only. Commits must appear as if made solely by the human user.
- Commit messages contain only the message body: no signatures, no AI
  attribution.

### Secrets and privacy

- Never print or commit credentials, tokens, or the contents of
  `server/data/` (user data, password hashes, sessions). All are gitignored.
- Use stored credentials transiently (e.g. `git credential fill`) and delete
  any temp files immediately.

## Known pitfalls

- Login is rate-limited (per IP and per account). Heavy automated probing of
  the login flow can trip 429s that look like auth bugs — reuse session
  cookies or in-page sign-in APIs instead of repeated `/api/login` calls.
- The server DB lives at `server/data/db.json` (not `<repo>/data/`).
- `requestAnimationFrame` does not tick in hidden/preview tabs — test
  timers and physics by driving state directly, not by waiting.
- Before concluding a fetch or event handler is dead, check for unhandled
  promise rejections and console output; several apparent "stuck states"
  have been probe races rather than application bugs.
