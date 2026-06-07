const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET','POST'] },
  transports: ['websocket', 'polling'],
  allowEIO3: true
});

app.use((req, res, next) => {
  res.setHeader('bypass-tunnel-reminder', 'true');
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

// ============ 常量 ============
const SUITS = ['♠', '♥', '♦', '♣'];
const RANKS = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
const RANK_VALUES = {};
RANKS.forEach((r, i) => RANK_VALUES[r] = i + 2);

const MAX_PLAYERS = 6;
const INITIAL_POINTS = 1000;
const DEFAULT_ANTE = 10;
const MAX_BET_LEVEL = 200;
const MAX_TURNS = 30;

// ============ 房间状态 ============
const rooms = {};

// ============ 扑克工具 ============
function createDeck() {
  const deck = [];
  for (const suit of SUITS) {
    for (const rank of RANKS) {
      deck.push({ suit, rank, value: RANK_VALUES[rank] });
    }
  }
  return deck;
}

function shuffle(deck) {
  const d = [...deck];
  for (let i = d.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [d[i], d[j]] = [d[j], d[i]];
  }
  return d;
}

// ============ 牌型判断 ============
function evaluateHand(cards) {
  const sorted = [...cards].sort((a, b) => b.value - a.value);
  const vals = sorted.map(c => c.value);
  const suits = sorted.map(c => c.suit);

  const isFlush = suits[0] === suits[1] && suits[1] === suits[2];

  let isStraight = false;
  let straightHigh = vals[0];

  if (vals[0] - vals[1] === 1 && vals[1] - vals[2] === 1) {
    isStraight = true;
    straightHigh = vals[0];
  } else if (vals[0] === 14 && vals[1] === 3 && vals[2] === 2) {
    isStraight = true;
    straightHigh = 3; // A-2-3最小顺子
  }

  const isTriple = vals[0] === vals[1] && vals[1] === vals[2];

  let pairRank = 0, kicker = 0, isPair = false;
  if (vals[0] === vals[1]) { isPair = true; pairRank = vals[0]; kicker = vals[2]; }
  else if (vals[1] === vals[2]) { isPair = true; pairRank = vals[1]; kicker = vals[0]; }

  let type, typeName, cmpVals;

  if (isTriple) {
    type = 6; typeName = '豹子'; cmpVals = [vals[0]];
  } else if (isFlush && isStraight) {
    type = 5; typeName = '同花顺'; cmpVals = [straightHigh];
  } else if (isFlush) {
    type = 4; typeName = '同花'; cmpVals = vals;
  } else if (isStraight) {
    type = 3; typeName = '顺子'; cmpVals = [straightHigh];
  } else if (isPair) {
    type = 2; typeName = '对子'; cmpVals = [pairRank, kicker];
  } else {
    type = 1; typeName = '散牌'; cmpVals = vals;
  }

  return { type, typeName, cmpVals };
}

// 返回 >0 表示 hand1 赢, <0 表示 hand2 赢, 0 表示平局(挑战者输)
function compareHands(cards1, cards2) {
  const h1 = evaluateHand(cards1);
  const h2 = evaluateHand(cards2);
  if (h1.type !== h2.type) return h1.type > h2.type ? 1 : -1;
  for (let i = 0; i < Math.min(h1.cmpVals.length, h2.cmpVals.length); i++) {
    if (h1.cmpVals[i] !== h2.cmpVals[i]) return h1.cmpVals[i] > h2.cmpVals[i] ? 1 : -1;
  }
  return -1; // 平局时挑战者输
}

// ============ 房间管理 ============
function generateRoomId() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function createRoom(hostId, hostName, ante) {
  let roomId;
  do { roomId = generateRoomId(); } while (rooms[roomId]);

  rooms[roomId] = {
    id: roomId,
    host: hostId,
    ante: ante || DEFAULT_ANTE,
    players: [makePlayer(hostId, hostName)],
    gameStarted: false,
    pot: 0,
    currentBet: 0,
    currentPlayerIndex: -1,
    turnCount: 0,
    deck: [],
    messages: []
  };
  return roomId;
}

function makePlayer(id, name) {
  return {
    id, name,
    points: INITIAL_POINTS,
    cards: [],
    looked: false,
    folded: false,
    totalBet: 0,
    connected: true
  };
}

function joinRoom(roomId, playerId, playerName) {
  const room = rooms[roomId];
  if (!room) return { error: '房间不存在' };
  if (room.gameStarted) return { error: '游戏进行中，无法加入' };
  if (room.players.length >= MAX_PLAYERS) return { error: '房间已满(最多6人)' };
  if (room.players.find(p => p.id === playerId)) return { error: '你已在房间中' };
  room.players.push(makePlayer(playerId, playerName));
  return { success: true };
}

function leaveRoom(roomId, playerId) {
  const room = rooms[roomId];
  if (!room) return;

  const pi = room.players.findIndex(p => p.id === playerId);
  if (pi === -1) return;

  if (room.gameStarted) {
    room.players[pi].folded = true;
    room.players[pi].connected = false;
    if (room.currentPlayerIndex === pi) moveToNextPlayer(roomId);
    checkGameEnd(roomId);
  } else {
    room.players.splice(pi, 1);
  }

  // 转移房主
  if (room.host === playerId) {
    const alive = room.players.filter(p => p.connected);
    if (alive.length > 0) room.host = alive[0].id;
  }

  // 清理空房间
  const active = room.players.filter(p => p.connected);
  if (active.length === 0) delete rooms[roomId];
}

// ============ 游戏逻辑 ============
function startGame(roomId) {
  const room = rooms[roomId];
  if (!room || room.gameStarted) return;
  const connected = room.players.filter(p => p.connected);
  if (connected.length < 2) return;

  room.gameStarted = true;
  room.pot = 0;
  room.currentBet = room.ante;
  room.turnCount = 0;
  room.deck = shuffle(createDeck());

  // 过滤掉断线玩家
  room.players = room.players.filter(p => p.connected);

  room.players.forEach(p => {
    p.cards = [room.deck.pop(), room.deck.pop(), room.deck.pop()];
    p.looked = false;
    p.folded = false;
    p.totalBet = 0;
    const ante = Math.min(room.ante, p.points);
    p.points -= ante;
    p.totalBet += ante;
    room.pot += ante;
  });

  // 房主下一位开始
  const hi = room.players.findIndex(p => p.id === room.host);
  room.currentPlayerIndex = (hi + 1) % room.players.length;

  broadcastRoomState(roomId);
  io.to(roomId).emit('gameMessage', { text: '游戏开始！底注已扣除，请轮流出牌' });
}

function getActive(room) {
  return room.players.filter(p => !p.folded && p.connected);
}

function moveToNextPlayer(roomId) {
  const room = rooms[roomId];
  if (!room) return;
  if (getActive(room).length <= 1) return;

  let next = (room.currentPlayerIndex + 1) % room.players.length;
  let tries = 0;
  while ((room.players[next].folded || !room.players[next].connected) && tries < room.players.length) {
    next = (next + 1) % room.players.length;
    tries++;
  }
  room.currentPlayerIndex = next;
  room.turnCount++;

  if (room.turnCount >= MAX_TURNS) {
    forceShowdown(roomId);
  }
}

function checkGameEnd(roomId) {
  const room = rooms[roomId];
  if (!room) return;
  if (getActive(room).length <= 1) endGame(roomId);
}

function endGame(roomId) {
  const room = rooms[roomId];
  if (!room) return;

  const active = getActive(room);
  const winner = active[0] || null;

  if (winner) {
    winner.points += room.pot;
  }

  const result = {
    winner: winner ? { id: winner.id, name: winner.name } : null,
    pot: room.pot,
    allCards: room.players.map(p => ({
      id: p.id, name: p.name, cards: p.cards,
      hand: p.cards.length ? evaluateHand(p.cards) : null,
      folded: p.folded, totalBet: p.totalBet
    }))
  };

  io.to(roomId).emit('gameEnd', result);
  room.gameStarted = false;
  room.pot = 0;

  // 移除0分且断线的玩家
  room.players = room.players.filter(p => p.points > 0 || p.connected);
  broadcastRoomState(roomId);
}

function forceShowdown(roomId) {
  const room = rooms[roomId];
  if (!room) return;
  const active = getActive(room);
  if (active.length <= 1) { endGame(roomId); return; }

  // 找最大牌
  let best = active[0];
  for (let i = 1; i < active.length; i++) {
    if (compareHands(active[i].cards, best.cards) > 0) {
      best = active[i];
    }
  }
  // 标记其他人弃牌
  active.forEach(p => { if (p.id !== best.id) p.folded = true; });
  endGame(roomId);
}

// ============ 玩家操作 ============
function playerAction(roomId, playerId, action, data) {
  const room = rooms[roomId];
  if (!room || !room.gameStarted) return;

  const player = room.players.find(p => p.id === playerId);
  if (!player || player.folded || !player.connected) return;

  const pi = room.players.findIndex(p => p.id === playerId);
  if (pi !== room.currentPlayerIndex) return;

  switch (action) {
    case 'look':
      player.looked = true;
      broadcastRoomState(roomId);
      io.to(roomId).emit('gameMessage', { text: `${player.name} 看了牌` });
      return; // 看牌不轮转

    case 'call': {
      const cost = player.looked ? room.currentBet * 2 : room.currentBet;
      if (player.points < cost) {
        io.to(playerId).emit('errorMessage', '积分不足！');
        return;
      }
      player.points -= cost;
      player.totalBet += cost;
      room.pot += cost;
      io.to(roomId).emit('gameMessage', {
        text: `${player.name} 跟注 ${cost}分${player.looked ? ' (明牌)' : ' (暗牌)'}`
      });
      break;
    }

    case 'raise': {
      const newBet = Math.min(room.currentBet * 2, MAX_BET_LEVEL);
      if (newBet === room.currentBet) {
        io.to(playerId).emit('errorMessage', '已到最大注额！');
        return;
      }
      const cost = player.looked ? newBet * 2 : newBet;
      if (player.points < cost) {
        io.to(playerId).emit('errorMessage', '积分不足！');
        return;
      }
      room.currentBet = newBet;
      player.points -= cost;
      player.totalBet += cost;
      room.pot += cost;
      io.to(roomId).emit('gameMessage', {
        text: `${player.name} 加注！当前注额 ${room.currentBet}，下注 ${cost}分`
      });
      break;
    }

    case 'compare': {
      const targetId = data && data.targetId;
      const target = room.players.find(p => p.id === targetId);
      if (!target || target.folded || !target.connected || targetId === playerId) return;

      const cost = player.looked ? room.currentBet * 2 : room.currentBet;
      if (player.points < cost) {
        io.to(playerId).emit('errorMessage', '积分不足！');
        return;
      }
      player.points -= cost;
      player.totalBet += cost;
      room.pot += cost;

      const result = compareHands(player.cards, target.cards);
      let loser, winner2;
      if (result > 0) {
        target.folded = true;
        loser = target; winner2 = player;
      } else {
        player.folded = true;
        loser = player; winner2 = target;
      }

      io.to(roomId).emit('compareResult', {
        challenger: { id: player.id, name: player.name, cards: player.cards, hand: evaluateHand(player.cards) },
        target: { id: target.id, name: target.name, cards: target.cards, hand: evaluateHand(target.cards) },
        winnerId: winner2.id,
        loserId: loser.id
      });
      io.to(roomId).emit('gameMessage', {
        text: `${player.name} 与 ${target.name} 比牌 → ${winner2.name} 胜！`
      });
      break;
    }

    case 'fold':
      player.folded = true;
      io.to(roomId).emit('gameMessage', { text: `${player.name} 弃牌` });
      break;

    default:
      return;
  }

  moveToNextPlayer(roomId);
  checkGameEnd(roomId);
  broadcastRoomState(roomId);
}

// ============ 广播 ============
function getPublicState(roomId, forPlayerId) {
  const room = rooms[roomId];
  if (!room) return null;

  return {
    id: room.id,
    host: room.host,
    ante: room.ante,
    gameStarted: room.gameStarted,
    pot: room.pot,
    currentBet: room.currentBet,
    currentPlayerIndex: room.currentPlayerIndex,
    players: room.players.map(p => ({
      id: p.id,
      name: p.name,
      points: p.points,
      looked: p.looked,
      folded: p.folded,
      totalBet: p.totalBet,
      connected: p.connected,
      // 只返回自己的牌
      cards: p.id === forPlayerId ? p.cards : (p.cards.length ? [null, null, null] : []),
      isCurrentTurn: room.gameStarted && room.players[room.currentPlayerIndex] && room.players[room.currentPlayerIndex].id === p.id
    }))
  };
}

function broadcastRoomState(roomId) {
  const room = rooms[roomId];
  if (!room) return;
  room.players.forEach(p => {
    if (p.connected) {
      io.to(p.id).emit('roomState', getPublicState(roomId, p.id));
    }
  });
}

// ============ Socket.io ============
io.on('connection', (socket) => {
  let currentRoomId = null;
  let playerName = '';

  socket.on('setName', (name) => {
    playerName = name || '匿名玩家';
  });

  socket.on('createRoom', (ante, callback) => {
    if (currentRoomId) {
      leaveRoom(currentRoomId, socket.id);
    }
    const anteVal = Math.max(5, Math.min(100, parseInt(ante) || DEFAULT_ANTE));
    const roomId = createRoom(socket.id, playerName, anteVal);
    currentRoomId = roomId;
    socket.join(roomId);
    broadcastRoomState(roomId);
    if (callback) callback({ roomId });
  });

  socket.on('joinRoom', (roomId, callback) => {
    if (currentRoomId) {
      leaveRoom(currentRoomId, socket.id);
    }
    const result = joinRoom(roomId, socket.id, playerName);
    if (result.success) {
      currentRoomId = roomId;
      socket.join(roomId);
      broadcastRoomState(roomId);
      io.to(roomId).emit('gameMessage', { text: `${playerName} 加入了房间` });
    }
    if (callback) callback(result);
  });

  socket.on('startGame', () => {
    if (currentRoomId && rooms[currentRoomId] && rooms[currentRoomId].host === socket.id) {
      startGame(currentRoomId);
    }
  });

  socket.on('action', (action, data) => {
    if (currentRoomId) playerAction(currentRoomId, socket.id, action, data);
  });

  socket.on('chat', (msg) => {
    if (currentRoomId && msg && msg.trim()) {
      io.to(currentRoomId).emit('chat', { name: playerName, text: msg.trim().slice(0, 200) });
    }
  });

  socket.on('disconnect', () => {
    if (currentRoomId) {
      leaveRoom(currentRoomId, socket.id);
      if (rooms[currentRoomId]) broadcastRoomState(currentRoomId);
      currentRoomId = null;
    }
  });
});

const PORT = process.env.PORT || 3000;
const os = require('os');

server.listen(PORT, '0.0.0.0', () => {
  console.log('🃏 炸金花服务器已启动！');
  console.log('⚠️  仅供娱乐，禁止赌博！');
  console.log('');
  console.log('📡 本机访问:');
  console.log(`   http://localhost:${PORT}`);

  // 显示局域网IP
  const nets = os.networkInterfaces();
  const lanIPs = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        lanIPs.push(net.address);
      }
    }
  }
  if (lanIPs.length > 0) {
    console.log('📡 局域网访问:');
    lanIPs.forEach(ip => console.log(`   http://${ip}:${PORT}`));
  }
  console.log('');

  // 自动开启外网隧道
  const tunnelFlag = process.argv.includes('--tunnel') || process.argv.includes('-t');
  if (tunnelFlag) {
    startTunnel(PORT);
  } else {
    console.log('💡 如需外网访问，请运行:');
    console.log(`   node server.js --tunnel`);
    console.log('   或手动使用 ngrok / cloudflared');
    console.log('');
  }
});

async function startTunnel(port) {
  try {
    const { default: localTunnel } = await import('localtunnel');
    const tunnel = await localTunnel({ port });
    console.log('🌍 外网隧道已开启！');
    console.log(`   👉 ${tunnel.url}`);
    console.log('');
    console.log('📢 把上面这个网址发给朋友就能玩了！');
    console.log('⚠️  隧道可能偶尔断开，断开请重启');
    console.log('');

    tunnel.on('close', () => {
      console.log('❌ 外网隧道已断开，请重启服务器');
    });

    tunnel.on('error', (err) => {
      console.log('❌ 隧道错误:', err.message);
      console.log('请尝试重新运行: node server.js --tunnel');
    });
  } catch (e) {
    console.log('❌ 无法启动隧道:', e.message);
    console.log('');
    console.log('备选方案：');
    console.log('1. 安装 ngrok: https://ngrok.com/download');
    console.log(`   然后运行: ngrok http ${port}`);
    console.log('2. 安装 cloudflared: https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/install-and-setup/');
    console.log(`   然后运行: cloudflared tunnel --url http://localhost:${port}`);
  }
}
