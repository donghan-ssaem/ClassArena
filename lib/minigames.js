'use strict';
// 미니게임 정의. 새 게임을 추가할 때는 이 파일에 항목 하나를 추가하면 된다.
// 각 게임이 정하는 것:
//   title, rules(설명 3줄), config(관리자 설정 정리), init(플레이어 기록 초기값),
//   action(학생 입력 처리), compare(순위 비교: 음수면 a가 앞), participated, record(기록 글자), done(완주 여부), live(관리자 실시간 화면용)

const GRACE_MS = 400; // 종료 직후 늦게 도착한 마지막 입력을 받아주는 시간

const MINIGAMES = {
  race: {
    title: '달리기',
    rules: ['왼쪽·오른쪽 버튼을 번갈아 톡톡', '같은 쪽 두 번은 앞으로 안 가요', '먼저 도착한 순서대로 등수'],
    config(c) {
      const goal = { short: 60, normal: 100, long: 150 }[c && c.distance] || 100;
      return { goal, seconds: 60, distance: (c && c.distance) || 'normal' };
    },
    MAX_RATE: 16, // 초당 최대 걸음(이보다 빠르면 자동 클릭으로 보고 잘라냄)
    init: () => ({ steps: 0, finishMs: null }),
    action(room, g, d, t) {
      const cfg = room.mini.cfg;
      const elapsed = t - room.mini.startedAt;
      if (elapsed < 0 || g.finishMs != null) return null;
      const want = Math.floor(Number(d && d.steps));
      if (!(want > g.steps)) return null;
      const cap = Math.floor((elapsed / 1000) * this.MAX_RATE) + 3;
      g.steps = Math.min(want, cap, cfg.goal);
      if (g.steps >= cfg.goal) {
        const minMs = (cfg.goal / this.MAX_RATE) * 1000;
        let ms = Number(d && d.elapsed);
        if (!isFinite(ms) || ms > elapsed + 150) ms = elapsed;
        g.finishMs = Math.round(Math.max(minMs, ms));
      }
      return { steps: g.steps, finishMs: g.finishMs };
    },
    compare(a, b) {
      if (a.finishMs != null || b.finishMs != null) {
        if (a.finishMs == null) return 1;
        if (b.finishMs == null) return -1;
        return a.finishMs - b.finishMs;
      }
      return b.steps - a.steps;
    },
    participated: (g) => g.steps > 0,
    done: (g) => g.finishMs != null,
    record: (g, cfg) => (g.finishMs != null ? `${(g.finishMs / 1000).toFixed(2)}초 도착` : `${Math.round((g.steps / cfg.goal) * 100)}% 지점`),
    live: (g, cfg) => ({ v: g.steps, max: cfg.goal, fin: g.finishMs != null }),
  },

  stop10: {
    title: '10초를 멈춰라',
    rules: ['시작하면 시계가 돌다가 3초 뒤 사라져요', '속으로 세다가 딱 10초라고 생각될 때 STOP', '10.00초에 가장 가까운 사람이 1등 · 기회는 한 번'],
    config: () => ({ target: 10000, hideAfter: 3000, seconds: 25 }),
    init: () => ({ stopMs: null, diff: null }),
    action(room, g, d, t) {
      if (g.stopMs != null) return { stopMs: g.stopMs };
      const elapsed = t - room.mini.startedAt;
      if (elapsed < 0) return null;
      let ms = Number(d && d.elapsed);
      if (!isFinite(ms) || ms < 0 || ms > elapsed + 150) ms = elapsed; // 서버 경과시간보다 클 수 없음
      g.stopMs = Math.round(ms);
      g.diff = Math.abs(g.stopMs - room.mini.cfg.target);
      return { stopMs: g.stopMs };
    },
    compare: (a, b) => a.diff - b.diff,
    participated: (g) => g.stopMs != null,
    done: (g) => g.stopMs != null,
    record: (g) => (g.stopMs != null ? `${(g.stopMs / 1000).toFixed(2)}초 (차이 ${(g.diff / 1000).toFixed(2)})` : '기록 없음'),
    live: (g) => ({ v: g.stopMs != null ? 1 : 0, max: 1, fin: g.stopMs != null }),
  },

  rub: {
    title: '문질문질',
    rules: ['손가락을 화면에 대고 좌우로 왕복', '방향이 바뀔 때마다 1회', '시간 안에 가장 많이 문지른 사람이 1등'],
    config(c) {
      const s = [10, 15, 20].includes(+(c && c.seconds)) ? +c.seconds : 15;
      return { seconds: s };
    },
    MAX_RATE: 22,
    init: () => ({ count: 0 }),
    action(room, g, d, t) {
      const elapsed = Math.min(t, room.mini.endsAt) - room.mini.startedAt;
      if (elapsed < 0) return null;
      const want = Math.floor(Number(d && d.count));
      if (!(want > g.count)) return null;
      g.count = Math.min(want, Math.floor((elapsed / 1000) * this.MAX_RATE) + 3);
      return { count: g.count };
    },
    compare: (a, b) => b.count - a.count,
    participated: (g) => g.count > 0,
    done: () => false,
    record: (g) => `${g.count}회`,
    live: (g) => ({ v: g.count, max: 0, fin: false }),
  },
};

module.exports = { MINIGAMES, GRACE_MS };
