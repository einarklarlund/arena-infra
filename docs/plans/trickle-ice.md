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

Session token wire form (length-prefixed UTF-8 vs fixed width) is **one shared decision** with the `SignalManager.cs` side — agree it before either repo codes the (de)serializer. An empty candidate string is the end-of-candidates marker and is relayed like any other candidate.

---

## Work items

### S1 — Session table
- Add a `sessions` map (token → `{ hostSignalId, clientSignalId, connectionId, createdAt }`), alongside the existing `rooms` / `playerID` / `signalConnectionID` maps.
- A token generator (reuse the `generateUniqueKey` style, but from a larger space than the 5-char room code — collisions here are a routing bug, not a UX annoyance).

### S2 — Mint on join-attempt (`attemptToJoinRoom`, `SignalServer.js:123`)
- When the room exists: mint a session with `hostSignalId = rooms[roomId].playerID`, `clientSignalId = ws.playerID`, `connectionId` unset (the host assigns it at offer time).
- Include the token in **both** replies already sent: the client's `joinRoomCallback` (0x03) success response, and the host notify (currently `attemptToJoinRoom` 0x02 with the client's signal id). No new round trip.

### S3 — Bind connectionId at offer time (`receivedOfferFromHost`, `SignalServer.js:157`)
- The host's offer already carries its `connectionId`. Record it onto the session (the host must also echo the session token on the offer, or the server correlates by (hostSignalId, clientSignalId) — pick one and mirror it in the game plan).
- Retire the `signalConnectionID` rewrite: with the session holding `connectionId`, the answer (0x05) and both trickle directions stamp it from the session instead of the old per-player map. Delete `signalConnectionID` once nothing reads it.

### S4 — Route trickle both ways (new 0x08 / 0x09; delete 0x06 at `:193`)
- `trickleToHost` (0x09, from client): `s = sessions[token]`; **reject if `ws.playerID !== s.clientSignalId`**; relay to `playerID[s.hostSignalId]` stamping `s.connectionId`.
- `trickleToClient` (0x08, from host): `s = sessions[token]`; **reject if `ws.playerID !== s.hostSignalId`**; relay to `playerID[s.clientSignalId]`.
- The membership check by socket id is the anti-spoof guarantee — do not skip it. A rejected trickle is logged and dropped, not answered.
- **Loopback:** when host and client are the same socket (host joins its own room), both checks pass for that socket and the message routes back to it; the opcode (0x08 vs 0x09) is what the game side uses to pick the right local peer connection, so the server needs no special case.

### S5 — Lifecycle
- Sweep the session when its peer connection is established or the attempt fails. Minimum viable now: delete the session on `close` for either member socket (`:215`), and when the answer completes the attempt.
- **Deferred (with reconnect, not now):** the grace window that holds a session past socket close, and a reclaim opcode. Build only the token + table now; ADR 0001's invariant is that reclaim can later re-open a route to an existing `connectionId`.
- Guard against unbounded growth even pre-grace-window: a client spamming `attemptToJoinRoom` mints sessions — cap or TTL-sweep abandoned ones so the map cannot leak.

---

## Verification

- **Node routing test** (new, in `signal-server/`): drive fake WebSocket clients (a `ws` mock or the `ws` client lib against a test instance) — assert that (a) join-attempt returns a token to the client and notifies the host with it, (b) 0x08/0x09 relay to the correct opposite socket with `connectionId` stamped, (c) a trickle from a non-member socket is **rejected**, (d) the loopback host-joins-own-room case routes. No WebRTC / no real ICE involved — this is pure relay logic and is the layer with the trickiest new code.
- **Integration:** covered from the game side — `ArenaURP`'s standalone PlayMode ICE test launches a real signal-server instance, and the manual `deploy_local.sh` two-browser join exercises the full path. Ensure the server starts cleanly for a test harness to spawn/reap (it already `listen`s on 9001; make the port overridable via env if the test needs isolation).

## Deploy note
No `docker-compose.yml` change required for trickle itself (no new service, no TURN). If the Node test needs a configurable port, thread it through env consistently with `REDIS_URL` / `ENABLE_CORS`.
