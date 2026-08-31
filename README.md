# Aether Descent

A pixel-art **roguelike sidescroller** that runs entirely in the browser — no
build step, no dependencies, no asset downloads. Every sprite, particle and
glyph is drawn procedurally at a 480x270 internal resolution and pushed through
a WebGL bloom pipeline, so the art stays crisp at any window size.

![Main menu](docs/screenshot-menu.png)
![Gameplay](docs/screenshot-play.png)

## Play

Open `index.html` over HTTP (it uses ES modules, so `file://` won't work):

```sh
python3 -m http.server 8000
# then visit http://localhost:8000
```

### Deploy to GitHub Pages

The repository root *is* the site. In **Settings → Pages**, choose
*Deploy from a branch*, pick this branch and the `/ (root)` folder. A
`.nojekyll` file is included so nothing gets filtered out.

## Controls

| Input | Action |
| --- | --- |
| `A` / `D` | Move left / right |
| double-tap `A` / `D` | Dash in that direction (i-frames) — only fires while the key is held |
| `Shift` | Dash as well, in the direction you are currently holding |
| `W` | Jump |
| `S` | Drop through a platform |
| double-tap `S` in the air | Ground slam (25 damage AoE + shockwave) |
| Left click | Attack toward the cursor |
| Right click | Interact with what's under the cursor (loot, gate) |
| Scroll wheel / `1`-`4` | Change hotbar slot |
| `E` | Inventory |
| `R` | Reload the bow |
| `Esc` | Pause |

## Run structure

Each **room** runs **two waves**. Enemies materialise on the left-centre and
right-centre platforms; in wave 2 the raised 4-block platform at the bottom
centre activates as a third spawn pad. When wave 2 ends, an item drops on that
centre platform and a gate opens on the right — right-click the drop to take
it, right-click the gate to descend into the next room. Rooms get denser and
add new enemy types as you go.

Clearing a wave restores **25% of max HP**, and stepping through the gate into
the next room restores you to **full HP**.

The game explains none of this to you. There are no banners, no objective
text, no "press X to..." prompts, and item tooltips show only a name and a
rarity — the effects are for you to discover. The Controls screen in the main
menu is the one and only place anything is spelled out.

### Classes

| Class | Weapon | Numbers |
| --- | --- | --- |
| Blade | Iron Sword | 3-block reach, 10 damage, 0.45s swing |
| Ranger | Hunter Bow | 10-block range, 5 damage, 10 ammo, 2s reload, 0.4s between shots |

Player HP is 100. Regular enemies have 80 HP and deal 10–20 damage depending on
type (Ghoul 12, Stinger 10 ranged, Brute 20).

### Perks

Perks are items — they work while they simply sit anywhere in the inventory.

| Item | Rarity | Effect |
| --- | --- | --- |
| Life Crystal | Common | +10 max HP each, effective up to 5 stacks (+50) |
| Fiery Blade | Common | Melee hits have a 33% chance to burn for 3s (-1 HP per 0.1s, non-stacking) |
| Lightning Arrow | Uncommon | Arrows mark enemies for 5s; with 2+ marks, arcs chain between them, damaging everything the arc crosses and applying *electrified* (-10 HP every 1.2–1.5s) |
| Wet Slime | Uncommon | Every 2s spits a homing glob that slows the target 30% for 1.5s |

Inventory is a 4x4 grid (16 slots); the top row doubles as the hotbar. Non-weapon
items stack to 10, weapons don't stack. Drag items between slots with the mouse.

## Shader packs

**Settings → Load .shdr**, or drag a `.shdr` file onto the window. A pack can
carry a JSON `@theme` header that repaints every colour in the game plus the
bloom/scanline/animation knobs, and a GLSL fragment shader that replaces the
final composite pass outright — so a pack changes the whole look, not just a
filter. See [`shaders/README.md`](shaders/README.md) for the format and the
uniforms, and the three included samples (`neon-veil`, `gameboy`, `crt-amber`).

![Neon Veil shader pack](docs/screenshot-neon.png)

If a pack's GLSL fails to compile it is rejected and the error is shown in
Settings; the built-in shader keeps running. If WebGL is unavailable the game
falls back to a plain scaled blit and stays playable.

## Layout

```
index.html          entry point
css/style.css       page frame
js/config.js        arena geometry + every tuning number
js/game.js          main loop, run/room/wave state machine
js/entities.js      player, enemies, projectiles, status effects
js/world.js         backdrop, platforms, pickups, gate, wave composer
js/items.js         item defs + inventory model
js/postfx.js        WebGL bloom pipeline + .shdr loader
js/gfx.js           camera shake, particles, combat text, draw helpers
js/ui.js            HUD, hotbar, inventory, tooltips
js/screens.js       menu, settings, class select, pause, death
js/font.js          5x7 bitmap font
js/input.js         keyboard/mouse + double-tap detection
js/audio.js         procedural sound effects
js/theme.js         palette (overridable by shader packs)
shaders/            sample .shdr packs
```
