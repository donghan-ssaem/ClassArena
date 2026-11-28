// 모두에게 같은 패턴을 만들어 주는 도구 (서버와 참가자 화면이 함께 사용)
// 같은 seed(씨앗 숫자)를 넣으면 어느 기기에서든 똑같은 순서가 나온다.
(function (root) {
  function rng(seed) {
    let s = seed >>> 0;
    return function () {
      s = (s + 0x6D2B79F5) >>> 0;
      let t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // 조커 잡기: [{t: 나오는 시각(ms), h: 칸 번호 0~8, d: 머무는 시간(ms)}]
  // 처음엔 느긋하게, 뒤로 갈수록 빨라짐. 후반에는 2~3장이 동시에 나오지만 보고 누를 수 있는 시간은 남김
  function jokerPattern(seed, totalMs) {
    const r = rng(seed);
    const list = [];
    const busyUntil = new Array(9).fill(0);
    let t = 500;
    while (t < totalMs - 300) {
      const p = t / totalMs;
      const stay = Math.round(1150 - 480 * Math.pow(p, 1.3));          // 1.15초 → 마지막 0.67초 (보고 누를 수 있는 시간)
      const roll = r();
      const many = p > 0.75 ? (roll < 0.12 ? 3 : roll < 0.55 ? 2 : 1)  // 마지막 4분의 1: 자주 2장, 가끔 3장
        : p > 0.5 ? (roll < 0.35 ? 2 : 1) : 1;
      for (let k = 0; k < many; k++) {
        let h = Math.floor(r() * 9), tries = 0;
        while (busyUntil[h] > t && tries++ < 20) h = Math.floor(r() * 9);
        if (busyUntil[h] > t) continue;
        list.push({ t: Math.round(t), h, d: stay });
        busyUntil[h] = t + stay + 120;
      }
      t += (900 - 520 * Math.pow(p, 1.6)) * (0.8 + r() * 0.4);        // 간격 0.9초 → 마지막 0.38초
    }
    return list;
  }

  // 하트 풍선: 5초마다 바뀌는 안전 구름 위치 [{t, c: 가운데(0~1), size: 높이}]
  function cloudPattern(seed, totalMs) {
    const r = rng(seed);
    const zones = [];
    let prev = 0.5;
    for (let t = 0; t < totalMs; t += 5000) {
      let c, tries = 0;
      do { c = 0.18 + r() * 0.64; } while (Math.abs(c - prev) < 0.22 && tries++ < 30);
      zones.push({ t, c: Math.round(c * 1000) / 1000, size: 0.22 });
      prev = c;
    }
    return zones;
  }

  root.CAPattern = { rng, jokerPattern, cloudPattern };
})(typeof module !== 'undefined' ? module.exports : window);
