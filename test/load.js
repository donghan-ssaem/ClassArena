'use strict';
// 동시접속 시뮬레이션: node test/load.js [인원수, 기본 80]
// 가짜 학생들이 실제 폰 화면과 같은 방식(0.25초마다 전송)으로 모든 게임을 한다.
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { io } = require('socket.io-client');
const { CAPattern } = require('../public/patterns.js');

const N = +process.argv[2] || 80;
const PORT = 3100 + Math.floor(Math.random() * 500), URL = `http://localhost:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errors = []; const lat = [];
const fail = (m) => errors.push(m);
const emit = (s, ev, d, ms = 5000) => new Promise((res) => {
  const t = Date.now();
  s.timeout(ms).emit(ev, d, (e, r) => { lat.push(Date.now() - t); if (e) fail('응답 없음 ' + ev); res(e ? null : r); });
});
const waitFor = async (fn, ms, label) => { const t = Date.now(); while (Date.now() - t < ms) { if (fn()) return true; await sleep(50); } fail('시간 초과: ' + label); return false; };

const QUIZ = [
  { q: 'ㄹㅁㅋㅂ', guide: '보드게임', type: 'text', accepts: ['루미큐브'], answerText: '루미큐브' },
  { q: '물의 화학식', guide: '', type: 'choice', choices: ['CO2', 'O2', 'H2O', 'NaCl'], answerIdx: 2 },
];
const TEXT_ANS = { 'ㄹㅁㅋㅂ': '루미 큐브' };
const T0 = Date.now();

(async () => {
  const srv = spawn('node', [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT }, stdio: ['ignore', 'inherit', 'inherit'] });
  await sleep(2500);
  // 1초마다 서버 CPU 사용률 기록
  let peak = 0, lastCpu = 0, phaseName = '준비';
  const peaks = {};
  const readCpu = () => { const st = fs.readFileSync(`/proc/${srv.pid}/stat`, 'utf8').split(') ')[1].split(' '); return (+st[11] + +st[12]) / 100; };
  const sampler = setInterval(() => { try { const c = readCpu(); const d = c - lastCpu; peak = Math.max(peak, d); peaks[phaseName] = Math.max(peaks[phaseName] || 0, d); if (process.env.TRACE && phaseName === 'race') console.log('  [race CPU]', (d * 100).toFixed(0) + '%'); lastCpu = c; } catch (e) {} }, 1000);
  try {
    const host = io(URL, { transports: ['websocket'] });
    await new Promise((r) => host.on('connect', r));
    const cr = await emit(host, 'host:create'); const code = cr.snap.code;
    await emit(host, 'host:setMax', { max: 80 });
    const H = { reveals: [], results: null };
    host.on('quiz:reveal', (d) => H.reveals.push(d.reveal));
    host.on('mini:result', (d) => { H.results = d; });

    phaseName = '입장';
    const bots = [];
    for (let i = 0; i < N; i++) {
      const b = { i, name: '학생' + i, pid: null, s: io(URL, { transports: ['websocket'], reconnectionDelay: 200 }), ev: {}, views: 0 };
      b.s.on('connect', async () => {
        const r = await emit(b.s, 'player:join', { code, name: b.name, playerId: b.pid });
        if (r && r.ok) b.pid = r.playerId; else fail('입장 실패 ' + b.name);
      });
      ['quiz:open', 'quiz:reveal', 'mini:play', 'mini:result', 'mini:ready', 'phase:final'].forEach((e) => b.s.on(e, (d) => { b.ev[e] = d; }));
      b.s.on('race:view', (d) => { b.views++; b.lastView = d; });
      bots.push(b);
    }
    await waitFor(() => bots.every((b) => b.pid), 8000, '전원 입장');
    console.log(`입장 ${bots.filter((b) => b.pid).length}/${N}명`);
    await sleep(1500);

    // ---- 퀴즈: 전원이 동시에 답을 보내도 첫 정답자는 1명 ----
    phaseName = '퀴즈';
    const qs = await emit(host, 'host:quizStart', { title: '', questions: QUIZ });
    if (qs.snap.quiz.title !== '보드게임 퀴즈') fail('퀴즈 기본 이름 오류: ' + qs.snap.quiz.title);
    for (let qi = 0; qi < QUIZ.length; qi++) {
      bots.forEach((b) => { b.ev['quiz:open'] = null; b.firsts = 0; });
      await emit(host, 'host:quizNext');
      await waitFor(() => bots.every((b) => b.ev['quiz:open']), 3000, '문제 수신');
      const q = QUIZ[qi]; let firstCount = 0;
      await Promise.all(bots.map(async (b) => {
        await sleep(Math.random() * 30);
        const d = q.type === 'choice' ? { n: qi + 1, choice: Math.random() < 0.5 ? q.answerIdx : (q.answerIdx + 1) % 4 } : { n: qi + 1, text: Math.random() < 0.5 ? TEXT_ANS[q.q] : '모름' };
        const a = await emit(b.s, 'quiz:answer', d);
        if (a && a.first) { firstCount++; b.firsts++; }
      }));
      await waitFor(() => H.reveals.length === qi + 1, 2000, '정답 공개');
      if (firstCount !== 1) fail(`${qi + 1}번 문제 첫 정답자가 ${firstCount}명`);
      const w = bots.find((b) => b.firsts === 1);
      if (!w || H.reveals[qi].winner.id !== w.pid) fail(`${qi + 1}번 정답자 불일치`);
      await sleep(1000);
    }
    await emit(host, 'host:quizNext');
    console.log(`퀴즈(기본 이름 "${qs.snap.quiz.title}"): 매 문제 첫 정답자 1명 확인`);
    await emit(host, 'host:toLobby');

    // ---- 미니게임 공통 ----
    async function runMini(game, cfg, behave) {
      phaseName = game;
      H.results = null;
      bots.forEach((b) => { b.ev['mini:play'] = null; b.ev['mini:result'] = null; b.ev['mini:ready'] = null; });
      const rd = await emit(host, 'host:miniReady', { game, cfg });
      await waitFor(() => bots.every((b) => b.ev['mini:ready']), 3000, game + ' 설명 수신');
      await emit(host, 'host:miniPlay');
      await waitFor(() => bots.every((b) => b.ev['mini:play']), 3000, game + ' 시작 수신');
      const st = bots[0].ev['mini:play'].startedAt;
      await sleep(st - Date.now() + 20);
      await Promise.all(bots.map((b) => behave(b, st, bots[0].ev['mini:ready'].cfg)));
      await waitFor(() => H.results, 45000, game + ' 결과');
      await waitFor(() => bots.every((b) => b.ev['mini:result']), 3000, game + ' 학생 결과 수신');
      await emit(host, 'host:toLobby');
      await sleep(1200);
      return { res: H.results, info: rd.mini };
    }
    const check = ({ res, info }) => {
      const rows = res.result.rows.filter((x) => x.rank != null);
      for (const x of rows) if (x.points !== Math.max(1, 51 - x.rank)) { fail(`${info.title} 점수 규칙 오류`); break; }
      for (let i = 1; i < rows.length; i++) if (rows[i].rank < rows[i - 1].rank) { fail(info.title + ' 등수 정렬 오류'); break; }
      const spec = res.result.rows.filter((x) => x.spectate).length;
      console.log(`${info.title}: ${rows.length}명 순위 · 1등 ${rows[0].name}(${rows[0].record}) +${rows[0].points}점` + (spec ? ` · 구경 ${spec}명` : ''));
      return rows;
    };
    // 실제 화면처럼 0.25초마다 값을 보냄
    const every250 = async (b, st, secs, valueAt) => {
      while (!b.ev['mini:result'] && Date.now() - st < secs * 1000 + 300) { await sleep(250); b.s.emit('mini:act', valueAt(Date.now() - st)); }
    };

    // 1) 카드 병정 레이스: 학생0은 자동클릭 흉내(초당 40회), 3명은 중간에 끊겼다 돌아옴
    const r1 = await runMini('race', { distance: 'short' }, async (b, st, cfg) => {
      const rate = b.i === 0 ? 40 : 6 + (b.i % 7); let cut = false;
      while (!b.ev['mini:result'] && Date.now() - st < 62000) {
        await sleep(250);
        const steps = Math.min(cfg.goal, Math.floor((Date.now() - st) / 1000 * rate));
        if (b.i >= 1 && b.i <= 3 && steps >= 30 && !cut) { cut = true; b.s.io.engine.close(); await sleep(900); }
        b.s.emit('mini:act', { steps, elapsed: Date.now() - st });
      }
    });
    const rows1 = check(r1);
    const cheat = rows1.find((x) => x.name === '학생0');
    if (parseFloat(cheat.record) < 60 / 16 - 0.01) fail('자동클릭 속도 제한이 동작하지 않음');
    // 앞사람 정보: 6명 이하, 모두 나보다 앞서 있어야 함
    const withView = bots.filter((b) => b.views > 0);
    const badView = withView.filter((b) => b.lastView.a.length > 6 || b.lastView.a.some((x) => x[1] <= b.lastView.v)).length;
    if (withView.length < N * 0.9) fail(`앞사람 정보를 받은 학생이 ${withView.length}명뿐`);
    if (badView) fail(`앞사람 정보 오류 ${badView}명`);
    console.log(`  앞사람 화면 정보: ${withView.length}명이 평균 ${Math.round(withView.reduce((a, b) => a + b.views, 0) / withView.length)}번 받음, 최대 6명·모두 앞선 사람만 ✓ / 자동클릭 학생0: ${cheat.record}`);

    // 2) 마음속 시계: 5명은 안 누름
    const r2 = await runMini('stop10', {}, async (b) => {
      if (b.i >= N - 5) return;
      await sleep(8500 + Math.random() * 3000);
      await emit(b.s, 'mini:act', { elapsed: 8500 + Math.random() * 3000 });
    });
    check(r2);
    if (r2.res.result.rows.filter((x) => x.rank == null).length !== 5) fail('마음속 시계: 참여 안 함 인원 오류');

    // 3) 카드 섞기 10초 (동점자 일부러)
    check(await runMini('rub', { seconds: 10 }, (b, st) => every250(b, st, 10, (e) => ({ count: Math.min(b.i < 4 ? 100 : 40 + (b.i % 30), Math.floor(e / 1000 * 12)) }))));

    // 4) 조커 잡기 30초: 같은 패턴인지 확인 + 학생0은 나온 조커보다 많이 잡았다고 속여 봄
    const r4 = await runMini('joker', {}, (b, st, cfg) => {
      const pat = CAPattern.jokerPattern(cfg.seed, cfg.seconds * 1000);
      const skill = 0.4 + (b.i % 10) * 0.06;
      return every250(b, st, 30, (e) => ({ hits: b.i === 0 ? 999 : Math.floor(pat.filter((s) => s.t + 300 <= e).length * skill) }));
    });
    const rows4 = check(r4);
    const total = CAPattern.jokerPattern(bots[0].ev['mini:ready'].cfg.seed, 30000).length;
    const j0 = rows4.find((x) => x.name === '학생0');
    if (parseInt(j0.record.replace(/\D/g, ''), 10) > total) fail('조커: 나온 수보다 많이 잡은 기록이 인정됨');
    console.log(`  조커 총 ${total}장 · 속이려던 학생0 기록 ${j0.record} (나온 수 넘지 못함 ✓)`);

    // 5) 하트 풍선 30초: 학생0은 경과 시간보다 긴 시간을 속여 봄
    const r5 = await runMini('balloon', {}, (b, st) => every250(b, st, 30, (e) => ({ ms: b.i === 0 ? 99999 : Math.floor(e * (0.3 + (b.i % 10) * 0.05)) })));
    const rows5 = check(r5);
    const b0 = rows5.find((x) => x.name === '학생0');
    if (parseFloat(b0.record) > 30.2) fail('하트 풍선: 경과 시간보다 긴 기록이 인정됨');

    // 6) 주사위 흔들기 15초: 10명은 크롬북(구경)
    const r6 = await runMini('dice', {}, async (b, st) => {
      if (b.i % 8 === 0) { await emit(b.s, 'mini:spectate'); return; }
      return every250(b, st, 15, (e) => ({ count: Math.floor(e / 1000 * (4 + (b.i % 6))) }));
    });
    check(r6);
    const specRows = r6.res.result.rows.filter((x) => x.spectate);
    if (specRows.length !== Math.ceil(N / 8)) fail(`구경 인원 오류 ${specRows.length}`);
    if (specRows.some((x) => x.points != null)) fail('구경한 학생에게 점수가 들어감');

    // 누적 점수 검증 (구경한 판은 빼고 합산)
    phaseName = '최종';
    const fin = await emit(host, 'host:final');
    const ok = fin.scores.players.every((p) => p.total === Object.values(p.pts).reduce((a, c) => a + (c || 0), 0));
    if (!ok) fail('누적 점수 합계 불일치');
    const specP = fin.scores.players.find((p) => p.name === '학생8');
    console.log(`최종: 1등 ${fin.scores.players[0].name} ${fin.scores.players[0].total}점, 게임 ${fin.scores.rounds.length}판 · 구경한 학생8의 주사위 판 기록: ${specP.pts[6] === null ? '구경(점수 없음) ✓' : specP.pts[6]}`);

    lat.sort((a, b) => a - b);
    const p = (q) => lat[Math.floor(lat.length * q)];
    console.log(`서버 응답 ${lat.length}건: 중간값 ${p(0.5)}ms, 95% ${p(0.95)}ms, 최대 ${lat[lat.length - 1]}ms`);
    console.log('단계별 가장 바빴던 1초 CPU: ' + Object.entries(peaks).map(([k, v]) => `${k} ${(v * 100).toFixed(0)}%`).join(', ') + ' (무료 서버 한도 10%)');
    bots.forEach((b) => b.s.close()); host.close();
  } catch (e) { console.error(e); fail(String(e)); }
  clearInterval(sampler);
  console.log(errors.length ? '❌ 오류 ' + errors.length + '건\n' + [...new Set(errors)].join('\n') : '✅ 오류 없음');
  srv.kill(); process.exit(errors.length ? 1 : 0);
})();
