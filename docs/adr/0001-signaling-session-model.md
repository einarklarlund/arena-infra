# ADR 0001 — Signal server owns a per-attempt signaling session, routed by opaque token

- **Status:** Accepted (2026-07-24)
- **Date:** 2026-07-24

To let the game trickle ICE candidates in **both** directions, the signal server can no longer rely on its old one-way trick of rewriting the connection id from a map keyed on the host's offer (`SignalServer.js:166`) — yet that rewrite is also what stops a client injecting candidates into another player's connection. So the server now owns a **signaling session**: an authoritative (host, client, connectionId) record minted at `attemptToJoinRoom` and named on the wire by an **opaque, server-minted token** handed to both peers in messages already in flight, with sender identity stamped by socket (`ws.playerID`, unforgeable). The session is scoped to one attempt and swept at establish-or-fail, but its **token ID space is built now** so a future host-minted reconnect can re-open a route to an existing `connectionId`; new opcodes `trickleToClient` (0x08) / `trickleToHost` (0x09) carry direction, and the dead `trickleICE` (0x06) path is deleted. We rejected a pure dumb relay (removes the anti-spoof guarantee, forcing the host to validate every inbound id) and a long-lived or Redis-persisted session (it identifies *sockets*, dies on a WebGL page reload, and would make this relay co-authoritative over player identity — which belongs to the game's server, not here).

This is the signal-server side of a cross-repo contract; the game-transport side and fuller rationale are in `ArenaURP/docs/adr/0011`.
