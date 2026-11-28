'use strict';
const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { Server } = require('socket.io');
const QRCode = require('qrcode');
const { MINIGAMES, GRACE_MS, makePattern } = require('./lib/minigames');
const sheet = require('./lib/sheet');

const PORT = process.env.PORT || 3000;
const DEFAULT_MAX = 50;          // 방 기본 인원
const HARD_MAX = 80;             // 관리자가 늘릴 수 있는 최대 인원
const LOCK_MS = 1500;            // 퀴즈 오답 시 잠금
const ROOM_TTL_MS = 8 * 3600e3;  // 8시간 활동 없으면 방 삭제
const TICK_MS = 200;             // 실시간 전송 간격
const AHEAD_N = 6;               // 레이스에서 보여 줄 앞사람 수
const DEFAULT_QUIZ_TITLE = '보드게임 퀴즈';

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  transports: ['websocket', 'polling'],
  pingInterval: 10000,
  pingTimeout: 25000,
  maxHttpBufferSize: 1e6,
  perMessageDeflate: false,
});

app.use(express.static(path.join(__dirname, 'public'), { maxAge: '10m', extensions: ['html'] }));
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
    rounds: [], mini: null, quiz: null,
    dirtyPlayers: true, dirtyLive: false, tickN: 0, lastActive: now(),
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
const pointsFor = (rank) => Math.max(1, 51 - rank); // 1등 50점, n등 51-n점 (51등 이하 1점)

function totalRanking(room) {
  return rankList([...room.players.values()], (a, b) => b.total - a.total)
    .map(({ item: p, rank }) => ({ rank, id: p.id, name: p.name, total: p.total, connected: p.connected }));
}
function scoresPayload(room) {
  return { rounds: room.rounds, players: totalRanking(room).map((r) => ({ ...r, pts: room.players.get(r.id).pts })) };
}

/* ---- 스냅샷 (새로고침·재접속 시 현재 화면 복원) ---- */
function miniInfo(room) {
  const m = room.mini, G = MINIGAMES[m.game];
  return { game: m.game, title: G.title, icon: G.icon, rules: G.rules, cfg: m.cfg, phoneOnly: !!G.phoneOnly };
}
function quizQuestionPublic(room) {
  const z = room.quiz; const q = z.questions[z.idx];
  return { n: z.idx + 1, total: z.questions.length, q: q.q, guide: q.guide, type: q.type, choices: q.choices || null };
}
function quizRevealPublic(room) {
  const z = room.quiz; const w = z.winners[z.idx];
  return { n: z.idx + 1, answer: z.questions[z.idx].answerText, winner: w ? { id: w.id, name: w.name, ms: w.ms } : null };
}
const pub = (p) => ({ id: p.id, name: p.name, connected: p.connected, hue: p.hue });

function playerSnapshot(room, p) {
  const s = { phase: room.phase, name: p.name, hue: p.hue, total: p.total, serverNow: now() };
  if (room.phase.startsWith('mini_')) {
    s.mini = { ...miniInfo(room), startedAt: room.mini.startedAt, endsAt: room.mini.endsAt, me: p.g };
    if (room.phase === 'mini_result') s.result = room.mini.resultFor && room.mini.resultFor[p.id];
  }
  if (room.phase.startsWith('quiz_')) {
    const z = room.quiz;
    s.quiz = { title: z.title, total: z.questions.length, oneWin: z.oneWin, won: hasWon(z, p) };
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
  if (room.mini) s.mini = { ...miniInfo(room), startedAt: room.mini.startedAt, endsAt: room.mini.endsAt, result: room.mini.result || null };
  if (room.quiz) {
    const z = room.quiz;
    s.quiz = { title: z.title, total: z.questions.length, idx: z.idx, oneWin: z.oneWin, summary: quizSummary(room) };
    if (room.phase === 'quiz_open') { s.question = quizQuestionPublic(room); s.openedAt = z.openedAt; s.attempts = z.attempts; s.eligible = eligibleCount(room); }
    if (room.phase === 'quiz_reveal') { s.question = quizQuestionPublic(room); s.reveal = quizRevealPublic(room); }
  }
  return s;
}

function quizSummary(room) {
  const z = room.quiz;
  return z.questions.map((q, i) => ({
    n: i + 1, q: q.q, answer: q.answerText,
    winner: z.winners[i] ? z.winners[i].name : null, ms: z.winners[i] ? z.winners[i].ms : null,
    played: i <= z.idx,
  }));
}

/* ---- 주기 전송 ---- */
// 학생 한 명에게 바로 보내기 (방 전체 방송 경로를 거치지 않아 더 가벼움)
function sendTo(p, ev, data) {
  const sk = p.socketId && io.sockets.sockets.get(p.socketId);
  if (sk) sk.emit(ev, data);
}
function roomTick(room) {
  if (now() - room.lastActive > ROOM_TTL_MS) return destroyRoom(room);
  room.tickN++;
  if (room.dirtyPlayers) {
    room.dirtyPlayers = false;
    io.to(H(room)).emit('host:players', [...room.players.values()].map(pub));
  }
  // 미니게임 실시간 화면은 0.4초마다 (무료 서버 CPU 절약)
  if (room.phase !== 'mini_play' || !room.dirtyLive || room.tickN % 2) return;
  room.dirtyLive = false;
  const m = room.mini, G = MINIGAMES[m.game];
  const ps = [...room.players.values()];
  const ranked = rankList(ps.filter((p) => !p.g.spectate), (a, b) => G.compare(a.g, b.g));
  io.to(H(room)).emit('host:live', {
    top: ranked.slice(0, 12).map(({ item: p, rank }) => ({ rank, name: p.name, hue: p.hue, ...G.live(p.g, m.cfg) })),
    count: ps.length, done: ps.filter((p) => G.done(p.g)).length,
    played: ps.filter((p) => G.participated(p.g)).length, connected: ps.filter((p) => p.connected).length,
    spectators: ps.filter((p) => p.g.spectate).length,
  });
  if (m.game === 'stop10') return; // 마음속 시계는 결과 공개 전까지 순위를 숨김

  if (m.game === 'race') {
    // 각 학생에게 '내 바로 앞에 있는 6명'의 위치만 보냄 (뒤에 있는 사람은 안 보냄)
    {
      const sorted = ranked.map((r) => r.item); // 앞선 순서
      sorted.forEach((p, i) => {
        if (!p.connected || !p.socketId) return;
        const ahead = [];
        for (let j = i - 1; j >= 0 && ahead.length < AHEAD_N; j--) {
          const q = sorted[j];
          if (q.g.steps > p.g.steps) ahead.push([q.name, q.g.steps, q.hue]);
        }
        sendTo(p, 'race:view', { rank: ranked[i].rank, count: sorted.length, v: p.g.steps, a: ahead });
      });
    }
    room.dirtyLive = true;
    return;
  }
  // 다른 게임: 1초마다 내 순위와 서버에 저장된 내 기록(v) 전송
  if (room.tickN % 6 === 0) {
    ranked.forEach(({ item: p, rank }) => {
      if (p.connected && p.socketId) sendTo(p, 'mini:rank', { rank, count: ranked.length, v: G.live(p.g, m.cfg).v, raw: p.g });
    });
  }
  room.dirtyLive = true;
}

/* ---- 미니게임 ---- */
function startMini(room, game, cfgIn) {
  const G = MINIGAMES[game];
  const cfg = G.config(cfgIn || {});
  cfg.seed = Math.floor(Math.random() * 2 ** 31); // 모두 같은 패턴을 만들기 위한 씨앗 숫자
  room.mini = { game, cfg, pattern: makePattern(game, cfg), startedAt: 0, endsAt: 0, timer: null, result: null, resultFor: null };
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
  const ranked = rankList(ps.filter((p) => G.participated(p.g)), (a, b) => G.compare(a.g, b.g));
  const n = room.rounds.length + 1;
  room.rounds.push({ n, game: m.game, title: G.title });
  const rows = [];
  for (const { item: p, rank } of ranked) {
    const pts = pointsFor(rank);
    p.total += pts; p.pts[n] = pts;
    rows.push({ rank, id: p.id, name: p.name, record: G.record(p.g, m.cfg), points: pts });
  }
  for (const p of ps) {
    if (G.participated(p.g)) continue;
    if (p.g.spectate) { p.pts[n] = null; rows.push({ rank: null, id: p.id, name: p.name, record: '구경 (크롬북)', points: null, spectate: true }); }
    else { p.pts[n] = 0; rows.push({ rank: null, id: p.id, name: p.name, record: '참여 안 함', points: 0 }); }
  }
  const trMap = new Map(totalRanking(room).map((x) => [x.id, x.rank]));
  const resultFor = {};
  for (const r of rows) {
    r.total = room.players.get(r.id).total; r.totalRank = trMap.get(r.id);
    resultFor[r.id] = { rank: r.rank, points: r.points, record: r.record, total: r.total, totalRank: r.totalRank, count: ranked.length, spectate: !!r.spectate };
  }
  m.result = { n, rows }; m.resultFor = resultFor;
  room.phase = 'mini_result';
  for (const p of ps) if (p.connected && p.socketId) io.to(p.socketId).emit('mini:result', resultFor[p.id]);
  io.to(H(room)).emit('mini:result', { result: m.result, scores: scoresPayload(room) });
}

function checkMiniDone(room) {
  if (room.phase !== 'mini_play') return;
  const G = MINIGAMES[room.mini.game];
  const conn = [...room.players.values()].filter((p) => p.connected && !p.g.spectate);
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
// 이번 퀴즈에서 이미 1등 정답을 한 번 맞힌 사람인지 (맞힌 사람은 다음 문제부터 구경)
const hasWon = (z, p) => z.winners.some((w) => w && w.id === p.id);
const eligibleCount = (room) => [...room.players.values()].filter((p) => p.connected && !(room.quiz.oneWin && hasWon(room.quiz, p))).length;

function openQuestion(room) {
  const z = room.quiz;
  z.openedAt = now(); z.attempts = 0;
  for (const p of room.players.values()) p.quizLock = 0;
  room.phase = 'quiz_open';
  const q = quizQuestionPublic(room);
  io.to(P(room)).emit('quiz:open', { question: q });
  io.to(H(room)).emit('quiz:open', { question: q, openedAt: z.openedAt, serverNow: now(), eligible: eligibleCount(room) });
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
function quizToSummary(room) {
  const z = room.quiz;
  room.phase = 'quiz_summary';
  for (const p of room.players.values()) {
    if (p.connected && p.socketId) io.to(p.socketId).emit('quiz:summary', { myWins: z.winners.filter((w) => w && w.id === p.id).length });
  }
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
  // 관리자 이벤트 공통 처리: 방 확인 + 오류가 나도 서버가 멈추지 않게
  const hostOn = (ev, fn) => socket.on(ev, async (d, cb) => {
    const room = hostRoom();
    if (!room) return ack(cb, { ok: false, error: '방 연결이 끊겼어요. 새로고침해 주세요.' });
    touch(room);
    try { await fn(room, d || {}, cb); } catch (e) { console.error(ev, e); ack(cb, { ok: false, error: '처리 중 오류가 났어요.' }); }
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
    if (room.phase === 'mini_play' || room.phase === 'quiz_open') return ack(cb, { ok: false, error: '진행 중인 게임을 먼저 끝내 주세요.' });
    startMini(room, d.game, d.cfg);
    const info = miniInfo(room);
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
    room.quiz = { title: clean(d.title, 40) || DEFAULT_QUIZ_TITLE, questions, idx: -1, winners: [], openedAt: 0, attempts: 0, oneWin: d.oneWin !== false };
    room.phase = 'quiz_ready';
    io.to(P(room)).emit('quiz:ready', { title: room.quiz.title, total: questions.length, oneWin: room.quiz.oneWin });
    ack(cb, { ok: true, snap: hostSnapshot(room) });
  });
  hostOn('host:quizNext', (room, _d, cb) => {
    const z = room.quiz;
    if (!z || !['quiz_ready', 'quiz_reveal'].includes(room.phase)) return ack(cb, { ok: false, error: '지금은 다음 문제로 넘길 수 없어요.' });
    if (z.idx + 1 >= z.questions.length) { quizToSummary(room); return ack(cb, { ok: true, summary: quizSummary(room) }); }
    z.idx++;
    openQuestion(room);
    ack(cb, { ok: true });
  });
  hostOn('host:quizReveal', (room, _d, cb) => { revealQuestion(room, null); ack(cb, { ok: true }); });
  hostOn('host:quizEnd', (room, _d, cb) => {
    if (!room.quiz) return ack(cb, { ok: false });
    if (room.phase === 'quiz_open') revealQuestion(room, null);
    quizToSummary(room);
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
      p = { id: rid(8), name, hue: Math.floor(Math.random() * 360), socketId: null, connected: false, total: 0, pts: {}, g: null, quizLock: 0 };
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

  // 센서가 없는 기기(크롬북 등): 이번 판은 구경만 (점수 없음, 누적에서 이 판 제외)
  socket.on('mini:spectate', (_d, cb) => {
    const me = meRoom();
    if (!me || !me.room.mini || !MINIGAMES[me.room.mini.game].phoneOnly) return ack(cb, { ok: false });
    if (!me.p.g || me.p.g.count > 0) return ack(cb, { ok: false });
    me.p.g.spectate = true; me.room.dirtyLive = true;
    ack(cb, { ok: true });
  });

  socket.on('quiz:answer', (d, cb) => {
    const me = meRoom();
    if (!me) return ack(cb, { ok: false });
    const { room, p } = me; const z = room.quiz; const t = now();
    if (room.phase !== 'quiz_open' || !z || (d && +d.n !== z.idx + 1)) return ack(cb, { ok: false, closed: true });
    if (z.oneWin && hasWon(z, p)) return ack(cb, { ok: false, already: true });
    if (t < p.quizLock) return ack(cb, { ok: false, locked: p.quizLock - t });
    const q = z.questions[z.idx];
    const correct = q.type === 'choice'
      ? parseInt(d && d.choice, 10) === q.answerIdx
      : q.accepts.includes(sheet.norm(String((d && d.text) || '').slice(0, 60)));
    z.attempts++;
    if (correct) {
      // 서버는 답을 하나씩 차례로 처리하므로 첫 정답자는 반드시 한 명만 나온다
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
