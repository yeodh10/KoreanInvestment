#!/usr/bin/env node
/**
 * market-check.js — 장중 자동 점검 (systemd 타이머가 평일 09:05·10:00 KST에 실행)
 * CLI/사람 없이도 서버·터널·실시간·응답속도·자동매매 상태를 측정해 리포트로 남긴다.
 * 결과: 장중점검-YYYYMMDD.md (저장소 루트, 추가 기록) + 텔레그램 요약(설정 시).
 * 실행: node market-check.js   (server와 같은 디렉터리)
 */
const http = require('http'), https = require('https'), dns = require('dns'), fs = require('fs'), path = require('path');
const KST = 9 * 3600 * 1000;
const PUBLIC_HOST = (() => { try { return fs.readFileSync(path.join(__dirname, 'CURRENT-URL.txt'), 'utf8').trim().replace(/^https?:\/\//, '').replace(/\/.*$/, ''); } catch (_) { return 'kis.tail8eca6a.ts.net'; } })();
const PORT = process.env.PORT || 3000;

const now = Date.now();
const k = new Date(now + KST);
const dateKey = k.toISOString().slice(0, 10);
const hhmm = `${String(k.getUTCHours()).padStart(2, '0')}:${String(k.getUTCMinutes()).padStart(2, '0')}`;

function localGet(p) {
  return new Promise(r => {
    const s = process.hrtime.bigint();
    const req = http.get({ host: '127.0.0.1', port: PORT, path: p }, res => {
      let n = 0; res.on('data', d => n += d.length);
      res.on('end', () => r({ status: res.statusCode, ms: Math.round(Number(process.hrtime.bigint() - s) / 1e6), bytes: n }));
    });
    req.on('error', e => r({ err: e.message }));
    req.setTimeout(15000, () => { req.destroy(); r({ err: 'timeout(15s)' }); });
  });
}
function publicGet(p) {
  return new Promise(res => {
    const rs = new dns.Resolver(); rs.setServers(['8.8.8.8']);
    rs.resolve4(PUBLIC_HOST, (e, a) => {
      if (e || !a || !a[0]) return res({ err: 'dns ' + (e ? e.message : 'noaddr') });
      const s = process.hrtime.bigint();
      const req = https.request({ host: a[0], path: p, servername: PUBLIC_HOST, headers: { Host: PUBLIC_HOST } }, rr => {
        let n = 0; rr.on('data', d => n += d.length);
        rr.on('end', () => res({ status: rr.statusCode, ms: Math.round(Number(process.hrtime.bigint() - s) / 1e6), bytes: n }));
      });
      req.on('error', ee => res({ err: ee.message }));
      req.setTimeout(15000, () => { req.destroy(); res({ err: 'timeout(15s)' }); });
      req.end();
    });
  });
}
const f = r => r.err ? `❌ ${r.err}` : `${r.status} · ${r.ms}ms${r.bytes ? ' · ' + (r.bytes > 9999 ? Math.round(r.bytes / 1024) + 'KB' : r.bytes + 'B') : ''}`;
const ok2 = r => !r.err && r.status === 200;

(async () => {
  const L = [];
  L.push(`\n## ${dateKey} ${hhmm} KST 점검\n`);

  // ── 1) 서버/터널 헬스 + 응답속도 ──
  const localHome = await localGet('/');
  const localMe = await localGet('/api/auth/me');
  const pubHome = await publicGet('/');
  const pubMe = await publicGet('/api/auth/me');
  L.push('### 헬스 · 응답속도');
  L.push(`- 로컬 메인(/):        ${f(localHome)}`);
  L.push(`- 로컬 API(/auth/me):  ${f(localMe)}`);
  L.push(`- 공개 메인(터널):      ${f(pubHome)}`);
  L.push(`- 공개 API(터널):       ${f(pubMe)}`);
  const serverUp = ok2(localMe) || (localMe.status >= 200 && localMe.status < 500);
  const tunnelUp = !pubHome.err && pubHome.status < 500;

  // ── 2) 자동매매 엔진 활동 (유저별 로그 최근 항목) ──
  L.push('\n### 자동매매 엔진');
  let engineLines = 0, engineErrs = 0;
  try {
    const dir = path.join(__dirname, 'user-configs');
    const logs = fs.existsSync(dir) ? fs.readdirSync(dir).filter(x => /^autotrade-log-/.test(x)) : [];
    if (!logs.length) L.push('- (자동매매 로그 파일 없음 — 엔진 미가동이거나 첫 거래일)');
    for (const lf of logs) {
      let arr = [];
      try { arr = JSON.parse(fs.readFileSync(path.join(dir, lf), 'utf8')); } catch (_) {}
      const today = arr.filter(e => new Date(new Date(e.time).getTime() + KST).toISOString().slice(0, 10) === dateKey);
      engineLines += today.length;
      const errs = today.filter(e => e.type === 'error'); engineErrs += errs.length;
      const acts = today.filter(e => e.type === 'buy' || e.type === 'sell');
      const uid = lf.replace('autotrade-log-', '').replace('.json', '');
      L.push(`- [${uid}] 오늘 로그 ${today.length}건 · 매수/매도 ${acts.length}건 · 오류 ${errs.length}건`);
      today.slice(0, 5).forEach(e => L.push(`    · ${(e.message || '').slice(0, 90)}`));
    }
  } catch (e) { L.push('- 엔진 로그 읽기 실패: ' + e.message); }

  // ── 3) 서버 로그 분석 (KIS 실시간 연결 · 최근 오류) ──
  L.push('\n### 서버 로그 (실시간 연결 · 오류 패턴)');
  let wsConnected = false, errSnap = [];
  try {
    // 로그 끝 64KB만 읽는다 — 로테이션 없이 커진 로그를 통째로 메모리에 올리지 않게
    let buf = '';
    try {
      const fd = fs.openSync('/var/log/autotrade.log', 'r');
      const { size } = fs.fstatSync(fd);
      const len = Math.min(size, 65536);
      const b = Buffer.alloc(len);
      fs.readSync(fd, b, 0, len, size - len);
      fs.closeSync(fd);
      buf = b.toString('utf8');
    } catch (_) { buf = fs.readFileSync('/var/log/autotrade.log', 'utf8'); }
    const tail = buf.split('\n').slice(-400);
    const lastWs = [...tail].reverse().find(l => /KIS WebSocket|WS 오류|연결 끊김|재연결/.test(l));
    wsConnected = !!(lastWs && /연결됨/.test(lastWs));
    L.push(`- 실시간 WS 최근 상태: ${lastWs ? lastWs.replace(/^.*?\]\s*/, '').slice(0, 80) : '(로그 없음)'}`);
    const errPat = /오류|error|EGW|타임아웃|timeout|실패|ECONN|Unhandled/i;
    const errs = tail.filter(l => errPat.test(l) && !/구독 응답|레거시|ExperimentalWarning/.test(l));
    L.push(`- 최근 400줄 중 오류성 로그: ${errs.length}건`);
    errSnap = errs.slice(-6);
    errSnap.forEach(l => L.push(`    · ${l.slice(0, 110)}`));
  } catch (e) { L.push('- 서버 로그 읽기 실패: ' + e.message); }

  // ── 4) 종합 판정 ──
  L.push('\n### 종합');
  const verdict = [];
  verdict.push(serverUp ? '🟢 서버 정상' : '🔴 서버 응답 이상');
  verdict.push(tunnelUp ? '🟢 터널 정상' : '🔴 터널 이상');
  verdict.push(wsConnected ? '🟢 실시간 연결' : '🟡 실시간 연결 미확인');
  const slow = [localHome, pubHome].filter(r => !r.err && r.ms > 1500);
  verdict.push(slow.length ? `🟡 느린 응답 ${slow.length}건(>1.5s)` : '🟢 응답속도 양호');
  verdict.push(engineErrs ? `🟡 엔진 오류 ${engineErrs}건` : '🟢 엔진 오류 없음');
  L.push('- ' + verdict.join(' · '));

  const report = L.join('\n') + '\n';
  // 리포트 파일에 추가 기록
  const file = path.join(__dirname, `장중점검-${dateKey.replace(/-/g, '')}.md`);
  try { fs.appendFileSync(file, report); } catch (_) {}
  console.log(report);

  // ── 5) 텔레그램 요약 발송 (설정된 유저에게) ──
  try {
    const auth = require('./auth.js');
    const users = auth.loadUsers();
    const summary = `📊 <b>장중 점검 ${hhmm}</b>\n${verdict.join('\n')}\n메인 ${localHome.ms||'-'}ms · 공개 ${pubHome.ms||'-'}ms`;
    for (const uname of Object.keys(users)) {
      const cfg = auth.loadUserConfig(users[uname].userId);
      if (cfg.telegramToken && cfg.telegramChatId) await sendTelegram(cfg.telegramToken, cfg.telegramChatId, summary);
    }
  } catch (_) {}
  process.exit(0);
})();

function sendTelegram(token, chatId, text) {
  return new Promise(res => {
    const body = JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' });
    const req = https.request({ hostname: 'api.telegram.org', path: `/bot${token}/sendMessage`, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, r => { r.on('data', () => {}); r.on('end', res); });
    req.on('error', res); req.setTimeout(8000, () => { req.destroy(); res(); });
    req.write(body); req.end();
  });
}
