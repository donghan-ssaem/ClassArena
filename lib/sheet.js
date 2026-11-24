'use strict';
// 구글 시트 → 퀴즈 문제 변환
// 열 순서: 문제 | 안내문 | 정답 | 보기1 | 보기2 | 보기3 | 보기4 | 다른 정답(쉼표 구분)
// 보기를 모두 비우면 주관식, 하나라도 적으면 객관식

function parseCSV(text) {
  const rows = [];
  let row = [], cell = '', q = false;
  text = String(text).replace(/^﻿/, '');
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; }
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

// 붙여넣기(탭 구분)도 같은 규칙으로 처리
function parseTSV(text) {
  return String(text).replace(/\r/g, '').split('\n').map((l) => l.split('\t'));
}

const norm = (s) => String(s == null ? '' : s).normalize('NFC').toLowerCase()
  .replace(/[\s.,!?·~\-_'"()[\]{}:;]/g, '');
const clean = (s, n) => String(s == null ? '' : s).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n);

function rowsToQuestions(rows) {
  const questions = [], errors = [];
  rows.forEach((r, i) => {
    const line = i + 1;
    const cells = r.map((c) => clean(c, 200));
    if (!cells.some(Boolean)) return;
    if (i === 0 && /^(문제|질문|question)$/i.test(cells[0])) return; // 머리글
    const [q, guide, ans, c1, c2, c3, c4, alt] = cells;
    if (!q) { errors.push(`${line}행: 문제가 비어 있어요`); return; }
    if (!ans) { errors.push(`${line}행: 정답이 비어 있어요`); return; }
    const raw = [c1, c2, c3, c4].map((x) => clean(x, 60));
    const choices = raw.filter(Boolean);
    const item = { q: clean(q, 120), guide: clean(guide, 80) };
    if (choices.length) {
      if (choices.length < 2) { errors.push(`${line}행: 객관식은 보기가 2개 이상 필요해요`); return; }
      let idx = choices.findIndex((c) => norm(c) === norm(ans));
      if (idx < 0 && /^[1-4]$/.test(ans) && raw[+ans - 1]) idx = choices.indexOf(raw[+ans - 1]);
      if (idx < 0) { errors.push(`${line}행: 정답 "${ans}"이(가) 보기에 없어요`); return; }
      Object.assign(item, { type: 'choice', choices, answerIdx: idx, answerText: choices[idx] });
    } else {
      const accepts = [ans, ...String(alt || '').split(',')].map(norm).filter(Boolean);
      Object.assign(item, { type: 'text', answerText: clean(ans, 60), accepts: [...new Set(accepts)] });
    }
    questions.push(item);
  });
  return { questions: questions.slice(0, 200), errors: errors.slice(0, 30) };
}

function sheetCsvUrl(url) {
  const m = String(url).match(/docs\.google\.com\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
  if (!m) return null;
  const g = String(url).match(/[#&?]gid=(\d+)/);
  return `https://docs.google.com/spreadsheets/d/${m[1]}/export?format=csv${g ? '&gid=' + g[1] : ''}`;
}

async function fetchSheet(url) {
  const csvUrl = sheetCsvUrl(url);
  if (!csvUrl) throw new Error('구글 시트 주소가 아니에요');
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(csvUrl, { signal: ctrl.signal, redirect: 'follow' });
    const text = await res.text();
    if (!res.ok || /<html/i.test(text.slice(0, 300))) {
      throw new Error('시트를 읽지 못했어요. 공유를 "링크가 있는 모든 사용자 - 뷰어"로 바꿔 주세요');
    }
    return rowsToQuestions(parseCSV(text));
  } finally { clearTimeout(t); }
}

module.exports = { parseCSV, parseTSV, rowsToQuestions, fetchSheet, sheetCsvUrl, norm };
