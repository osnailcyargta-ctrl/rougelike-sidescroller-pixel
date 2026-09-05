# Aether Descent, packaged

A WebView around the game, with the game itself copied inside the APK. It
plays in flight mode from the moment it is installed; the network is only ever
used to look for a newer copy, and only on a cold start.

## Served over https, not file://

The game is ES modules. A module script fetched from a `file://` page has an
opaque origin, so Chromium blocks it by CORS — the page paints and nothing
runs, which is a "click to start" with nothing behind it. So the assets are
served through `WebViewAssetLoader` at
`https://appassets.androidplatform.net/`. That also gives `localStorage` a
single origin that survives an update, so settings and unlocks are not lost
when the files underneath change.

If the game object has not appeared a few seconds after the page loads, the
loading screen says so instead of handing over a dead overlay.

## Updating

On a **cold start** — first launch, or after the app was swiped out of recents
— it checks for a newer copy:

- **Offline**: nothing is attempted. The game starts immediately from what is
  already installed.
- **Online**: it fetches `webapp.json` from the release branch and compares
  each file's SHA-256 against what is on the device. Only files that actually
  differ are downloaded, into a staging directory. If every one arrives and
  every hash matches, the staged set replaces the live one in a single rename;
  if anything at all fails, the staging is thrown away and the copy already
  installed is used.

Coming back from the background does **not** re-check — the activity is still
alive and you are probably mid-run.

Two copies exist at all times: the one packaged in the APK, which cannot go
missing, and the downloaded one, which is only used once it is complete. Reads
prefer the download and fall back to the package per file.

## What the build does

1. `snapshot.sh` copies `index.html`, `js/`, `css/` and `shaders/` out of the
   repository into `app/src/main/assets/www/`, writes a `build.json` recording
   the commit and date, and regenerates `webapp.json` — the file list with
   hashes that the installed app later compares against the web copy.
2. It then refuses to continue if anything in the bundle points at `http://`
   or `https://` — a single absolute reference would be a file the game could
   not load offline.
3. Gradle packages that as the app's assets. `MainActivity` loads
   `file:///android_asset/www/index.html?app=1`.

The snapshot is **not** in git. It is generated, and a copy in the branch
would sooner or later be the stale one that ships.

## Getting an APK

Push to `claude/android-apk`, or run **Build APK** from the Actions tab. The
workflow attaches two files:

- `aether-descent-<version>.apk` — install this one
- `...-debug.apk` — same thing, debuggable

Both are signed with Gradle's debug key, so they install on a phone without
anyone holding a release keystore. That also means Play Store upload is out
until a real key is added.

### Packaging a different version of the game

Run the workflow by hand and put a branch, tag or SHA in **game_ref**. It
checks out the app from this branch and the game files from that ref, so you
can build an APK of any version without merging anything.

### Keeping this branch current

`android/` lives here; the game lives on the game branch. Either merge the
game branch in before building, or use `game_ref` above and leave this branch
alone.

## What the wrapper handles

- Landscape, immersive, cutout-to-edge, screen kept awake.
- `?app=1` tells the game it is the packaged build, so the on-screen pad
  starts switched on. It is only a default — change it once and your choice is
  saved like any other setting.
- Back sends Escape, which is what the game already uses to pause and to close
  a popup, rather than killing the app mid-run.
- The loop and the audio stop when the app goes to the background.
- Long-press text selection is off, zoom is off, and the system font scale
  cannot move the HUD.

## Building locally

Needs the Android SDK and JDK 17.

```sh
bash android/snapshot.sh
cd android && gradle assembleDebug -PgameVersion=local -PgameCode=1
```
