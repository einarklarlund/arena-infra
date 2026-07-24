'use strict';

// Test harness for the signal server.
//
// Spawns a real SignalServer.js on a port it picks, drives it with fake
// WebSocket peers, and reaps it. No Redis is required: the server mirrors
// rooms to Redis for discovery only, and nothing in the signaling path
// reads it back, so the harness points REDIS_URL at a dead port on purpose.

const { spawn } = require('node:child_process');
const net = require('node:net');
const path = require('node:path');
const assert = require('node:assert/strict');
const WebSocket = require('ws');

const SERVER_ENTRY = path.join(__dirname, '..', 'SignalServer.js');

// The wire protocol, as the game speaks it (see docs/plans/trickle-ice.md).
// 0x06 is retired scaffold and must stay unused.
const OP = {
    createRoom: 0x01,
    attemptToJoinRoom: 0x02,
    joinRoomCallback: 0x03,
    receivedOfferFromHost: 0x04,
    receivedAnswerFromClient: 0x05,
    ping: 0x07,
    trickleToClient: 0x08,
    trickleToHost: 0x09,
};

const DEFAULT_TIMEOUT_MS = 3000;
// How long to wait before concluding the server sent nothing back. Kept short
// because the assertion is about silence, and every test using it pays it.
const SILENCE_WINDOW_MS = 300;

function reserveEphemeralPort() {
    return new Promise((resolve, reject) => {
        const probe = net.createServer();
        probe.once('error', reject);
        probe.listen(0, '127.0.0.1', () => {
            const { port } = probe.address();
            probe.close(() => resolve(port));
        });
    });
}

/**
 * Spawn an isolated signal server. Resolves once it reports it is listening.
 * Prefer `withServer`, which reaps the instance on success and failure alike.
 */
async function startSignalServer({ env = {} } = {}) {
    const port = await reserveEphemeralPort();

    const child = spawn(process.execPath, [SERVER_ENTRY], {
        env: {
            ...process.env,
            SIGNAL_PORT: String(port),
            // Deliberately unreachable: proves the routing path needs no Redis.
            REDIS_URL: 'redis://127.0.0.1:1',
            // Keeps the server log plain text so tests can match on it.
            // (npm sets FORCE_COLOR, which otherwise wins over NO_COLOR.)
            NO_COLOR: '1',
            FORCE_COLOR: '0',
            ...env,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
    });

    const output = [];
    const record = (chunk) => output.push(chunk.toString());
    child.stdout.on('data', record);
    child.stderr.on('data', record);

    const peers = [];

    const handle = {
        port,
        child,
        log: () => output.join(''),
        /** Open a fake peer against this server. Closed automatically on stop. */
        async connectPeer(name) {
            const peer = await Peer.connect(port, name);
            peers.push(peer);
            return peer;
        },
        async stop() {
            for (const peer of peers) peer.close();
            peers.length = 0;
            if (child.exitCode !== null || child.signalCode !== null) return;
            await new Promise((resolve) => {
                child.once('exit', resolve);
                child.kill('SIGKILL');
            });
        },
    };

    await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            reject(new Error(`Signal server did not start within ${DEFAULT_TIMEOUT_MS}ms:\n${handle.log()}`));
        }, DEFAULT_TIMEOUT_MS);

        const onData = () => {
            if (handle.log().includes(`Server listening on port ${port}`)) {
                clearTimeout(timer);
                child.stdout.off('data', onData);
                resolve();
            }
        };
        child.stdout.on('data', onData);
        child.once('exit', (code) => {
            clearTimeout(timer);
            reject(new Error(`Signal server exited early (code ${code}):\n${handle.log()}`));
        });
    }).catch(async (err) => {
        await handle.stop();
        throw err;
    });

    return handle;
}

/** Run `body` against a freshly spawned server, reaping it either way. */
async function withServer(body, options) {
    const server = await startSignalServer(options);
    try {
        return await body(server);
    } finally {
        await server.stop();
    }
}

/**
 * A fake peer: a WebSocket that queues every binary frame the server sends so
 * a test can await them one at a time. Server pings (0x07) are dropped - they
 * are keepalive noise, not protocol traffic.
 */
class Peer {
    constructor(ws, name) {
        this.ws = ws;
        this.name = name || 'peer';
        this.inbox = [];
        this.waiters = [];
        this.closed = false;

        ws.on('message', (data) => {
            const message = Buffer.from(data);
            if (message.length > 0 && message[0] === OP.ping) return;
            const waiter = this.waiters.shift();
            if (waiter) waiter.resolve(message);
            else this.inbox.push(message);
        });
        ws.on('close', () => {
            this.closed = true;
            for (const waiter of this.waiters.splice(0)) {
                waiter.reject(new Error(`${this.name}: socket closed while awaiting a message`));
            }
        });
    }

    static connect(port, name) {
        return new Promise((resolve, reject) => {
            const ws = new WebSocket(`ws://127.0.0.1:${port}/Signal`);
            ws.binaryType = 'nodebuffer';
            ws.once('open', () => resolve(new Peer(ws, name)));
            ws.once('error', reject);
        });
    }

    send(buffer) {
        this.ws.send(buffer, { binary: true });
    }

    /** The next protocol message this peer receives. */
    next({ timeout = DEFAULT_TIMEOUT_MS } = {}) {
        if (this.inbox.length > 0) return Promise.resolve(this.inbox.shift());
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                const index = this.waiters.findIndex((w) => w.timer === timer);
                if (index !== -1) this.waiters.splice(index, 1);
                reject(new Error(`${this.name}: timed out after ${timeout}ms waiting for a message`));
            }, timeout);
            this.waiters.push({
                timer,
                resolve: (message) => { clearTimeout(timer); resolve(message); },
                reject: (err) => { clearTimeout(timer); reject(err); },
            });
        });
    }

    /** Assert the server sends this peer nothing at all for a short window. */
    async expectSilence({ within = SILENCE_WINDOW_MS } = {}) {
        await new Promise((resolve) => setTimeout(resolve, within));
        if (this.inbox.length > 0) {
            throw new Error(`${this.name}: expected no message, got opcode 0x${this.inbox[0][0].toString(16)}`);
        }
    }

    /** Close and give the server a moment to run its `close` handler. */
    async closeAndSettle() {
        this.close();
        await new Promise((resolve) => setTimeout(resolve, 150));
    }

    close() {
        if (!this.closed) this.ws.close();
    }
}

// --- wire helpers -----------------------------------------------------------
// Strings the server frames itself (the room code today) are always one uint8
// length byte followed by that many UTF-8 bytes.

function lengthPrefixed(value) {
    const bytes = Buffer.from(value, 'utf-8');
    return Buffer.concat([Buffer.from([bytes.length]), bytes]);
}

function readLengthPrefixed(buffer, offset) {
    const length = buffer[offset];
    return {
        value: buffer.toString('utf-8', offset + 1, offset + 1 + length),
        offset: offset + 1 + length,
    };
}

function buildCreateRoom() {
    return Buffer.from([OP.createRoom]);
}

function buildAttemptToJoinRoom(roomCode) {
    return Buffer.concat([Buffer.from([OP.attemptToJoinRoom]), lengthPrefixed(roomCode)]);
}

function buildOffer(targetClientSignalId, connectionId, sessionToken, sdp) {
    const ids = Buffer.alloc(8);
    ids.writeInt32LE(targetClientSignalId, 0);
    ids.writeInt32LE(connectionId, 4);
    return Buffer.concat([
        Buffer.from([OP.receivedOfferFromHost]),
        ids,
        lengthPrefixed(sessionToken),
        Buffer.from(sdp, 'utf-8'),
    ]);
}

function buildAnswer(targetHostSignalId, sdp) {
    const id = Buffer.alloc(4);
    id.writeInt32LE(targetHostSignalId, 0);
    return Buffer.concat([Buffer.from([OP.receivedAnswerFromClient]), id, Buffer.from(sdp, 'utf-8')]);
}

/**
 * A candidate, named by session token. `opcode` is OP.trickleToClient for the
 * host's candidates or OP.trickleToHost for the client's; an empty candidate
 * string is the end-of-candidates marker.
 */
function buildTrickle(opcode, sessionToken, candidate) {
    return Buffer.concat([
        Buffer.from([opcode]),
        lengthPrefixed(sessionToken),
        Buffer.from(candidate, 'utf-8'),
    ]);
}

// --- message parsers --------------------------------------------------------

function parseCreateRoomResponse(message) {
    return { opcode: message[0], roomCode: readLengthPrefixed(message, 1).value };
}

function parseJoinRoomCallback(message) {
    const ok = message[1] === 1;
    return {
        opcode: message[0],
        ok,
        // Only the success response names a session.
        sessionToken: ok ? readLengthPrefixed(message, 2).value : undefined,
        length: message.length,
    };
}

function parseJoinNotify(message) {
    return {
        opcode: message[0],
        clientSignalId: message.readInt32LE(1),
        sessionToken: readLengthPrefixed(message, 5).value,
    };
}

function parseOfferToClient(message) {
    return {
        opcode: message[0],
        hostSignalId: message.readInt32LE(1),
        sdp: message.toString('utf-8', 5),
    };
}

function parseAnswerToHost(message) {
    return {
        opcode: message[0],
        connectionId: message.readInt32LE(1),
        sdp: message.toString('utf-8', 5),
    };
}

function parseTrickle(message) {
    return {
        opcode: message[0],
        connectionId: message.readInt32LE(1),
        candidate: message.toString('utf-8', 5),
    };
}

/**
 * Drive create-room + join-attempt, the preamble almost every test needs.
 * Returns both peers plus the routing state they now share.
 */
async function establishJoinAttempt(server) {
    const host = await server.connectPeer('host');
    const client = await server.connectPeer('client');

    host.send(buildCreateRoom());
    const { roomCode } = parseCreateRoomResponse(await host.next());

    client.send(buildAttemptToJoinRoom(roomCode));
    const callback = parseJoinRoomCallback(await client.next());
    const notify = parseJoinNotify(await host.next());

    assert.equal(callback.sessionToken, notify.sessionToken,
        'both peers must be handed the same session token');

    return {
        host,
        client,
        roomCode,
        callback,
        notify,
        clientSignalId: notify.clientSignalId,
        sessionToken: callback.sessionToken,
    };
}

/**
 * Drive the handshake one step further, through the host's offer, so the
 * session carries a connection id and candidates can flow.
 */
async function establishOfferedAttempt(server, { connectionId = 42 } = {}) {
    const attempt = await establishJoinAttempt(server);

    attempt.host.send(buildOffer(attempt.clientSignalId, connectionId, attempt.sessionToken, 'offer-sdp'));
    const offer = parseOfferToClient(await attempt.client.next());

    return { ...attempt, connectionId, hostSignalId: offer.hostSignalId };
}

/**
 * How many signaling sessions the server currently holds, read from the log
 * line it writes whenever the table changes. The session table is internal
 * routing state with no wire representation, and giving it one would mean
 * exposing a probe surface for the sake of a test.
 */
function liveSessionCount(server) {
    const matches = server.log().match(/(\d+) live\./g);
    if (!matches) return 0;
    return parseInt(matches[matches.length - 1], 10);
}

module.exports = {
    OP,
    Peer,
    startSignalServer,
    withServer,
    lengthPrefixed,
    readLengthPrefixed,
    buildCreateRoom,
    buildAttemptToJoinRoom,
    buildOffer,
    buildAnswer,
    buildTrickle,
    parseCreateRoomResponse,
    parseJoinRoomCallback,
    parseJoinNotify,
    parseOfferToClient,
    parseAnswerToHost,
    parseTrickle,
    establishJoinAttempt,
    establishOfferedAttempt,
    liveSessionCount,
};
