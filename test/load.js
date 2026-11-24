'use strict';
// 동시접속 시뮬레이션: node test/load.js [인원수, 기본 80]
const { spawn } = require('child_process');
const path = require('path');
const { io } = require('socket.io-client');

const N = +process.argv[2] || 80;
const PORT = 3100 + Math.floor(Math.random() * 500), URL = `http://localhost:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errors = []; const lat = [];
const fail = (m) => { errors.push(m); };
const emit = (s, ev, d, ms = 5000) => new Promise((res) => {
  const t = Date.now();
  s.timeout(ms).emit(ev, d, (e, r) => { lat.push(Date.now() - t); if (e) fail('응답 없음 ' + ev); res(e ? null : r); });
});
const waitFor = async (fn, ms, label) => { const t = Date.now(); while (Date.now() - t < ms) { if (fn()) return true; await sleep(50); } fail('시간 초과: ' + label); return false; };

const QUIZ = [
  { q: 'ㄹㅁㅋㅂ', guide: '보드게임', type: 'text', accepts: ['루미큐브'], answerText: '루미큐브' },
  { q: '물의 화학식', guide: '', type: 'choice', choices: ['CO2', 'O2', 'H2O', 'NaCl'], answerIdx: 2 },
  { q: 'ㅎㄹㄱㄹ', guide: '보드게임', type: 'text', accepts: ['할리갈리'], answerText: '할리갈리' },
  { q: '7×8', guide: '', type: 'choice', choices: ['54', '56', '58', '64'], answerIdx: 1 },
];
const TEXT_ANS = { 'ㄹㅁㅋㅂ': '루미 큐브', 'ㅎㄹㄱㄹ': '할리갈리' };

const T0 = Date.now();
(async () => {
  const srv = spawn('node', [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT }, stdio: ['ignore', 'inherit', 'inherit'] });
  await sleep(3000); // 서버가 완전히 켜진 뒤 측정
  // 1초마다 서버 CPU 사용률을 재서 가장 높았던 순간을 기록
  let peak = 0, lastCpu = 0;
  const readCpu = () => { const st = require('fs').readFileSync(`/proc/${srv.pid}/stat`, 'utf8').split(') ')[1].split(' '); return (+st[11] + +st[12]) / 100; };
  const sampler = setInterval(() => { try { const c = readCpu(); peak = Math.max(peak, c - lastCpu); if (c - lastCpu > 0.03) console.log('  [CPU]', ((c - lastCpu) * 100).toFixed(0) + '%', ((Date.now() - T0) / 1000).toFixed(0) + '초'); lastCpu = c; } catch (e) {} }, 1000);
  try {
    const host = io(URL, { transports: ['websocket'] });
    await new Promise((r) => host.on('connect', r));
    const cr = await emit(host, 'host:create'); const code = cr.snap.code;
    await emit(host, 'host:setMax', { max: 80 });
    const H = { reveals: [], results: null };
    host.on('quiz:reveal', (d) => H.reveals.push(d.reveal));
    host.on('mini:result', (d) => { H.results = d; });
    let liveCount = 0; host.on('host:live', () => liveCount++);

    // ---- 입장 ----
    const bots = [];
    const t0 = Date.now();
    for (let i = 0; i < N; i++) {
      const b = { i, name: '학생' + i, pid: null, s: io(URL, { transports: ['websocket'], reconnectionDelay: 200 }), ev: {} };
      b.s.on('connect', async () => {
        const r = await emit(b.s, 'player:join', { code, name: b.name, playerId: b.pid });
        if (r && r.ok) { b.pid = r.playerId; b.snap = r.snap; } else fail('입장 실패 ' + b.name + ' ' + JSON.stringify(r));
      });
      ['quiz:open', 'quiz:reveal', 'mini:play', 'mini:result', 'mini:ready', 'phase:final'].forEach((e) => b.s.on(e, (d) => { b.ev[e] = d; }));
      bots.push(b);
    }
    await waitFor(() => bots.every((b) => b.pid), 8000, '전원 입장');
    console.log(`입장 ${bots.filter((b) => b.pid).length}/${N}명 (${Date.now() - t0}ms)`);
    // 81번째는 거절되어야 함
    const extra = io(URL, { transports: ['websocket'] }); await new Promise((r) => extra.on('connect', r));
    const ex = await emit(extra, 'player:join', { code, name: '초과' });
    if (N >= 80 && ex.ok) fail('정원 초과 입장이 허용됨'); extra.close();

    await sleep(2100); // 입장과 퀴즈 부하를 따로 재기 위해 쉼
    // ---- 퀴즈: 전원이 동시에 답을 보내도 첫 정답자는 1명 ----
    let r = await emit(host, 'host:quizStart', { title: '테스트 퀴즈', questions: QUIZ });
    if (!r.ok) fail('퀴즈 시작 실패');
    for (let qi = 0; qi < QUIZ.length; qi++) {
      bots.forEach((b) => { b.ev['quiz:open'] = null; b.firsts = 0; });
      await sleep(1100);
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
      const rv = H.reveals[qi];
      if (firstCount !== 1) fail(`${qi + 1}번 문제 첫 정답자가 ${firstCount}명`);
      const w = bots.find((b) => b.firsts === 1);
      if (!rv || !rv.winner || !w || rv.winner.id !== w.pid) fail(`${qi + 1}번 정답자 불일치`);
      await waitFor(() => bots.every((b) => b.ev['quiz:reveal'] && b.ev['quiz:reveal'].n === qi + 1), 2000, '학생 정답 공개 수신');
    }
    const sum = await emit(host, 'host:quizNext');
    console.log(`퀴즈 ${QUIZ.length}문제: 매 문제 첫 정답자 1명 확인, 정답자 = ${sum.summary.map((x) => x.winner).join(', ')}`);
    await emit(host, 'host:toLobby');

    // ---- 미니게임 공통 실행기 ----
    async function runMini(game, cfg, behave) {
      H.results = null;
      bots.forEach((b) => { b.ev['mini:play'] = null; b.ev['mini:result'] = null; });
      await emit(host, 'host:miniReady', { game, cfg });
      await emit(host, 'host:miniPlay');
      await waitFor(() => bots.every((b) => b.ev['mini:play']), 3000, game + ' 시작 수신');
      const st = bots[0].ev['mini:play'].startedAt;
      await sleep(st - Date.now() + 20);
      await Promise.all(bots.map((b) => behave(b, st)));
      await waitFor(() => H.results, 40000, game + ' 결과');
      await waitFor(() => bots.every((b) => b.ev['mini:result']), 3000, game + ' 학생 결과 수신');
      return H.results;
    }
    const check = (res, label) => {
      const rows = res.result.rows.filter((x) => x.rank != null);
      for (const x of rows) if (x.points !== Math.max(1, 51 - x.rank)) { fail(`${label} 점수 규칙 오류 ${x.rank}등 ${x.points}점`); break; }
      for (let i = 1; i < rows.length; i++) if (rows[i].rank < rows[i - 1].rank) { fail(label + ' 등수 정렬 오류'); break; }
      console.log(`${label}: ${rows.length}명 순위, 1등 ${rows[0].name}(${rows[0].record}) +${rows[0].points}점, 꼴등 ${rows[rows.length - 1].rank}등 +${rows[rows.length - 1].points}점, 참여 안 함 ${res.result.rows.length - rows.length}명`);
    };

    // 달리기: 사람마다 연타 속도가 다름(초당 6~12회), 3명은 중간에 접속이 끊겼다 돌아옴, 1명은 자동클릭(초당 40회) 흉내
    // 달리기: 실제 폰 화면과 똑같이 0.25초마다 보냄. 연타 속도는 사람마다 초당 6~12회, 3명은 중간에 끊겼다 돌아옴, 학생0은 자동클릭(초당 40회) 흉내
    const res1 = await runMini('race', { distance: 'short' }, async (b, st) => {
      const rate = b.i === 0 ? 40 : 6 + (b.i % 7); const goal = 60; let cut = false;
      while (!b.ev['mini:result'] && Date.now() - st < 62000) {
        await sleep(250);
        const steps = Math.min(goal, Math.floor((Date.now() - st) / 1000 * rate));
        if (b.i >= 1 && b.i <= 3 && steps >= 30 && !cut) { cut = true; b.s.io.engine.close(); await sleep(900); }
        b.s.emit('mini:act', { steps, elapsed: Date.now() - st });
      }
    });
    check(res1, '달리기');
    const cheat = res1.result.rows.find((x) => x.name === '학생0');
    if (cheat && cheat.rank === 1 && parseFloat(cheat.record) < 60 / 16 - 0.01) fail('자동클릭 속도 제한이 동작하지 않음');
    console.log(`  자동클릭 흉내 학생0 기록: ${cheat.record} (초당 16걸음 제한 → 최소 3.75초)`);
    await emit(host, 'host:toLobby');

    // 10초: 5명은 안 누름
    const res2 = await runMini('stop10', {}, async (b) => {
      if (b.i >= N - 5) return;
      await sleep(8500 + Math.random() * 3000);
      await emit(b.s, 'mini:act', { elapsed: 8500 + Math.random() * 3000 });
    });
    check(res2, '10초를 멈춰라');
    if (res2.result.rows.filter((x) => x.rank == null).length !== 5) fail('10초: 참여 안 함 인원 오류');
    await emit(host, 'host:toLobby');

    // 문질문질 10초: 일부러 동점자 만들기
    // 문질문질 10초: 0.25초마다 보냄, 일부러 동점자 만들기
    const res3 = await runMini('rub', { seconds: 10 }, async (b, st) => {
      const target = b.i < 4 ? 100 : 40 + (b.i % 30);
      while (Date.now() - st < 10200) { await sleep(250); b.s.emit('mini:act', { count: Math.min(target, Math.floor((Date.now() - st) / 1000 * 12)) }); }
    });
    check(res3, '문질문질');
    const tied = res3.result.rows.filter((x) => x.rank === 1);
    console.log(`  1등 동점 ${tied.length}명 (모두 ${tied[0].points}점)`);

    // 누적 점수 검증
    const fin = await emit(host, 'host:final');
    const sumCheck = fin.scores.players.every((p) => p.total === Object.values(p.pts).reduce((a, c) => a + c, 0));
    if (!sumCheck) fail('누적 점수 합계 불일치');
    await waitFor(() => bots.every((b) => b.ev['phase:final']), 3000, '최종 결과 수신');
    console.log(`최종: 1등 ${fin.scores.players[0].name} ${fin.scores.players[0].total}점, 게임 ${fin.scores.rounds.length}판, 실시간 순위 전송 ${liveCount}회`);

    lat.sort((a, b) => a - b);
    const p = (q) => lat[Math.floor(lat.length * q)];
    console.log(`서버 응답 ${lat.length}건: 중간값 ${p(0.5)}ms, 95% ${p(0.95)}ms, 99% ${p(0.99)}ms, 최대 ${lat[lat.length - 1]}ms`);
    bots.forEach((b) => b.s.close()); host.close();
  } catch (e) { console.error(e); fail(String(e)); }
  console.log(errors.length ? '❌ 오류 ' + errors.length + '건\n' + [...new Set(errors)].join('\n') : '✅ 오류 없음');
  try {
    const st = require('fs').readFileSync(`/proc/${srv.pid}/stat`, 'utf8').split(') ')[1].split(' ');
    const cpu = (+st[11] + +st[12]) / 100; const wall = (Date.now() - T0) / 1000;
    console.log(`서버 CPU 사용: ${cpu.toFixed(2)}초 / 테스트 ${wall.toFixed(0)}초 = 평균 ${(cpu / wall * 100).toFixed(1)}% (무료 서버 한도 10%), 가장 바빴던 1초 ${(peak * 100).toFixed(0)}%`); clearInterval(sampler);
  } catch (e) {}
  srv.kill(); process.exit(errors.length ? 1 : 0);
})();
