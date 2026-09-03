# Aether Descent

A pixel-art **roguelike sidescroller** that runs entirely in the browser — no
build step, no dependencies, no asset downloads. Every sprite, particle and
glyph is drawn procedurally at a 480x270 internal resolution and pushed through
a WebGL bloom pipeline, so the art stays crisp at any window size.

The presentation leans on motion rather than frame counts: characters squash and
stretch, cloth hangs off verlet chains, the blade leaves a tapered ribbon, hits
throw expanding rings and streak sparks, the camera punches inward on impact,
and the backdrop is a three-layer parallax skyline with light shafts, fog banks
and drifting embers.

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
| double-tap `A` / `D` | Dash in that direction (i-frames) |
| `W` | Jump |
| `S` | Drop through a platform |
| double-tap `S` in the air | Ground slam (25 damage AoE + shockwave) |
| Left click | Attack toward the cursor |
| Right click | Interact with what's under the cursor (loot, gate) |
| Scroll wheel / `1`-`4` | Change hotbar slot |
| `E` | Inventory |
| `R` | Reload the bow |
| `Q` | Fire the grappling hook (needs the item) |
| `Esc` | Pause |

Every key in that table except the mouse, the scroll wheel and `Esc` can be
**rebound** from Controls in the main menu — click a key, press the new one.
Assigning a key that is already taken swaps the two, and the mapping is saved
in `localStorage`.

There is one shortcut the game never mentions: **`Ctrl+M`** opens a debug menu
with god mode, infinite health, a spawner for every item in the game, a spawner
for every enemy and both bosses, full heal and kill-wave. It is
deliberately absent from the in-game Controls screen.

## Run structure

The arena has three static one-way platforms (left, right, and the raised
4-block platform at the bottom centre) plus a **drifting platform high in the
centre** that slides left and right and carries whatever is standing on it.

Each **room** runs **two waves**. The opening is a soft on-ramp — room 1 sends
one enemy then two, room 2 sends two then three — and from room 3 the normal
scaling takes over. Enemies materialise on the left-centre and
right-centre platforms; in wave 2 the raised 4-block platform at the bottom
centre activates as a third spawn pad. When wave 2 ends, a drop appears on that
centre platform — a perk 80% of the time, a **weapon** the other 20% (favouring
one you aren't already carrying, so it can open up the other playstyle) and a gate opens on the right — right-click the drop to take
it, right-click the gate to descend into the next room. Rooms get denser and
add new enemy types as you go, and past room 12 — where enemies stop scaling —
the rooms fill up instead, to a hard ceiling of **17 enemies in one wave**. A
run is **20 rooms long**: Alphads waits in
room 20 and killing it finishes the game.

Enemies keep their base stats through the first five rooms. From **room 6** they
step up **once every two rooms**, and they **stop scaling after room 12** — past
that the difficulty comes from the bosses, not from ordinary enemies quietly
turning into sponges. Each step is +18% max HP and +12% damage, so a
Ghoul is 80 HP / 12 damage until room 5, 94 / 13 in rooms 6–7, and 123 / 17 by
rooms 10–11.

You regenerate **1 HP per second** at all times. Clearing a wave restores **25%
of max HP**, stepping through the gate into the next room restores you to
**full HP**, and the boss wave in a boss room also starts you at full.

Nothing is announced. There are no banners, no wave-clear notifications and no
"press X to..." prompts — you find out what happened by watching the screen.
Reference information stays available where you go looking for it: the HUD
carries the wave and enemies-left counters, item tooltips describe their
effects, and the Controls screen sits in the main menu.

### Seeds

The class-select screen has a **seed** field. Type anything and the run's rooms,
wave composition, enemy types, spawn offsets and every drop roll replay exactly;
leave it blank and one is rolled for you. Purely cosmetic randomness (particles,
timing jitter) runs on its own unseeded stream, so it never desyncs a replay.
The death screen shows the seed and offers **Retry Seed** next to **New Seed**.

### Run summary

Dying opens a summary panel: class, room and wave reached, kills, run time, max
HP, the seed, and every item you were carrying (hover one for its tooltip).

### Boss rooms

Every **5th room** (5, 10, 15, 20) runs a **third wave** instead of ending after
two, and holds its drop back for it. Wave 3 spawns a boss in the centre of the
arena. When it dies, **two perks** appear on the centre platform and you may
take **one** — the moment you claim one the other greys out for good.

**Aether Golem** (990 HP, +40% per boss room). It never stands still: between
orders it paces in and out of a stand-off that breathes with it, and pops off
the floor in short hops that kick up dust and land with weight.

Two phases sharing one pool:

It is a large target — a 48x60 body with a 32x27 head — and it waits **3
seconds between attacks**, so its openings are readable.

* *Phase 1* — head fused to the body. Loops: four small lasers 0.2s apart → one
  heavy beam that tracks your position with a 0.3s delay for 2s → a high jump
  into a ground slam.
* *Phase 2* (at 462 HP) — the head tears free over a second and a half: it
  strains and sinks in the socket, snaps loose in a burst of arcs, then climbs
  with an eased overshoot while a bolt still tethers it to the body. From then
  on it never parks — it sweeps, bobs and banks continuously, stalking you
  between orders, and only moves on the X axis. Its script continues (four small lasers → turn → 2s beam → 1s beam)
  while the body improvises underneath with high slams, quick slams and dashes,
  and charges in alongside the head's short beam.

**Big Dude** (600 HP, +40% per repeat appearance). A twenty-block worm that
lives under the floor. The head drives a path and every body segment trails it
by a fixed arc length, so the whole thing swims, erupts and dives as one curve —
and only the parts above the floor line can be hit or can hurt you (the head
hurts far more than the back). Its loop: buried 3s, leap, wait 2s, leap, wait
2s, leap + spit, buried 3s, spit + leap, wait 2s, repeat. The spit is a fan of
20 globs thrown up on their own arcs.

**Undead Ceiling, THE ROOF OF MEAT** (2000 HP, fixed). **Room 15.** It is not
standing in the arena — it *is* the roof: a slab of grafted flesh stretched
across the whole top of the screen, breathing through swollen lobes, dripping,
with sinew hanging off its underside and **one enormous eye** in the middle
that tracks you. Its body is flesh **all the way up past the top of the frame**,
so when it comes down there is nothing behind it but more meat. It never moves
sideways and **ground slam does nothing**.

* *Stare* — the eye opens, follows you while it charges, then **locks and fires
  for 1 second** along that fixed line. Once it fires it does not follow.
* *Grasp* — **five** arms of muscle grow out of the ceiling from five places
  along the slab, a sixth of a second apart. The one nearest you hunts you; the
  rest commit to their own patch of floor. Each punches for 60.
* *Crush* — the whole slab drops to the floor and grinds there before rising
  again.

**The crush is the clock, not an attack.** You have **2 minutes 30 seconds** to
kill it. Past that it starts ending every cycle by dropping on you for **2000
damage that goes straight through shields, invulnerability frames and dashes** —
there is no surviving it and no tanking it. Kill it in time or the run is over.

Its loop is `stare, stare, stare, grasp, grasp`, tightened to 65% of the written
pauses, and everything it does hits for double its listed numbers.

Because it hangs from the roof, melee has to go up to reach it: from the floor
you cannot touch it, but the **top drifting platform** puts it in range, and the
crush brings the whole thing down to you.

Killing it does not offer a choice. It leaves exactly one thing: the **Damage
Booster**.

Note that 2000 HP inside 150 seconds is still a DPS check — a little over 13
sustained damage per second — so it wants a real weapon, not the starter bow.

**Alphads, THE AETHER GOD** (2000 HP, fixed — it does not scale). The run's
last fight, waiting in **room 20**. It never lands and **ground slam does
nothing to it**. The body is a black censor bar under a halo, with two wings on
each side — a large one above and a small one below — and it carries a gold bow
that aims wherever its next shot is going. Five attacks:

* *Shot* — **ten** arrows in a row, 40 damage each.
* *Arrow rain* — **twenty-five** arrows fired straight up and off the top of the screen;
  they arc back down as rain, with sights marking the floor under each one.
* *Time stop* — for **2 seconds** the player and every enemy stop dead (no
  movement, no attacks, no grapple) and the whole screen drains to grayscale.
  Only Alphads acts, calling up **3 shardlings** — at most **10** summoned in
  the fight. These are its own: same AI and same sprite as the room's
  Shardlings, but only they count against the cap and they never drop a
  weapon.
* *Healing* — every living shardling is unmade into a green orb that homes in
  on Alphads and heals it **15 HP** on contact. Shoot the orbs to pop them
  before they land.
* *God rays* — a laser that tracks you **only while it charges**. The instant
  it fires it **locks to where you were standing** and stays on that line for 2
  seconds — it does not follow you. Every **0.75s** a shock wave peels off it
  and runs out **10 blocks** to either side.

Its liturgy: `(shot, 0.5s, shot, 1s, arrow rain, 3s) x3, 1s, time stop,
(god ray, 2.3s, god ray, 1s, shot, shot, shot), healing`, then repeat — every
written pause runs at **65%** of its length, and everything it does lands for
**double** the listed number.

**Room 20 is the last room.** Killing Alphads ends the run — no drops, no
portal, no room 16, just the ending screen with your run summary.

Rooms 5 and 10 hold the golem and Big Dude, and each of those
scales from its own first appearance, so a debut boss always fights at its
listed stats.

### Boss cutscenes

Every boss gets an intro and an outro. The world keeps rendering underneath —
gameplay pauses, letterbox bars slide in, the camera pushes onto the boss, and
the name card wipes in on a light streak with its letters dropping one at a
time over a filling HP bar. Big Dude tears up out of the floor for its reveal
instead of sitting invisible underground. The outro walks a chain of
detonations along the body in slow motion, strikes the boss's name through and
stamps DEFEATED. The golem's outro tears its head free (even if it died in
phase 1), drops it, bounces it off the floor, settles it on its side and then
lets it crumble away the same way a spent arrow does. Alphads gets its own pair
instead of the explosions: feathers fall through the reveal, and the outro has
it come apart a wing-row at a time and rise out of the top of the frame in a
column of light. Any key skips after half a second.

### Enemies

| Enemy | Behaviour | Damage |
| --- | --- | --- |
| Ghoul | Chases and swipes | 12 |
| Stinger | Flies, keeps distance, shoots | 10 |
| Brute | Slow, heavy, occasionally charges | 20 |
| Lurker | Circles at range, then commits to a long telegraphed lunge | 15 |
| Spitter | Holds a stand-off and lobs acid on a high arc | 16 |
| Wisp | Post-golem, from room 6. **It never attacks you.** It hangs behind the pack on the far side and feeds **+20% speed to the three allies nearest you**, tethered by a visible thread. 30 HP — kill it first or the whole room gets faster | 0 |
| Shardling | Golem wreckage, from room 6. Hovers with its plate toward you, sights a line, then commits to one straight charge it cannot steer. The plate turns **75% of any frontal hit** — open it up from behind or above | 10 |

### Classes

| Class | Weapon | Numbers |
| --- | --- | --- |
| Melee | Iron Sword | 3-block reach, 10 damage, 0.45s swing |
| Ranger | Hunter Bow | 10-block range, 5 damage, 10 ammo, 2s reload, 0.4s between shots |
| Origamist | 100 Paper + Paper Plane Tutor | **50 HP.** Paper is the ammunition; folds are the weapons |

At the end of its 10 blocks an arrow does not blink out: it loses its drive with
a small puff, hitches upward, then tumbles down under gravity and plants itself
nose-first in whatever surface it lands on before fading. A spent arrow deals no
damage, so the bow's reach stays exactly 10 blocks.

Player HP is 100. Regular enemies have 80 HP and deal 10–20 damage depending on
type (Ghoul 12, Stinger 10 ranged, Brute 20).

### Origamist

The Origamist has **50 HP** — half of everyone else — and starts with **100
sheets of paper** and the **Paper Plane Tutor**. Paper is both weapon and
ammunition, and you can carry **250 sheets at most**; anything past that is
simply never handed over.

Everything the Origamist throws is drawn in **two colours only, ink and paper**,
with shaky hand-drawn outlines that re-jitter about twelve times a second, so it
reads as a doodle moving rather than a sprite sliding.

Attacking with paper selected does not fire anything: **the world stops** and a
fold carousel opens over your head. Every fold you own the tutor book for is a
card on it. **Scroll** to turn the wheel — it spins to the new card rather than
snapping — and the card that lands under the notch is the one you throw. Left
click or the card's number commits, right click or Escape backs out. Committing
spends that fold's sheets; nothing in the room moves until you decide.

| Fold | Book | Sheets | Behaviour |
| --- | --- | --- | --- |
| Paper Plane | starting kit | 1 | 0.45s between throws. Glides forever, sinking slowly as it goes. **30 damage.** It kicks off side walls (up to 3 times, gaining a little lift each time) and only dies when it meets the ground or a platform, where it crumples |
| Paper Missile | Big Dude's first offer | 2 | 0.9s between throws. Leaves the hand slow and keeps building speed to a scream. Detonates on anything it touches for **40 over 5 blocks**, tapering to two thirds at the rim |

Paper comes back to you two ways: every enemy you kill has a **10% chance to
shed 1–4 sheets**, collected automatically with no need to pick them up, and
**every new room hands you 50 more** on arrival, plus **20 for every wave you
clear** — all of it capped at 250. Folds have their own cooldown and the wheel
will not open while one is running, whichever class is holding the paper.

The **Paper Missile Tutor** is held in the first slot of Big Dude's drop pair,
once. Playing as the Origamist it also replaces the Nukerang in the *second*
slot of the first boss you kill, since a boomerang is no use to you — so the
missile is guaranteed either way.

### Nukerang

The first boss you kill always offers the **Nukerang** as its second choice —
once. Take it or leave it; if you already own one it never appears again, and
that slot goes back to a normal perk.

It is a thrown melee weapon. Left click hurls it five blocks out, it decelerates
into a turn, then homes back to your hand — while it is in the air your hands
are empty and you cannot throw again. Every enemy it passes through takes a
**small blast for 14**, and **every third blast** is a full detonation for **28**
over a much wider radius. The counter carries across throws, so you can line the
third one up.

### Armour and the anvil

The inventory has **three armour slots** — head, body, legs — down the left of
the grid. Drag a piece onto its slot to wear it, drag it back off to take it
away. Every worn piece adds **flat defence**, taken straight off each hit you
receive (a hit always leaves at least 1), and carries a buff. Wearing all three
pieces of one set adds a set bonus on top.

Every **second room** puts an **anvil on the drifting platform** — it rides the
platform as it slides, throwing light and embers so you can spot it from the
floor, and it rings and lifts a chevron once you are standing close enough to
use it. Right-click it to open the forge. Nothing there is
timed; the world stops while it is open.

| Recipe | Cost | Effect |
| --- | --- | --- |
| Melt a weapon | Iron Sword, Shardgun, Nukerang, Grappling Hook or Firey Twin Dagger | **2 Iron Bars** |
| Iron Helmet | 3 bars | 3 defence, **+20% melee damage** |
| Iron Chestplate | 3 bars | 4 defence, **+1 tile of melee reach** |
| Iron Leggings | 3 bars | 3 defence |
| *Iron set bonus* | wear all three | **+1 defence, -10% melee cooldown** (11 defence total) |
| Paper Helmet | 75 paper | 0 defence, **+10% Origamist damage** |
| Paper Chestplate | 75 paper | 2 defence, **-30% fold cooldown** |
| Paper Leggings | 75 paper | 1 defence, **+10% paper plane speed** |
| *Paper set bonus* | wear all three | a fourth fold: **PAPER SHIELD** |

**Paper Shield** costs **20 sheets** and raises **3 plates that orbit you**,
cutting anything they pass through for **20**. They last **90 seconds** and you
can only have one set up — the fold is refused until the last plate is gone.

### Perks

Perks are items — they work while they simply sit anywhere in the inventory.

| Item | Rarity | Effect |
| --- | --- | --- |
| Life Crystal | Common | +10 max HP each, effective up to 5 stacks (+50) |
| Fiery Blade | Common | Melee hits have a 33% chance to burn for 3s (-1 HP per 0.1s, non-stacking) |
| Lightning Arrow | Uncommon | Arrows mark enemies for 5s; with 2+ marks, arcs chain between them, damaging everything the arc crosses and applying *electrified* (-10 HP every 1.2–1.5s). **Bosses are immune** — they take no mark, never electrify, and the arc passes straight through them |
| Wet Slime | Uncommon | Every 2s spits a homing glob that slows the target 30% for 1.5s |
| Bloodstone | Common | Every 5th hit you land heals 3 HP (+2 per extra stack) |
| Aegis Shard | Uncommon | +20 absorb shield that soaks damage before your HP; refills 5s after you stop taking hits |
| Shardgun | Rare | Ranged. **1 shell, 1.5s reload, 20 damage.** Each shot throws 5 shards over 5 blocks; they stop dead at that range, hang there **0.87s**, then re-form as splinters that streak at your **cursor** for **50%** damage with no range limit. Two splinters that meet burst into **8 fragments** at **75%** of base — so where you point when they let go is where the room detonates. Drops from a **Shardling, 10% of the time**, falling from where it broke. One per run |
| Damage Booster | Rare | **+50% damage with your own class's weapons** while it is held — melee and the Nukerang for MELEE, the bow and Shardgun for RANGER, folds for the ORIGAMIST. It costs you **5 max HP**. The only thing the Undead Ceiling ever drops. One per run |
| Firey Twin Dagger | Rare | Melee. **2-block reach, 5 damage, one strike every 0.3s** — the fastest weapon in the game. It carries **Fiery Blade built in and never rolls for it**: every connect burns. Every **15th hit** throws you forward in a burning dash that carves everything it passes for **+5** and leaves you briefly untouchable. Drops from a **Lurker, 1% of the time**. One per run |
| Grappling Hook | Rare | `Q` fires a hook at the cursor. It bites terrain, reels you in on a rope you can swing from, and `Q` again lets go. Past its 11-block reach the hook **falls under gravity and keeps biting** on the way down, so a lobbed shot still catches. One per run |

Inventory is a 4x4 grid (16 slots); the top row doubles as the hotbar. Non-weapon
items stack to 10, weapons don't stack. Drag items between slots with the mouse.

## Settings

**Settings** is three tabs, and everything in it is written to `localStorage`
the moment you change it — options, sliders and the loaded shader pack all come
back on the next boot.

**Indicators** are readouts and nothing else; none of them change the fight.
FPS, weapon range ring, enemy HP numbers, boss HP numbers, damage numbers,
enemy HP bars, the wave counter, the aim reticle, the attack cooldown ring over
your head, and the boss enrage timer.

**Visuals** are sliders: bloom, scanlines, vignette, chromatic split,
saturation, film grain, halation, screen shake, flash strength, particle
density, trails, light shafts, animation speed and volume. The shader loader
lives here too, with a palette strip showing what the active pack has done to
the colours, and a DEFAULTS button that puts every slider back.

**Controls** is the key rebinder.

A shader pack sets the *baseline* the visual sliders ride on, so loading a pack
and then tuning bloom does what you would expect rather than fighting it.

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
