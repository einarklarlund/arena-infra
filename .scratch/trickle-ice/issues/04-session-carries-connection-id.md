# 04 — The session carries the connection id, and `signalConnectionID` is gone

**What to build:** The host's offer binds its **connection id** onto the signaling session, and the client's answer is stamped with that id read from the session rather than from the old per-player map. From the outside nothing changes — the same offer reaches the same client, the same answer reaches the host carrying the same connection id — but the id now lives on the session that owns the attempt, which is what lets both trickle directions stamp it in ticket 05.

The old `signalConnectionID` map is then deleted outright, along with the cleanup that touches it on room creation and on socket close. Its one remaining reader was the dead 0x06 path removed in ticket 02.

How the offer names its session was decided in ticket 01 — either the host echoes the token, or the server correlates by the host/client pair. Implement whichever was agreed; do not invent a third.

Retiring that map is the point of the ticket, not a side effect. Rewriting the connection id from a map keyed on the host's offer is what currently stops a client injecting into another player's connection; moving it onto the session is what preserves that guarantee once candidates start flowing in both directions.

**Blocked by:** 03.

**Status:** done

- [x] The host's offer records its connection id onto the correct session, by the mechanism agreed in ticket 01
- [x] The client's answer is stamped with the connection id read from the session
- [x] `signalConnectionID` is deleted, along with every read, write, and cleanup of it
- [x] The create → join → offer → answer test from ticket 02 still passes unchanged, proving behaviour is identical
- [x] An offer that names no live session is logged and dropped, not relayed

## Comments

The ticket-02 offer/answer test kept every assertion it had, but its `buildOffer`
call had to grow the echoed token - that is the wire change ticket 01 settled, so
"unchanged" is read as unchanged behaviour, not an unchanged call site.

Two drop rules beyond the ticket's "no live session" one, both the same anti-spoof
principle the ticket names: an offer is dropped if the sending socket is not the
session's host, and if its `targetClientSignalId` disagrees with the session's
client. The session is authoritative for routing; the offer's target field is now
a redundant check rather than the route.

The answer (0x05) is unchanged on the wire and so carries no token, so its session
is found by the (client, host) signal-id pair, restricted to sessions a host has
already offered on. Newest wins - the same last-write-wins the retired
`signalConnectionID` map had when a host re-offered to the same client.
