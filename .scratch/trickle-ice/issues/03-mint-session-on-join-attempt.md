# 03 — A signaling session is minted on join-attempt and reaches both peers

**What to build:** When a client attempts to join a room that exists, the server mints a **signaling session** — its authoritative record of that one peer-connection attempt, holding the host, the client, and (later) the connection id — and names it on the wire with an opaque **session token**. Both peers learn the token from messages the server already sends: the client gets it in its `joinRoomCallback` success response, the host gets it in the join notify alongside the client's player id. No new round trip, and the failure path (room does not exist) is unchanged.

Nothing consumes the token yet; this ticket is done when both peers demonstrably hold the same one.

The token names a session for *routing*; it does not authenticate. Authentication stays with the socket's player id, which the server mints on open and a peer cannot forge. Token generation follows the existing room-code generator in style but draws from a much larger space — a room-code collision is a UX annoyance a user retries past, whereas a token collision silently crosses two peers' routing state.

**Blocked by:** 01 (the token's wire form is a cross-repo contract), 02 (the harness this is verified in).

**Status:** done

- [x] Joining an existing room mints a session recording the host's and the client's signal ids, with the connection id not yet set
- [x] The token is delivered to the client in the `joinRoomCallback` success response, in the wire form agreed in ticket 01
- [x] The token is delivered to the host in the join notify, alongside the client's signal id as today
- [x] No additional round trip is introduced
- [x] Joining a room that does not exist behaves exactly as before, and mints nothing
- [x] Test asserts both peers receive the same token, and that two concurrent join attempts get distinct tokens

## Comments

The session table has no wire representation - exposing one would hand a prober a
surface for the sake of a test - so the server logs a one-line record whenever the
table changes (`Session <token> minted for host <h>, client <c>. N live.`) and the
harness reads the live count from that log.
