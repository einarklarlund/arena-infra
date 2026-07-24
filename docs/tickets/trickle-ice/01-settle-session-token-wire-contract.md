# 01 — Settle the session-token wire contract with ArenaURP

**What to build:** Two open cross-repo decisions get pinned down in writing, so that neither repo codes a (de)serializer against a guess. Both peers ship in lockstep and there is no backward-compat window, so a mismatch here is a hard failure at handshake time rather than a degraded path.

The decisions:

1. **Session token wire form** — length-prefixed UTF-8 (as the room code already is) versus a fixed width. Applies everywhere the token crosses the wire: the client's `joinRoomCallback` success response, the host notify, and both trickle opcodes.
2. **Offer-to-session correlation** — whether the host echoes the session token on its offer, or the server correlates the offer to a session by the (host, client) pair it already knows. Whichever is chosen, the game plan must say the same thing.

The outcome is recorded in this repo's trickle-ice plan and, if it changes the shape of the decision rather than just filling in a blank, in ADR 0001. The matching statement lands in `ArenaURP`'s plan.

**Blocked by:** None — can start immediately.

**Status:** ready-for-human

- [ ] Token wire form decided and written into `docs/plans/trickle-ice.md`, replacing the "one shared decision" note
- [ ] Offer-to-session correlation decided and written into the same plan, replacing the "pick one and mirror it" note
- [ ] `ArenaURP`'s trickle-ice plan states the identical contract for both
- [ ] Any decision that contradicts or extends ADR 0001 is reflected there; a decision that merely fills in a detail is not
