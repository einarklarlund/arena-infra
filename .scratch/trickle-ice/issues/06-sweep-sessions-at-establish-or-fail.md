# 06 — Sessions are swept at establish-or-fail and cannot leak

**What to build:** A signaling session is routing state for one attempt, and must not outlive it. After a run of joins, connections, disconnections, and abandoned attempts, the session table is empty — the server holds no record of attempts that have concluded.

Three sweep triggers:

- **Either member socket closes.** The attempt cannot continue, so the session goes.
- **Both directions have signalled end-of-candidates.** The attempt has concluded gathering and the route is no longer needed.
- **A TTL backstop from mint time.** A client that spams join attempts mints a session per attempt and may never send anything again; abandoned sessions must expire (or be capped) so the map cannot grow without bound.

**Do not sweep when the answer completes.** The plan's original wording said to, but candidates keep flowing after the answer — that is the entire point of trickle — so sweeping there would drop the session mid-gather and break the feature this work exists to enable.

The token ID space is deliberately built wider than this ticket needs. The grace window that holds a session past socket close, and the reclaim opcode that re-opens a route to an existing connection id, are **deferred to the reconnect work and are not in scope here**. ADR 0001's invariant is only that this design does not foreclose them.

**Blocked by:** 05 (the end-of-candidates trigger depends on the trickle path existing).

**Status:** done

- [x] A session is deleted when either its host or its client socket closes
- [x] A session is deleted once end-of-candidates has been seen in both directions
- [x] A session is never deleted merely because the answer was relayed
- [x] Abandoned sessions are TTL-swept or capped, so repeated join attempts cannot grow the table without bound
- [x] Test drives a full attempt to completion and asserts the session table is empty afterwards
- [x] Test drives an abandoned attempt and asserts it does not persist
- [x] No grace window and no reclaim opcode are introduced

## Comments

The TTL backstop is `SESSION_TTL_MS` (default 5 minutes), swept on an interval of
a quarter of it. It is overridable by environment - the same way `SIGNAL_PORT` and
`REDIS_URL` are - because otherwise the abandoned-attempt test would have to wait
out the default.

TTL runs from mint time as the ticket says, so a gather lasting longer than the TTL
would lose its route. Five minutes is far beyond any real gather, but it is the one
place this design trades a hard cap for a soft one.

`docs/plans/trickle-ice.md` S5 said to sweep when the answer completes; this ticket
overrides that, and the plan has been corrected to match rather than left to
contradict the tickets.
