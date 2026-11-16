require('dotenv').config();

const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { Server } = require('socket.io');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const srv = http.createServer(app);
const io = new Server(srv, {
  cors: { origin: process.env.CORS_ORIGIN || '*' }
});

const sb = process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY
  ? createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    )
  : null;

const MAX_PER_ROOM = 10;
const MIN_PLAYERS = Math.max(2, Number(process.env.MIN_PLAYERS) || 2);

const LEN = 200;
const HW = 6;
const DT = 1 / 30;
const SPIN = [-50, -100, -150];

const rooms = new Map();

app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/config', (req, res) => {
  res.json({
    url: process.env.SUPABASE_URL || '',
    key: process.env.SUPABASE_ANON_KEY || ''
  });
});

// Verificar la sesión de cada jugador
io.use(async (socket, next) => {
  try {
    if (!sb) {
      socket.data = {
        uid: null,
        name: String(socket.handshake.auth.name || 'Invitado').slice(0, 16)
      };
      return next();
    }

    const { data, error } = await sb.auth.getUser(
      socket.handshake.auth.token || ''
    );

    if (error || !data.user) {
      return next(new Error('Sesión no válida'));
    }

    const { data: profile } = await sb
      .from('profiles')
      .select('username')
      .eq('id', data.user.id)
      .single();

    socket.data = {
      uid: data.user.id,
      name: profile?.username || 'Jugador'
    };

    next();
  } catch (error) {
    next(new Error('Error de autenticación'));
  }
});

// Crear un código de sala
function makeCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;

  do {
    code = '';
    for (let i = 0; i < 6; i++) {
      code += chars[Math.floor(Math.random() * chars.length)];
    }
  } while (rooms.has(code));

  return code;
}

// Crear una sala nueva
function makeRoom(code, ownerId) {
  return {
    code,
    ownerId,
    players: new Map(),
    phase: 'lobby',
    cd: 0,
    rt: 0,
    order: [],
    resT: 0
  };
}
// Posición inicial de los jugadores
function spawn(p) {
  p.x = (Math.random() - 0.5) * 10;
  p.z = 2 + Math.random() * 3;
  p.y = 0;
  p.vy = 0;
  p.cp = 3;
  p.fin = 0;
  p.grounded = true;
}

// Información de la sala
function roomState(room) {
  return {
    code: room.code,
    ownerId: room.ownerId,
    ph: room.phase,
    cd: Math.ceil(room.cd),
    rt: room.rt,
    n: room.players.size,
    max: MAX_PER_ROOM,
    pl: [...room.players.values()].map(p => [
      p.id,
      p.name,
      +p.x.toFixed(2),
      +p.y.toFixed(2),
      +p.z.toFixed(2),
      +p.r.toFixed(2),
      p.fin
    ])
  };
}

// Enviar información a los jugadores de una sala
function broadcastRoom(room) {
  io.to(room.code).emit('s', roomState(room));
}

// Movimiento de los jugadores
function step(p, room) {
  const { mx, mz, j, s } = p.inp;
  const speed = s ? 11 : 7;

  p.x += mx * speed * DT;
  p.z += mz * speed * DT;

  if (mx || mz) {
    p.r = Math.atan2(mx, mz);
  }

  const ground =
    Math.abs(p.x) <= HW &&
    p.z <= 5 &&
    p.z >= -LEN - 10;

  p.vy -= 30 * DT;
  p.y += p.vy * DT;

  if (ground && p.y <= 0 && p.vy <= 0) {
    p.y = 0;
    p.vy = 0;
    p.grounded = true;
  } else {
    p.grounded = false;
  }

  if (j && p.grounded) {
    p.vy = 11;
    p.grounded = false;
  }

  if (p.y < -15) {
    p.x = 0;
    p.z = p.cp;
    p.y = 0.5;
    p.vy = 0;
  }

  const cpz = -Math.floor(Math.max(0, -p.z) / 50) * 50;

  if (p.y >= 0 && ground) {
    p.cp = cpz === 0 ? 3 : cpz;
  }

  SPIN.forEach((sz, k) => {
    const a = room.rt * 1.6 + k;
    const c = Math.cos(a);
    const si = Math.sin(a);

    const dx = p.x;
    const dz = p.z - sz;

    const u = dx * c + dz * si;
    const v = -dx * si + dz * c;

    if (Math.abs(u) < 5 && Math.abs(v) < 0.7 && p.y < 1.6) {
      const n = v >= 0 ? 1 : -1;
      p.x += -si * n * 0.9;
      p.z += c * n * 0.9;
    }
  });

  if (!p.fin && p.z < -LEN) {
    room.order.push(p);
    p.fin = room.order.length;
  }
}

// Guardar recompensas de la partida
async function reward(room, list) {
  const match = crypto.randomUUID();

  for (const p of list) {
    const position = p.fin || 0;
    const coins =
      10 +
      (position ? 20 : 0) +
      (position === 1 ? 50 : 0);

    p.coins = coins;

    if (sb && p.uid) {
      const { error } = await sb.rpc('award_match', {
        p_player: p.uid,
        p_match: match,
        p_position: position || 99,
        p_coins: coins
      });

      if (error) {
        console.error('Error al guardar recompensa:', error.message);
      }
    }
  }
}
// Buscar la sala donde está un jugador
function findRoomForSocket(socketId) {
  for (const room of rooms.values()) {
    if (room.players.has(socketId)) return room;
  }
  return null;
}

// Salir de la sala actual
function leaveCurrentRoom(socket) {
  const oldRoom = findRoomForSocket(socket.id);
  if (!oldRoom) return;

  oldRoom.players.delete(socket.id);
  socket.leave(oldRoom.code);

  if (!oldRoom.players.size) {
    rooms.delete(oldRoom.code);
  } else {
    if (oldRoom.ownerId === socket.id) {
      oldRoom.ownerId = oldRoom.players.keys().next().value;
    }
    broadcastRoom(oldRoom);
  }
}

// Agregar jugador a una sala
function addPlayer(room, socket) {
  const p = {
    id: socket.id,
    uid: socket.data.uid,
    name: socket.data.name,
    r: 0,
    grounded: true,
    inp: { mx: 0, mz: 0, j: false, s: false }
  };

  spawn(p);
  room.players.set(socket.id, p);
  socket.join(room.code);

  socket.emit('room-joined', {
    code: room.code,
    owner: room.ownerId === socket.id,
    n: room.players.size,
    max: MAX_PER_ROOM
  });

  broadcastRoom(room);
}

// Conexiones
io.on('connection', socket => {

  // Crear sala
  socket.on('create-room', () => {
    leaveCurrentRoom(socket);

    const code = makeCode();
    const room = makeRoom(code, socket.id);

    rooms.set(code, room);
    addPlayer(room, socket);
  });

  // Unirse con código
  socket.on('join-room', rawCode => {
    const code = String(rawCode || '').trim().toUpperCase();
    const room = rooms.get(code);

    if (!room) {
      return socket.emit('room-error', 'No existe esa sala. Revisa el código.');
    }

    if (room.phase !== 'lobby') {
      return socket.emit('room-error', 'La partida ya comenzó.');
    }

    if (room.players.size >= MAX_PER_ROOM) {
      return socket.emit('room-error', 'La sala está llena (10/10).');
    }

    leaveCurrentRoom(socket);
    addPlayer(room, socket);
  });

  // Iniciar partida
  socket.on('start-match', () => {
    const room = findRoomForSocket(socket.id);

    if (!room) {
      return socket.emit('room-error', 'Primero debes entrar a una sala.');
    }

    if (room.ownerId !== socket.id) {
      return socket.emit('room-error', 'Solo el creador puede iniciar la partida.');
    }

    if (room.phase !== 'lobby') return;

    if (room.players.size < MIN_PLAYERS) {
      return socket.emit(
        'room-error',
        `Se necesitan al menos ${MIN_PLAYERS} jugadores para comenzar.`
      );
    }

    room.phase = 'countdown';
    room.cd = 5;
    broadcastRoom(room);
  });

  // Recibir controles
  socket.on('in', input => {
    const room = findRoomForSocket(socket.id);
    if (!room || room.phase !== 'race') return;

    const p = room.players.get(socket.id);
    if (!p) return;

    let mx = Number(input?.mx) || 0;
    let mz = Number(input?.mz) || 0;
    const length = Math.hypot(mx, mz);

    if (length > 1) {
      mx /= length;
      mz /= length;
    }

    p.inp = {
      mx,
      mz,
      j: !!input?.j,
      s: !!input?.s
    };
  });

  // Cuando un jugador se desconecta
  socket.on('disconnect', () => {
    const room = findRoomForSocket(socket.id);
    if (!room) return;

    room.players.delete(socket.id);

    if (!room.players.size) {
      rooms.delete(room.code);
      return;
    }

    if (room.ownerId === socket.id) {
      room.ownerId = room.players.keys().next().value;
    }

    broadcastRoom(room);
  });
});

// Actualizar todas las salas
setInterval(() => {
  for (const room of rooms.values()) {
    const players = [...room.players.values()];

    if (room.phase === 'countdown') {
      if (players.length < MIN_PLAYERS) {
        room.phase = 'lobby';
        room.cd = 0;
      } else if ((room.cd -= DT) <= 0) {
        room.phase = 'race';
        room.rt = 0;
        room.order = [];
        players.forEach(spawn);
      }

    } else if (room.phase === 'race') {
      room.rt += DT;
      players.forEach(p => step(p, room));

      // Evitar que los jugadores se atraviesen
      for (let i = 0; i < players.length; i++) {
        for (let k = i + 1; k < players.length; k++) {
          const a = players[i];
          const b = players[k];

          const dx = b.x - a.x;
          const dz = b.z - a.z;
          const distance = Math.hypot(dx, dz);

          if (
            distance < 1 &&
            distance > 0.001 &&
            Math.abs(a.y - b.y) < 1.5
          ) {
            const force = (1 - distance) / 2;

            a.x -= dx / distance * force;
            a.z -= dz / distance * force;
            b.x += dx / distance * force;
            b.z += dz / distance * force;
          }
        }
      }

      if (
        players.length &&
        (players.every(p => p.fin) || room.rt > 90)
      ) {
        room.phase = 'results';
        room.resT = 8;

        const list = players.slice().sort(
          (a, b) => (a.fin || 99) - (b.fin || 99)
        );

        reward(room, list).then(() => {
          io.to(room.code).emit(
            'results',
            list.map(p => ({
              id: p.id,
              n: p.name,
              pos: p.fin,
              coins: p.coins
            }))
          );
        });
      }

    } else if (room.phase === 'results') {
      if ((room.resT -= DT) <= 0) {
        room.phase = 'lobby';
        room.cd = 0;
        players.forEach(spawn);
      }
    }

    broadcastRoom(room);
  }
}, 1000 / 30);

// Encender servidor
srv.listen(process.env.PORT || 3000, () => {
  console.log(
    'TROPIEZOS EXTREMOS en http://localhost:' +
    (process.env.PORT || 3000)
  );
});
