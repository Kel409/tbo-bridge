# Bridge Online - build 2 (seats, human play, hidden hands)

The authoritative game runs on a Node server and streams a per-player view to each browser over
Socket.IO. Empty seats are played by bots; a human can sit in any bot seat, bid and play, and leave
again. If a player disconnects, their seat reverts to a bot and play continues. You only ever see your
own hand and the dummy - other hands arrive face-down.

## Setup (once)

```
npm install
```

## Run

```
npm start
```

Open http://localhost:3000. To try multiplayer, open several tabs or windows (or other devices on your
network pointed at your machine's address). Ctrl+C stops the server.

## How to play

- Seats start EMPTY (no bots). Each seat shows small controls: Sit, + Bot / - Bot, or Leave.
- Whoever is at the table always sits at the BOTTOM of their own screen; the other seats rotate around.
- The game pauses on any empty seat ("Waiting for ..."). Fill all four (humans and/or bots) to play.
- On your turn to bid, the controls light up: pick a level and a strain, or Pass. You have 30s.
- On your turn to play, your legal cards glow; click one. If you are declarer, you also play the dummy.
- New Deal advances between hands. Reset (temporary) wipes the score and starts over, keeping seats.

Test it with two tabs (open each fresh, do not duplicate): sit South in one and North in the other,
add bots to East and West, and you are the North-South pair against two bots. Each tab sees only its
own hand, and each sees its own seat at the bottom.

## What this build has

- Seat claiming and releasing, with a per-tab identity.
- Human bidding and playing, validated on the server (illegal or out-of-turn intents are ignored).
- Per-player hand hiding: the server sends each client only the hands it may see.
- A turn clock: a connected player has 30s to act, after which the server auto-passes (bidding) or
  plays a legal card (play). The remaining time shows in the top bar.
- Reconnection grace: if you disconnect, your seat is held for 25s (bots cover your turns meanwhile);
  reconnect within that window and the seat is yours again. After it expires the seat becomes a bot.

## Not yet (later)

- Multiple rooms and a solo mode (v1 is one shared table).
- Connecting to the main website / accounts.

## Layout

- `server/index.js` - authoritative server: seats, intents, hiding, bot driver
- `public/` - client served statically; `js/` holds the shared engine plus `ui.js` and `main.js`

## Deploying (play with friends)

This is a stateful, long-running server (one in-memory game, Socket.IO fan-out to all players), so it
must run on a host that keeps a Node process alive. It will NOT work on Vercel/Netlify serverless.

Use Railway or Render (both connect to a GitHub repo and auto-deploy on push):

1. Push this folder to a GitHub repo. `node_modules/` is gitignored - do not commit it.
2. On Railway: New Project -> Deploy from GitHub repo -> pick the repo. It detects Node, runs
   `npm install`, then `npm start`. Open the generated URL.
   On Render: New -> Web Service -> connect the repo -> Build `npm install`, Start `npm start`.
3. Share the URL with friends. Each person opens it, sits in a seat, and adds bots to fill the rest.

Notes:
- State is in memory, so a redeploy or restart wipes the current game. Fine for casual play.
- Free tiers may sleep when idle and take a few seconds to wake on the next visit.
- Keep it to a single instance. Multiple instances would each hold a separate game; sharing one game
  across instances needs a Socket.IO adapter (e.g. Redis), which is a later concern.
