# 01 — Settle the session-token wire contract with ArenaURP

**What to build:** Two open cross-repo decisions get pinned down in writing, so that neither repo codes a (de)serializer against a guess. Both peers ship in lockstep and there is no backward-compat window, so a mismatch here is a hard failure at handshake time rather than a degraded path.

The decisions:

1. **Session token wire form** — length-prefixed UTF-8 (as the room code already is) versus a fixed width. Applies everywhere the token crosses the wire: the client's `joinRoomCallback` success response, the host notify, and both trickle opcodes.
2. **Offer-to-session correlation** — whether the host echoes the session token on its offer, or the server correlates the offer to a session by the (host, client) pair it already knows. Whichever is chosen, the game plan must say the same thing.

The outcome is recorded in this repo's trickle-ice plan and, if it changes the shape of the decision rather than just filling in a blank, in ADR 0001. The matching statement lands in `ArenaURP`'s plan.

**Blocked by:** None — can start immediately.

**Status:** done

**Resolution**

1. **Token wire form: length-prefixed UTF-8**, framed exactly like the room code — one `uint8` length byte then that many UTF-8 bytes. The token is 22 chars from a 62-char alphabet. Chosen over fixed width because it is the framing both codebases already read and write for the room code, so neither side grows a second string convention.
2. **Offer-to-session correlation: the host echoes the token on its offer.** Chosen over server-side (host, client) correlation because the host must already hold the token at offer time to address its 0x08 trickles — so echoing costs one field and buys a direct lookup with no ambiguity when the same client attempts the same room twice.

Full byte layouts for every changed message are in `docs/plans/trickle-ice.md` ("Settled cross-repo contract"), reproduced identically in `ArenaURP/docs/plans/trickle-ice.md`.

- [x] Token wire form decided and written into `docs/plans/trickle-ice.md`, replacing the "one shared decision" note
- [x] Offer-to-session correlation decided and written into the same plan, replacing the "pick one and mirror it" note
- [x] `ArenaURP`'s trickle-ice plan states the identical contract for both
- [x] Neither decision contradicts or extends ADR 0001 — both merely fill in detail it left open — so ADR 0001 is unchanged
