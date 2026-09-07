// Where the duel server lives.
//
// This is the one line to edit when the box it runs on changes address. It is
// its own file so that pointing the game at a different NAS is a one-line diff
// with nothing else in it - and so the address is somewhere obvious rather than
// buried in the networking code.
//
// Leave it empty and the game falls back to the page's own host on the default
// port, which is what you want while developing on one machine.
//
// Examples:
//   'nas.local:8897'                  a name your router hands out
//   '192.168.1.20:8897'               the box's address on the LAN
//   'wss://duels.example.com'         behind a reverse proxy with a certificate
//
// A player can still override it: ?pvp=host:port in the URL wins over
// everything, and an address typed on the connect screen is remembered in that
// browser and wins over this.
export const PVP_SERVER = '';

// The port compose.yaml publishes.
export const PVP_PORT = 8897;
