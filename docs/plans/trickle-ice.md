# Trickle ICE — ArenaInfra (signal server) implementation plan

**Decision:** ADR [0001](../adr/0001-signaling-session-model.md) (this repo) / `ArenaURP` ADR 0011. The paired game-transport work is in **ArenaURP** `docs/plans/trickle-ice.md`; the two land together — both peers ship in lockstep, so there is no backward-compat window to preserve.

**Scope:** all changes are in `signal-server/SignalServer.js`. `main-server/MainServer.js` and Redis are **untouched** — room discovery is unaffected; only per-connection signaling changes.

**Role:** the signal server is a **relay**. It routes offer/answer/candidate between two peers and stamps identity so neither can spoof the other. It never inspects SDP or candidate contents.

---

## Wire protocol (the contract — must match `SignalManager.cs`)

| Opcode | Name | Server's job |
|---|---|---|
| 0x01 | `createRoom` | unchanged |
| 0x02 | `attemptToJoinRoom` | **now also: mint a session, return its token to the client, include it in the host notify** |
| 0x04 | `receivedOfferFromHost` | route to client (SDP now candidate-free — no server change, it is opaque) |
| 0x05 | `receivedAnswerFromClient` | route to host |
| **0x08** | `trickleToClient` | host→client: look up session by token, verify sender is the session's host, relay candidate to the client stamping the session's `connectionId` |
| **0x09** | `trickleToHost` | client→host: look up session by token, verify sender is the session's client, relay candidate to the host stamping the session's `connectionId` |
| ~~0x06~~ | ~~`trickleICE`~~ | **deleted** — dead scaffold; do not reuse the byte |

### Settled cross-repo contract (ticket 01)

Both decisions ticket 01 held open are now closed. `ArenaURP/docs/plans/trickle-ice.md` states the identical contract; neither repo may code a (de)serializer against anything else.

**1. Session token wire form — length-prefixed UTF-8.** The token is opaque ASCII, **22 characters** drawn from a 62-char alphabet (`A–Z a–z 0–9`), which is ~131 bits against the room code's 5 chars — a room-code collision is a UX annoyance, a token collision silently crosses two peers' routing state. On the wire it is **always** framed exactly like the room code already is: one `uint8` length byte, then that many UTF-8 bytes. Never fixed-width, never null-terminated. Written `[tok]` below.

**2. Offer-to-session correlation — the host echoes the token on its offer.** The server does **not** correlate by the (host, client) pair it already knows. The host must already hold the token at offer time in order to address its `trickleToClient` (0x08) messages, so echoing it costs one length-prefixed field and buys the server a direct map lookup instead of a scan — with no ambiguity if the same client attempts the same room twice.

Byte layouts (integers little-endian, as today):

| Message | Direction | Layout |
|---|---|---|
| `joinRoomCallback` 0x03 — success | server→client | `0x03` `0x01` `[tok]` |
| `joinRoomCallback` 0x03 — failure | server→client | `0x03` `0x00` *(unchanged)* |
| `attemptToJoinRoom` 0x02 — host notify | server→host | `0x02` `int32 clientSignalId` `[tok]` |
| `receivedOfferFromHost` 0x04 | host→server | `0x04` `int32 targetClientSignalId` `int32 connectionId` `[tok]` `sdp…` |
| `receivedOfferFromHost` 0x04 | server→client | `0x04` `int32 hostSignalId` `sdp…` *(unchanged)* |
| `receivedAnswerFromClient` 0x05 | both | *(unchanged)* |
| `trickleToClient` 0x08 | host→server | `0x08` `[tok]` `candidate…` |
| `trickleToClient` 0x08 | server→client | `0x08` `int32 connectionId` `candidate…` |
| `trickleToHost` 0x09 | client→server | `0x09` `[tok]` `candidate…` |
| `trickleToHost` 0x09 | server→host | `0x09` `int32 connectionId` `candidate…` |

A peer→server trickle carries **no target player id** — the token alone selects the route, which is precisely what makes the membership check the only way in. `candidate…` is the remainder of the buffer read as UTF-8, so **zero remaining bytes is the end-of-candidates marker**; it is relayed like any other candidate and never inspected. The server stamps `connectionId` on **both** outbound directions so the two peers share one parser: the host uses it to select the connection, the client ignores it (it has exactly one connection to the host).

This fills in detail ADR 0001 deliberately left open (it fixes the token's encoding and the offer's correlation mechanism) without contradicting or extending its decision, so ADR 0001 is unchanged.

---

## Work items

### S1 — Session table
- Add a `sessions` map (token → `{ hostSignalId, clientSignalId, connectionId, createdAt }`), alongside the existing `rooms` / `playerID` maps. (`signalConnectionID` is retired by S3, so the session table replaces it rather than sitting beside it.)
- A token generator (reuse the `generateUniqueKey` style, but from a larger space than the 5-char room code — collisions here are a routing bug, not a UX annoyance).

### S2 — Mint on join-attempt (`attemptToJoinRoom`, `SignalServer.js:123`)
- When the room exists: mint a session with `hostSignalId = rooms[roomId].playerID`, `clientSignalId = ws.playerID`, `connectionId` unset (the host assigns it at offer time).
- Include the token in **both** replies already sent: the client's `joinRoomCallback` (0x03) success response, and the host notify (currently `attemptToJoinRoom` 0x02 with the client's signal id). No new round trip.

### S3 — Bind connectionId at offer time (`receivedOfferFromHost`, `SignalServer.js:157`)
- The host's offer already carries its `connectionId`, and now also echoes the session token (settled in ticket 01). Look the session up by that token and record `connectionId` onto it. An offer naming no live session is logged and dropped, not relayed.
- Retire the `signalConnectionID` rewrite: with the session holding `connectionId`, the answer (0x05) and both trickle directions stamp it from the session instead of the old per-player map. Delete `signalConnectionID` once nothing reads it.

### S4 — Route trickle both ways (new 0x08 / 0x09; delete 0x06 at `:193`)
- `trickleToHost` (0x09, from client): `s = sessions[token]`; **reject if `ws.playerID !== s.clientSignalId`**; relay to `playerID[s.hostSignalId]` stamping `s.connectionId`.
- `trickleToClient` (0x08, from host): `s = sessions[token]`; **reject if `ws.playerID !== s.hostSignalId`**; relay to `playerID[s.clientSignalId]`.
- The membership check by socket id is the anti-spoof guarantee — do not skip it. A rejected trickle is logged and dropped, not answered.
- **Loopback:** when host and client are the same socket (host joins its own room), both checks pass for that socket and the message routes back to it; the opcode (0x08 vs 0x09) is what the game side uses to pick the right local peer connection, so the server needs no special case.

### S5 — Lifecycle
- Sweep the session when its peer connection is established or the attempt fails. Three triggers: `close` on either member socket, both directions having signalled end-of-candidates, and a TTL backstop from mint time (`SESSION_TTL_MS`, default 5 minutes).
- **Corrected during build (ticket 06):** this section originally also said to sweep when the answer completes the attempt. That is wrong — candidates keep flowing after the answer, which is the point of trickle, so sweeping there would drop the session mid-gather. Ticket 06 overrides it and the answer is not a sweep trigger.
- **Deferred (with reconnect, not now):** the grace window that holds a session past socket close, and a reclaim opcode. Build only the token + table now; ADR 0001's invariant is that reclaim can later re-open a route to an existing `connectionId`.
- Guard against unbounded growth even pre-grace-window: a client spamming `attemptToJoinRoom` mints sessions — cap or TTL-sweep abandoned ones so the map cannot leak.

---

## Verification

- **Node routing test** (new, in `signal-server/`): drive fake WebSocket clients (a `ws` mock or the `ws` client lib against a test instance) — assert that (a) join-attempt returns a token to the client and notifies the host with it, (b) 0x08/0x09 relay to the correct opposite socket with `connectionId` stamped, (c) a trickle from a non-member socket is **rejected**, (d) the loopback host-joins-own-room case routes. No WebRTC / no real ICE involved — this is pure relay logic and is the layer with the trickiest new code.
- **Built as** `signal-server/test/` (`npm test`, Node's own test runner): `harness.js` spawns a real server on an ephemeral port with `REDIS_URL` pointed at a dead port, drives it with `ws` clients, and reaps it; `routing.test.js` / `session.test.js` / `trickle.test.js` / `lifecycle.test.js` hold the assertions. Requires Node 20 — `uWebSockets.js` v20.40.0 ships no binary for newer runtimes, and the releases that do have dropped the Node 20 the deploy image uses.
- **Integration — now proven (2026-07-31).** `ArenaURP`'s `WebRtcJoinTests` ran in-editor against a real server this file's code launched and reaped, and both peers reached data-channels-open in **0.05s**; the trickle relay, the membership checks and the session sweep were all exercised by a real handshake rather than only by the Node harness. The two-browser gate is still outstanding on the game side, so **no browser has ever spoken to this server's 0x08/0x09 routes**.
- **Integration:** covered from the game side — `ArenaURP`'s standalone PlayMode ICE test launches a real signal-server instance, and the manual `deploy_local.sh` two-browser join exercises the full path. Ensure the server starts cleanly for a test harness to spawn/reap (it already `listen`s on 9001; make the port overridable via env if the test needs isolation).

## Deploy note
No `docker-compose.yml` change required for trickle itself (no new service, no TURN). The listen port is now read from `SIGNAL_PORT`, defaulting to 9001, so the compose file's fixed `9001:9001` mapping is unaffected; the test harness sets it to an ephemeral port for isolation.
