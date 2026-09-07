# Ascent to the Aether — duel server

**This branch is the server and nothing else.** No game, no assets, no build.
The game itself is served from GitHub Pages off the `main` branch and fetches
this box for its lobby list, so there is nothing here to keep in sync with it.

```
index.html                          the page you get when you open this box
compose.yaml                        deploys it
server/pvp.js                       the whole server, one file, no dependencies
server/secret/watch-password.txt    the password, and the only place it exists
```

## Looking at it

Open `http://<nas>:8897/` in a browser. Type the password once and you get,
side by side:

* **every live lobby**, each as two moving pictures - what both players are
  looking at right now, 10 to 30 frames a second, your pick;
* **everything people did**, in order: who arrived, who opened which lobby, who
  joined, who was kicked, which map a duel rolled, each round's scoreline, who
  won, and the door shutting or resting. The last eighty lines are kept, so the
  page shows what happened before you opened it and not only what is happening
  while you watch.

The wording of every line is written by the server. The game sends numbers, not
sentences, so nothing a player can type reaches this page.

## Running it

Clone this branch onto the NAS and start it:

```sh
git clone -b claude/pvp-nas-server --single-branch <this repo> aether-pvp
cd aether-pvp
docker compose up -d
docker compose logs -f
```

It listens on **8897**. Point the game at it once, in `js/pvpserver.js` on the
game branch — or a player can override it with `?pvp=host:8897` in the URL or
by typing the address on the PvP connect screen.

There is nothing to install. It speaks WebSocket over node's own `http` module,
so `compose.yaml` just runs stock `node:22-alpine` over this directory.

## The password

`server/secret/watch-password.txt`, read on every attempt — changing it is the
whole job, with nothing to restart. It is never in the code and never in
`compose.yaml`.

**The file in this branch has the default in it. Change it before this box is
reachable from anywhere but your own network.**

## Opening hours

`QUIET_FROM` and `QUIET_TO` in `compose.yaml`, read in the server's own clock
(`TZ`, also in `compose.yaml`) — deliberately, so a player in another timezone
does not get their own set of opening hours. Written as `21` or as `21:30`.

Between them there is no lobby system. Not "no lobbies": no list to fetch and
nothing to create, refused at the socket rather than in the menu, so going
around the game's own buttons gets you nowhere. Any duel in progress is closed
and both players are told which hour it comes back.

The process stays up while it is shut, on purpose: it still answers `GET /`,
which is how the game tells "shut until 04:00" apart from "there is no server",
and it is what lets the menu name the hour. Shut, it holds about 56 MB and uses
no measurable CPU.

## The memory line

Past `MEM_LIMIT_MB` (150) it shuts itself the same way and rests for
`REST_MINUTES` (30), then opens again on its own.

A reading over the line is not proof on its own — V8 holds memory it is not
using — so the container runs node with `--expose-gc` and the watchdog only
rests if the number survives a full collection. The rest drops every open
socket too: a rest that kept them would be a rest that never got its memory
back. The game notices, reconnects by itself, and is told the same thing again
by the door.

Measured through a full cycle:

```
06:34:11  OPEN  PVP SHUTS AT 21:00 SERVER TIME
06:34:15  SHUT  PVP IS RESTING UNTIL 06:35 SERVER TIME
06:35:15  OPEN  PVP SHUTS AT 21:00 SERVER TIME
```

## What it costs

Measured against the real protocol, not estimated:

| | memory | CPU |
|---|---|---|
| idle, nobody connected | 55 MB | ~0 |
| shut (quiet hours) | 56 MB | 0.07s total |
| 10 lobbies, 20 players, all fighting | 70 MB | under 1% of one core |
| the same, plus the watch page at 30 fps | 77 MB | ~13% of one core |

A full minute of that worst case never reaches the 150 MB line, so reaching it
means something is wrong rather than busy.

Bandwidth matters more than either. Each player sends 30 snapshots a second at
about 450 bytes, so one lobby is roughly 55 KB/s through the server and ten
lobbies about half a megabyte a second each way.

The screen previews are the expensive part: half-size WebP, about 3.5 KB a
frame. Twenty players at 30 fps is roughly 2 MB/s in and the same out to every
watcher. **Nobody sends a single frame while nobody is watching** — the server
asks for them when a watcher opens the page and tells everyone to stop when the
last one closes — so it is only paid while somebody is actually looking. Watch
from the same network, or drop the rate to 10 fps.

## Routes

| | |
|---|---|
| `GET /` | the page: a password box, then the lobbies and the log. |
| `GET /watch` | the same page, for anyone who bookmarked it there. |
| `GET /status` | status and opening hours. What the game fetches. |
| `ws://…/` | players |
| `ws://…/watch` | watchers, after the password |
