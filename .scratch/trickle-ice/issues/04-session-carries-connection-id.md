# 04 — The session carries the connection id, and `signalConnectionID` is gone

**What to build:** The host's offer binds its **connection id** onto the signaling session, and the client's answer is stamped with that id read from the session rather than from the old per-player map. From the outside nothing changes — the same offer reaches the same client, the same answer reaches the host carrying the same connection id — but the id now lives on the session that owns the attempt, which is what lets both trickle directions stamp it in ticket 05.

The old `signalConnectionID` map is then deleted outright, along with the cleanup that touches it on room creation and on socket close. Its one remaining reader was the dead 0x06 path removed in ticket 02.

How the offer names its session was decided in ticket 01 — either the host echoes the token, or the server correlates by the host/client pair. Implement whichever was agreed; do not invent a third.

Retiring that map is the point of the ticket, not a side effect. Rewriting the connection id from a map keyed on the host's offer is what currently stops a client injecting into another player's connection; moving it onto the session is what preserves that guarantee once candidates start flowing in both directions.

**Blocked by:** 03.

**Status:** ready-for-agent

- [ ] The host's offer records its connection id onto the correct session, by the mechanism agreed in ticket 01
- [ ] The client's answer is stamped with the connection id read from the session
- [ ] `signalConnectionID` is deleted, along with every read, write, and cleanup of it
- [ ] The create → join → offer → answer test from ticket 02 still passes unchanged, proving behaviour is identical
- [ ] An offer that names no live session is logged and dropped, not relayed
