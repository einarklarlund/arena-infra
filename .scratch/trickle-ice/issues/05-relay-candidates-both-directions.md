# 05 — Candidates relay in both directions, and only between session members

**What to build:** Either peer can send a **candidate** the instant it gathers one and have it arrive at the other peer, named by session token. `trickleToHost` (0x09) carries a client's candidate to that session's host, stamped with the session's connection id so the host knows which connection it belongs to. `trickleToClient` (0x08) carries a host's candidate to that session's client. The candidate string itself is opaque — the server never inspects it — and an empty candidate string is the end-of-candidates marker, relayed like any other candidate.

**The membership check is the anti-spoof guarantee and is the reason this ticket exists.** For each direction the server looks up the session by token and rejects the message unless the sending socket's player id is that session's client (for 0x09) or its host (for 0x08). A rejected trickle is logged and dropped — never answered, since a reply would tell a prober whether a token is live. This is what replaces the guarantee that the old connection-id rewrite gave for free, and it is not optional.

**Loopback works without a special case.** When a host joins its own room, host and client are the same socket, so both membership checks pass for it and the message routes back to itself. The opcode is what the game side uses to pick the right local peer connection, so the server needs no branch for it — but it does need a test proving it.

**Blocked by:** 04 (0x09 stamps the connection id the session only carries after 04).

**Status:** ready-for-agent

- [ ] 0x09 from a session's client relays the candidate to that session's host, stamped with the session's connection id
- [ ] 0x08 from a session's host relays the candidate to that session's client
- [ ] A trickle whose sender is neither member of the named session is logged and dropped, with no response of any kind
- [ ] A trickle naming an unknown or already-swept token is logged and dropped
- [ ] An empty candidate string relays through both directions unchanged
- [ ] Host-joins-own-room loopback routes back to the sending socket, on both opcodes, with no special-casing in the server
- [ ] Candidate contents are never parsed or inspected
