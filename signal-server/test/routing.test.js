'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    OP,
    withServer,
    buildCreateRoom,
    buildAttemptToJoinRoom,
    buildOffer,
    buildAnswer,
    parseCreateRoomResponse,
    parseJoinRoomCallback,
    parseJoinNotify,
    parseOfferToClient,
    parseAnswerToHost,
    establishJoinAttempt,
    establishOfferedAttempt,
} = require('./harness');

test('a host creates a room and is told its room code', async () => {
    await withServer(async (server) => {
        const host = await server.connectPeer('host');

        host.send(buildCreateRoom());
        const response = parseCreateRoomResponse(await host.next());

        assert.equal(response.opcode, OP.createRoom);
        assert.match(response.roomCode, /^[A-Z0-9]{5}$/);
    });
});

test('a join attempt succeeds for the client and notifies the host with the client player id', async () => {
    await withServer(async (server) => {
        const host = await server.connectPeer('host');
        const client = await server.connectPeer('client');

        host.send(buildCreateRoom());
        const { roomCode } = parseCreateRoomResponse(await host.next());

        client.send(buildAttemptToJoinRoom(roomCode));

        const callback = parseJoinRoomCallback(await client.next());
        assert.equal(callback.opcode, OP.joinRoomCallback);
        assert.equal(callback.ok, true);

        const notify = parseJoinNotify(await host.next());
        assert.equal(notify.opcode, OP.attemptToJoinRoom);
        assert.ok(notify.clientPlayerID > 0);
    });
});

test('a join attempt on an unknown room fails, and no host is notified', async () => {
    await withServer(async (server) => {
        const host = await server.connectPeer('host');
        const client = await server.connectPeer('client');

        host.send(buildCreateRoom());
        await host.next();

        client.send(buildAttemptToJoinRoom('ZZZZZ'));

        const callback = parseJoinRoomCallback(await client.next());
        assert.equal(callback.opcode, OP.joinRoomCallback);
        assert.equal(callback.ok, false);

        await host.expectSilence();
    });
});

test('the room code is matched case-insensitively', async () => {
    await withServer(async (server) => {
        const host = await server.connectPeer('host');
        const client = await server.connectPeer('client');

        host.send(buildCreateRoom());
        const { roomCode } = parseCreateRoomResponse(await host.next());

        client.send(buildAttemptToJoinRoom(roomCode.toLowerCase()));

        assert.equal(parseJoinRoomCallback(await client.next()).ok, true);
        await host.next();
    });
});

test('the offer reaches the client and the answer reaches the host stamped with the connection id', async () => {
    await withServer(async (server) => {
        const host = await server.connectPeer('host');
        const client = await server.connectPeer('client');
        const connectionId = 42;

        host.send(buildCreateRoom());
        const { roomCode } = parseCreateRoomResponse(await host.next());

        client.send(buildAttemptToJoinRoom(roomCode));
        await client.next();
        const { clientPlayerID, sessionToken } = parseJoinNotify(await host.next());

        host.send(buildOffer(clientPlayerID, connectionId, sessionToken, 'fake-offer-sdp'));

        const offer = parseOfferToClient(await client.next());
        assert.equal(offer.opcode, OP.receivedOfferFromHost);
        assert.equal(offer.sdp, 'fake-offer-sdp');
        assert.ok(offer.hostPlayerID > 0);

        client.send(buildAnswer(offer.hostPlayerID, sessionToken, 'fake-answer-sdp'));

        const answer = parseAnswerToHost(await host.next());
        assert.equal(answer.opcode, OP.receivedAnswerFromClient);
        assert.equal(answer.connectionId, connectionId);
        assert.equal(answer.sdp, 'fake-answer-sdp');
    });
});

test('the retired 0x06 opcode is unhandled and answered by nobody', async () => {
    await withServer(async (server) => {
        const peer = await server.connectPeer('peer');

        peer.send(Buffer.from([0x06, 0x00, 0x00, 0x00, 0x00]));

        await peer.expectSilence();
        assert.match(server.log(), /Unknown message type: 6/);
    });
});

test('an offer naming no live session is logged and dropped, not relayed', async () => {
    await withServer(async (server) => {
        const { host, client, clientPlayerID } = await establishJoinAttempt(server);

        host.send(buildOffer(clientPlayerID, 7, 'aaaaaaaaaaaaaaaaaaaaaa', 'fake-offer-sdp'));

        await client.expectSilence();
        await host.expectSilence();
        assert.match(server.log(), /Offer named no live session/);
    });
});

test('an offer from a socket that is not the session host is logged and dropped', async () => {
    await withServer(async (server) => {
        const { client, clientPlayerID, sessionToken } = await establishJoinAttempt(server);
        const impostor = await server.connectPeer('impostor');

        impostor.send(buildOffer(clientPlayerID, 7, sessionToken, 'spoofed-offer-sdp'));

        await client.expectSilence();
        await impostor.expectSilence();
        assert.match(server.log(), /not its host/);
    });
});

test('an answer on a session the host has not offered on yet is logged and dropped', async () => {
    await withServer(async (server) => {
        const { host, client, sessionToken } = await establishJoinAttempt(server);

        // No offer has been sent, so the session carries no connection id to stamp.
        client.send(buildAnswer(1, sessionToken, 'premature-answer-sdp'));

        await host.expectSilence();
        await client.expectSilence();
        assert.match(server.log(), /carries no connection id yet/);
    });
});

test('an answer naming an unknown token is logged and dropped', async () => {
    await withServer(async (server) => {
        const { host, client, hostPlayerID } = await establishOfferedAttempt(server);

        client.send(buildAnswer(hostPlayerID, 'aaaaaaaaaaaaaaaaaaaaaa', 'answer-sdp'));

        await host.expectSilence();
        await client.expectSilence();
        assert.match(server.log(), /Answer named no live session/);
    });
});

test('an answer from a socket that is not the session client is logged and dropped', async () => {
    await withServer(async (server) => {
        const { host, sessionToken, hostPlayerID } = await establishOfferedAttempt(server);
        const impostor = await server.connectPeer('impostor');

        impostor.send(buildAnswer(hostPlayerID, sessionToken, 'spoofed-answer-sdp'));

        await host.expectSilence();
        await impostor.expectSilence();
        assert.match(server.log(), /not its client/);
    });
});

test('an answer names which of two live sessions with the same host it belongs to', async () => {
    await withServer(async (server) => {
        const host = await server.connectPeer('host');
        const client = await server.connectPeer('client');

        host.send(buildCreateRoom());
        const { roomCode } = parseCreateRoomResponse(await host.next());

        // The same client attempts the same room twice, so the (client, host) pair
        // no longer identifies one attempt.
        const attempts = [];
        for (const connectionId of [11, 22]) {
            client.send(buildAttemptToJoinRoom(roomCode));
            await client.next();
            const { clientPlayerID, sessionToken } = parseJoinNotify(await host.next());

            host.send(buildOffer(clientPlayerID, connectionId, sessionToken, 'offer-sdp'));
            const offer = parseOfferToClient(await client.next());

            attempts.push({ sessionToken, connectionId, hostPlayerID: offer.hostPlayerID });
        }

        const first = attempts[0];
        client.send(buildAnswer(first.hostPlayerID, first.sessionToken, 'answer-sdp'));

        const answer = parseAnswerToHost(await host.next());
        assert.equal(answer.connectionId, first.connectionId);
        assert.equal(answer.sdp, 'answer-sdp');
    });
});
