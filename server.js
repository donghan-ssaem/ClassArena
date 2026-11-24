'use strict';
const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { Server } = require('socket.io');
const QRCode = require('qrcode');
const { MINIGAMES, GRACE_MS } = require('./lib/minigames');
const sheet = require('./lib/sheet');

const PORT = process.env.PORT || 3000;
const DEFAULT_MAX = 50;          // 방 기본 인원
const HARD_MAX = 80;             // 관리자가 늘릴 수 있는 최대 인원
const LOCK_MS = 1500;            // 퀴즈 오답 시 잠금
const ROOM_TTL_MS = 8 * 3600e3;  // 8시간 활동 없으면 방 삭제
const TICK_MS = 200;             // 실시간 순위 전송 간격

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  transports: ['websocket', 'polling'],
  pingInterval: 10000,
  pingTimeout: 25000,
  maxHttpBufferSize: 1e6,
  perMessageDeflate: false,
});

app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1h', extensions: ['html'] }));
app.get('/favicon.ico', (_q, r) => r.status(204).end());
app.get('/healthz', (_q, r) => r.type('text').send('ok'));
app.get('/qr', async (req, res) => {
  try {
    const u = String(req.query.u || '').slice(0, 300);
    if (!/^https?:\/\//.test(u)) return res.status(400).end();
    const svg = await QRCode.toString(u, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
    res.type('image/svg+xml').set('Cache-Control', 'public, max-age=3600').send(svg);
  } catch (e) { res.status(500).end(); }
});

/* ================= 상태 ================= */
const rooms = new Map();
const now = () => Date.now();
const rid = (n) => crypto.randomBytes(n).toString('hex');
const clean = (s, n) => String(s == null ? '' : s).replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, n);

function makeCode() {
  for (let i = 0; i < 500; i++) {
    const c = String(Math.floor(100000 + Math.random() * 900000));
    if (!rooms.has(c)) return c;
  }
  throw new Error('code');
}

function createRoom() {
  const room = {
    code: makeCode(), hostKey: rid(16), maxPlayers: DEFAULT_MAX,
    players: new Map(), phase: 'lobby',
    rounds: [],          // 끝난 미니게임 목록 [{n, game, title}]
    mini: null,          // 진행 중/직전 미니게임
    quiz: null,          // 진행 중/직전 퀴즈
    dirtyPlayers: true, dirtyLive: false, lastActive: now(),
  };
  room.tick = setInterval(() => roomTick(room), TICK_MS);
  rooms.set(room.code, room);
  return room;
}
function destroyRoom(room) {
  clearInterval(room.tick);
  if (room.mini) clearTimeout(room.mini.timer);
  rooms.delete(room.code);
}

const H = (r) => r.code + ':h';
const P = (r) => r.code + ':p';
const touch = (r) => { r.lastActive = now(); };

/* ---- 순위 계산 (동점은 같은 등수) ---- */
function rankList(items, cmp) {
  const arr = items.slice().sort(cmp);
  let prev = null, prevRank = 0;
  return arr.map((x, i) => {
    const rank = prev && cmp(prev, x) === 0 ? prevRank : i + 1;
    prev = x; prevRank = rank;
    return { item: x, rank };
  });
}
const pointsFor = (rank) => Math.max(1, 51 - rank); // 1등 50점, n등 51-n점 (51등 이하는 1점)

function totalRanking(room) {
  return rankList([...room.players.values()], (a, b) => b.total - a.total)
    .map(({ item: p, rank }) => ({ rank, id: p.id, name: p.name, total: p.total, connected: p.connected }));
}

function scoresPayload(room) {
  return {
    rounds: room.rounds,
    players: totalRanking(room).map((r) => ({ ...r, pts: room.players.get(r.id).pts })),
  };
}

/* ---- 스냅샷 (새로고침·재접속 시 현재 화면 복원) ---- */
function quizQuestionPublic(room) {
  const z = room.quiz; const q = z.questions[z.idx];
  return { n: z.idx + 1, total: z.questions.length, q: q.q, guide: q.guide, type: q.type, choices: q.choices || null };
}
function quizRevealPublic(room) {
  const z = room.quiz; const w = z.winners[z.idx];
  return { n: z.idx + 1, answer: z.questions[z.idx].answerText, winner: w ? { id: w.id, name: w.name, ms: w.ms } : null };
}

function playerSnapshot(room, p) {
  const s = { phase: room.phase, name: p.name, total: p.total, serverNow: now() };
  if (room.phase.startsWith('mini_')) {
    const m = room.mini, G = MINIGAMES[m.game];
    s.mini = { game: m.game, title: G.title, rules: G.rules, cfg: m.cfg, startedAt: m.startedAt, endsAt: m.endsAt, me: p.g };
    if (room.phase === 'mini_result') s.result = m.resultFor && m.resultFor[p.id];
  }
  if (room.phase.startsWith('quiz_')) {
    const z = room.quiz;
    s.quiz = { title: z.title, total: z.questions.length };
    if (room.phase === 'quiz_open') { s.question = quizQuestionPublic(room); s.lockLeft = Math.max(0, (p.quizLock || 0) - now()); }
    if (room.phase === 'quiz_reveal') s.reveal = quizRevealPublic(room);
    if (room.phase === 'quiz_summary') s.myWins = z.winners.filter((w) => w && w.id === p.id).length;
  }
  if (room.phase === 'final') {
    const tr = totalRanking(room); const me = tr.find((x) => x.id === p.id);
    s.final = { rank: me && me.rank, total: p.total, count: tr.length };
  }
  return s;
}

function hostSnapshot(room) {
  const s = {
    code: room.code, phase: room.phase, maxPlayers: room.maxPlayers, serverNow: now(),
    players: [...room.players.values()].map(pub), scores: scoresPayload(room),
  };
  if (room.mini) {
    const m = room.mini, G = MINIGAMES[m.game];
    s.mini = { game: m.game, title: G.title, rules: G.rules, cfg: m.cfg, startedAt: m.startedAt, endsAt: m.endsAt, result: m.result || null };
  }
  if (room.quiz) {
    const z = room.quiz;
    s.quiz = { title: z.title, total: z.questions.length, idx: z.idx, summary: quizSummary(room) };
    if (room.phase === 'quiz_open') { s.question = quizQuestionPublic(room); s.openedAt = z.openedAt; s.attempts = z.attempts; }
    if (room.phase === 'quiz_reveal') { s.question = quizQuestionPublic(room); s.reveal = quizRevealPublic(room); }
  }
  return s;
}
const pub = (p) => ({ id: p.id, name: p.name, connected: p.connected });

function quizSummary(room) {
  const z = room.quiz;
  return z.questions.map((q, i) => ({
    n: i + 1, q: q.q, answer: q.answerText,
    winner: z.winners[i] ? z.winners[i].name : null, ms: z.winners[i] ? z.winners[i].ms : null,
    played: i <= z.idx,
  }));
}

/* ---- 주기 전송 ---- */
function roomTick(room) {
  if (now() - room.lastActive > ROOM_TTL_MS) return destroyRoom(room);
  if (room.dirtyPlayers) {
    room.dirtyPlayers = false;
    io.to(H(room)).emit('host:players', [...room.players.values()].map(pub));
  }
  if (room.phase === 'mini_play' && room.dirtyLive) {
    room.dirtyLive = false;
    const m = room.mini, G = MINIGAMES[m.game];
    const ps = [...room.players.values()];
    const ranked = rankList(ps, (a, b) => G.compare(a.g, b.g));
    io.to(H(room)).emit('host:live', {
      top: ranked.slice(0, 12).map(({ item: p, rank }) => ({ rank, name: p.name, ...G.live(p.g, m.cfg) })),
      count: ps.length, done: ps.filter((p) => G.done(p.g)).length,
      played: ps.filter((p) => G.participated(p.g)).length, connected: ps.filter((p) => p.connected).length,
    });
    // 학생 개인 순위는 1초에 한 번만 보냄 (무료 서버 CPU 절약). 10초 게임은 결과 공개 전까지 숨김
    room.rankTick = (room.rankTick || 0) + 1;
    if (m.game !== 'stop10' && room.rankTick % 5 === 0) {
      ranked.forEach(({ item: p, rank }) => {
        if (p.connected && p.socketId) io.to(p.socketId).emit('mini:rank', { rank, count: ps.length, v: m.game === 'race' ? p.g.steps : p.g.count });
      });
    } else if (m.game !== 'stop10') room.dirtyLive = true; // 다음 순위 전송 때 다시 계산되도록 유지
  }
}

/* ---- 미니게임 ---- */
function startMini(room, game, cfgIn) {
  const G = MINIGAMES[game];
  const cfg = G.config(cfgIn || {});
  room.mini = { game, cfg, startedAt: 0, endsAt: 0, timer: null, result: null, resultFor: null };
  for (const p of room.players.values()) p.g = G.init();
  room.phase = 'mini_ready';
}

function playMini(room) {
  const m = room.mini;
  for (const p of room.players.values()) p.g = MINIGAMES[m.game].init();
  m.startedAt = now() + 3000; // 3초 카운트다운
  m.endsAt = m.startedAt + m.cfg.seconds * 1000;
  room.phase = 'mini_play';
  clearTimeout(m.timer);
  m.timer = setTimeout(() => endMini(room), m.endsAt - now() + GRACE_MS);
  const payload = { startedAt: m.startedAt, endsAt: m.endsAt, serverNow: now() };
  io.to(P(room)).emit('mini:play', payload);
  io.to(H(room)).emit('mini:play', payload);
  room.dirtyLive = true;
}

function endMini(room) {
  if (room.phase !== 'mini_play') return;
  const m = room.mini, G = MINIGAMES[m.game];
  clearTimeout(m.timer);
  const ps = [...room.players.values()];
  const playedList = ps.filter((p) => G.participated(p.g));
  const ranked = rankList(playedList, (a, b) => G.compare(a.g, b.g));
  const n = room.rounds.length + 1;
  room.rounds.push({ n, game: m.game, title: G.title });
  const rows = [];
  const resultFor = {};
  for (const { item: p, rank } of ranked) {
    const pts = pointsFor(rank);
    p.total += pts; p.pts[n] = pts;
    rows.push({ rank, id: p.id, name: p.name, record: G.record(p.g, m.cfg), points: pts });
  }
  for (const p of ps) {
    if (!G.participated(p.g)) { p.pts[n] = 0; rows.push({ rank: null, id: p.id, name: p.name, record: '참여 안 함', points: 0 }); }
  }
  const tr = totalRanking(room);
  const trMap = new Map(tr.map((x) => [x.id, x.rank]));
  rows.forEach((r) => { r.total = room.players.get(r.id).total; r.totalRank = trMap.get(r.id); });
  for (const r of rows) resultFor[r.id] = { rank: r.rank, points: r.points, record: r.record, total: r.total, totalRank: r.totalRank, count: ranked.length };
  m.result = { n, rows }; m.resultFor = resultFor;
  room.phase = 'mini_result';
  for (const p of ps) if (p.connected && p.socketId) io.to(p.socketId).emit('mini:result', resultFor[p.id]);
  io.to(H(room)).emit('mini:result', { result: m.result, scores: scoresPayload(room) });
}

function checkMiniDone(room) {
  if (room.phase !== 'mini_play') return;
  const G = MINIGAMES[room.mini.game];
  const conn = [...room.players.values()].filter((p) => p.connected);
  if (conn.length && conn.every((p) => G.done(p.g))) setTimeout(() => endMini(room), 700);
}

/* ---- 퀴즈 ---- */
function sanitizeQuiz(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const x of list.slice(0, 200)) {
    if (!x || !clean(x.q, 120)) continue;
    const item = { q: clean(x.q, 120), guide: clean(x.guide, 80) };
    if (x.type === 'choice') {
      const choices = (Array.isArray(x.choices) ? x.choices : []).map((c) => clean(c, 60)).filter(Boolean).slice(0, 4);
      const idx = parseInt(x.answerIdx, 10);
      if (choices.length < 2 || !(idx >= 0 && idx < choices.length)) continue;
      Object.assign(item, { type: 'choice', choices, answerIdx: idx, answerText: choices[idx] });
    } else {
      const accepts = (Array.isArray(x.accepts) ? x.accepts : []).map(sheet.norm).filter(Boolean).slice(0, 20);
      if (!accepts.length) continue;
      Object.assign(item, { type: 'text', accepts, answerText: clean(x.answerText, 60) || accepts[0] });
    }
    out.push(item);
  }
  return out;
}

function openQuestion(room) {
  const z = room.quiz;
  z.openedAt = now(); z.attempts = 0;
  for (const p of room.players.values()) p.quizLock = 0;
  room.phase = 'quiz_open';
  const q = quizQuestionPublic(room);
  io.to(P(room)).emit('quiz:open', { question: q });
  io.to(H(room)).emit('quiz:open', { question: q, openedAt: z.openedAt, serverNow: now() });
}

function revealQuestion(room, winner) {
  const z = room.quiz;
  if (room.phase !== 'quiz_open') return;
  z.winners[z.idx] = winner || null;
  room.phase = 'quiz_reveal';
  const rv = quizRevealPublic(room);
  io.to(P(room)).emit('quiz:reveal', rv);
  io.to(H(room)).emit('quiz:reveal', { reveal: rv, summary: quizSummary(room) });
}

/* ================= 소켓 ================= */
io.on('connection', (socket) => {
  const ack = (cb, d) => { if (typeof cb === 'function') cb(d); };
  const hostRoom = () => (socket.data.hostRoom && rooms.get(socket.data.hostRoom)) || null;
  const meRoom = () => {
    const room = rooms.get(socket.data.room);
    const p = room && room.players.get(socket.data.playerId);
    return p && p.socketId === socket.id ? { room, p } : null;
  };
  // 관리자 이벤트 공통 처리: 방 확인 + 오류가 나도 서버가 죽지 않게
  const hostOn = (ev, fn) => socket.on(ev, (d, cb) => {
    const room = hostRoom();
    if (!room) return ack(cb, { ok: false, error: '방 연결이 끊겼어요. 새로고침해 주세요.' });
    touch(room);
    try { fn(room, d || {}, cb); } catch (e) { console.error(ev, e); ack(cb, { ok: false, error: '처리 중 오류가 났어요.' }); }
  });

  socket.on('time:sync', (_d, cb) => ack(cb, now()));

  /* ---- 관리자 ---- */
  socket.on('host:create', (_d, cb) => {
    try {
      const room = createRoom();
      socket.data.hostRoom = room.code; socket.join(H(room));
      ack(cb, { ok: true, hostKey: room.hostKey, snap: hostSnapshot(room) });
    } catch (e) { ack(cb, { ok: false, error: '방을 만들지 못했어요.' }); }
  });
  socket.on('host:resume', (d, cb) => {
    const room = d && rooms.get(String(d.code));
    if (!room || room.hostKey !== d.hostKey) return ack(cb, { ok: false });
    socket.data.hostRoom = room.code; socket.join(H(room)); touch(room);
    ack(cb, { ok: true, snap: hostSnapshot(room) });
  });

  hostOn('host:setMax', (room, d, cb) => {
    room.maxPlayers = Math.min(HARD_MAX, Math.max(10, parseInt(d.max, 10) || DEFAULT_MAX));
    ack(cb, { ok: true, maxPlayers: room.maxPlayers });
  });
  hostOn('host:kick', (room, d, cb) => {
    const p = room.players.get(String(d.id));
    if (p) {
      if (p.socketId) io.to(p.socketId).emit('player:kicked');
      room.players.delete(p.id); room.dirtyPlayers = true;
    }
    ack(cb, { ok: true });
  });
  hostOn('host:toLobby', (room, _d, cb) => {
    if (room.phase === 'mini_play') endMini(room);
    if (room.mini) clearTimeout(room.mini.timer);
    room.phase = 'lobby';
    io.to(P(room)).emit('phase:lobby', {});
    ack(cb, { ok: true, scores: scoresPayload(room) });
  });
  hostOn('host:final', (room, _d, cb) => {
    if (room.phase === 'mini_play') endMini(room);
    room.phase = 'final';
    const tr = totalRanking(room);
    for (const r of tr) {
      const p = room.players.get(r.id);
      if (p.connected && p.socketId) io.to(p.socketId).emit('phase:final', { rank: r.rank, total: r.total, count: tr.length });
    }
    ack(cb, { ok: true, scores: scoresPayload(room) });
  });
  hostOn('host:resetScores', (room, _d, cb) => {
    if (room.phase !== 'lobby') return ack(cb, { ok: false, error: '대기 화면에서만 초기화할 수 있어요.' });
    room.rounds = [];
    for (const p of room.players.values()) { p.total = 0; p.pts = {}; }
    io.to(P(room)).emit('score:reset');
    ack(cb, { ok: true, scores: scoresPayload(room) });
  });

  // 미니게임
  hostOn('host:miniReady', (room, d, cb) => {
    if (!MINIGAMES[d.game]) return ack(cb, { ok: false, error: '없는 게임이에요.' });
    if (room.phase === 'mini_play' || room.phase.startsWith('quiz_open')) return ack(cb, { ok: false, error: '진행 중인 게임을 먼저 끝내 주세요.' });
    startMini(room, d.game, d.cfg);
    const m = room.mini, G = MINIGAMES[m.game];
    const info = { game: m.game, title: G.title, rules: G.rules, cfg: m.cfg };
    io.to(P(room)).emit('mini:ready', info);
    ack(cb, { ok: true, mini: info });
  });
  hostOn('host:miniPlay', (room, _d, cb) => {
    if (room.phase !== 'mini_ready') return ack(cb, { ok: false, error: '게임 설명 화면에서 시작할 수 있어요.' });
    if (![...room.players.values()].some((p) => p.connected)) return ack(cb, { ok: false, error: '접속한 참가자가 없어요.' });
    playMini(room);
    ack(cb, { ok: true });
  });
  hostOn('host:miniEnd', (room, _d, cb) => { endMini(room); ack(cb, { ok: true }); });

  // 퀴즈
  hostOn('host:loadSheet', async (room, d, cb) => {
    try { ack(cb, { ok: true, ...(await sheet.fetchSheet(String(d.url || ''))) }); }
    catch (e) { ack(cb, { ok: false, error: e.name === 'AbortError' ? '시트 응답이 너무 늦어요. 다시 시도해 주세요.' : e.message }); }
  });
  hostOn('host:parsePaste', (room, d, cb) => {
    ack(cb, { ok: true, ...sheet.rowsToQuestions(sheet.parseTSV(String(d.text || '').slice(0, 200000))) });
  });
  hostOn('host:quizStart', (room, d, cb) => {
    if (room.phase === 'mini_play') return ack(cb, { ok: false, error: '진행 중인 게임을 먼저 끝내 주세요.' });
    const questions = sanitizeQuiz(d.questions);
    if (!questions.length) return ack(cb, { ok: false, error: '문제가 없어요. 시트를 먼저 불러와 주세요.' });
    room.quiz = { title: clean(d.title, 40) || '퀴즈', questions, idx: -1, winners: [], openedAt: 0, attempts: 0 };
    room.phase = 'quiz_ready';
    io.to(P(room)).emit('quiz:ready', { title: room.quiz.title, total: questions.length });
    ack(cb, { ok: true, snap: hostSnapshot(room) });
  });
  hostOn('host:quizNext', (room, _d, cb) => {
    const z = room.quiz;
    if (!z || !['quiz_ready', 'quiz_reveal'].includes(room.phase)) return ack(cb, { ok: false, error: '지금은 다음 문제로 넘길 수 없어요.' });
    if (z.idx + 1 >= z.questions.length) {
      room.phase = 'quiz_summary';
      for (const p of room.players.values()) {
        if (p.connected && p.socketId) io.to(p.socketId).emit('quiz:summary', { myWins: z.winners.filter((w) => w && w.id === p.id).length });
      }
      return ack(cb, { ok: true, summary: quizSummary(room) });
    }
    z.idx++;
    openQuestion(room);
    ack(cb, { ok: true });
  });
  hostOn('host:quizReveal', (room, _d, cb) => { revealQuestion(room, null); ack(cb, { ok: true }); });
  hostOn('host:quizEnd', (room, _d, cb) => {
    if (!room.quiz) return ack(cb, { ok: false });
    if (room.phase === 'quiz_open') revealQuestion(room, null);
    room.phase = 'quiz_summary';
    for (const p of room.players.values()) {
      if (p.connected && p.socketId) io.to(p.socketId).emit('quiz:summary', { myWins: room.quiz.winners.filter((w) => w && w.id === p.id).length });
    }
    ack(cb, { ok: true, summary: quizSummary(room) });
  });

  /* ---- 참가자 ---- */
  socket.on('player:join', (d, cb) => {
    d = d || {};
    const room = rooms.get(String(d.code || '').replace(/\D/g, ''));
    if (!room) return ack(cb, { ok: false, error: '참가 코드를 확인해 주세요.' });
    let p = d.playerId && room.players.get(String(d.playerId));
    if (!p) {
      if (room.players.size >= room.maxPlayers) return ack(cb, { ok: false, error: `방이 가득 찼어요 (최대 ${room.maxPlayers}명).` });
      let name = clean(d.name, 10);
      if (!name) return ack(cb, { ok: false, error: '이름을 입력해 주세요.' });
      const taken = new Set([...room.players.values()].map((x) => x.name));
      if (taken.has(name)) { let k = 2; while (taken.has(`${name}(${k})`)) k++; name = `${name}(${k})`; }
      p = { id: rid(8), name, socketId: null, connected: false, total: 0, pts: {}, g: null, quizLock: 0 };
      if (room.mini) p.g = MINIGAMES[room.mini.game].init();
      room.players.set(p.id, p);
    }
    if (!p.g && room.mini) p.g = MINIGAMES[room.mini.game].init();
    if (p.socketId && p.socketId !== socket.id) {
      const old = io.sockets.sockets.get(p.socketId);
      if (old) { old.leave(P(room)); old.emit('player:replaced'); old.data.playerId = null; }
    }
    p.socketId = socket.id; p.connected = true;
    socket.data.room = room.code; socket.data.playerId = p.id;
    socket.join(P(room));
    touch(room); room.dirtyPlayers = true; room.dirtyLive = true;
    ack(cb, { ok: true, playerId: p.id, snap: playerSnapshot(room, p) });
  });

  socket.on('mini:act', (d, cb) => {
    const me = meRoom();
    if (!me || me.room.phase !== 'mini_play') return ack(cb, { ok: false });
    const { room, p } = me; const t = now();
    if (t > room.mini.endsAt + GRACE_MS) return ack(cb, { ok: false });
    const r = MINIGAMES[room.mini.game].action(room, p.g, d, t);
    if (r) { room.dirtyLive = true; checkMiniDone(room); }
    ack(cb, { ok: true, ...(r || {}) });
  });

  socket.on('quiz:answer', (d, cb) => {
    const me = meRoom();
    if (!me) return ack(cb, { ok: false });
    const { room, p } = me; const z = room.quiz; const t = now();
    if (room.phase !== 'quiz_open' || !z || (d && +d.n !== z.idx + 1)) return ack(cb, { ok: false, closed: true });
    if (t < p.quizLock) return ack(cb, { ok: false, locked: p.quizLock - t });
    const q = z.questions[z.idx];
    let correct;
    if (q.type === 'choice') correct = parseInt(d && d.choice, 10) === q.answerIdx;
    else correct = q.accepts.includes(sheet.norm(String((d && d.text) || '').slice(0, 60)));
    z.attempts++;
    if (correct) {
      // Node는 이벤트를 하나씩 처리하므로 첫 정답자는 반드시 한 명만 나온다
      revealQuestion(room, { id: p.id, name: p.name, ms: t - z.openedAt });
      return ack(cb, { ok: true, correct: true, first: true });
    }
    p.quizLock = t + LOCK_MS;
    ack(cb, { ok: true, correct: false, lock: LOCK_MS });
    io.to(H(room)).emit('quiz:attempts', z.attempts);
  });

  socket.on('disconnect', () => {
    const room = rooms.get(socket.data.room);
    if (!room) return;
    const p = room.players.get(socket.data.playerId);
    if (p && p.socketId === socket.id) {
      p.connected = false; p.socketId = null;
      room.dirtyPlayers = true; room.dirtyLive = true;
    }
  });
});

process.on('unhandledRejection', (e) => console.error('unhandledRejection', e));
process.on('uncaughtException', (e) => console.error('uncaughtException', e));

server.on('error', (e) => { console.error('서버 시작 실패:', e.message); process.exit(1); });
if (require.main === module) server.listen(PORT, () => console.log(`ClassArena listening on :${PORT}`));
module.exports = { server, io, rooms };
