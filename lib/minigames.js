'use strict';
// 미니게임 정의. 새 게임은 여기에 항목 하나를 추가하면 된다.
//   title(이름), rules(설명), config(설정 정리), init(기록 초기값), action(학생 입력 처리),
//   compare(순위 비교: 음수면 a가 앞), participated(참여 여부), done(완주 여부), record(기록 글자), live(관리자 실시간용)
// 학생 기기에서 계산한 값은 '그 시간 안에 사람이 낼 수 있는 최댓값'을 넘지 않게 서버에서 잘라낸다.
const { CAPattern } = require('../public/patterns.js');

const GRACE_MS = 400; // 끝난 직후 늦게 도착한 마지막 입력을 받아주는 시간
const elapsedOf = (room, t) => Math.min(t, room.mini.endsAt) - room.mini.startedAt;

const MINIGAMES = {
  race: {
    title: '카드 병정 레이스',
    icon: '🏃',
    rules: ['왼발 · 오른발 버튼을 차례로 눌러 한 걸음씩', '한쪽만 계속 누르면 제자리예요', '결승선을 먼저 넘은 병정이 1등'],
    config(c) {
      const goal = { short: 60, normal: 100, long: 150 }[c && c.distance] || 100;
      return { goal, seconds: 60, distance: (c && c.distance) || 'normal' };
    },
    MAX_RATE: 16, // 초당 최대 걸음 (이보다 빠르면 자동 클릭으로 보고 잘라냄)
    init: () => ({ steps: 0, finishMs: null }),
    action(room, g, d, t) {
      const cfg = room.mini.cfg; const el = t - room.mini.startedAt;
      if (el < 0 || g.finishMs != null) return null;
      const want = Math.floor(Number(d && d.steps));
      if (!(want > g.steps)) return null;
      g.steps = Math.min(want, Math.floor((el / 1000) * this.MAX_RATE) + 3, cfg.goal);
      if (g.steps >= cfg.goal) {
        let ms = Number(d && d.elapsed);
        if (!isFinite(ms) || ms > el + 150) ms = el;
        g.finishMs = Math.round(Math.max((cfg.goal / this.MAX_RATE) * 1000, ms));
      }
      return { steps: g.steps };
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
    record: (g, cfg) => (g.finishMs != null ? `${(g.finishMs / 1000).toFixed(2)}초 결승` : `${Math.round((g.steps / cfg.goal) * 100)}% 지점`),
    live: (g, cfg) => ({ v: g.steps, max: cfg.goal, fin: g.finishMs != null }),
  },

  stop10: {
    title: '마음속 시계',
    icon: '⏱',
    rules: ['시계는 3초까지만 보여 주고 사라져요', '그다음은 속으로 이어서 세어요', '10.00초라고 생각될 때 STOP · 딱 한 번'],
    config: () => ({ target: 10000, hideAfter: 3000, seconds: 25 }),
    init: () => ({ stopMs: null, diff: null }),
    action(room, g, d, t) {
      if (g.stopMs != null) return { stopMs: g.stopMs };
      const el = t - room.mini.startedAt;
      if (el < 0) return null;
      let ms = Number(d && d.elapsed);
      if (!isFinite(ms) || ms < 0 || ms > el + 150) ms = el;
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
    title: '카드 섞기',
    icon: '🃏',
    rules: ['카드 더미를 손가락으로 좌우로 쓱쓱', '방향을 바꿀 때마다 한 번 섞여요', '시간 안에 가장 많이 섞은 사람이 1등'],
    config(c) {
      const s = [10, 15, 20].includes(+(c && c.seconds)) ? +c.seconds : 15;
      return { seconds: s };
    },
    MAX_RATE: 22,
    init: () => ({ count: 0 }),
    action(room, g, d, t) {
      const el = elapsedOf(room, t); if (el < 0) return null;
      const want = Math.floor(Number(d && d.count));
      if (!(want > g.count)) return null;
      g.count = Math.min(want, Math.floor((el / 1000) * this.MAX_RATE) + 3);
      return { count: g.count };
    },
    compare: (a, b) => b.count - a.count,
    participated: (g) => g.count > 0,
    done: () => false,
    record: (g) => `${g.count}번`,
    live: (g) => ({ v: g.count, unit: '번' }),
  },

  joker: {
    title: '조커 잡기',
    icon: '🤡',
    rules: ['9칸 카드 더미에서 조커가 고개를 내밀어요', '숨기 전에 톡 누르면 한 장', '빈칸을 누르면 0.5초 동안 못 눌러요 · 갈수록 빨라져요'],
    config: () => ({ seconds: 30 }),
    init: () => ({ hits: 0 }),
    action(room, g, d, t) {
      const el = elapsedOf(room, t); if (el < 0) return null;
      const want = Math.floor(Number(d && d.hits));
      if (!(want > g.hits)) return null;
      const shown = room.mini.pattern.filter((s) => s.t <= el + 100).length; // 지금까지 나온 조커 수를 넘을 수 없음
      g.hits = Math.min(want, shown);
      return { hits: g.hits };
    },
    compare: (a, b) => b.hits - a.hits,
    participated: (g) => g.hits > 0,
    done: () => false,
    record: (g) => `조커 ${g.hits}장`,
    live: (g) => ({ v: g.hits, unit: '장' }),
  },

  balloon: {
    title: '하트 풍선',
    icon: '🎈',
    rules: ['꾹 누르고 있으면 풍선이 떠오르고, 떼면 내려가요', '초록 구름 안에 머문 시간이 점수', '구름은 5초마다 자리를 옮겨요'],
    config: () => ({ seconds: 30 }),
    init: () => ({ ms: 0 }),
    action(room, g, d, t) {
      const el = elapsedOf(room, t); if (el < 0) return null;
      const want = Math.floor(Number(d && d.ms));
      if (!(want > g.ms)) return null;
      g.ms = Math.min(want, el + 100);
      return { ms: g.ms };
    },
    compare: (a, b) => Math.round(b.ms / 10) - Math.round(a.ms / 10),
    participated: (g) => g.ms > 0,
    done: () => false,
    record: (g) => `${(g.ms / 1000).toFixed(1)}초`,
    live: (g) => ({ v: Math.round(g.ms / 100) / 10, unit: '초' }),
  },

  dice: {
    title: '주사위 흔들기',
    icon: '🎲',
    rules: ['폰을 주사위 컵처럼 꽉 쥐고 흔들어요', '아이폰은 "동작 및 방향"을 허용해 주세요', '폰을 놓치지 않게 조심 (크롬북은 구경)'],
    phoneOnly: true,
    config: () => ({ seconds: 15 }),
    MAX_RATE: 12,
    init: () => ({ count: 0, spectate: false }),
    action(room, g, d, t) {
      if (g.spectate) return null;
      const el = elapsedOf(room, t); if (el < 0) return null;
      const want = Math.floor(Number(d && d.count));
      if (!(want > g.count)) return null;
      g.count = Math.min(want, Math.floor((el / 1000) * this.MAX_RATE) + 3);
      return { count: g.count };
    },
    compare: (a, b) => b.count - a.count,
    participated: (g) => g.count > 0 && !g.spectate,
    done: () => false,
    record: (g) => `${g.count}번`,
    live: (g) => ({ v: g.count, unit: '번' }),
  },
};

function makePattern(game, cfg) {
  if (game === 'joker') return CAPattern.jokerPattern(cfg.seed, cfg.seconds * 1000);
  return null;
}

module.exports = { MINIGAMES, GRACE_MS, makePattern };
