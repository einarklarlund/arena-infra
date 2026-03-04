const uWS = require('uWebSockets.js');

const Redis = require('ioredis');
const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
const redis = new Redis(redisUrl);

//TODO - Use buffer instead of reallocating, similar to jslib variant

let currentID = 1;
function generateID() {
    const id = currentID;
    currentID = (currentID + 1) & 0x7FFFFFFF;
    return id;
}

const playerID = {}; //uniqueID - player
const signalConnectionID = {} //SignalID - ConnectionID

const rooms = {}; //room key - host ws

const createRoom = 0x01; //responded to directly with the room code
const attemptToJoinRoom = 0x02; //responded to directly if join code is valid and if host has been notified
const joinRoomCallback = 0x03; //this is the callback for the client who initiated the attempt
const receivedOfferFromHost = 0x04; //may contain error details if not allowed!
const receivedAnswerFromClient = 0x05; //client has received the offer, has started to join, and is sending answer
const trickleICE = 0x06;
const ping = 0x07; //simple manual ping



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

                // Clean up any connections this player was already connected to
                if(signalConnectionID.hasOwnProperty(ws.playerID)){
                    delete signalConnectionID[ws.playerID]
                }

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

                    // Prepare success response for connecting client
                    responseBuffer = Buffer.alloc(2);
                    responseBuffer[0] = joinRoomCallback;
                    responseBuffer[1] = 1;

                    // Notify host that a client is connecting
                    notifyBuffer = Buffer.alloc(1+4);
                    notifyBuffer[0] = attemptToJoinRoom;
                    notifyBuffer.writeInt32LE(ws.playerID, 1);

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
                const sendOffer_targetPlayerSignalID = messageData.readInt32LE(1);

                // Read the ID of the connection between the host and connecting client
                const sendOffer_targetPlayerConnectionID = messageData.readInt32LE(5);
                const sendOffer_remainingData = messageData.slice(9);

                // Map connecting client ID to the connection ID
                signalConnectionID[sendOffer_targetPlayerSignalID] = sendOffer_targetPlayerConnectionID

                // Tell connecting client that a host has sent an offer
                responseBuffer = Buffer.alloc(1 + 4 + sendOffer_remainingData.length);
                responseBuffer[0] = receivedOfferFromHost;
                responseBuffer.writeInt32LE(ws.playerID, 1);
                sendOffer_remainingData.copy(responseBuffer, 5);

                sendData(playerID[sendOffer_targetPlayerSignalID], responseBuffer);

                break;

            case receivedAnswerFromClient: // Signal server received a client's answer
                // Read host's ID
                const sendAnswer_targetPlayerID = messageData.readInt32LE(1);
                const sendAnswer_remainingData = messageData.slice(5);
                responseBuffer = Buffer.alloc(1 + 4 + sendAnswer_remainingData.length);

                // Give the connection ID to the host
                responseBuffer[0] = receivedAnswerFromClient;
                responseBuffer.writeInt32LE(signalConnectionID[ws.playerID], 1);
                sendAnswer_remainingData.copy(responseBuffer, 5);

                sendData(playerID[sendAnswer_targetPlayerID], responseBuffer);

                break;

            case trickleICE:
                //Not Implemented

                const sendICE_targetPlayerID = messageData.readInt32LE(1);
                const remainingData = messageData.slice(5);
                responseBuffer = Buffer.alloc(1 + 4 + remainingData.length);

                responseBuffer[0] = trickleICE;
                responseBuffer.writeInt32LE(signalConnectionID[ws.playerID], 1);
                remainingData.copy(responseBuffer, 5);

                sendData(playerID[sendICE_targetPlayerID], responseBuffer);

                break;

            case ping:
                break;

            default:
                console.log('Unknown message type:', messageType);
    }},

    close: (ws, code, message) => {
        console.log("Client ["+ ws.playerID +"] closed connection.");

        if(signalConnectionID.hasOwnProperty(ws.playerID)){
            delete signalConnectionID[ws.playerID]
        }

        delete playerID[ws.playerID];

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

}).listen(9001, (token) => {
    if (token) {
        console.log('Server listening on port 9001');
    } else {
        console.log('Failed to listen on port 9001');
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

async function updateRedisRoom(roomID, hostID) {
    const key = `room:${roomID}`;
    const roomMetadata = {
        id: roomID,
        hostID: hostID,
        lastSeen: Date.now(),
        // You can eventually pass player counts/map names here
    };

    // Set with a 60-second TTL. If no update happens, it expires.
    await redis.set(key, JSON.stringify(roomMetadata), 'EX', 60);
}

async function removeRedisRoom(roomID) {
    await redis.del(`room:${roomID}`);
}