# 02 — Signal-server test harness, with the dead trickle path removed

**What to build:** A developer can run `npm test` in `signal-server/` and watch a real signal-server instance get spawned, driven through the existing handshake by fake WebSocket peers, and reaped. The test asserts today's behaviour end to end: a host creates a room and gets a room code, a client joins it and gets a success callback while the host is notified with the client's player id, the host's offer reaches the client, and the client's answer reaches the host stamped with the connection id.

This is prefactoring — "make the change easy, then make the easy change". Every later ticket in this feature is verified by extending this harness, and pinning the current answer-stamping behaviour now is what makes it safe to move that behaviour onto the signaling session later.

Two things the harness needs from the server:

- **An overridable listen port.** The server hardcodes 9001; tests need isolation from a developer's running instance and from each other. Thread it through the environment consistently with `REDIS_URL` and `ENABLE_CORS`, defaulting to 9001 so nothing else changes.
- **To not require a live Redis.** Room creation mirrors to Redis and heartbeats every 30s. The harness must start cleanly and the routing assertions must pass whether or not Redis is reachable — Redis is discovery state, and none of this feature's logic reads it.

Also in this ticket: delete the `trickleICE` (0x06) case. It is dead scaffold that was never implemented, and it is one of the readers of the `signalConnectionID` map that ticket 04 retires. The byte is not reused — the new opcodes are 0x08 and 0x09.

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

- [ ] `npm test` in `signal-server/` runs the routing test and exits non-zero on failure
- [ ] The harness spawns a server instance on a port it chooses, and reaps it on completion and on failure
- [ ] Test covers create room → join room → offer → answer, asserting the messages each peer receives
- [ ] Tests pass with no Redis running
- [ ] Listen port is env-overridable, defaulting to 9001
- [ ] The 0x06 `trickleICE` case is deleted and the byte is left unused
