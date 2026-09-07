# The duel server

One file, no dependencies, `node server/pvp.js`. It is the only thing a NAS
needs to run: the game itself is served from GitHub and fetches this box for
its lobby list.

```sh
docker compose up -d      # from the root of the repo
docker compose logs -f
```

## The password

The watch page at `http://<nas>:8897/watch` is behind a password that lives in
a file of its own, never in the code and never in `compose.yaml`:

```
server/secret/watch-password.txt
```

It is read on every attempt, so changing it is the whole job - nothing to
restart. **The file in this repo has the default in it; change it before this
box is reachable from anywhere but your own network.**

## Opening hours

`QUIET_FROM` and `QUIET_TO` in `compose.yaml`, read in the server's own clock
(`TZ`, also in `compose.yaml`) - deliberately, so a player in another timezone
does not get their own set of opening hours. Written as `21` or as `21:30`.

Between them there is no lobby system. Not "no lobbies": no list to fetch and
nothing to create, refused at the socket rather than in the menu, so bypassing
the game's own buttons gets you nowhere. Any duel in progress is closed and
both players are told which hour it comes back.

The process stays up while it is shut, and that is on purpose: it still answers
`GET /`, which is how the game tells "shut until 04:00" apart from "there is no
server", and it is what lets the menu name the hour. Shut, it holds about 56 MB
and uses no measurable CPU.

## What it costs

Measured, on this machine, against the real protocol:

| | memory | CPU |
|---|---|---|
| idle, nobody connected | 55 MB | ~0 |
| quiet hours | 56 MB | 0.07s total |
| 10 lobbies, 20 players, all fighting | 70 MB | under 1% of one core |
| the same, plus the watch page at 30 fps | 72 MB | ~11% of one core |

Bandwidth is the number that matters more than either. Each player sends 30
snapshots a second at about 450 bytes, so a lobby is roughly 55 KB/s through
the server and ten lobbies about half a megabyte a second each way.

The screen previews are the expensive part: half-size WebP, about 3.5 KB a
frame. Twenty players at 30 fps is roughly 2 MB/s in and the same out to every
watcher. **Nobody sends a single frame while nobody is watching** - the server
asks for them when a watcher opens the page and tells everyone to stop when the
last one closes - so this is only paid while somebody is actually looking.
Watch from the same network, or drop the rate to 10 fps.

## Routes

| | |
|---|---|
| `GET /` | status, and the opening hours. What the game fetches. |
| `GET /watch` | the watch page: a password box, then every live lobby. |
| `ws://…/` | players |
| `ws://…/watch` | watchers, after the password |
