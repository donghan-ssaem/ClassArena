// 관리자·참가자 화면 공통 도구
(function () {
  const $ = (id) => document.getElementById(id);
  let flip = 0;
  // 캐릭터 이미지 주소. who를 안 주면 두리·서이를 번갈아 사용
  function charSrc(pose, who) {
    if (!who) who = (flip++ % 2) ? 'seoi' : 'duri';
    return `/img/${who}_${pose}.webp`;
  }
  function setChar(el, pose, who) { if (el) el.src = charSrc(pose, who); }

  let toastT;
  function toast(msg) {
    let t = $('toast');
    if (!t) { t = document.createElement('div'); t.id = 'toast'; document.body.appendChild(t); }
    t.textContent = msg; t.classList.remove('hidden');
    clearTimeout(toastT); toastT = setTimeout(() => t.classList.add('hidden'), 3200);
  }

  function connBadge(sock) {
    const b = document.createElement('div'); b.id = 'conn'; b.className = 'hidden';
    b.textContent = '연결이 끊겼어요 · 다시 연결하는 중…';
    document.body.appendChild(b);
    sock.on('connect', () => b.classList.add('hidden'));
    sock.on('disconnect', () => b.classList.remove('hidden'));
    sock.on('connect_error', () => b.classList.remove('hidden'));
  }

  function connect() {
    return io({ transports: ['websocket', 'polling'], reconnection: true, reconnectionDelay: 300, reconnectionDelayMax: 2500, timeout: 8000 });
  }

  // 서버 시계와의 차이(ms). 왕복이 가장 짧은 측정값 사용
  async function syncTime(sock) {
    let best = null;
    for (let i = 0; i < 5; i++) {
      const t0 = performance.now(); const c0 = Date.now();
      const s = await new Promise((r) => sock.timeout(2000).emit('time:sync', null, (e, v) => r(e ? null : v)));
      const rtt = performance.now() - t0;
      if (s != null && (!best || rtt < best.rtt)) best = { rtt, off: s + rtt / 2 - (c0 + rtt) };
      await new Promise((r) => setTimeout(r, 40));
    }
    return best ? best.off : 0;
  }

  // 응답 대기 emit (Promise). 실패하면 { ok:false, timeout:true }
  function call(sock, ev, data, ms) {
    return new Promise((r) => sock.timeout(ms || 6000).emit(ev, data, (e, res) => r(e ? { ok: false, timeout: true, error: '서버 응답이 없어요. 잠시 후 다시 시도해 주세요.' } : (res || { ok: false }))));
  }

  function downloadCSV(rows, filename) {
    const esc = (v) => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
    const csv = '﻿' + rows.map((r) => r.map(esc).join(',')).join('\r\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    a.download = filename; document.body.appendChild(a); a.click(); a.remove();
  }

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  window.CA = { $, charSrc, setChar, toast, connBadge, connect, syncTime, call, downloadCSV, el };
})();
