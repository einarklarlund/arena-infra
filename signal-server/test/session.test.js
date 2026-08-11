'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    OP,
    withServer,
    buildCreateRoom,
    buildAttemptToJoinRoom,
    parseCreateRoomResponse,
    parseJoinRoomCallback,
    parseJoinNotify,
    liveSessionCount,
    establishJoinAttempt,
} = require('./harness');

// The token alphabet and width settled in ticket 01: 22 chars from A-Z a-z 0-9.
const TOKEN_PATTERN = /^[A-Za-z0-9]{22}$/;

test('a join attempt mints a session and hands the same token to both peers', async () => {
    await withServer(async (server) => {
        const host = await server.connectPeer('host');
        const client = await server.connectPeer('client');

        host.send(buildCreateRoom());
        const { roomCode } = parseCreateRoomResponse(await host.next());

        client.send(buildAttemptToJoinRoom(roomCode));

        const callback = parseJoinRoomCallback(await client.next());
        assert.equal(callback.opcode, OP.joinRoomCallback);
        assert.equal(callback.ok, true);
        assert.match(callback.sessionToken, TOKEN_PATTERN);
        // 0x03 0x01 [tok] - nothing trails the token.
        assert.equal(callback.length, 2 + 1 + callback.sessionToken.length);

        const notify = parseJoinNotify(await host.next());
        assert.equal(notify.opcode, OP.attemptToJoinRoom);
        assert.ok(notify.clientPlayerID > 0);
        assert.equal(notify.sessionToken, callback.sessionToken);

        assert.equal(liveSessionCount(server), 1);
    });
});

test('the session records the host and the client signal ids', async () => {
    await withServer(async (server) => {
        const { notify } = await establishJoinAttempt(server);
        // The host is player 1 and the client player 2 - they connected in that order.
        assert.equal(notify.clientPlayerID, 2);
        assert.match(server.log(), /Session \w+ minted for host 1, client 2\./);
    });
});

test('two concurrent join attempts on one room get distinct tokens', async () => {
    await withServer(async (server) => {
        const host = await server.connectPeer('host');
        const first = await server.connectPeer('first');
        const second = await server.connectPeer('second');

        host.send(buildCreateRoom());
        const { roomCode } = parseCreateRoomResponse(await host.next());

        first.send(buildAttemptToJoinRoom(roomCode));
        const firstToken = parseJoinRoomCallback(await first.next()).sessionToken;
        const firstNotify = parseJoinNotify(await host.next());

        second.send(buildAttemptToJoinRoom(roomCode));
        const secondToken = parseJoinRoomCallback(await second.next()).sessionToken;
        const secondNotify = parseJoinNotify(await host.next());

        assert.match(firstToken, TOKEN_PATTERN);
        assert.match(secondToken, TOKEN_PATTERN);
        assert.notEqual(firstToken, secondToken);
        assert.equal(firstNotify.sessionToken, firstToken);
        assert.equal(secondNotify.sessionToken, secondToken);
        assert.notEqual(firstNotify.clientPlayerID, secondNotify.clientPlayerID);

        assert.equal(liveSessionCount(server), 2);
    });
});

test('the same client attempting the same room twice gets two distinct sessions', async () => {
    await withServer(async (server) => {
        const host = await server.connectPeer('host');
        const client = await server.connectPeer('client');

        host.send(buildCreateRoom());
        const { roomCode } = parseCreateRoomResponse(await host.next());

        client.send(buildAttemptToJoinRoom(roomCode));
        const firstToken = parseJoinRoomCallback(await client.next()).sessionToken;
        await host.next();

        client.send(buildAttemptToJoinRoom(roomCode));
        const secondToken = parseJoinRoomCallback(await client.next()).sessionToken;
        await host.next();

        assert.notEqual(firstToken, secondToken);
        assert.equal(liveSessionCount(server), 2);
    });
});

test('a join attempt on an unknown room mints nothing and its failure reply is unchanged', async () => {
    await withServer(async (server) => {
        const client = await server.connectPeer('client');

        client.send(buildAttemptToJoinRoom('ZZZZZ'));

        const message = await client.next();
        assert.deepEqual(message, Buffer.from([OP.joinRoomCallback, 0x00]));
        assert.equal(liveSessionCount(server), 0);
    });
});

test('a join attempt costs no extra round trip - each peer hears exactly once', async () => {
    await withServer(async (server) => {
        const { host, client } = await establishJoinAttempt(server);

        await host.expectSilence();
        await client.expectSilence();
    });
});
