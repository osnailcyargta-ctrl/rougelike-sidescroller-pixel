# Shader packs (`.shdr`)

Load one from **Settings → Load .shdr**, or just drag a `.shdr` file onto the
game window.

A pack is a plain text file with two parts, both optional:

1. **A `@theme` JSON header.** Every key here overrides one entry of the game's
   palette / effect config, so a pack can repaint every sprite, platform and
   UI element — not just the screen filter.
2. **A GLSL fragment shader** that replaces the final composite pass.

```
/*@theme
{ "name": "My Pack", "player": "#ff00aa", "bloomStrength": 1.6 }
@*/
precision mediump float;
varying vec2 vUv;
uniform sampler2D uScene;
void main() { gl_FragColor = texture2D(uScene, vUv); }
```

## Uniforms available to the composite shader

| uniform | type | meaning |
| --- | --- | --- |
| `uScene` | `sampler2D` | the rendered 480x270 frame |
| `uBloom` | `sampler2D` | blurred bright-pass buffer |
| `uResolution` | `vec2` | scene size in pixels (480, 270) |
| `uTime` | `float` | seconds since load |
| `uBloomStrength` | `float` | from the theme |
| `uVignette`, `uChroma`, `uScanline`, `uSaturation` | `float` | from the theme |
| `uHit` | `float` | 0..1, spikes when the player takes damage |
| `uSlowmo` | `float` | 0..1, rises during hit-stop |

`vUv` is the varying from the built-in vertex shader. Write to `gl_FragColor`.

## Theme keys

Colors (hex strings): `bgFar bgMid bgNear fog ground groundTop groundEdge
platform platformTop platformGlow player playerDark playerAccent cloth
clothDark skin steel steelDark enemyGrunt enemyBrute enemyStinger enemyDark
eye fire fireHot spark blood lightning slime ui uiDim uiAccent uiPanel hp
hpBack star`

Numbers: `bloomStrength bloomThreshold vignette chroma scanline saturation`
plus the animation knobs `animSpeed` (sprite animation rate), `wobble`
(cape / secondary motion) and `trail` (afterimage and projectile trail
opacity).

A pack may ship only a theme (no GLSL) — the built-in composite is kept.
If the GLSL fails to compile the pack is rejected and the error is shown in
Settings.

## Included samples

* `neon-veil.shdr` — magenta/cyan synthwave, heavy bloom and wave distortion.
* `gameboy.shdr` — 4-tone dithered handheld palette.
* `crt-amber.shdr` — curved amber phosphor terminal.
