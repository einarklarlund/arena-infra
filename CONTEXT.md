# ArenaInfra

The backend for **Arena** (the Unity game in `ArenaURP`): a **signal server** that brokers WebRTC connections between game peers, a **main server** that lists joinable games, and a Redis bridge between them. This repo owns no gameplay — only the plumbing that gets two peers connected and lets a client find a game.

## Language

Terms specific to this repo. Shared with the game's glossary (`ArenaURP/CONTEXT.md`, *Networking* section) — keep the two in step; a term must mean the same thing on both sides of the WebSocket.

**Peer**:
A game process that connects to the signal server — a **host** (runs the game's server) or a joining **client**. Identified per-WebSocket by a server-assigned **player id** (`ws.playerID`), unforgeable because the server mints it on `open`.
_Avoid_: user, player (a player is a game concept; here it is a peer / a socket)

**Room**:
A joinable game, keyed by a short human code. The signal server holds `roomCode → host socket` in memory and **mirrors** it to Redis (`room:<code>`, TTL, heartbeated) so the main server's `GET /Servers` can list it. A room is *discovery* — the host owns exactly one; joining begins a handshake but is not itself a connection.
_Avoid_: lobby, match, server

**Signaling session**:
The server's authoritative record of **one** peer-connection attempt — the (host, client, connectionId) triple it routes offer/answer/**candidate** between, in both directions. It is *routing state*, not identity: scoped to a single attempt and swept when the connection is established or fails. It does **not** identify a player and must not outlive the attempt.
_Avoid_: connection (that is the WebRTC peer connection the game owns), room, player

**Session token**:
The opaque key the server mints to name a **signaling session** on the wire, handed to both peers inside messages already being sent. The token *routes* a message to the right session; it does not *authenticate* it — the server authenticates by socket (**player id**), so a peer can never signal into a session it does not belong to.
_Avoid_: session id, connection id, room code

**Connection id**:
A host-local integer the game's host assigns per joining **client** (the game uses it to address that client). The signal server carries it inside a **signaling session** and stamps it on relayed messages so neither peer can spoof which connection a **candidate** belongs to.
_Avoid_: player id (that is per-socket), session token

**Candidate / Trickle / End-of-candidates**:
A **candidate** is one possible network path for a WebRTC connection. **Trickle** = the peer sends each candidate the instant it is gathered instead of bundling them into the offer/answer; the server relays them verbatim by **session token**. **End-of-candidates** is signalled as a trickle message with an empty candidate string.
_Avoid_: ICE (protocol-level; here we only relay opaque candidate strings), address, route

## Where the rest lives

- **Why** a contested choice went the way it did is in [docs/adr/](docs/adr/), indexed by [docs/adr/README.md](docs/adr/README.md).
- **What's planned** is in [docs/plans/](docs/plans/).
- The game side of this vocabulary and the cross-repo decision records are in `ArenaURP` (`CONTEXT.md`, `docs/adr/0010`–`0012`).
