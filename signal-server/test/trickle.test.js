'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    OP,
    withServer,
    buildCreateRoom,
    buildAttemptToJoinRoom,
    buildOffer,
    buildTrickle,
    parseCreateRoomResponse,
    parseJoinRoomCallback,
    parseJoinNotify,
    parseOfferToClient,
    parseTrickle,
    establishJoinAttempt,
    establishOfferedAttempt,
} = require('./harness');

test("a client's candidate reaches the session host, stamped with the connection id", async () => {
    await withServer(async (server) => {
        const { host, client, sessionToken, connectionId } = await establishOfferedAttempt(server);

        client.send(buildTrickle(OP.trickleToHost, sessionToken, 'candidate:client-1'));

        const relayed = parseTrickle(await host.next());
        assert.equal(relayed.opcode, OP.trickleToHost);
        assert.equal(relayed.connectionId, connectionId);
        assert.equal(relayed.candidate, 'candidate:client-1');
        await client.expectSilence();
    });
});

test("a host's candidate reaches the session client, stamped with the connection id", async () => {
    await withServer(async (server) => {
        const { host, client, sessionToken, connectionId } = await establishOfferedAttempt(server);

        host.send(buildTrickle(OP.trickleToClient, sessionToken, 'candidate:host-1'));

        const relayed = parseTrickle(await client.next());
        assert.equal(relayed.opcode, OP.trickleToClient);
        assert.equal(relayed.connectionId, connectionId);
        assert.equal(relayed.candidate, 'candidate:host-1');
        await host.expectSilence();
    });
});

test('candidates keep flowing in both directions, in order', async () => {
    await withServer(async (server) => {
        const { host, client, sessionToken } = await establishOfferedAttempt(server);

        host.send(buildTrickle(OP.trickleToClient, sessionToken, 'candidate:host-1'));
        host.send(buildTrickle(OP.trickleToClient, sessionToken, 'candidate:host-2'));
        client.send(buildTrickle(OP.trickleToHost, sessionToken, 'candidate:client-1'));

        assert.equal(parseTrickle(await client.next()).candidate, 'candidate:host-1');
        assert.equal(parseTrickle(await client.next()).candidate, 'candidate:host-2');
        assert.equal(parseTrickle(await host.next()).candidate, 'candidate:client-1');
    });
});

test('the candidate string is relayed verbatim and never inspected', async () => {
    await withServer(async (server) => {
        const { host, client, sessionToken } = await establishOfferedAttempt(server);
        // Not remotely a valid ICE candidate. The server is a relay.
        const opaque = 'not a candidate at all — ☃ 0x00-ish \\ " {} |';

        client.send(buildTrickle(OP.trickleToHost, sessionToken, opaque));

        assert.equal(parseTrickle(await host.next()).candidate, opaque);
    });
});

test('an empty candidate - end-of-candidates - relays through both directions', async () => {
    await withServer(async (server) => {
        const { host, client, sessionToken, connectionId } = await establishOfferedAttempt(server);

        client.send(buildTrickle(OP.trickleToHost, sessionToken, ''));
        const toHost = parseTrickle(await host.next());
        assert.equal(toHost.opcode, OP.trickleToHost);
        assert.equal(toHost.connectionId, connectionId);
        assert.equal(toHost.candidate, '');

        host.send(buildTrickle(OP.trickleToClient, sessionToken, ''));
        const toClient = parseTrickle(await client.next());
        assert.equal(toClient.opcode, OP.trickleToClient);
        assert.equal(toClient.connectionId, connectionId);
        assert.equal(toClient.candidate, '');
    });
});

test('a trickle from a socket in neither role of the named session is dropped in silence', async () => {
    await withServer(async (server) => {
        const { host, client, sessionToken } = await establishOfferedAttempt(server);
        const prober = await server.connectPeer('prober');

        prober.send(buildTrickle(OP.trickleToHost, sessionToken, 'candidate:spoofed'));
        prober.send(buildTrickle(OP.trickleToClient, sessionToken, 'candidate:spoofed'));

        // No response of any kind: a reply would tell the prober the token is live.
        await prober.expectSilence();
        await host.expectSilence();
        await client.expectSilence();
        assert.match(server.log(), /Trickle into session \w+ from player \d+/);
    });
});

test("a client cannot send the host's direction, nor the host the client's", async () => {
    await withServer(async (server) => {
        const { host, client, sessionToken } = await establishOfferedAttempt(server);

        // 0x08 is the host's direction; 0x09 is the client's.
        client.send(buildTrickle(OP.trickleToClient, sessionToken, 'candidate:wrong-way'));
        host.send(buildTrickle(OP.trickleToHost, sessionToken, 'candidate:wrong-way'));

        await host.expectSilence();
        await client.expectSilence();
    });
});

test('a trickle naming an unknown token is dropped in silence', async () => {
    await withServer(async (server) => {
        const { host, client } = await establishOfferedAttempt(server);

        client.send(buildTrickle(OP.trickleToHost, 'aaaaaaaaaaaaaaaaaaaaaa', 'candidate:client-1'));

        await host.expectSilence();
        await client.expectSilence();
        assert.match(server.log(), /Trickle named no live session/);
    });
});

test('a host that joins its own room trickles to itself on both opcodes', async () => {
    await withServer(async (server) => {
        const peer = await server.connectPeer('loopback');
        const connectionId = 99;

        peer.send(buildCreateRoom());
        const { roomCode } = parseCreateRoomResponse(await peer.next());

        peer.send(buildAttemptToJoinRoom(roomCode));
        // Host and client are the same socket, so it hears both replies.
        const notify = parseJoinNotify(await peer.next());
        const callback = parseJoinRoomCallback(await peer.next());
        assert.equal(callback.ok, true);
        assert.equal(callback.sessionToken, notify.sessionToken);

        const sessionToken = callback.sessionToken;
        peer.send(buildOffer(notify.clientSignalId, connectionId, sessionToken, 'offer-sdp'));
        assert.equal(parseOfferToClient(await peer.next()).sdp, 'offer-sdp');

        peer.send(buildTrickle(OP.trickleToHost, sessionToken, 'candidate:loop-to-host'));
        const toHost = parseTrickle(await peer.next());
        assert.equal(toHost.opcode, OP.trickleToHost);
        assert.equal(toHost.connectionId, connectionId);
        assert.equal(toHost.candidate, 'candidate:loop-to-host');

        peer.send(buildTrickle(OP.trickleToClient, sessionToken, 'candidate:loop-to-client'));
        const toClient = parseTrickle(await peer.next());
        assert.equal(toClient.opcode, OP.trickleToClient);
        assert.equal(toClient.connectionId, connectionId);
        assert.equal(toClient.candidate, 'candidate:loop-to-client');
    });
});

test('a trickle on a session the host has not offered on yet is dropped in silence', async () => {
    await withServer(async (server) => {
        const { host, client, sessionToken } = await establishJoinAttempt(server);

        client.send(buildTrickle(OP.trickleToHost, sessionToken, 'candidate:too-early'));

        await host.expectSilence();
        await client.expectSilence();
        assert.match(server.log(), /carries no connection id/);
    });
});
