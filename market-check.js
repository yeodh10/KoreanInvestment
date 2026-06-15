#!/usr/bin/env node
/**
 * market-check.js — 장중 자동 점검 (systemd 타이머가 평일 09:05·10:00 KST에 실행)
 * CLI/사람 없이도 서버·터널·실시간·응답속도·자동매매 상태를 측정해 리포트로 남긴다.
 * 결과: 장중점검-YYYYMMDD.md (저장소 루트, 추가 기록) + 텔레그램 요약(설정 시).
 * 실행: node market-check.js   (server와 같은 디렉터리)
 */
const http = require('http'), https = require('https'), dns = require('dns'), fs = require('fs'), path = require('path');
// KRX 휴장일 판정을 auto-trader.js의 권위 테이블(KRX_HOLIDAYS)에서 재사용 —
// 평일이라도 휴장일이면 WS/시세 피드가 정상적으로 멈추므로 거짓 '🔴 연결 끊김/피드 정지'
// 경보(텔레그램 스팸)를 막는다. require는 부작용 없음(엔진은 클래스로만 기동).
let isHoliday = () => false, isMarketOpen = () => false;
try { ({ isHoliday, isMarketOpen } = require('./auto-trader.js')); } catch (_) {}
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

  // ── 1b) 부하 견딤 미니테스트 — 폭락장 트래픽 폭주를 가정해 메인을 동시 12요청 ──
  const N = 12, t0 = Date.now();
  const rs = await Promise.all(Array.from({ length: N }, () => localGet('/')));
  const oks = rs.filter(r => !r.err && r.status === 200);
  const mss = oks.map(r => r.ms).sort((a, b) => a - b);
  const p50 = mss.length ? mss[Math.floor(mss.length * 0.5)] : 0;
  const p95 = mss.length ? (mss[Math.floor(mss.length * 0.95)] || mss[mss.length - 1]) : 0;
  L.push(`- 부하 견딤(동시 ${N}요청): 성공 ${oks.length}/${N} · p50 ${p50}ms · p95 ${p95}ms · 총 ${Date.now() - t0}ms`);
  const loadOk = oks.length === N && p95 < 3000;

  // ── 시장 지수 · 환율 + 시세 피드 신선도 (캐시) ──
  let idx = '', feedStale = false;
  const km = new Date(Date.now() + KST), kmm = km.getUTCHours() * 60 + km.getUTCMinutes();
  // 개장 여부는 auto-trader의 권위 isMarketOpen()으로 판정 — 휴장일뿐 아니라 단축장(수능 등
  // 늦장개장)도 반영한다. 휴장/장외/단축장 개장 전이면 WS·피드 정지가 정상이라 거짓 🔴 경보를 막는다.
  // (manual 09:00~15:30 윈도우는 단축장 늦장개장을 몰라 09:05 점검에서 거짓 경보를 냈음.)
  const openMkt = isMarketOpen();
  try {
    const c = JSON.parse(fs.readFileSync(path.join(__dirname, 'data-cache.json'), 'utf8'));
    const m = c['market'] && (c['market'].v || c['market']);
    if (m) {
      const g = o => o ? `${(o.bstp_nmix_prpr || 0)} (${o.bstp_nmix_prdy_ctrt || 0}%)` : '-';
      idx = `KOSPI ${g(m.KOSPI)} · KOSDAQ ${g(m.KOSDAQ)} · USD/KRW ${m.USDKRW && m.USDKRW.rate || '-'}`;
      L.push(`- 지수/환율: ${idx}`);
    }
    // ★ 시세 피드 신선도 — 서버가 살아 있어도 시세 갱신이 멈추면(폭락장 큐 적체 등) "거짓 초록"이
    //   되므로, 장중엔 시세 캐시 갱신 시각으로 정지/지연을 실제로 감지한다.
    const pp = c['persist:price'] && (c['persist:price'].v || c['persist:price']) || {};
    const tot = Object.keys(pp).length;
    if (openMkt && tot > 0) {
      const fresh = Object.values(pp).filter(e => e && e.t && Date.now() - e.t < 120000).length;
      const ratio = fresh / tot;
      L.push(`- 시세 피드: ${fresh}/${tot} 종목 2분내 갱신 (${Math.round(ratio * 100)}%)`);
      feedStale = ratio < 0.3; // 장중인데 30% 미만 신선 = 피드 지연/정지 의심
    }
  } catch (_) {}

  // ── 봇 대응 · 서킷 상태 (유저별 state) ──
  L.push('\n### 봇 대응 · 서킷');
  let circuitTripped = false;
  try {
    const dir = path.join(__dirname, 'user-configs');
    const states = fs.existsSync(dir) ? fs.readdirSync(dir).filter(x => /^autotrade-state-/.test(x)) : [];
    if (!states.length) L.push('- (상태 파일 없음)');
    for (const sf of states) {
      let s = {}; try { s = JSON.parse(fs.readFileSync(path.join(dir, sf), 'utf8')); } catch (_) {}
      const pnl = s.dailyRealizedPnl || 0, sft = s.settings && s.settings.safety || {};
      const halts = [];
      if (s.stoppedByLoss) halts.push('일일손실정지');
      if ((s.consecLosses || 0) >= (sft.maxConsecLosses || 99)) halts.push('연속패정지');
      if ((s.tradesToday || 0) >= (sft.maxTradesPerDay || 999)) halts.push('거래수한도');
      if (halts.length) circuitTripped = true;
      const uid = sf.replace('autotrade-state-', '').replace('.json', '');
      L.push(`- [${uid}] enabled=${s.settings && s.settings.enabled} · 실현손익 ${(pnl >= 0 ? '+' : '') + Math.round(pnl).toLocaleString()} · 연속패 ${s.consecLosses || 0} · 거래 ${s.tradesToday || 0} · 봇보유 ${Object.keys(s.botPositions || {}).length}종목 · 서킷 ${halts.length ? '🛑 ' + halts.join(',') : '정상범위'}`);
    }
  } catch (e) { L.push('- 봇 상태 읽기 실패: ' + e.message); }

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
      const stops = today.filter(e => /손절|트레일/.test(e.message || ''));
      const fills = today.filter(e => /체결 확정/.test(e.message || ''));
      const uid = lf.replace('autotrade-log-', '').replace('.json', '');
      L.push(`- [${uid}] 오늘 로그 ${today.length}건 · 매수/매도 ${acts.length}건 · 손절/트레일 ${stops.length}건 · 체결확정 ${fills.length}건 · 오류 ${errs.length}건`);
      today.slice(0, 5).forEach(e => L.push(`    · ${(e.message || '').slice(0, 90)}`));
    }
  } catch (e) { L.push('- 엔진 로그 읽기 실패: ' + e.message); }

  // ── 3) 서버 로그 분석 (KIS 실시간 연결 · 최근 오류) ──
  L.push('\n### 서버 로그 (실시간 연결 · 오류 패턴)');
  let wsConnected = false, errSnap = [], serverStable = true;
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
    // 폭락장 부하 견딤 지표
    const egw = tail.filter(l => /EGW00201|초당 거래건수/.test(l)).length;
    const reconn = tail.filter(l => /재연결|무수신|강제 재연결/.test(l)).length;
    const procEx = tail.filter(l => /\[Rejection\]|\[Uncaught\]/.test(l)).length;
    L.push(`- 부하 견딤: KIS 레이트리밋거부(EGW) ${egw}건 · WS 재연결/무수신 ${reconn}건 · 프로세스 예외 ${procEx}건`);
    serverStable = procEx === 0;
    errSnap = errs.slice(-6);
    errSnap.forEach(l => L.push(`    · ${l.slice(0, 110)}`));
  } catch (e) { L.push('- 서버 로그 읽기 실패: ' + e.message); }

  // ── 4) 종합 판정 ──
  L.push('\n### 종합');
  const verdict = [];
  verdict.push(serverUp ? '🟢 서버 정상' : '🔴 서버 응답 이상');
  verdict.push(serverStable ? '🟢 무중단(예외 0)' : '🔴 프로세스 예외 발생');
  verdict.push(tunnelUp ? '🟢 터널 정상' : '🔴 터널 이상');
  verdict.push(wsConnected ? '🟢 실시간 연결' : (openMkt ? '🔴 실시간 연결 끊김' : '🟡 실시간 연결 미확인'));
  verdict.push(openMkt ? (feedStale ? '🔴 시세 피드 지연/정지' : '🟢 시세 피드 신선') : '🟢 장외');
  verdict.push(loadOk ? '🟢 부하 견딤' : '🟡 부하 지연/실패');
  const slow = [localHome, pubHome].filter(r => !r.err && r.ms > 1500);
  verdict.push(slow.length ? `🟡 느린 응답 ${slow.length}건(>1.5s)` : '🟢 응답속도 양호');
  verdict.push(circuitTripped ? '🟡 신규매수 중지 (한도 도달 — 설계대로 정상 보호)' : '🟢 서킷 정상범위');
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
    const summary = `📊 <b>장중 점검 ${hhmm}</b>\n${idx ? idx + '\n' : ''}${verdict.join('\n')}\n부하 p95 ${p95}ms · 공개 ${pubHome.ms||'-'}ms`;
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
