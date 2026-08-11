const uWS = require('uWebSockets.js');
const crypto = require('crypto');

const Redis = require('ioredis');
const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
const redis = new Redis(redisUrl);

// Overridable so a test harness can run an isolated instance alongside a
// developer's own, consistent with REDIS_URL / ENABLE_CORS.
const listenPort = parseInt(process.env.SIGNAL_PORT, 10) || 9001;

redis.on('error', (err) => {
    console.warn('[ioredis] Waiting for Redis connection...', err.message);
});

redis.on('connect', () => {
    console.log('[ioredis] Connected to Redis successfully!');
});

//TODO - Use buffer instead of reallocating, similar to jslib variant

let currentID = 1;
function generateID() {
    const id = currentID;
    currentID = (currentID + 1) & 0x7FFFFFFF;
    return id;
}

const playerID = {}; //uniqueID - player

const rooms = {}; //room key - host ws

// Signaling sessions: the server's authoritative record of one peer-connection
// attempt, named on the wire by an opaque token. Routing state only - it does
// not identify a player, and is swept when the attempt establishes or fails.
const sessions = {}; //session token - { hostPlayerID, clientPlayerID, connectionId, createdAt, hostDoneGathering, clientDoneGathering }

const createRoom = 0x01; //responded to directly with the room code
const attemptToJoinRoom = 0x02; //responded to directly if join code is valid and if host has been notified
const joinRoomCallback = 0x03; //this is the callback for the client who initiated the attempt
const receivedOfferFromHost = 0x04; //may contain error details if not allowed!
const receivedAnswerFromClient = 0x05; //client has received the offer, has started to join, and is sending answer
// 0x06 is retired - it was the never-implemented trickleICE scaffold. Do not reuse the byte.
const ping = 0x07; //simple manual ping
const trickleToClient = 0x08; //host's candidate for the client of the named session
const trickleToHost = 0x09; //client's candidate for the host of the named session



IdleTimeout = 120;
const pingBuffer = Buffer.alloc(1);
pingBuffer[0] = ping;


const app = uWS.App().ws('/Signal', {

    idleTimeout: IdleTimeout,
    sendPingsAutomatically: false,

    upgrade: (res, req, context) => {
        res.onAborted(() => {
            console.log('Upgrade aborted');
        });

        res.upgrade(
            { ip: res.getRemoteAddressAsText() },
            req.getHeader('sec-websocket-key'),
            req.getHeader('sec-websocket-protocol'),
            req.getHeader('sec-websocket-extensions'),
            context
        )

    },


    open: (ws) => {
        const newID = generateID();
        playerID[newID] = ws;
        ws.playerID = newID;
        ws.hostRoomID = -1;
        ws.backpressureQueue = [];

        if (IdleTimeout > 0) {
            ws.pingInterval = setInterval(() => {
                sendData(ws, pingBuffer);
            }, (IdleTimeout * 1000) / 2);
        }

        console.log(`Client ${newID} opened connection.`)
    },

    // Called when a message is received
    message: (ws, message, isBinary) => {
        const messageData = Buffer.from(message);
        const messageType = messageData[0];

        let responseBuffer;

        switch (messageType) {
            case createRoom: // A client wants to host a room
                // Clean up any rooms that the client was already hosting
                if(ws.hostRoomID != -1){
                    delete rooms[ws.hostRoomID];
                    removeRedisRoom(ws.hostRoomID);
                }

                // Create the room
                const roomID = generateUniqueKey();
                rooms[roomID] = ws;
                updateRedisRoom(roomID, ws.playerID);

                // Set host websocket information
                ws.hostRoomID = roomID;
                ws.redisHeartbeat = setInterval(() => {
                    updateRedisRoom(ws.hostRoomID, ws.playerID);
                }, 30000); // Heartbeat every 30 seconds

                // Respond to host with room ID
                const roomIDLength = Buffer.byteLength(roomID);
                responseBuffer = Buffer.alloc(2 + roomIDLength);
                responseBuffer[0] = createRoom;
                responseBuffer[1] = roomIDLength;
                responseBuffer.write(roomID, 2, 'utf-8');

                sendData(ws, responseBuffer);

                break;

            case attemptToJoinRoom: // A client wants to join a room
                // Parse incoming room ID
                const joinRoom_RoomIDLength = messageData[1];
                const joinRoom_RoomID = messageData
                    .toString('utf-8', 2, 2 + joinRoom_RoomIDLength)
                    .toUpperCase();

                if (rooms.hasOwnProperty(joinRoom_RoomID)) {
                    // MISSING - cleanup any room the rooms that the client was already
                    // hosting and reset hostRoomID ONLY IF not connecting to its own room

                    // Mint the signaling session for this attempt. The host assigns
                    // the connection ID later, at offer time.
                    const joinRoom_SessionToken = mintSession(
                        rooms[joinRoom_RoomID].playerID,
                        ws.playerID
                    );
                    const joinRoom_TokenLength = Buffer.byteLength(joinRoom_SessionToken);

                    // Prepare success response for connecting client, naming the session
                    responseBuffer = Buffer.alloc(2 + 1 + joinRoom_TokenLength);
                    responseBuffer[0] = joinRoomCallback;
                    responseBuffer[1] = 1;
                    responseBuffer[2] = joinRoom_TokenLength;
                    responseBuffer.write(joinRoom_SessionToken, 3, 'utf-8');

                    // Notify host that a client is connecting, naming the same session
                    notifyBuffer = Buffer.alloc(1 + 4 + 1 + joinRoom_TokenLength);
                    notifyBuffer[0] = attemptToJoinRoom;
                    notifyBuffer.writeInt32LE(ws.playerID, 1);
                    notifyBuffer[5] = joinRoom_TokenLength;
                    notifyBuffer.write(joinRoom_SessionToken, 6, 'utf-8');

                    sendData(playerID[rooms[joinRoom_RoomID].playerID], notifyBuffer);
                } else {
                    // Prepare failure response for connecting client
                    responseBuffer = Buffer.alloc(2);
                    responseBuffer[0] = joinRoomCallback;
                    responseBuffer[1] = 0;
                }

                // Notify client of success/failure
                sendData(ws, responseBuffer);

                break;

            case receivedOfferFromHost: // Signal server received offer from host
                // Read connecting client's ID
                const sendOffer_targetPlayerID = messageData.readInt32LE(1);

                // Read the ID of the connection between the host and connecting client
                const sendOffer_targetPlayerConnectionID = messageData.readInt32LE(5);

                // The host echoes the session token it was given at join-attempt
                const sendOffer_tokenLength = messageData[9];
                const sendOffer_token = messageData.toString('utf-8', 10, 10 + sendOffer_tokenLength);
                const sendOffer_remainingData = messageData.slice(10 + sendOffer_tokenLength);

                const sendOffer_session = sessions[sendOffer_token];
                if (!sendOffer_session) {
                    console.log(`Offer named no live session (token ${sendOffer_token}) - dropped.`);
                    break;
                }
                // Sender identity is by socket, so the host cannot be impersonated.
                if (ws.playerID !== sendOffer_session.hostPlayerID) {
                    console.log(`Offer into session ${sendOffer_token} from player ${ws.playerID}, not its host - dropped.`);
                    break;
                }
                if (sendOffer_targetPlayerID !== sendOffer_session.clientPlayerID) {
                    console.log(`Offer into session ${sendOffer_token} targets player ${sendOffer_targetPlayerID}, not its client - dropped.`);
                    break;
                }

                // The session owns the connection ID from here on: it is what both
                // trickle directions stamp, so neither peer can spoof it.
                sendOffer_session.connectionId = sendOffer_targetPlayerConnectionID;

                // Tell connecting client that a host has sent an offer
                responseBuffer = Buffer.alloc(1 + 4 + sendOffer_remainingData.length);
                responseBuffer[0] = receivedOfferFromHost;
                responseBuffer.writeInt32LE(ws.playerID, 1);
                sendOffer_remainingData.copy(responseBuffer, 5);

                sendData(playerID[sendOffer_session.clientPlayerID], responseBuffer);

                break;

            case receivedAnswerFromClient: // Signal server received a client's answer
                // Read host's ID
                const sendAnswer_targetPlayerID = messageData.readInt32LE(1);

                // The client echoes the session token it was given at join-attempt
                const sendAnswer_tokenLength = messageData[5];
                const sendAnswer_token = messageData.toString('utf-8', 6, 6 + sendAnswer_tokenLength);
                const sendAnswer_remainingData = messageData.slice(6 + sendAnswer_tokenLength);

                const sendAnswer_session = sessions[sendAnswer_token];
                if (!sendAnswer_session) {
                    console.log(`Answer named no live session (token ${sendAnswer_token}) - dropped.`);
                    break;
                }
                // Sender identity is by socket, so the client cannot be impersonated.
                if (ws.playerID !== sendAnswer_session.clientPlayerID) {
                    console.log(`Answer into session ${sendAnswer_token} from player ${ws.playerID}, not its client - dropped.`);
                    break;
                }
                if (sendAnswer_targetPlayerID !== sendAnswer_session.hostPlayerID) {
                    console.log(`Answer into session ${sendAnswer_token} targets player ${sendAnswer_targetPlayerID}, not its host - dropped.`);
                    break;
                }
                if (sendAnswer_session.connectionId === undefined) {
                    console.log(`Answer into session ${sendAnswer_token} carries no connection id yet - dropped.`);
                    break;
                }

                responseBuffer = Buffer.alloc(1 + 4 + sendAnswer_remainingData.length);

                // Give the connection ID to the host
                responseBuffer[0] = receivedAnswerFromClient;
                responseBuffer.writeInt32LE(sendAnswer_session.connectionId, 1);
                sendAnswer_remainingData.copy(responseBuffer, 5);

                sendData(playerID[sendAnswer_session.hostPlayerID], responseBuffer);

                break;

            case trickleToClient: // A host's candidate, bound for its session's client
                relayCandidate(ws, messageData, trickleToClient);
                break;

            case trickleToHost: // A client's candidate, bound for its session's host
                relayCandidate(ws, messageData, trickleToHost);
                break;

            case ping:
                break;

            default:
                console.log('Unknown message type:', messageType);
    }},

    close: (ws, code, message) => {
        console.log("Client ["+ ws.playerID +"] closed connection.");

        delete playerID[ws.playerID];

        // Every attempt this socket was a member of is over.
        sweepSessionsOfPlayer(ws.playerID);

        if(ws.hostRoomID != -1){
            removeRedisRoom(ws.hostRoomID);
            clearInterval(ws.redisHeartbeat);
            delete rooms[ws.hostRoomID];
        }

        if (ws.pingInterval) {
            clearInterval(ws.pingInterval);
        }
    },

    drain: (ws) => {
        console.log("Drain event occurred. Resuming data transmission.");
        if (ws.backpressureQueue && ws.backpressureQueue.length > 0) {
            while (ws.getBufferedAmount() < BACKPRESSURE_THRESHOLD && ws.backpressureQueue.length > 0) {
                const bufferToSend = ws.backpressureQueue.shift();
                sendData(ws, bufferToSend);
            }
        }
    },

    dropped: (ws, message, isBinary) => {
        console.log("Message dropped:", message);
    },

    subscription: (ws, topic, newCount, oldCount) => {
        console.log("Subscription event:", topic, newCount, oldCount);
    }

}).listen(listenPort, (token) => {
    if (token) {
        console.log(`Server listening on port ${listenPort}`);
    } else {
        console.log(`Failed to listen on port ${listenPort}`);
        process.exit(1);
    }
});

const BACKPRESSURE_THRESHOLD = 1024 * 1024; // 1MB

function sendData(ws, data) {
    if(ws){
        if (ws.getBufferedAmount() < BACKPRESSURE_THRESHOLD) {
            ws.send(data, true);
        } else {
            console.log('Backpressure detected, queueing data');

            ws.backpressureQueue.push(data);
        }
    }
}

function generateUniqueKey() {
    const allowedChars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890';
    const generateKey = () => {
        let key = '';
        for (let i = 0; i < 5; i++) {
            key += allowedChars.charAt(Math.floor(Math.random() * allowedChars.length));
        }
        return key;
    };

    let key;
    do {
        key = generateKey();
    } while (rooms.hasOwnProperty(key));

    return key;
}

// 22 chars from a 62-char alphabet is ~131 bits. Far wider than the 5-char room
// code on purpose: a room-code collision is a UX annoyance a user retries past,
// a token collision silently crosses two peers' routing state.
const SESSION_TOKEN_LENGTH = 22;
const SESSION_TOKEN_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

function generateSessionToken() {
    const generateToken = () => {
        let token = '';
        for (let i = 0; i < SESSION_TOKEN_LENGTH; i++) {
            token += SESSION_TOKEN_CHARS.charAt(crypto.randomInt(SESSION_TOKEN_CHARS.length));
        }
        return token;
    };

    let token;
    do {
        token = generateToken();
    } while (sessions.hasOwnProperty(token));

    return token;
}

/** Record one peer-connection attempt and return the token that names it. */
function mintSession(hostPlayerID, clientPlayerID) {
    const token = generateSessionToken();

    sessions[token] = {
        hostPlayerID: hostPlayerID,
        clientPlayerID: clientPlayerID,
        connectionId: undefined, // the host assigns it, at offer time
        createdAt: Date.now(),
        hostDoneGathering: false,
        clientDoneGathering: false,
    };

    console.log(`Session ${token} minted for host ${hostPlayerID}, client ${clientPlayerID}. ${Object.keys(sessions).length} live.`);

    return token;
}

/**
 * A signaling session is routing state for one attempt and must not outlive it.
 * It is swept when the attempt establishes or fails, never merely because the
 * answer was relayed - candidates keep flowing after the answer, which is the
 * whole point of trickle.
 */
function sweepSession(token, reason) {
    if (!sessions.hasOwnProperty(token)) return;

    delete sessions[token];
    console.log(`Session ${token} swept (${reason}). ${Object.keys(sessions).length} live.`);
}

/** Either member socket going away ends the attempt. */
function sweepSessionsOfPlayer(departedPlayerID) {
    for (const token of Object.keys(sessions)) {
        const session = sessions[token];
        if (session.hostPlayerID === departedPlayerID || session.clientPlayerID === departedPlayerID) {
            sweepSession(token, `player ${departedPlayerID} disconnected`);
        }
    }
}

// Backstop against unbounded growth: a peer can mint a session per join attempt
// and then never signal again. Overridable so tests need not wait out the
// default, consistent with SIGNAL_PORT / REDIS_URL.
const SESSION_TTL_MS = parseInt(process.env.SESSION_TTL_MS, 10) || 5 * 60 * 1000;
const SESSION_SWEEP_INTERVAL_MS = Math.max(100, Math.floor(SESSION_TTL_MS / 4));

setInterval(() => {
    const expiredBefore = Date.now() - SESSION_TTL_MS;
    for (const token of Object.keys(sessions)) {
        if (sessions[token].createdAt <= expiredBefore) {
            sweepSession(token, 'expired');
        }
    }
}, SESSION_SWEEP_INTERVAL_MS);

/**
 * Relay one candidate to the opposite member of the session the token names,
 * stamping the session's connection id so neither peer can spoof which
 * connection a candidate belongs to.
 *
 * The message carries no target - the token alone selects the route - so the
 * membership check by socket is the only thing standing between a prober and
 * another pair's routing state. A rejected trickle is logged and dropped with
 * no response of any kind: answering would tell the sender the token is live.
 *
 * Loopback needs no special case. When a host joins its own room both roles are
 * the same socket, both checks pass for it, and the candidate routes back to
 * it - the opcode is what the game side uses to pick the local peer connection.
 *
 * The candidate itself is never parsed. It is the remainder of the buffer, so
 * zero remaining bytes is the end-of-candidates marker, relayed like any other.
 */
function relayCandidate(ws, messageData, direction) {
    const tokenLength = messageData[1];
    const token = messageData.toString('utf-8', 2, 2 + tokenLength);
    const candidateData = messageData.slice(2 + tokenLength);

    const session = sessions[token];
    if (!session) {
        console.log(`Trickle named no live session (token ${token}) - dropped.`);
        return;
    }

    const sender = direction === trickleToClient ? session.hostPlayerID : session.clientPlayerID;
    const recipient = direction === trickleToClient ? session.clientPlayerID : session.hostPlayerID;

    if (ws.playerID !== sender) {
        console.log(`Trickle into session ${token} from player ${ws.playerID}, not its ${direction === trickleToClient ? 'host' : 'client'} - dropped.`);
        return;
    }
    if (session.connectionId === undefined) {
        console.log(`Trickle into session ${token} carries no connection id yet - dropped.`);
        return;
    }

    const responseBuffer = Buffer.alloc(1 + 4 + candidateData.length);
    responseBuffer[0] = direction;
    responseBuffer.writeInt32LE(session.connectionId, 1);
    candidateData.copy(responseBuffer, 5);

    sendData(playerID[recipient], responseBuffer);

    // An empty candidate is end-of-candidates. Once both peers have sent theirs
    // the attempt has concluded gathering and the route is no longer needed.
    if (candidateData.length === 0) {
        if (direction === trickleToClient) session.hostDoneGathering = true;
        else session.clientDoneGathering = true;

        if (session.hostDoneGathering && session.clientDoneGathering) {
            sweepSession(token, 'both peers finished gathering');
        }
    }
}

async function updateRedisRoom(roomID, hostID) {
    const key = `room:${roomID}`;
    const roomMetadata = {
        id: roomID,
        hostID: hostID,
        lastSeen: Date.now(),
        // You can eventually pass player counts/map names here
    };

    // Set with a 60-second TTL. If no update happens, it expires.
    // Redis is discovery state only - no signaling logic reads it, so a
    // failure here must never take the relay down with it.
    try {
        await redis.set(key, JSON.stringify(roomMetadata), 'EX', 60);
    } catch (err) {
        console.warn('[ioredis] Could not mirror room', roomID, '-', err.message);
    }
}

async function removeRedisRoom(roomID) {
    try {
        await redis.del(`room:${roomID}`);
    } catch (err) {
        console.warn('[ioredis] Could not remove room', roomID, '-', err.message);
    }
}