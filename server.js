require('dotenv').config();
const express = require('express'), http = require('http'), path = require('path'), crypto = require('crypto');
const { Server } = require('socket.io');
const { createClient } = require('@supabase/supabase-js');

const app = express(), srv = http.createServer(app);
const io = new Server(srv, { cors: { origin: process.env.CORS_ORIGIN || '*' } });
const sb = process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY) : null;

const MAX = 30, MIN = +process.env.MIN_PLAYERS || 2, LEN = 200, HW = 6, DT = 1 / 30;
const SPIN = [-50, -100, -150];

app.use(express.static(path.join(__dirname, '../frontend')));
app.get('/config', (q, s) => s.json({ url: process.env.SUPABASE_URL || '', key: process.env.SUPABASE_ANON_KEY || '' }));

const P = new Map();
let phase = 'lobby', cd = 0, rt = 0, order = [], resT = 0;

// Verifica la sesión de Supabase; sin Supabase configurado se permiten invitados (solo pruebas locales).
io.use(async (s, next) => {
  try {
    if (P.size >= MAX) return next(new Error('Sala llena (30/30)'));
    if (!sb) { s.data = { uid: null, name: String(s.handshake.auth.name || 'Invitado').slice(0, 16) }; return next(); }
    const { data, error } = await sb.auth.getUser(s.handshake.auth.token || '');
    if (error || !data.user) return next(new Error('Sesión no válida'));
    const { data: pr } = await sb.from('profiles').select('username').eq('id', data.user.id).single();
    s.data = { uid: data.user.id, name: pr?.username || 'Jugador' };
    next();
  } catch (e) { next(new Error('Error de autenticación')); }
});

function spawn(p) { p.x = (Math.random() - .5) * 10; p.z = 2 + Math.random() * 3; p.y = 0; p.vy = 0; p.cp = 3; p.fin = 0; }

io.on('connection', s => {
  for (const q of P.values()) if (s.data.uid && q.uid === s.data.uid) { io.sockets.sockets.get(q.id)?.disconnect(true); P.delete(q.id); }
  const p = { id: s.id, uid: s.data.uid, name: s.data.name, r: 0, grounded: true, inp: { mx: 0, mz: 0, j: 0, s: 0 } };
  spawn(p); P.set(s.id, p);
  s.on('in', i => { // el servidor limita el input: dirección normalizada, sin posiciones enviadas por el cliente
    let mx = +i.mx || 0, mz = +i.mz || 0; const l = Math.hypot(mx, mz);
    if (l > 1) { mx /= l; mz /= l; }
    p.inp = { mx, mz, j: !!i.j, s: !!i.s };
  });
  s.on('disconnect', () => P.delete(s.id));
});

function step(p) {
  const { mx, mz, j, s } = p.inp, sp = s ? 11 : 7;
  p.x += mx * sp * DT; p.z += mz * sp * DT;
  if (mx || mz) p.r = Math.atan2(mx, mz);
  const ground = Math.abs(p.x) <= HW && p.z <= 5 && p.z >= -LEN - 10;
  p.vy -= 30 * DT; p.y += p.vy * DT;
  if (ground && p.y <= 0 && p.vy <= 0) { p.y = 0; p.vy = 0; p.grounded = true; } else p.grounded = false;
  if (j && p.grounded) { p.vy = 11; p.grounded = false; }
  if (p.y < -15) { p.x = 0; p.z = p.cp; p.y = 0.5; p.vy = 0; } // reaparece en el último punto de control
  const cpz = -Math.floor(Math.max(0, -p.z) / 50) * 50; if (p.y >= 0 && ground) p.cp = cpz === 0 ? 3 : cpz;
  SPIN.forEach((sz, k) => { // barras giratorias
    const a = rt * 1.6 + k, c = Math.cos(a), si = Math.sin(a), dx = p.x, dz = p.z - sz;
    const u = dx * c + dz * si, v = -dx * si + dz * c;
    if (Math.abs(u) < 5 && Math.abs(v) < 0.7 && p.y < 1.6) { const n = v >= 0 ? 1 : -1; p.x += -si * n * 0.9; p.z += c * n * 0.9; }
  });
  if (!p.fin && p.z < -LEN) { order.push(p); p.fin = order.length; }
}

async function reward(list) {
  const match = crypto.randomUUID();
  for (const p of list) {
    const pos = p.fin || 0, coins = 10 + (pos ? 20 : 0) + (pos === 1 ? 50 : 0);
    p.coins = coins;
    if (sb && p.uid) { const { error } = await sb.rpc('award_match', { p_player: p.uid, p_match: match, p_position: pos || 99, p_coins: coins }); if (error) console.error(error.message); }
  }
}

setInterval(() => {
  const n = P.size;
  if (phase === 'lobby' && n >= MIN) { phase = 'countdown'; cd = 10; }
  else if (phase === 'countdown') { if (n < MIN) phase = 'lobby'; else if ((cd -= DT) <= 0) { phase = 'race'; rt = 0; order = []; P.forEach(p => { spawn(p); }); } }
  else if (phase === 'race') {
    rt += DT; const ps = [...P.values()]; ps.forEach(step);
    for (let i = 0; i < ps.length; i++) for (let k = i + 1; k < ps.length; k++) { // empujones entre jugadores
      const a = ps[i], b = ps[k], dx = b.x - a.x, dz = b.z - a.z, d = Math.hypot(dx, dz);
      if (d < 1 && d > 0.001 && Math.abs(a.y - b.y) < 1.5) { const f = (1 - d) / 2; a.x -= dx / d * f; a.z -= dz / d * f; b.x += dx / d * f; b.z += dz / d * f; }
    }
    if (ps.length && (ps.every(p => p.fin) || rt > 90)) {
      phase = 'results'; resT = 8; const list = ps.slice().sort((a, b) => (a.fin || 99) - (b.fin || 99));
      reward(list).then(() => io.emit('results', list.map(p => ({ id: p.id, n: p.name, pos: p.fin, coins: p.coins }))));
    }
  } else if (phase === 'results' && (resT -= DT) <= 0) { phase = 'lobby'; P.forEach(spawn); }
  io.emit('s', { ph: phase, cd: Math.ceil(cd), rt, n, pl: [...P.values()].map(p => [p.id, p.name, +p.x.toFixed(2), +p.y.toFixed(2), +p.z.toFixed(2), +p.r.toFixed(2), p.fin]) });
}, 1000 / 30);

srv.listen(process.env.PORT || 3000, () => console.log('TROPIEZOS EXTREMOS en http://localhost:' + (process.env.PORT || 3000)));
