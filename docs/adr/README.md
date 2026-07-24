# ADR index

Architectural Decision Records — the **why** behind a contested, load-bearing choice: what we decided, what we rejected, and why. Kept few and small (see [../agents/domain.md](../agents/domain.md)). Some decisions are shared with the game repo; those cross-link to `ArenaURP/docs/adr/`.

| # | Decision | Status | Date |
|---|---|---|---|
| [0001](0001-signaling-session-model.md) | Signal server owns a per-attempt signaling session routed by an opaque server-minted token (bidirectional trickle); dumb-relay and long-lived/Redis sessions rejected. Pairs with ArenaURP ADR 0011 | Accepted | 2026-07-24 |
