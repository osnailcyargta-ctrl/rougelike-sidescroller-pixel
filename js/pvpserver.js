// Where the duel server lives.
//
// This is the one line to edit when the box it runs on changes address. It is
// its own file so that pointing the game somewhere else is a one-line diff with
// nothing else in it, and so the address is somewhere obvious rather than
// buried in the networking code.
//
// No port, on purpose. The game is served over https from GitHub Pages, and a
// page loaded over https may only talk to https and wss - so the duel server
// has to answer on 443 behind something that terminates TLS and forwards the
// WebSocket upgrade. That reverse proxy is what points aether.argya.me at the
// NAS on 8897; see the server branch's README for what it has to forward.
//
// Other shapes that work:
//   'nas.local:8897'                  a name your router hands out, over http
//   '192.168.1.20:8897'               the box's address on the LAN
//   'wss://duels.example.com'         spelled out, when the scheme is not obvious
//
// A player can still override it: ?pvp=host:port in the URL wins over
// everything, and an address typed on the connect screen is remembered in that
// browser and wins over this. Empty falls back to the page's own host on the
// port below, which is what you want while developing on one machine.
export const PVP_SERVER = 'aether.argya.me';

// The port compose.yaml publishes, for the fallback above and for the address
// the connect screen suggests.
export const PVP_PORT = 8897;
