'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    OP,
    withServer,
    buildCreateRoom,
    buildAttemptToJoinRoom,
    buildAnswer,
    buildTrickle,
    parseCreateRoomResponse,
    parseJoinRoomCallback,
    parseAnswerToHost,
    parseTrickle,
    establishJoinAttempt,
    establishOfferedAttempt,
    liveSessionCount,
} = require('./harness');

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('a full attempt run to completion leaves the session table empty', async () => {
    await withServer(async (server) => {
        const { host, client, sessionToken, hostPlayerID, connectionId } =
            await establishOfferedAttempt(server);

        client.send(buildAnswer(hostPlayerID, sessionToken, 'answer-sdp'));
        assert.equal(parseAnswerToHost(await host.next()).connectionId, connectionId);

        host.send(buildTrickle(OP.trickleToClient, sessionToken, 'candidate:host-1'));
        await client.next();
        client.send(buildTrickle(OP.trickleToHost, sessionToken, 'candidate:client-1'));
        await host.next();

        // Both peers signal end-of-candidates.
        host.send(buildTrickle(OP.trickleToClient, sessionToken, ''));
        assert.equal(parseTrickle(await client.next()).candidate, '');
        client.send(buildTrickle(OP.trickleToHost, sessionToken, ''));
        assert.equal(parseTrickle(await host.next()).candidate, '');

        await delay(100);
        assert.equal(liveSessionCount(server), 0);
    });
});

test('relaying the answer never sweeps the session - candidates still flow after it', async () => {
    await withServer(async (server) => {
        const { host, client, sessionToken, hostPlayerID } = await establishOfferedAttempt(server);

        client.send(buildAnswer(hostPlayerID, sessionToken, 'answer-sdp'));
        await host.next();

        await delay(100);
        assert.equal(liveSessionCount(server), 1);

        host.send(buildTrickle(OP.trickleToClient, sessionToken, 'candidate:after-answer'));
        assert.equal(parseTrickle(await client.next()).candidate, 'candidate:after-answer');
    });
});

test('end-of-candidates from one direction alone does not sweep the session', async () => {
    await withServer(async (server) => {
        const { host, client, sessionToken } = await establishOfferedAttempt(server);

        client.send(buildTrickle(OP.trickleToHost, sessionToken, ''));
        await host.next();

        await delay(100);
        assert.equal(liveSessionCount(server), 1);

        // The other direction is still routable.
        host.send(buildTrickle(OP.trickleToClient, sessionToken, 'candidate:host-late'));
        assert.equal(parseTrickle(await client.next()).candidate, 'candidate:host-late');
    });
});

test("a session is swept when its client's socket closes", async () => {
    await withServer(async (server) => {
        const { client } = await establishOfferedAttempt(server);

        await client.closeAndSettle();

        assert.equal(liveSessionCount(server), 0);
    });
});

test("a session is swept when its host's socket closes", async () => {
    await withServer(async (server) => {
        const { host } = await establishOfferedAttempt(server);

        await host.closeAndSettle();

        assert.equal(liveSessionCount(server), 0);
    });
});

test('a host closing sweeps every session of every client attempting its room', async () => {
    await withServer(async (server) => {
        const host = await server.connectPeer('host');
        const first = await server.connectPeer('first');
        const second = await server.connectPeer('second');

        host.send(buildCreateRoom());
        const { roomCode } = parseCreateRoomResponse(await host.next());

        for (const client of [first, second]) {
            client.send(buildAttemptToJoinRoom(roomCode));
            await client.next();
            await host.next();
        }
        assert.equal(liveSessionCount(server), 2);

        await host.closeAndSettle();

        assert.equal(liveSessionCount(server), 0);
    });
});

test('abandoned attempts are TTL-swept, so repeated join attempts cannot grow the table', async () => {
    await withServer(async (server) => {
        const host = await server.connectPeer('host');
        const client = await server.connectPeer('client');

        host.send(buildCreateRoom());
        const { roomCode } = parseCreateRoomResponse(await host.next());

        // A client that mints sessions and then never signals again.
        for (let i = 0; i < 5; i++) {
            client.send(buildAttemptToJoinRoom(roomCode));
            assert.equal(parseJoinRoomCallback(await client.next()).ok, true);
            await host.next();
        }
        assert.equal(liveSessionCount(server), 5);

        await delay(1200);

        assert.equal(liveSessionCount(server), 0);
        // The sockets themselves are untouched - only the routing state expired.
        assert.equal(host.closed, false);
        assert.equal(client.closed, false);
    }, { env: { SESSION_TTL_MS: '400' } });
});

test('a live attempt started after an abandoned one still routes', async () => {
    await withServer(async (server) => {
        await establishJoinAttempt(server);
        await delay(1200);
        assert.equal(liveSessionCount(server), 0);

        const { host, client, sessionToken } = await establishOfferedAttempt(server);
        client.send(buildTrickle(OP.trickleToHost, sessionToken, 'candidate:fresh'));

        assert.equal(parseTrickle(await host.next()).candidate, 'candidate:fresh');
    }, { env: { SESSION_TTL_MS: '400' } });
});
