require('dotenv').config();
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

app.use(cors());
app.use(express.static('.'));
app.use(express.json());

// ============ DATA MANAGEMENT ============
const players = {};
const rooms = {};
const matchmakingQueue = [];
const leaderboard = new Map();

const MAX_PLAYERS_TOTAL = 12;
const MAX_PLAYERS_PER_ROOM = 2;
const ROOM_TIMEOUT = 5 * 60 * 1000; // 5 minutes

// ============ UTILITY FUNCTIONS ============
function generateRoomId() {
    return 'room_' + Math.random().toString(36).substr(2, 9);
}

function generatePlayerId() {
    return 'player_' + Math.random().toString(36).substr(2, 9);
}

function getPlayerCount() {
    return Object.keys(players).length;
}

function getRoomCount() {
    return Object.keys(rooms).filter(key => rooms[key].gameActive).length;
}

function getAvailableSlots() {
    return MAX_PLAYERS_TOTAL - getPlayerCount();
}

// ============ LEADERBOARD FUNCTIONS ============
function updateLeaderboard(playerId, playerData) {
    if (!leaderboard.has(playerId)) {
        leaderboard.set(playerId, {
            id: playerId,
            name: playerData.name || 'Anonymous',
            wins: 0,
            losses: 0,
            totalGames: 0,
            winRate: 0
        });
    }
    
    const player = leaderboard.get(playerId);
    player.totalGames = player.wins + player.losses;
    player.winRate = player.totalGames > 0 ? ((player.wins / player.totalGames) * 100).toFixed(2) : 0;
}

function getTopPlayers(limit = 10) {
    return Array.from(leaderboard.values())
        .sort((a, b) => {
            if (b.wins !== a.wins) return b.wins - a.wins;
            return b.winRate - a.winRate;
        })
        .slice(0, limit);
}

// ============ SOCKET.IO EVENTS ============
io.on('connection', (socket) => {
    console.log(`[${new Date().toISOString()}] Player connected: ${socket.id}`);
    console.log(`📊 Total Players: ${getPlayerCount() + 1}/${MAX_PLAYERS_TOTAL}, Rooms: ${getRoomCount()}, Queue: ${matchmakingQueue.length}`);

    // Register player
    socket.on('register_player', (data) => {
        if (getPlayerCount() >= MAX_PLAYERS_TOTAL) {
            socket.emit('error', { message: 'Server is full (12/12 players)' });
            socket.disconnect();
            return;
        }

        const playerData = {
            id: socket.id,
            name: data.name || 'Anonymous',
            character: data.character || '⚔️',
            weapon: data.weapon || 'sword',
            joinedAt: new Date(),
            inGame: false,
            roomId: null,
            wins: 0,
            losses: 0
        };

        players[socket.id] = playerData;
        updateLeaderboard(socket.id, playerData);

        socket.emit('registered', {
            playerId: socket.id,
            playerCount: getPlayerCount(),
            maxPlayers: MAX_PLAYERS_TOTAL,
            availableSlots: getAvailableSlots()
        });

        // Broadcast updated stats
        io.emit('server_stats', {
            totalPlayers: getPlayerCount(),
            activeRooms: getRoomCount(),
            queuedPlayers: matchmakingQueue.length,
            maxPlayers: MAX_PLAYERS_TOTAL
        });

        console.log(`✅ Player registered: ${playerData.name} (${socket.id})`);
    });

    // Quick play (matchmaking)
    socket.on('quick_play', (data) => {
        if (!players[socket.id]) return;

        // Check if already in queue or game
        if (players[socket.id].inGame) {
            socket.emit('error', { message: 'Already in a game' });
            return;
        }

        if (matchmakingQueue.some(p => p.id === socket.id)) {
            socket.emit('error', { message: 'Already in matchmaking queue' });
            return;
        }

        players[socket.id].character = data.character;
        players[socket.id].weapon = data.weapon;
        players[socket.id].spawnDistance = data.spawnDistance;

        // Add to queue
        matchmakingQueue.push({
            id: socket.id,
            socketId: socket.id,
            character: data.character,
            weapon: data.weapon,
            spawnDistance: data.spawnDistance,
            queuedAt: Date.now()
        });

        socket.emit('queued', { position: matchmakingQueue.length });
        console.log(`⏳ Player queued for matchmaking: ${socket.id}, Queue: ${matchmakingQueue.length}`);

        // Try to match players
        matchPlayers();
    });

    // Create custom room
    socket.on('create_room', (data) => {
        if (!players[socket.id]) return;

        const roomId = generateRoomId();
        rooms[roomId] = {
            id: roomId,
            host: socket.id,
            player1: {
                id: socket.id,
                name: players[socket.id].name,
                character: data.character,
                weapon: data.weapon
            },
            player2: null,
            gameActive: false,
            spawnDistance: data.spawnDistance,
            createdAt: new Date(),
            startedAt: null,
            gameState: null,
            timeout: null
        };

        players[socket.id].inGame = true;
        players[socket.id].roomId = roomId;
        socket.join(roomId);

        // Set room timeout
        rooms[roomId].timeout = setTimeout(() => {
            if (rooms[roomId] && !rooms[roomId].gameActive) {
                io.to(roomId).emit('room_timeout', { message: 'Room timed out' });
                deleteRoom(roomId);
            }
        }, ROOM_TIMEOUT);

        socket.emit('room_created', {
            roomId,
            roomData: {
                id: rooms[roomId].id,
                host: rooms[roomId].player1.name,
                status: 'waiting'
            }
        });

        io.emit('room_list_updated', { rooms: getRoomsList() });
        console.log(`🏠 Room created: ${roomId}`);
    });

    // Join room
    socket.on('join_room', (data) => {
        const { roomId } = data;
        if (!players[socket.id]) return;

        if (!rooms[roomId]) {
            socket.emit('error', { message: 'Room not found' });
            return;
        }

        if (rooms[roomId].player2) {
            socket.emit('error', { message: 'Room is full' });
            return;
        }

        rooms[roomId].player2 = {
            id: socket.id,
            name: players[socket.id].name,
            character: data.character,
            weapon: data.weapon
        };

        players[socket.id].inGame = true;
        players[socket.id].roomId = roomId;
        socket.join(roomId);

        // Notify both players
        io.to(roomId).emit('players_ready', {
            player1: rooms[roomId].player1,
            player2: rooms[roomId].player2,
            spawnDistance: rooms[roomId].spawnDistance,
            isReady: true
        });

        io.emit('room_list_updated', { rooms: getRoomsList() });
        console.log(`👥 Player joined room ${roomId}`);
    });

    // Get rooms list
    socket.on('list_rooms', () => {
        socket.emit('rooms_list', getRoomsList());
    });

    // Get leaderboard
    socket.on('get_leaderboard', () => {
        socket.emit('leaderboard_update', {
            topPlayers: getTopPlayers(10),
            playerStats: leaderboard.get(socket.id) || null
        });
    });

    // Start game
    socket.on('start_game', (data) => {
        const roomId = players[socket.id]?.roomId;
        if (!roomId || !rooms[roomId]) return;

        rooms[roomId].gameActive = true;
        rooms[roomId].startedAt = new Date();

        io.to(roomId).emit('game_started', {
            player1: rooms[roomId].player1,
            player2: rooms[roomId].player2,
            spawnDistance: rooms[roomId].spawnDistance,
            timestamp: Date.now()
        });

        console.log(`🎮 Game started in room ${roomId}`);
    });

    // Sync game actions
    socket.on('game_action', (data) => {
        const roomId = players[socket.id]?.roomId;
        if (!roomId) return;

        io.to(roomId).emit('update_game', {
            playerId: socket.id,
            action: data.action,
            payload: data.payload
        });
    });

    // Game over
    socket.on('game_over', (data) => {
        const roomId = players[socket.id]?.roomId;
        if (!roomId || !rooms[roomId]) return;

        const { winnerId, loser1HP, loser2HP } = data;
        
        // Update leaderboard
        if (rooms[roomId].player1.id === winnerId) {
            players[rooms[roomId].player1.id].wins++;
            if (rooms[roomId].player2) {
                players[rooms[roomId].player2.id].losses++;
            }
        } else {
            players[rooms[roomId].player2.id].wins++;
            players[rooms[roomId].player1.id].losses++;
        }

        updateLeaderboard(rooms[roomId].player1.id, players[rooms[roomId].player1.id]);
        if (rooms[roomId].player2) {
            updateLeaderboard(rooms[roomId].player2.id, players[rooms[roomId].player2.id]);
        }

        io.to(roomId).emit('game_ended', {
            winnerId,
            player1Stats: {
                id: rooms[roomId].player1.id,
                name: rooms[roomId].player1.name,
                wins: players[rooms[roomId].player1.id].wins,
                losses: players[rooms[roomId].player1.id].losses
            },
            player2Stats: rooms[roomId].player2 ? {
                id: rooms[roomId].player2.id,
                name: rooms[roomId].player2.name,
                wins: players[rooms[roomId].player2.id].wins,
                losses: players[rooms[roomId].player2.id].losses
            } : null
        });

        // Broadcast updated leaderboard
        io.emit('leaderboard_update', {
            topPlayers: getTopPlayers(10)
        });

        console.log(`🏆 Game ended in room ${roomId}, Winner: ${winnerId}`);
    });

    // Disconnect
    socket.on('disconnect', () => {
        if (!players[socket.id]) return;

        const playerName = players[socket.id].name;
        const roomId = players[socket.id].roomId;

        // Remove from queue
        const queueIndex = matchmakingQueue.findIndex(p => p.id === socket.id);
        if (queueIndex !== -1) {
            matchmakingQueue.splice(queueIndex, 1);
        }

        // Notify room
        if (roomId && rooms[roomId]) {
            io.to(roomId).emit('player_disconnected', {
                playerId: socket.id,
                message: `${playerName} disconnected`
            });
            deleteRoom(roomId);
        }

        delete players[socket.id];
        io.emit('server_stats', {
            totalPlayers: getPlayerCount(),
            activeRooms: getRoomCount(),
            queuedPlayers: matchmakingQueue.length,
            maxPlayers: MAX_PLAYERS_TOTAL
        });

        console.log(`❌ Player disconnected: ${playerName}, Total: ${getPlayerCount()}`);
    });
});

// ============ MATCHMAKING FUNCTION ============
function matchPlayers() {
    while (matchmakingQueue.length >= 2) {
        const player1 = matchmakingQueue.shift();
        const player2 = matchmakingQueue.shift();

        const roomId = generateRoomId();
        rooms[roomId] = {
            id: roomId,
            host: player1.id,
            player1: {
                id: player1.id,
                name: players[player1.id].name,
                character: player1.character,
                weapon: player1.weapon
            },
            player2: {
                id: player2.id,
                name: players[player2.id].name,
                character: player2.character,
                weapon: player2.weapon
            },
            gameActive: false,
            spawnDistance: player1.spawnDistance,
            createdAt: new Date(),
            startedAt: null,
            gameState: null,
            timeout: null
        };

        players[player1.id].inGame = true;
        players[player1.id].roomId = roomId;
        players[player2.id].inGame = true;
        players[player2.id].roomId = roomId;

        // Notify both players
        const matchedPlayers = [
            io.sockets.sockets.get(player1.socketId),
            io.sockets.sockets.get(player2.socketId)
        ];

        matchedPlayers.forEach(s => {
            if (s) s.join(roomId);
        });

        io.to(roomId).emit('matched', {
            roomId,
            player1: rooms[roomId].player1,
            player2: rooms[roomId].player2,
            spawnDistance: rooms[roomId].spawnDistance,
            message: 'Matched! Game starts in 3 seconds...'
        });

        console.log(`✨ Players matched: ${player1.id} vs ${player2.id} in room ${roomId}`);

        // Set room timeout
        rooms[roomId].timeout = setTimeout(() => {
            if (rooms[roomId] && !rooms[roomId].gameActive) {
                io.to(roomId).emit('room_timeout', { message: 'Room timed out' });
                deleteRoom(roomId);
            }
        }, ROOM_TIMEOUT);
    }

    // Broadcast queue status
    io.emit('queue_status', { queuedPlayers: matchmakingQueue.length });
}

// ============ HELPER FUNCTIONS ============
function getRoomsList() {
    return Object.values(rooms)
        .filter(room => !room.player2)
        .map(room => ({
            id: room.id,
            host: room.player1.name,
            character: room.player1.character,
            weapon: room.player1.weapon,
            status: room.gameActive ? 'in-game' : 'waiting'
        }));
}

function deleteRoom(roomId) {
    if (rooms[roomId]) {
        const room = rooms[roomId];
        if (room.timeout) clearTimeout(room.timeout);

        // Mark players as not in game
        [room.player1, room.player2].forEach(player => {
            if (player && players[player.id]) {
                players[player.id].inGame = false;
                players[player.id].roomId = null;
            }
        });

        delete rooms[roomId];
    }
    io.emit('room_list_updated', { rooms: getRoomsList() });
}

// ============ SERVER START ============
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`
    🚀 ======================== SERVER STARTED ========================
    📍 Host: http://localhost:${PORT}
    👥 Max Players: ${MAX_PLAYERS_TOTAL}
    🎮 Max Players per Room: ${MAX_PLAYERS_PER_ROOM}
    ⏱️  Room Timeout: ${ROOM_TIMEOUT / 1000}s
    ================================================================
    `);
});

// Server stats logging
setInterval(() => {
    const stats = {
        timestamp: new Date().toISOString(),
        totalPlayers: getPlayerCount(),
        activeRooms: getRoomCount(),
        queuedPlayers: matchmakingQueue.length,
        availableSlots: getAvailableSlots()
    };
    console.log(`📊 ${JSON.stringify(stats)}`);
}, 30000); // Log every 30 seconds
