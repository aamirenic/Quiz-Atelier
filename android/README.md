# Quiz Atelier — Android

Standalone Android app wrapping the Quiz Atelier web app (offline-first).

## Layout
- `app/src/main/java/com/quizatelier/app/MainActivity.kt` — the entire native
  layer: a WebView serving bundled assets through `WebViewAssetLoader`
  (`https://appassets.androidplatform.net/assets/www/`), with file-picker
  bridging for the PDF generator, back-stack handling, and JS console logging.
- `app/src/main/assets/www/index.html` — the mobile-optimized web app
  (single file, same codebase as the site).

## Build
```bash
# once: point these at your installs
export JAVA_HOME="<path to JDK 17>"
export ANDROID_HOME="<path to Android SDK>"

cd android
./gradlew assembleRelease        # → app/build/outputs/apk/release/app-release.apk
```

The release APK is signed with `app/release.keystore` (key alias `quizatelier`).
Regenerate a keystore with:
```bash
keytool -genkeypair -v -keystore app/release.keystore -alias quizatelier \
  -keyalg RSA -keysize 2048 -validity 10000
```

## Updating the web app
Replace `app/src/main/assets/www/index.html` with a fresh build and re-run
`./gradlew assembleRelease`. Bump `versionCode` in `app/build.gradle.kts`.
