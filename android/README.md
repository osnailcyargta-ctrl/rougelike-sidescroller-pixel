# Aether Descent, packaged

A WebView around the game, with the game itself copied inside the APK. There
is no `INTERNET` permission: once it is installed nothing is downloaded, and
it plays in flight mode.

## What the build does

1. `snapshot.sh` copies `index.html`, `js/`, `css/` and `shaders/` out of the
   repository into `app/src/main/assets/www/`, and writes a `build.json` next
   to them recording the commit it took and the date.
2. It then refuses to continue if anything in the bundle points at `http://`
   or `https://` — a single absolute reference would be a file the game could
   not load offline.
3. Gradle packages that as the app's assets. `MainActivity` loads
   `file:///android_asset/www/index.html?app=1`.

The snapshot is **not** in git. It is generated, and a copy in the branch
would sooner or later be the stale one that ships.

## Known good

The first CI run built it in 48 seconds:

```
BUILD SUCCESSFUL in 48s
aether-descent-2026.09.05-1402e6d-debug.apk   256K
aether-descent-2026.09.05-1402e6d.apk         218K
32 game files packaged
```

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
