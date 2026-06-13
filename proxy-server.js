/**
 * AutoTrade KR — KIS API 프록시 서버
 * Node.js 빌트인 모듈만 사용 (npm 설치 불필요)
 * 실행: node proxy-server.js
 * 포트: 3000
 */

const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');
const { execFile } = require('child_process'); // AI 세팅 어시스턴트(claude CLI 헤드리스 호출)용
const auth  = require('./auth');

const PORT = parseInt(process.env.PORT) || 3000;
// 기본은 127.0.0.1 — 터널/리버스 프록시만 접속, LAN/공인망 직접 노출 차단.
// LAN 직접 노출이 필요하면 HOST=0.0.0.0 으로 실행.
const HOST = process.env.HOST || '127.0.0.1';
const CONFIG_FILE = path.join(__dirname, 'kis-config.json');
const STOCK_FILE = path.join(__dirname, 'stocks-data.json');

// ── 멀티유저: 요청 스코프 userId (AsyncLocalStorage) ──
// 이전엔 전역 변수 하나를 공유 → A 요청이 await 중 B 요청이 값을 바꾸면
// A가 재개될 때 B의 계좌를 읽고 쓰는 치명적 경합이 있었다.
// AsyncLocalStorage는 각 요청이 await를 건너도 자기 store를 유지하므로 교차가 불가능하다.
const { AsyncLocalStorage } = require('async_hooks');
const _als = new AsyncLocalStorage();
function currentUserId() {
  const store = _als.getStore();
  return store ? store.userId : (global._fallbackUserId || null);
}
// 서버 기동 시 전역(하위호환) 경로 등 als 컨텍스트 밖에서 쓰는 경우만 사용
function setCurrentUser(userId) { global._fallbackUserId = userId; }

// ── KIS API 엔드포인트 ──
const KIS_HOST_REAL = 'openapi.koreainvestment.com:9443';
const KIS_HOST_VTS  = 'openapivts.koreainvestment.com:29443';

// ── 종목 마스터 로드 (캐시) ──
let _stockMaster = null;
function loadStockMaster() {
  if (_stockMaster) return _stockMaster;
  try {
    if (fs.existsSync(STOCK_FILE)) {
      _stockMaster = JSON.parse(fs.readFileSync(STOCK_FILE, 'utf8'));
      console.log(`📋 종목 마스터 로드됨: ${Object.keys(_stockMaster.nameToCode||{}).length}개 종목`);
      return _stockMaster;
    }
  } catch(e) {}
  _stockMaster = { nameToCode:{}, codeToName:{} };
  return _stockMaster;
}

// 종목 마스터에 추가 저장 (검색으로 새 종목 발견 시)
function addToMaster(code, name) {
  const m = loadStockMaster();
  if (!m.nameToCode[name]) {
    m.nameToCode[name] = code;
    m.codeToName[code] = name;
    try { fs.writeFileSync(STOCK_FILE, JSON.stringify(m)); } catch(e) {}
  }
}

// ── 설정 로드 (멀티유저) ──
// _currentUserId가 있으면 그 유저 설정, 없으면 기존 전역 파일(하위호환/admin)
function loadConfig() {
  const uid = currentUserId();
  if (uid) {
    return auth.loadUserConfig(uid);
  }
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    }
  } catch(e) {}
  return { appKey:'', appSecret:'', accNo:'', txMode:'vts', token:'', tokenExpiry:0 };
}

function saveConfig(cfg) {
  // cfg에 각인된 소유자 우선 → 없으면 요청 컨텍스트 → 둘 다 없으면 전역(하위호환)
  const uid = (cfg && cfg.__userId) || currentUserId();
  if (uid) {
    auth.saveUserConfig(uid, cfg);
    return;
  }
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
}

// ── HTTPS 요청 헬퍼 ──
function httpsRequest(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(data) });
        } catch(e) {
          resolve({ status: res.statusCode, headers: res.headers, body: data });
        }
      });
    });
    req.on('error', reject);
    // KIS 무응답 시 10초 타임아웃 — 응답 없는 소켓이 큐 전체를 정체시키는 것 방지
    req.setTimeout(10000, () => req.destroy(new Error('KIS 응답 시간 초과(10초)')));
    if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

// ── KIS 토큰 발급 ──
// KIS는 접근토큰 발급을 1분 1회로 제한한다. 만료 시 엔진·실시간·주문이 동시에
// 재발급을 치면 전부 실패하므로: ① 진행 중인 발급은 모두가 공유(동시 발급 1건으로 합침)
// ② 실패 시 65초 쿨다운(그동안 기존 토큰이 살아있으면 그것 사용)
const _tokenIssue = {}; // appKey → { p: Promise|null, failUntil: ts }
async function getKisToken(cfg) {
  const now = Date.now();
  // 유효한 토큰이 있으면 무조건 재사용 (재인증 불필요)
  if (cfg.token && cfg.tokenExpiry > now + 60000) return cfg.token;

  const tkey = cfg.appKey || '_global';
  const st = _tokenIssue[tkey] || (_tokenIssue[tkey] = { p: null, failUntil: 0, token: null, expiry: 0 });

  // 메모리 토큰 미러 — cfg(매 요청 새로 로드)에 토큰이 없어도 발급분 재사용.
  // 토큰 만료 시점이 겹쳐도 "주문 1분 불가" 없이 직전 발급 토큰으로 이어간다.
  if (st.token && st.expiry > now + 60000) {
    cfg.token = st.token; cfg.tokenExpiry = st.expiry;
    return st.token;
  }

  // 실패 쿨다운 중 — 기존 토큰이 아직 살아있으면 그것 사용, 아니면 대기 안내
  if (now < st.failUntil) {
    if (cfg.token && cfg.tokenExpiry > now) return cfg.token;
    if (st.token && st.expiry > now) return st.token;
    throw new Error('토큰 발급 제한(1분 1회) — 잠시 후 자동 재시도됩니다');
  }

  // 이미 다른 요청이 발급 진행 중이면 그 결과를 같이 기다림 (동시 발급 방지)
  if (st.p) return st.p;

  st.p = (async () => {
    const host = cfg.txMode === 'vts' ? KIS_HOST_VTS : KIS_HOST_REAL;
    const [hostname, port] = host.split(':');
    const body = JSON.stringify({
      grant_type: 'client_credentials',
      appkey: cfg.appKey,
      appsecret: cfg.appSecret
    });
    const res = await httpsRequest({
      hostname, port: parseInt(port),
      path: '/oauth2/tokenP',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    }, body);

    if (res.body && res.body.access_token) {
      cfg.token = res.body.access_token;
      cfg.tokenExpiry = Date.now() + (res.body.expires_in - 600) * 1000; // 10분 여유
      st.token = cfg.token; st.expiry = cfg.tokenExpiry; // 메모리 미러 — 파일 저장 실패에도 유지
      saveConfig(cfg);
      st.failUntil = 0;
      return cfg.token;
    }
    // 발급 실패 — 65초 쿨다운 설정 (KIS 1분 제한 준수)
    st.failUntil = Date.now() + 65000;
    // 기존 토큰이 아직 안 죽었으면 그거라도 사용
    if (cfg.token && cfg.tokenExpiry > Date.now()) return cfg.token;
    if (st.token && st.expiry > Date.now()) return st.token;
    throw new Error('토큰 발급 실패: ' + JSON.stringify(res.body));
  })();

  try { return await st.p; }
  finally { st.p = null; }
}

// ── 주문용 hashkey 발급 ──
async function getHashkey(cfg, bodyObj) {
  const host = cfg.txMode === 'vts' ? KIS_HOST_VTS : KIS_HOST_REAL;
  const [hostname, port] = host.split(':');
  const body = JSON.stringify(bodyObj);
  try {
    const res = await httpsRequest({
      hostname, port: parseInt(port),
      path: '/uapi/hashkey',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'appkey': cfg.appKey,
        'appsecret': cfg.appSecret
      }
    }, body);
    return res.body && res.body.HASH ? res.body.HASH : '';
  } catch(e) {
    return '';
  }
}

// ── KIS API 프록시 요청 ──
// ── 앱키(계좌)별 우선순위 큐 ──
// KIS rate limit은 앱키(계좌) 단위이므로, 사용자마다 독립 큐를 둬서 서로 간섭하지 않게 한다.
// (예전엔 전역 단일 큐라 사용자가 늘면 한도를 나눠 써 더 느려졌다.)
// high = 사용자 동작(호가/체결/현재가) — 백그라운드 폴링을 새치기한다.
// 간격(gap)은 모드별: 모의(vts) 약 5건/초, 실전(live) 약 16건/초(안전마진).
const KIS_GAP_MS = { vts: 280, live: 60 }; // vts 3.6/s — 주문·토큰용 여유분(1.4/s) 확보
function kisGapFor(cfg) { return (cfg && cfg.txMode === 'live') ? KIS_GAP_MS.live : KIS_GAP_MS.vts; }

const _kisQueues = {}; // appKey → { high, low, last, pumping, gap }
function _kisQ(key) {
  return _kisQueues[key] || (_kisQueues[key] = { high: [], low: [], last: 0, pumping: false, gap: KIS_GAP_MS.vts });
}
function kisSchedule(key, gap, fn, priority) {
  const q = _kisQ(key);
  q.gap = gap + (q.penalty || 0); // 적응형: 한도 초과가 잦으면 간격을 자동으로 벌림
  return new Promise((resolve, reject) => {
    // 백프레셔: KIS가 느려져 큐가 적체되면 — 백그라운드(low)는 즉시 포기(캐시 유지),
    // 사용자 요청(high)도 한계치를 넘으면 빠르게 실패시켜 폴백이 동작하게 한다.
    // urgent(주문/취소)는 제한 없이 high 큐 맨 앞으로 — 항상 최우선.
    if (priority === 'urgent') { q.high.unshift({ fn, resolve, reject }); pumpKis(key); return; }
    if (priority !== 'high' && q.low.length >= 10) { reject(new Error('큐 적체 — 백그라운드 스킵')); return; }
    if (priority === 'high' && q.high.length >= 25) { reject(new Error('큐 적체 — 잠시 후 재시도')); return; }
    (priority === 'high' ? q.high : q.low).push({ fn, resolve, reject });
    pumpKis(key);
  });
}
async function pumpKis(key) {
  const q = _kisQ(key);
  if (q.pumping) return;
  q.pumping = true;
  try {
    while (q.high.length || q.low.length) {
      // 동시 진행 상한 — 느린 응답이 쌓여도 소켓이 폭주하지 않게
      if ((q.inflight || 0) >= 8) { await new Promise(r => setTimeout(r, 50)); continue; }
      // high 우선이되 4:1로 low(백그라운드 시세 갱신)도 섞어 기아 방지.
      // 폭락장처럼 high 요청이 폭주할 때 low가 영구히 밀려 화면 시세 캐시가 멈추던 문제 차단.
      let job;
      if (q.high.length && (q._lowStarve || 0) < 4) { job = q.high.shift(); q._lowStarve = (q._lowStarve || 0) + 1; }
      else if (q.low.length) { job = q.low.shift(); q._lowStarve = 0; }
      else { job = q.high.shift(); }
      // 주문(직발사) 진행 중이면 그 시간만큼 일반 큐가 양보 (초당 한도 충돌 방지)
      const hold = (q.holdUntil || 0) - Date.now();
      const wait = Math.max(q.gap - (Date.now() - q.last), hold);
      if (wait > 0) await new Promise(r => setTimeout(r, wait));
      q.last = Date.now();
      // 핵심: 발사 간격(초당 한도)만 지키고 응답은 기다리지 않는다(병렬).
      // KIS가 느려져도 처리량이 발사율(초당 ~4건)을 유지 — 직렬 대기로 인한 적체 제거.
      q.inflight = (q.inflight || 0) + 1;
      const jt0 = Date.now();
      job.fn().then(v => job.resolve(v), e => job.reject(e)).finally(() => {
        q.inflight--;
        q.lastJobMs = Date.now() - jt0;                        // 진단용: 직전 작업 소요
        if (q.penalty) q.penalty = Math.max(0, q.penalty - 5); // 정상 처리마다 패널티 완화
      });
    }
  } finally { q.pumping = false; }
}

async function kisProxy(cfg, kispath, trId, queryParams, priority = 'high') {
  // 기본 high: 사용자 라우트·엔진 경로가 priority 누락으로 low 캡(10)에 걸려
  // 무작위 실패하던 문제 수정. 백그라운드(prefetch/SWR)는 호출부가 'low' 명시.
  if (!cfg.appKey || !cfg.appSecret) throw new Error('NO_KIS_KEY'); // 무키 유저 — 큐 진입 전 단락. refresh*가 캐시/폴백으로 받음
  const host = cfg.txMode === 'vts' ? KIS_HOST_VTS : KIS_HOST_REAL;
  const [hostname, port] = host.split(':');
  const qs = new URLSearchParams(queryParams).toString();
  const fullPath = kispath + (qs ? '?' + qs : '');

  // 우선순위 큐로 간격 보장 + EGW00201(초당 한도 초과) 시 백오프 재시도
  // 재시도는 수요를 증폭시켜 적체를 악화시키므로 최소화: high 1회, low 0회 (폴백·캐시가 받아줌)
  const qKey = cfg.appKey || '_global';
  const gap = kisGapFor(cfg);
  const maxAttempts = priority === 'high' ? 2 : 1;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const res = await kisSchedule(qKey, gap, async () => {
      const token = await getKisToken(cfg);
      return httpsRequest({
        hostname, port: parseInt(port),
        path: fullPath,
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          'authorization': 'Bearer ' + token,
          'appkey': cfg.appKey,
          'appsecret': cfg.appSecret,
          'tr_id': trId,
          'custtype': 'P'
        }
      });
    }, priority);
    if (res?.body && res.body.msg_cd === 'EGW00201') {
      const q = _kisQ(qKey);
      q.penalty = Math.min(300, (q.penalty || 0) + 100); // 한도 초과 감지 → 간격 자동 확장
      if (attempt < maxAttempts - 1) { await new Promise(r => setTimeout(r, 400)); continue; }
    }
    return res;
  }
}

// ── 실전 도메인 전용 토큰/호출 (순위 등 모의투자 도메인 미지원 API용) ──
// 모의투자(vts)는 ranking 등 일부 조회 API를 지원하지 않으므로 실전 도메인으로 호출한다.
// 키가 실전 도메인을 지원하지 않으면 토큰 발급이 실패하며, 5분 쿨다운 후 재시도한다.
async function getKisTokenReal(cfg) {
  const now = Date.now();
  if (cfg.tokenReal && cfg.tokenRealExpiry > now + 60000) return cfg.tokenReal;
  if (cfg._realTokenFailUntil && now < cfg._realTokenFailUntil) throw new Error('실전 도메인 토큰 쿨다운 중');
  const [hostname, port] = KIS_HOST_REAL.split(':');
  const body = JSON.stringify({ grant_type: 'client_credentials', appkey: cfg.appKey, appsecret: cfg.appSecret });
  const res = await httpsRequest({
    hostname, port: parseInt(port), path: '/oauth2/tokenP', method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
  }, body);
  if (res.body && res.body.access_token) {
    cfg.tokenReal = res.body.access_token;
    cfg.tokenRealExpiry = now + (res.body.expires_in - 600) * 1000;
    cfg._realTokenFailUntil = 0;
    return cfg.tokenReal;
  }
  cfg._realTokenFailUntil = now + 5 * 60 * 1000; // 실패 시 5분간 재시도 안 함
  throw new Error('실전 토큰 발급 실패: ' + JSON.stringify(res.body));
}

async function kisProxyReal(cfg, kispath, trId, queryParams, priority) {
  if (!cfg.appKey || !cfg.appSecret) throw new Error('NO_KIS_KEY'); // 무키 유저 — 단락(호출부가 캐시/폴백 처리)
  const [hostname, port] = KIS_HOST_REAL.split(':');
  const qs = new URLSearchParams(queryParams).toString();
  const fullPath = kispath + (qs ? '?' + qs : '');
  // 실전 도메인 호출도 같은 앱키 큐를 공유한다(앱키 단위 한도 보호). 간격은 실전 한도 적용.
  const qKey = cfg.appKey || '_global';
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await kisSchedule(qKey, KIS_GAP_MS.live, async () => {
      const token = await getKisTokenReal(cfg);
      return httpsRequest({
        hostname, port: parseInt(port), path: fullPath, method: 'GET',
        headers: {
          'Content-Type': 'application/json', 'authorization': 'Bearer ' + token,
          'appkey': cfg.appKey, 'appsecret': cfg.appSecret, 'tr_id': trId, 'custtype': 'P'
        }
      });
    }, priority);
    if (res?.body && res.body.msg_cd === 'EGW00201' && attempt < 2) { await new Promise(r => setTimeout(r, 400 * (attempt + 1))); continue; }
    return res;
  }
}

// ── 주문/취소 POST도 같은 앱키 큐로 직렬화 (초당 한도 보호) + 거부 시 자동 재시도 ──
// 예전엔 주문이 큐를 우회해서, 엔진 스캔 중 주문하면 "초당 거래건수 초과"로 거부됐다.
// 거부된 주문은 접수되지 않은 것이므로 재시도해도 중복 접수 위험이 없다.
async function kisPost(cfg, kispath, trId, bodyObj) {
  const host = cfg.txMode === 'vts' ? KIS_HOST_VTS : KIS_HOST_REAL;
  const [hostname, port] = host.split(':');
  const qKey = cfg.appKey || '_global';
  const gap = kisGapFor(cfg);
  let res = null;
  const q = _kisQ(qKey);
  for (let attempt = 0; attempt < 4; attempt++) {
    const token = await getKisToken(cfg);
    // 주문은 큐를 거치지 않고 직발사하되, 초당 한도 충돌을 확실히 피한다:
    // ① 일반 발사를 1.5초 정지 ② 직전 1초간 나간 요청들이 한도 창을 벗어나도록 0.6초 대기 후 발사.
    // hashkey는 KIS 선택 항목이라 생략(호출 1건 절약).
    q.holdUntil = Date.now() + 1500;
    await new Promise(r => setTimeout(r, 600));
    const body = JSON.stringify(bodyObj);
    res = await httpsRequest({
      hostname, port: parseInt(port), path: kispath, method: 'POST',
      headers: {
        'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body),
        'authorization': 'Bearer ' + token, 'appkey': cfg.appKey, 'appsecret': cfg.appSecret,
        'tr_id': trId, 'custtype': 'P'
      }
    }, body);
    const msg = res?.body?.msg1 || '', cd = res?.body?.msg_cd || '';
    if (res?.body?.rt_cd !== '0' && (cd === 'EGW00201' || msg.includes('초당 거래건수')) && attempt < 3) {
      console.log(`[주문 재시도 ${attempt + 1}] 초당 한도 — 재전송`);
      await new Promise(r => setTimeout(r, 300 * (attempt + 1)));
      continue;
    }
    return res;
  }
  return res;
}

// ════════════════════════════════════════
// 자동매매 엔진용 재사용 헬퍼
// ════════════════════════════════════════

// ── 이중 스로틀 제거됨(Phase 0-B): kisProxy의 앱키별 큐가 이미 간격을 보장하므로
//    그 위에 덧씌우던 전역 rateLimitedCall(350ms) 게이트는 삭제했다. (호출당 최대 700ms→해소)

// ── 재시도 래퍼: socket hang up 시 최대 2회 재시도 ──
async function withRetry(fn, label, retries = 2) {
  for (let i = 0; i <= retries; i++) {
    try {
      return await fn();
    } catch(e) {
      const isHangUp = e.message && (e.message.includes('hang up') || e.message.includes('ECONNRESET') || e.message.includes('ETIMEDOUT'));
      if (isHangUp && i < retries) {
        console.log(`[재시도 ${i+1}] ${label} — ${e.message}`);
        await new Promise(r => setTimeout(r, 1000 * (i+1)));
        // (수정) 예전엔 여기서 토큰을 지워 재발급을 유도했는데, hang-up은 토큰 문제가 아니라
        // 네트워크 문제다. 멀쩡한 토큰을 지우면 재발급 1분 제한에 걸려 주문까지 마비된다.
        continue;
      }
      throw e;
    }
  }
}

// ── 차트 캐시 (당일 장 마감까지 유지) ──
const _chartCache = {};
function chartCacheKey(code, period) { return `${code}_${period}_${new Date().toISOString().slice(0,10)}`; }

// 현재가 1종목
async function fetchCurrentPrice(cfg, code) {
  return withRetry(async () => {
    const r = await kisProxy(cfg, '/uapi/domestic-stock/v1/quotations/inquire-price', 'FHKST01010100', {
      FID_COND_MRKT_DIV_CODE: 'J', FID_INPUT_ISCD: code
    });
    return parseInt(r.body?.output?.stck_prpr || 0);
  }, `현재가:${code}`);
}

// 일봉 차트 (캐시 적용)
async function fetchChart(cfg, code, period) {
  const key = chartCacheKey(code, period || 'D');
  if (_chartCache[key]) return _chartCache[key]; // 캐시 히트

  const result = await withRetry(async () => {
    const today = new Date();
    const toDate = today.toISOString().slice(0,10).replace(/-/g,'');
    const fromDate = new Date(today - 120*24*60*60*1000).toISOString().slice(0,10).replace(/-/g,'');
    const r = await kisProxy(cfg, '/uapi/domestic-stock/v1/quotations/inquire-daily-itemchartprice', 'FHKST03010100', {
      FID_COND_MRKT_DIV_CODE: 'J', FID_INPUT_ISCD: code,
      FID_INPUT_DATE_1: fromDate, FID_INPUT_DATE_2: toDate,
      FID_PERIOD_DIV_CODE: period||'D', FID_ORG_ADJ_PRC: '0'
    });
    const rows = r.body?.output2 || [];
    return rows.slice().reverse().map(d => ({
      open: parseInt(d.stck_oprc||0), high: parseInt(d.stck_hgpr||0),
      low: parseInt(d.stck_lwpr||0), close: parseInt(d.stck_clpr||0),
      vol: parseInt(d.acml_vol||0)
    })).filter(d => d.close > 0);
  }, `차트:${code}`);

  if (result && result.length > 0) {
    _chartCache[key] = result; // 정상 데이터만 캐시
    // 장 마감 후 KST 자정에 캐시 초기화 — 서버 로컬 자정(UTC 서버면 개장 직후!)이 아니라 한국 자정 기준
    const t = setTimeout(() => { delete _chartCache[key]; }, msToKstMidnight());
    if (t.unref) t.unref();
  }
  return result;
}

// KST 자정까지 남은 ms — 서버 타임존과 무관 (리눅스/UTC 서버 호환)
function msToKstMidnight() {
  const kstNow = Date.now() + 9 * 3600 * 1000;
  const nextKstMidnight = (Math.floor(kstNow / 86400000) + 1) * 86400000;
  return nextKstMidnight - kstNow;
}

// 계좌 잔고
async function fetchAccount(cfg) {
  return withRetry(async () => {
    const trId = cfg.txMode === 'vts' ? 'VTTC8434R' : 'TTTC8434R';
    const [cano, acntPrdtCd] = (cfg.accNo || '').split('-');
    const r = await kisProxy(cfg, '/uapi/domestic-stock/v1/trading/inquire-balance', trId, {
      CANO: cano||'', ACNT_PRDT_CD: acntPrdtCd||'01',
      AFHR_FLPR_YN:'N', OFL_YN:'', INQR_DVSN:'02', UNPR_DVSN:'01',
      FUND_STTL_ICLD_YN:'N', FNCG_AMT_AUTO_RDPT_YN:'N', PRCS_DVSN:'01',
      CTX_AREA_FK100:'', CTX_AREA_NK100:''
    });
    return r.body;
  }, '계좌잔고');
}

// 주문 실행 (엔진용)
async function executeOrder(cfg, { side, code, qty, price, orderType, source }, userId) {
  const isBuy = side === 'buy';
  const trId = cfg.txMode === 'vts'
    ? (isBuy ? 'VTTC0802U' : 'VTTC0801U')
    : (isBuy ? 'TTTC0802U' : 'TTTC0801U');
  const [cano, acntPrdtCd] = (cfg.accNo || '').split('-');
  const orderObj = {
    CANO: cano||'', ACNT_PRDT_CD: acntPrdtCd||'01',
    PDNO: code, ORD_DVSN: orderType||'00',
    ORD_QTY: String(qty), ORD_UNPR: (orderType === '01') ? '0' : String(price||0) // 시장가는 단가 0
  };
  // 큐를 통해 직렬화 + 초당 한도 거부 시 자동 재시도
  const r = await kisPost(cfg, '/uapi/domestic-stock/v1/trading/order-cash', trId, orderObj);
  if (r.body?.rt_cd === '0') {
    orderJournal.add({
      userId, side, code, qty, price: price || 0, orderType: orderType || '00',
      odno: r.body?.output?.ODNO, orgNo: r.body?.output?.KRX_FWDG_ORD_ORGNO,
      qtyBefore: heldQtyOf(userId || 'default', code),
      source: source || 'manual' // 봇 placeOrder는 'bot' 주입, 그 외 직접 주문은 manual
    });
  }
  return r.body;
}

// 당일 분봉 (장중 반등 전략용) — inquire-time-itemchartprice, 최근 ~30분 1분봉
async function fetchMinuteBars(cfg, code) {
  return withRetry(async () => {
    const r = await kisProxy(cfg, '/uapi/domestic-stock/v1/quotations/inquire-time-itemchartprice', 'FHKST03010200', {
      FID_ETC_CLS_CODE: '', FID_COND_MRKT_DIV_CODE: 'J', FID_INPUT_ISCD: code,
      FID_INPUT_HOUR_1: '', FID_PW_DATA_INCU_YN: 'N'
    }, 'high'); // 봇 매수 타이밍 판단 — 적시성 우선(낙폭과대 종목만 조회되므로 빈도 낮음)
    const rows = r.body?.output2 || [];
    return rows.slice().reverse().map(b => ({   // 최신→과거 → 과거→현재
      open: parseInt(b.stck_oprc || 0), high: parseInt(b.stck_hgpr || 0),
      low: parseInt(b.stck_lwpr || 0), close: parseInt(b.stck_prpr || 0),
      vol: parseInt(b.cntg_vol || 0)
    })).filter(b => b.close > 0);
  }, `분봉:${code}`);
}

// 코드→이름
function codeToNameLookup(code) {
  const master = loadStockMaster();
  return master.codeToName?.[code] || code;
}

// ── 엔진 초기화 ──
const { AutoTrader, getLogs } = require('./auto-trader.js');
// ── Phase 2: KIS 실시간 시세 (WebSocket → SSE) ──
const realtime = require('./kis-realtime.js');
// ── 빈 화면 금지 폴백: 마지막 정상 데이터(영속)·환율 공개소스·호가 사다리 ──
const fb = require('./data-fallback.js');

// ── 캐시 워밍 영속화: 가격·일봉 캐시를 디스크에 보존 — 서버 재시작 직후에도 첫 화면 즉시 ──
global._priceCache = fb.get('persist:price') || {};
(() => { // 일봉 캐시는 당일 키만 복원 (오래된 키 무한 누적 방지)
  const saved = fb.get('persist:chart') || {};
  const todayUTC = new Date().toISOString().slice(0, 10);
  global._chartCache = {};
  for (const k in saved) if (k.endsWith(todayUTC)) global._chartCache[k] = saved[k];
})();
let _persistCacheTimer = null;
function persistCachesSoon() {
  if (_persistCacheTimer) return;
  _persistCacheTimer = setTimeout(() => {
    _persistCacheTimer = null;
    try {
      fb.save('persist:price', global._priceCache || {});
      const todayUTC = new Date().toISOString().slice(0, 10);
      const pruned = {};
      for (const k in (global._chartCache || {})) if (k.endsWith(todayUTC)) pruned[k] = global._chartCache[k];
      fb.save('persist:chart', pruned);
    } catch (_) {}
  }, 30000); // 30초 디바운스 — 디스크 쓰기 최소화
  if (_persistCacheTimer.unref) _persistCacheTimer.unref();
}
// ── 로컬 주문 저널: 모의투자 당일내역 API 공백 보완 + 잔고 대조 체결 판정 ──
const orderJournal = require('./order-journal.js');

// 계좌 캐시에서 특정 종목 보유수량 (주문 시점 스냅샷용 — 캐시 없으면 null=판정 보류)
function heldQtyOf(userKey, code) {
  try {
    const list = global._acctCache?.[userKey]?.data?.data?.output1;
    if (!list) return null;
    const p = list.find(x => x.pdno === code);
    return p ? parseInt(p.hldg_qty || 0) : 0;
  } catch (e) { return null; }
}
// ── 텔레그램 알림 발송 ──
async function sendTelegram(cfg, message) {
  if (!cfg.telegramToken || !cfg.telegramChatId) return;
  const url = `https://api.telegram.org/bot${cfg.telegramToken}/sendMessage`;
  const body = JSON.stringify({ chat_id: cfg.telegramChatId, text: message, parse_mode: 'HTML' });
  try {
    await httpsRequest({
      hostname: 'api.telegram.org', port: 443,
      path: `/bot${cfg.telegramToken}/sendMessage`,
      method: 'POST',
      headers: { 'Content-Type':'application/json', 'Content-Length':Buffer.byteLength(body) }
    }, body);
  } catch(e) { console.log('[텔레그램 오류]', e.message); }
}

// 거래량 상위 조회 (엔진 스캔 목록용)
async function fetchVolTop(cfg) {
  return withRetry(async () => {
    const r = await kisProxy(cfg, '/uapi/domestic-stock/v1/ranking/volume', 'FHPST01710000', {
      fid_cond_mrkt_div_code: 'J', fid_cond_scr_div_code: '20171',
      fid_input_iscd: '0000', fid_div_cls_code: '0', fid_blng_cls_code: '0',
      fid_trgt_cls_code: '111111111', fid_trgt_exls_cls_code: '000000',
      fid_input_price_1: '', fid_input_price_2: '', fid_vol_cnt: '', fid_input_date_1: ''
    });
    return r.body;
  }, '거래량상위');
}

// ── 위험 종목 판정 (자동매수 차단용) ──
// 거래량 상위 자동매수가 관리종목·투자경고/위험·거래정지 종목을 무차별로 사는 것을 막는다.
// inquire-price(FHKST01010100)의 종목상태/시장경고 코드로 판정. 매수 직전 1회만 호출(BUY 후보에만).
const _RISK_STAT = { '51':'관리종목', '52':'투자위험', '53':'투자경고', '58':'거래정지', '59':'단기과열' };
async function fetchStockFlags(cfg, code) {
  try {
    const r = await kisProxy(cfg, '/uapi/domestic-stock/v1/quotations/inquire-price', 'FHKST01010100', {
      FID_COND_MRKT_DIV_CODE: 'J', FID_INPUT_ISCD: code
    }, 'high');
    const o = r.body?.output || {};
    const stat = String(o.iscd_stat_cls_code || '').trim();   // 51 관리·52 위험·53 경고·58 정지·59 과열
    const warn = String(o.mrkt_warn_cls_code || '00').trim();  // 00 없음·01 주의·02 경고·03 위험
    if (_RISK_STAT[stat]) return { blocked: true, reason: _RISK_STAT[stat] };
    if (warn === '02') return { blocked: true, reason: '투자경고' };
    if (warn === '03') return { blocked: true, reason: '투자위험' };
    if (String(o.sltr_yn || '').trim() === 'Y') return { blocked: true, reason: '정리매매' };
    return { blocked: false };
  } catch (e) {
    // 조회 실패 시 매수를 막지 않는다(과차단 방지). 진짜 거래정지면 KIS가 주문을 거부 — 2차 방어.
    return { blocked: false };
  }
}

// ── 멀티유저: 유저별 자동매매 엔진 ──
const _traders = {}; // userId → AutoTrader
function getTrader(userId) {
  if (!userId) userId = '_global'; // 로그인 안 한 경우(하위호환)
  if (_traders[userId]) return _traders[userId];
  // 이 유저 전용 loadConfig — 항상 이 유저 설정만 읽음 (전역 _currentUserId와 무관)
  const userLoadConfig = () => {
    if (userId === '_global') {
      try { return JSON.parse(fs.readFileSync(CONFIG_FILE,'utf8')); } catch(e){ return {appKey:'',txMode:'vts'}; }
    }
    return auth.loadUserConfig(userId);
  };
  const t = new AutoTrader({
    userId,
    loadConfig:      userLoadConfig,
    getStockChart:   fetchChart,       // (cfg, code, period) 시그니처 그대로 사용
    getCurrentPrice: fetchCurrentPrice,// (cfg, code)
    getMinuteBars:   fetchMinuteBars,  // (cfg, code) — 장중 반등 전략용 당일 분봉
    placeOrder:      (c, o) => executeOrder(c, { ...o, source: 'bot' }, userId), // 봇 주문 — source=bot 각인
    getAccount:      async (c) => {    // (cfg) — 잔고 조회 + _acctCache 워밍
      // ★ 헤드리스(브라우저 미접속) 운영에서도 heldQtyOf가 동작하도록 봇 잔고를 _acctCache에 적재.
      //   안 하면 봇 지정가 매수의 qtyBefore가 null로 기록돼 reconcile(잔고대조)이 영원히 건너뛰어
      //   '접수'로 방치 → 미체결 잔량(pendBuyAmt) 과대계상으로 후속 매수가 과소사이징됨.
      const r = await fetchAccount(c);
      try { if (r && r.rt_cd === '0') (global._acctCache || (global._acctCache = {}))[userId] = { t: Date.now(), data: { ok: true, data: r } }; } catch (_) {}
      return r;
    },
    getVolTop:       fetchVolTop,      // (cfg)
    getStockFlags:   fetchStockFlags,  // (cfg, code) → {blocked, reason} — 위험종목 자동매수 차단
    codeToName:      codeToNameLookup,
    sendTelegram:    sendTelegram,
    // 미체결(접수) 주문 목록 — 엔진의 중복매도 방지·매수한도 계산에 사용
    getPendingOrders: () => orderJournal.pendingList(userId === '_global' ? null : userId),
    // 잔고 대조로 저널 체결 확정 — 헤드리스(브라우저 미접속) 운영에서도 미체결 가드/자동취소 정상화
    reconcileOrders: (holdings) => orderJournal.reconcile(userId === '_global' ? null : userId, holdings)
  });
  _traders[userId] = t;
  return t;
}

// ── 뉴스 수집 (KIS → 구글 RSS → 네이버 링크) — 라우트는 SWR 캐시로 즉시 응답 ──
async function _fetchNews(cfg, code, fallbackUrl) {
  // 1) KIS 뉴스 — 권한 없는 키가 대부분. 한 번 실패하면 6시간 동안 건너뛴다.
  if (!global._kisNewsFailAt || Date.now() - global._kisNewsFailAt > 6 * 3600 * 1000) {
    try {
      const r = await kisProxy(cfg, '/uapi/domestic-stock/v1/quotations/news-title', 'FHKST01011800', {
        FID_NEWS_OFER_ENTP_CODE: '', FID_COND_MRKT_DIV_CODE: 'J',
        FID_INPUT_ISCD: code, FID_TITL_CNTT: '',
        FID_INPUT_DATE_1: '', FID_INPUT_HOUR_1: '',
        FID_RANK_SORT_CLS_CODE: '', FID_INPUT_SRNO: ''
      });
      const list = r.body?.output || [];
      if (list.length) return { ok: true, source: 'kis', data: { output: list, rt_cd: '0' } };
      global._kisNewsFailAt = Date.now(); // 빈 응답 = 권한 없음으로 간주
    } catch (e) { global._kisNewsFailAt = Date.now(); }
  }
  // 2) 구글 뉴스 RSS (키 불필요) — 종목 뉴스 + 시장 뉴스를 7:3 비율로 혼합
  try {
    const name = codeToNameLookup(code);
    const [stockItems, marketItems] = await Promise.all([
      _fetchGoogleRss(`${name} 주가`, 20),
      _fetchMarketNews() // 코스피 시장 뉴스 (10분 공유 캐시)
    ]);
    if (stockItems.length || marketItems.length) {
      const mkt = marketItems.map(n => ({ ...n, market: true })); // 시장 뉴스 표시용 플래그
      const items = [...stockItems.slice(0, 20), ...mkt.slice(0, 8)] // 종목 위주 + 시장 — 스크롤 분량 확보
        .sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0)); // 최신순 통합 정렬
      return { ok: true, source: 'google', data: { output: items, rt_cd: '0' }, fallbackUrl };
    }
  } catch (e) { /* RSS 실패 → 링크 폴백 */ }
  // 3) 둘 다 실패 → 네이버 금융 링크
  return { ok: true, data: { output: [], rt_cd: '1', noPermission: true }, fallbackUrl };
}

// 구글 뉴스 RSS 공용 파서
async function _fetchGoogleRss(queryText, limit) {
  const q = encodeURIComponent(queryText);
  const rss = await httpsRequest({
    hostname: 'news.google.com',
    path: `/rss/search?q=${q}&hl=ko&gl=KR&ceid=KR:ko`,
    method: 'GET',
    headers: { 'User-Agent': 'Mozilla/5.0' }
  });
  const xml = typeof rss.body === 'string' ? rss.body : '';
  const decode = s => s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&').trim();
  const items = [];
  const itemRe = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = itemRe.exec(xml)) && items.length < (limit || 15)) {
    const block = m[1];
    const pick = tag => {
      const mt = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`).exec(block);
      return mt ? decode(mt[1]) : '';
    };
    let title = pick('title');
    let source = pick('source');
    if (title.includes(' - ')) {
      const idx = title.lastIndexOf(' - ');
      if (!source) source = title.slice(idx + 3);
      title = title.slice(0, idx); // source 태그 있어도 제목 끝 중복 제거
    }
    items.push({ title, link: pick('link'), source, date: pick('pubDate') });
  }
  return items;
}

// 시장(코스피) 뉴스 — 모든 종목이 공유, 10분 캐시
async function _fetchMarketNews() {
  const c = global._mktNewsCache;
  if (c && Date.now() - c.t < 10 * 60 * 1000) return c.items;
  try {
    const items = await _fetchGoogleRss('코스피 증시', 8);
    global._mktNewsCache = { t: Date.now(), items };
    return items;
  } catch (e) { return c ? c.items : []; }
}

// ── 일봉 → 분봉 변환 헬퍼 ──
// 하루의 OHLCV를 n개 봉으로 자연스럽게 분할
// 실제 장중 흐름처럼: 시가 시작 → 저가/고가 구간 통과 → 종가 마감
function interpolateDayCandles(open, high, low, close, n) {
  if (n <= 1) return [{ o:open, h:high, l:low, c:close }];
  const bars = [];

  // 가격 경로: 시가 → (저점 또는 고점 먼저) → 반대 극단 → 종가
  // 종가가 시가보다 높으면 (양봉): 전반부 하락 → 후반부 상승
  const bullish = close >= open;
  const n1 = Math.floor(n * 0.35); // 저점/고점 도달 지점
  const n2 = Math.floor(n * 0.7);  // 반대 극단 도달 지점

  for (let i = 0; i < n; i++) {
    let midPrice;
    if (i <= n1) {
      // 시가 → 첫 번째 극단
      const t = n1 > 0 ? i / n1 : 1;
      midPrice = bullish ? open + (low - open) * t : open + (high - open) * t;
    } else if (i <= n2) {
      // 첫 번째 극단 → 두 번째 극단
      const t = (i - n1) / (n2 - n1);
      midPrice = bullish ? low + (high - low) * t : high + (low - high) * t;
    } else {
      // 두 번째 극단 → 종가
      const t = (i - n2) / (n - n2);
      midPrice = bullish ? high + (close - high) * t : low + (close - low) * t;
    }

    // 작은 노이즈 추가 (봉이 너무 평평하지 않게)
    const noise = (high - low) * 0.03;
    const barOpen  = Math.round(i === 0 ? open : bars[i-1].c);
    const barClose = Math.round(midPrice + (Math.random()-0.5)*noise);
    const barHigh  = Math.round(Math.max(barOpen, barClose) + Math.random()*noise);
    const barLow   = Math.round(Math.min(barOpen, barClose) - Math.random()*noise);
    // 전체 고/저가 범위 안에 클램핑
    bars.push({
      o: Math.max(low, Math.min(high, barOpen)),
      h: Math.max(low, Math.min(high, barHigh)),
      l: Math.max(low, Math.min(high, barLow)),
      c: Math.max(low, Math.min(high, barClose))
    });
  }
  // 마지막 봉 종가를 실제 종가로 고정
  bars[n-1].c = close;
  return bars;
}

// ── CORS 헤더 (하드닝: 전체 허용 '*' → localhost 계열만) ──
function setCors(res, req) {
  const o = (req && req.headers.origin) || '';
  if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o)) {
    res.setHeader('Access-Control-Allow-Origin', o);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  }
  // 보안 헤더
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
}

// ── 세션 쿠키 플래그 ──
// 리버스 프록시(Cloudflare/nginx)가 HTTPS를 종단하면 X-Forwarded-Proto=https → Secure 부여.
// 로컬 평문 HTTP 테스트에서는 Secure를 빼서 쿠키가 정상 설정되게 한다.
function cookieFlags(req) {
  const https = req && (req.headers['x-forwarded-proto'] === 'https' || req.socket?.encrypted);
  return `HttpOnly; Path=/; SameSite=Lax${https ? '; Secure' : ''}`;
}

// ── 관리자 세션 판별 ──
function isAdminSession(session) {
  if (!session) return false;
  try { const u = auth.loadUsers()[session.username]; return (u && u.role) === 'admin'; } catch (e) { return false; }
}

// ── 실제 클라이언트 IP ──
// 터널/리버스 프록시 뒤에서는 socket.remoteAddress가 항상 127.0.0.1이라
// 모든 사용자가 한 IP로 합쳐진다 → 가입/로그인 제한이 전체에 걸리는 사고.
// 어떤 헤더를 신뢰할지는 앞단 프록시 종류에 따라 다르다 (TRUSTED_PROXY env):
//  - tailscale(기본): Funnel이 X-Forwarded-For를 진짜 IP로 "덮어씀" → XFF만 신뢰.
//    CF-Connecting-IP는 방문자가 그대로 위조 가능하므로 절대 보면 안 됨(실측 확인, 2026-06-06).
//  - cloudflare: CF가 CF-Connecting-IP를 덮어씀 → 그걸 우선 신뢰.
// 서버는 127.0.0.1 바인딩이라 헤더 출처는 신뢰된 터널뿐.
const TRUSTED_PROXY = (process.env.TRUSTED_PROXY || 'tailscale').toLowerCase();
function clientIp(req) {
  if (TRUSTED_PROXY === 'cloudflare') {
    const cf = req.headers['cf-connecting-ip'];
    if (cf) return cf.trim();
  }
  const xff = req.headers['x-forwarded-for'];
  if (xff) return xff.split(',')[0].trim();
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

// ── 로그인/가입 무차별 시도 방어 (IP 기준) ──
const _authGuard = {}; // ip → { fails, lockUntil, regs, regDay }
function authGuardOf(req) {
  const ip = clientIp(req);
  return _authGuard[ip] || (_authGuard[ip] = { fails: 0, lockUntil: 0, regs: 0, regDay: '' });
}

// ── JSON 응답 ──
function jsonRes(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

// ── 요청 바디 파싱 ──
const MAX_BODY_BYTES = 256 * 1024; // 요청 본문 상한 — 거대 페이로드로 메모리 고갈시키는 DoS 차단
function parseBody(req) {
  return new Promise((resolve) => {
    let body = '';
    let aborted = false;
    req.on('data', chunk => {
      if (aborted) return;
      body += chunk;
      if (body.length > MAX_BODY_BYTES) { // 상한 초과 → 즉시 연결 차단
        aborted = true;
        try { req.destroy(); } catch (_) {}
        resolve({});
      }
    });
    req.on('end', () => {
      if (aborted) return;
      try { resolve(JSON.parse(body)); } catch(e) { resolve({}); }
    });
    req.on('error', () => { if (!aborted) { aborted = true; resolve({}); } });
  });
}

// ── 정적 파일 서빙 ──
function serveStatic(res, filepath) {
  const ext = path.extname(filepath);
  const mimeTypes = {
    '.html': 'text/html; charset=utf-8',
    '.js':   'application/javascript',
    '.css':  'text/css',
    '.json': 'application/json',
    '.png':  'image/png',
    '.webmanifest': 'application/manifest+json',
  };
  const mime = mimeTypes[ext] || 'text/plain';
  try {
    const content = fs.readFileSync(filepath);
    // no-cache: UI 업데이트가 새로고침만으로 즉시 반영되게 (캐시된 옛 화면 방지)
    res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-cache' });
    res.end(content);
  } catch(e) {
    res.writeHead(404);
    res.end('Not found');
  }
}

// ════════════════════════════════════════
// Phase 1 — L1 즉시 응답 (stale-while-revalidate) + 서버 prefetch
// ════════════════════════════════════════
// 원칙: 캐시값이 있으면 신선/만료 상관없이 "즉시" 반환하고, 만료됐으면 백그라운드(low)로
//       갱신만 트리거한다(응답을 기다리지 않음). 캐시가 비어 있을 때만 동기 fetch(high).
//       → 사용자를 절대 기다리게 하지 않는다.
const SWR_TTL = { price: 5000, acct: 2000, market: 30000, vol: 90000, stockinfo: 2500, ob: 1500, tick: 2500 };
// 진행 중 백그라운드 갱신 중복 방지 (low 우선순위 갱신에만 적용; high는 항상 즉시 실행)
const _bgRefreshing = { price: {}, acct: {}, market: false, vol: false, stockinfo: {}, ob: {}, tick: {} };

// ── 단일 종목 현재가 → global._priceCache 갱신 ──
async function refreshPrice(cfg, code, priority = 'low') {
  if (priority === 'low') { if (_bgRefreshing.price[code]) return; _bgRefreshing.price[code] = true; }
  if (!global._priceCache) global._priceCache = {};
  try {
    const r = await withRetry(() =>
      kisProxy(cfg, '/uapi/domestic-stock/v1/quotations/inquire-price', 'FHKST01010100', {
        FID_COND_MRKT_DIV_CODE: 'J', FID_INPUT_ISCD: code
      }, priority), `현재가:${code}`);
    const o = r.body?.output || {};
    let cur = parseInt(o.stck_prpr || 0);
    let prev = parseInt(o.stck_sdpr || 0);
    if (!prev && cur) {
      const vrss = parseInt(o.prdy_vrss || 0);
      const sign = o.prdy_vrss_sign;
      prev = (sign === '5' || sign === '4') ? cur + vrss : cur - vrss;
    }
    let chgPct = parseFloat(o.prdy_ctrt || 0);
    let sign = o.prdy_vrss_sign || '3';
    // 현재가/전일종가 둘 다 0이면 — 일봉 마지막 두 종가로 가격 + 전일대비 등락률 직접 계산
    // ("전일" 라벨 폴백 제거: 어떤 경우에도 전일 종가 기준 등락률을 제공한다)
    if (!cur && !prev) {
      try {
        const dr = await kisProxy(cfg, '/uapi/domestic-stock/v1/quotations/inquire-daily-price', 'FHKST01010400', {
          FID_COND_MRKT_DIV_CODE: 'J', FID_INPUT_ISCD: code, FID_PERIOD_DIV_CODE: 'D', FID_ORG_ADJ_PRC: '0'
        }, priority);
        const days = dr.body?.output || [];
        const last = parseInt(days[0]?.stck_clpr || 0);   // 가장 최근 거래일 종가
        const prior = parseInt(days[1]?.stck_clpr || 0);  // 그 전 거래일 종가
        if (last) {
          cur = last;
          prev = prior || last;
          if (prior) {
            chgPct = Math.round(((last - prior) / prior) * 10000) / 100;
            sign = last > prior ? '2' : last < prior ? '5' : '3';
          }
        }
      } catch (e2) {}
    }
    const data = { price: cur, chgPct, sign, prev: prev || cur,
                   accVol: parseInt(o.acml_vol || 0) }; // 거래량 캐시 — volume100 폴백이 거래량 0으로 정렬되던 버그 수정
    if (data.price > 0 || data.prev > 0) { global._priceCache[code] = { t: Date.now(), data }; persistCachesSoon(); }
    return data;
  } catch (e) { return global._priceCache[code]?.data || null; }
  finally { if (priority === 'low') _bgRefreshing.price[code] = false; }
}

// ── 종목 기본정보 → global._stockinfoCache[code] 갱신 (SWR) ──
async function refreshStockinfo(cfg, code, priority = 'low') {
  if (priority === 'low') { if (_bgRefreshing.stockinfo[code]) return global._stockinfoCache?.[code]?.resp || null; _bgRefreshing.stockinfo[code] = true; }
  if (!global._stockinfoCache) global._stockinfoCache = {};
  try {
    const priceR = await kisProxy(cfg, '/uapi/domestic-stock/v1/quotations/inquire-price', 'FHKST01010100', {
      FID_COND_MRKT_DIV_CODE: 'J', FID_INPUT_ISCD: code
    }, priority);
    const p = priceR.body?.output || {};
    let data = {
      code, name: p.hts_kor_isnm || codeToNameLookup(code) || code,
      price: parseInt(p.stck_prpr||0), change: parseInt(p.prdy_vrss||0), changePct: parseFloat(p.prdy_ctrt||0),
      sign: p.prdy_vrss_sign, open: parseInt(p.stck_oprc||0), high: parseInt(p.stck_hgpr||0), low: parseInt(p.stck_lwpr||0),
      vol: parseInt(p.acml_vol||0), amount: parseInt(p.acml_tr_pbmn||0), marketCap: parseInt(p.hts_avls||0),
      per: parseFloat(p.per||0), pbr: parseFloat(p.pbr||0), eps: parseFloat(p.eps||0),
      hi52: parseInt(p.w52_hgpr||p.stck_mxpr||0), lo52: parseInt(p.w52_lwpr||p.stck_llam||0), rt_cd: priceR.body?.rt_cd
    };
    if (data.price > 0) { fb.save('stockinfo:' + code, data); }
    else {
      const last = fb.get('stockinfo:' + code);
      if (last && last.price > 0) data = { ...last, stale: true };
      else { try { const candles = await fetchChart(cfg, code, 'D'); const n = candles?.length||0;
        if (n) { const c1=candles[n-1].close, c0=n>1?candles[n-2].close:c1; data.price=c1; data.change=c1-c0;
          data.changePct=c0?Math.round((c1-c0)/c0*10000)/100:0; data.sign=c1>=c0?'2':'5'; data.stale=true; } } catch(_){} }
    }
    const resp = { data };
    global._stockinfoCache[code] = { t: Date.now(), resp };
    return resp;
  } catch (e) { return global._stockinfoCache?.[code]?.resp || null; }
  finally { if (priority === 'low') _bgRefreshing.stockinfo[code] = false; }
}

// ── 호가 → global._obCache[code] 갱신 (SWR, 빈 호가 폴백 포함) ──
async function refreshOrderbook(cfg, code, priority = 'low') {
  if (priority === 'low') { if (_bgRefreshing.ob[code]) return global._obCache?.[code]?.resp || null; _bgRefreshing.ob[code] = true; }
  if (!global._obCache) global._obCache = {};
  try {
    const result = await kisProxy(cfg, '/uapi/domestic-stock/v1/quotations/inquire-asking-price-exp-ccn', 'FHKST01010200', {
      FID_COND_MRKT_DIV_CODE: 'J', FID_INPUT_ISCD: code
    }, priority);
    let resp;
    if (!fb.isOrderbookEmpty(result.body?.output1)) {
      fb.save('ob:' + code, result.body); resp = { data: result.body };
    } else {
      const lastObEnt = fb.getEntry('ob:' + code);
      if (lastObEnt) resp = { data: lastObEnt.v, cached: true, asOf: lastObEnt.t }; // asOf=마지막 정상 호가 시각(신선도 라벨용)
      else {
        let basePrice = global._priceCache?.[code]?.data?.price || global._priceCache?.[code]?.data?.prev || 0;
        if (!basePrice) basePrice = (fb.get('stockinfo:' + code) || {}).price || 0;
        if (!basePrice) { try { const cs = await fetchChart(cfg, code, 'D'); basePrice = cs?.[cs.length-1]?.close || 0; } catch(_){} }
        const ladder = fb.buildLadder(basePrice);
        resp = ladder ? { data: { output1: ladder, rt_cd: '0' }, synthetic: true } : { data: result.body };
      }
    }
    global._obCache[code] = { t: Date.now(), resp };
    return resp;
  } catch (e) { return global._obCache?.[code]?.resp || null; }
  finally { if (priority === 'low') _bgRefreshing.ob[code] = false; }
}

// ── 당일 체결 → global._tickCache[code] 갱신 (SWR). cached=이전 거래일 데이터 표시용 ──
async function refreshTick(cfg, code, priority = 'low') {
  if (priority === 'low') { if (_bgRefreshing.tick[code]) return global._tickCache?.[code]?.resp || null; _bgRefreshing.tick[code] = true; }
  if (!global._tickCache) global._tickCache = {};
  try {
    const r = await withRetry(() => kisProxy(cfg, '/uapi/domestic-stock/v1/quotations/inquire-ccnl', 'FHKST01010300', {
      FID_COND_MRKT_DIV_CODE: 'J', FID_INPUT_ISCD: code
    }, priority), `체결:${code}`);
    const rows = r.body?.output || [];
    let resp;
    if (rows.length) { fb.save('tick:' + code, r.body); resp = { data: r.body }; }
    else {
      const last = fb.get('tick:' + code);
      if (last) resp = { data: last, cached: true };
      else {
        try {
          const mc = await kisProxy(cfg, '/uapi/domestic-stock/v1/quotations/inquire-time-itemchartprice', 'FHKST03010200', {
            FID_ETC_CLS_CODE: '', FID_COND_MRKT_DIV_CODE: 'J', FID_INPUT_ISCD: code, FID_INPUT_HOUR_1: '153000', FID_PW_DATA_INCU_YN: 'Y'
          }, priority);
          const bars = mc.body?.output2 || [];
          if (bars.length) {
            const synth = bars.slice(0, 50).map(b => ({ stck_cntg_hour: b.stck_cntg_hour||'', stck_prpr: b.stck_prpr, cntg_vol: b.cntg_vol, acml_vol: b.acml_vol||'0' }));
            const payload = { output: synth, rt_cd: '0' };
            fb.save('tick:' + code, payload); resp = { data: payload, cached: true, synthetic: true };
          }
        } catch (_) {}
        if (!resp) resp = { data: r.body, cached: false };
      }
    }
    global._tickCache[code] = { t: Date.now(), resp };
    return resp;
  } catch (e) { return global._tickCache?.[code]?.resp || null; }
  finally { if (priority === 'low') _bgRefreshing.tick[code] = false; }
}

// ── 계좌 잔고 → global._acctCache[userKey] 갱신 ──
async function refreshAccount(cfg, userKey, priority = 'low') {
  if (priority === 'low') { if (_bgRefreshing.acct[userKey]) return; _bgRefreshing.acct[userKey] = true; }
  if (!global._acctCache) global._acctCache = {};
  try {
    const trId = cfg.txMode === 'vts' ? 'VTTC8434R' : 'TTTC8434R';
    const [cano, acntPrdtCd] = (cfg.accNo || '').split('-');
    const result = await kisProxy(cfg, '/uapi/domestic-stock/v1/trading/inquire-balance', trId, {
      CANO: cano || '', ACNT_PRDT_CD: acntPrdtCd || '01', AFHR_FLPR_YN: 'N', OFL_YN: '',
      INQR_DVSN: '02', UNPR_DVSN: '01', FUND_STTL_ICLD_YN: 'N', FNCG_AMT_AUTO_RDPT_YN: 'N',
      PRCS_DVSN: '01', CTX_AREA_FK100: '', CTX_AREA_NK100: ''
    }, priority);
    const payload = { ok: true, data: result.body };
    if (result.body && result.body.rt_cd === '0') {
      global._acctCache[userKey] = { t: Date.now(), data: payload };
      // 체결 판정: 잔고 수량과 저널의 접수 주문 대조
      const holdings = {};
      for (const p of (result.body.output1 || [])) holdings[p.pdno] = parseInt(p.hldg_qty || 0);
      const filled = orderJournal.reconcile(userKey, holdings); // 자기 주문만 대조 — 타 유저 미체결 주문 오판 방지
      if (filled) console.log(`[체결확인] (${userKey}) 잔고 대조로 ${filled}건 체결 판정`);
    }
    return payload;
  } catch (e) { return global._acctCache[userKey]?.data || null; }
  finally { if (priority === 'low') _bgRefreshing.acct[userKey] = false; }
}

// ── 지수/환율 → global._marketCache 갱신 ──
async function refreshMarket(cfg, priority = 'low') {
  if (priority === 'low') { if (_bgRefreshing.market) return; _bgRefreshing.market = true; }
  if (!global._marketCache) global._marketCache = { data: null, ts: 0 };
  try {
    const results = {};
    for (const idx of [{ code: '0001', name: 'KOSPI' }, { code: '1001', name: 'KOSDAQ' }]) {
      try {
        const r = await kisProxy(cfg, '/uapi/domestic-stock/v1/quotations/inquire-index-price', 'FHPUP02100000', {
          FID_COND_MRKT_DIV_CODE: 'U', FID_INPUT_ISCD: idx.code
        }, priority);
        if (r.body?.output) results[idx.name] = r.body.output;
      } catch (e) {}
    }
    try {
      const fx = await kisProxy(cfg, '/uapi/domestic-stock/v1/quotations/inquire-price', 'FHKST01010100', {
        FID_COND_MRKT_DIV_CODE: 'X', FID_INPUT_ISCD: 'FX@KRW'
      }, priority);
      if (fx.body?.output?.stck_prpr) results.USDKRW = { rate: fx.body.output.stck_prpr };
    } catch (e) {}
    // KIS 환율(FX@KRW)은 VTS/실전 모두 자주 미지원 → 공개 API 폴백 (open.er-api.com, 1시간 캐시)
    if (!results.USDKRW) {
      try { const rate = await fb.fetchUsdKrw(); if (rate) results.USDKRW = { rate }; } catch (e) {}
    }
    const prevMkt = global._marketCache.data || fb.get('market'); // 서버 재시작 후에도 마지막 값 복원
    if (prevMkt) {
      for (const k of ['KOSPI', 'KOSDAQ', 'USDKRW']) {
        if (!results[k] && prevMkt[k]) results[k] = prevMkt[k];
      }
    }
    if (results.KOSPI || results.KOSDAQ) fb.save('market', results);
    global._marketCache = { data: results, ts: Date.now() };
    return results;
  } catch (e) { return global._marketCache?.data || null; }
  finally { if (priority === 'low') _bgRefreshing.market = false; }
}

// ── 거래량 상위 100 → global._volCache 갱신 ──
async function refreshVol100(cfg, priority = 'low') {
  if (priority === 'low') { if (_bgRefreshing.vol) return; _bgRefreshing.vol = true; }
  if (!global._volCache) global._volCache = { data: null, ts: 0 };
  try {
    // 1) 실전 도메인 순위 API 시도 (실전 키가 있으면 진짜 TOP)
    try {
      const result = await kisProxyReal(cfg, '/uapi/domestic-stock/v1/ranking/volume', 'FHPST01710000', {
        fid_cond_mrkt_div_code: 'J', fid_cond_scr_div_code: '20171', fid_input_iscd: '0000',
        fid_div_cls_code: '0', fid_blng_cls_code: '0', fid_trgt_cls_code: '111111111',
        fid_trgt_exls_cls_code: '000000', fid_input_price_1: '', fid_input_price_2: '',
        fid_vol_cnt: '', fid_input_date_1: ''
      }, priority);
      const out = result.body?.output || [];
      if (out.length) {
        const payload = { data: result.body };
        global._volCache = { data: payload, ts: Date.now() };
        return payload;
      }
    } catch (e) { /* 실전 도메인 불가 → 폴백 */ }
    // 2) 폴백: 가격캐시(프리페치·실시간이 데워둠)를 우선 사용(KIS 호출 0회),
    //    캐시에 없는 종목만 병렬 조회 → 거래량 정렬
    // VTS(모의투자)는 거래량 순위 API 미지원 → 시총 상위 50종목으로 폴백(prefetch가 데운 가격캐시 우선).
    const VOL_CODES = PREFETCH_VOL_CODES;
    const rows = [];
    const missing = [];
    for (const code of VOL_CODES) {
      const c = global._priceCache && global._priceCache[code];
      if (c && c.data && c.data.price > 0) {
        rows.push({ stck_shrn_iscd: code, hts_kor_isnm: codeToNameLookup(code),
          stck_prpr: String(c.data.price), prdy_ctrt: String(c.data.chgPct ?? 0),
          acml_vol: String(c.data.accVol || 0), acml_tr_pbmn: '0' });
      } else missing.push(code);
    }
    const fetched = await Promise.all(missing.map(code =>
      kisProxy(cfg, '/uapi/domestic-stock/v1/quotations/inquire-price', 'FHKST01010100',
        { FID_COND_MRKT_DIV_CODE: 'J', FID_INPUT_ISCD: code }, priority).catch(() => null)));
    fetched.forEach((pr, i) => {
      const o = pr && pr.body && pr.body.output;
      if (o && parseInt(o.stck_prpr || 0) > 0) {
        rows.push({ stck_shrn_iscd: missing[i], hts_kor_isnm: o.hts_kor_isnm || codeToNameLookup(missing[i]),
          stck_prpr: o.stck_prpr, prdy_ctrt: o.prdy_ctrt, acml_vol: o.acml_vol, acml_tr_pbmn: o.acml_tr_pbmn });
      }
    });
    rows.sort((a, b) => parseInt(b.acml_vol || 0) - parseInt(a.acml_vol || 0));
    const payload = { data: { output: rows }, fallback: 'curated' };
    if (rows.length) global._volCache = { data: payload, ts: Date.now() }; // 빈 결과는 캐시 금지 (0건 고착 방지)
    return payload;
  } catch (e) { return global._volCache?.data || null; }
  finally { if (priority === 'low') _bgRefreshing.vol = false; }
}

// ── 서버 prefetch 루프 ──
// 등록 유저의 관심종목 + 주요 거래량 종목 시세를 장중 주기적으로 미리 데워 캐시를 채운다.
// 우선순위 'low' — 사용자 동작(현재가/호가 등 high)을 절대 방해하지 않는다.
// TTL이 남은 캐시는 건드리지 않아 rate limit 낭비를 막는다.
// 시총 상위 50 — prefetch가 데우고, refreshVol100 폴백도 이 목록을 사용(단일 소스)
const PREFETCH_VOL_CODES = ['005930','000660','373220','207940','005380','000270','068270','005490','105560','028260','051910','012330','055550','086790','323410','006400','066570','035720','035420','015760','034020','096770','011170','000720','003670','010130','033780','000120','010950','003490','032830','000810','316140','024110','138040','329180','012450','003550','034730','017670','030200','032640','009150','402340','259960','036570','251270','042700','011200','047050'];
// KRX 휴장일 (주말 외, 2026) — auto-trader.js와 동일 목록 유지
const KRX_HOLIDAYS = new Set([
  '2026-01-01','2026-02-16','2026-02-17','2026-02-18','2026-03-02','2026-05-05','2026-05-25',
  '2026-08-17','2026-09-24','2026-09-25','2026-09-28','2026-10-05','2026-10-09','2026-12-25','2026-12-31'
]);
function _isMarketHours() {
  const kst = new Date(Date.now() + 9 * 3600 * 1000); // UTC → KST
  const day = kst.getUTCDay();                         // 0=일, 6=토
  if (day === 0 || day === 6) return false;
  if (KRX_HOLIDAYS.has(kst.toISOString().slice(0, 10))) return false; // 공휴일 prefetch 중단
  const mins = kst.getUTCHours() * 60 + kst.getUTCMinutes();
  return mins >= 9 * 60 && mins <= 15 * 60 + 30;        // 09:00~15:30
}
let _prefetchBusy = false;
async function prefetchTick() {
  if (_prefetchBusy) return;
  _prefetchBusy = true;
  try {
    const now = Date.now();
    let users = {};
    try { users = auth.loadUsers(); } catch (e) { return; }
    for (const username of Object.keys(users)) {
      const uid = users[username].userId;
      let cfg;
      try { cfg = auth.loadUserConfig(uid); } catch (e) { continue; }
      if (!cfg || !cfg.appKey || !cfg.appSecret) continue;
      let watch = [];
      try { watch = (getTrader(uid).state.settings.watchList) || []; } catch (e) {}
      const codes = [...new Set([...watch, ...PREFETCH_VOL_CODES, '005930'])].slice(0, 60);
      // 봇 보유 종목은 화면·관리 핵심 → stale이면 high로 끌어올려 폭락장 부하에도 절대 안 멈추게.
      let held = [];
      try { held = Object.keys(getTrader(uid).state.botPositions || {}); } catch (e) {}
      if (!global._stockinfoCache) global._stockinfoCache = {};
      if (!global._obCache) global._obCache = {};
      if (!global._tickCache) global._tickCache = {};
      for (let i = 0; i < codes.length; i++) {
        const code = codes[i];
        const c = global._priceCache && global._priceCache[code];
        // 봇 보유종목(소수)만 high로 — 화면 핵심이라 폭락장 부하에도 안 멈추게. watchList/시세표는 SSE
        // 실시간 구독으로 채워지므로 low로 충분. (top12까지 high로 올리면 사용자 클릭 high를 밀어내 역효과)
        const prio = held.includes(code) ? 'high' : 'low';
        if (!c || now - c.t >= SWR_TTL.price) refreshPrice(cfg, code, prio); // 만료된 것만
        // ★ 첫 클릭 콜드 제거: 종목정보 캐시는 비어있을 때만 워밍(이후엔 라우트 SWR이 신선도 유지).
        if (!global._stockinfoCache[code]) refreshStockinfo(cfg, code, 'low');
        // 호가·체결은 무겁다 → 첫 클릭 가능성 높은 상위 8종목만 워밍
        if (i < 8) {
          if (!global._obCache[code]) refreshOrderbook(cfg, code, 'low');
          if (!global._tickCache[code]) refreshTick(cfg, code, 'low');
        }
      }
      // 지수·거래량 캐시도 데움(전역 캐시 — TTL 남으면 건너뜀, 중복은 플래그가 차단)
      if (!global._marketCache || !global._marketCache.data || now - global._marketCache.ts >= SWR_TTL.market) refreshMarket(cfg, 'low');
      if (!global._volCache || !global._volCache.data || now - global._volCache.ts >= SWR_TTL.vol) refreshVol100(cfg, 'low');
    }
  } catch (e) { /* 백그라운드 — 조용히 무시 */ }
  finally { _prefetchBusy = false; }
}
function schedulePrefetch() {
  const interval = _isMarketHours() ? 20000 : 120000; // 장중 20초, 장외/주말 2분
  setTimeout(() => { prefetchTick().finally(schedulePrefetch); }, interval);
}

// ── 미체결 자동 취소: 지정가 접수 후 N분 경과 시 자동 취소 (저널 기반) ──
const STALE_ORDER_CANCEL_MIN = 10;
async function cancelStaleOrders() {
  if (!_isMarketHours()) return;
  const now = Date.now();
  for (const e of orderJournal.pendingList()) {
    if (e.orderType === '01') continue;                              // 시장가는 즉시 체결 — 대상 아님
    if (now - e.t < STALE_ORDER_CANCEL_MIN * 60000) continue;
    if (!e.odno) continue;
    // 이 주문 주인의 als 컨텍스트로 실행 — getKisToken의 토큰 저장이 올바른 유저 파일로 가게
    await _als.run({ userId: e.userId || null }, async () => {
    try {
      const cfg2 = e.userId ? auth.loadUserConfig(e.userId) : (() => { try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch (err) { return null; } })();
      if (!cfg2 || !cfg2.appKey) return;
      const trId = cfg2.txMode === 'vts' ? 'VTTC0803U' : 'TTTC0803U';
      const [cano, prd] = (cfg2.accNo || '').split('-');
      const r = await kisPost(cfg2, '/uapi/domestic-stock/v1/trading/order-rvsecncl', trId, {
        CANO: cano || '', ACNT_PRDT_CD: prd || '01',
        KRX_FWDG_ORD_ORGNO: e.orgNo || '', ORGN_ODNO: e.odno,
        ORD_DVSN: '00', RVSE_CNCL_DVSN_CD: '02',
        ORD_QTY: String(e.qty), ORD_UNPR: '0', QTY_ALL_ORD_YN: 'N'
      });
      if (r.body?.rt_cd === '0') {
        orderJournal.markCancel(e.odno, e.userId);
        console.log(`[자동취소] ${e.code} ${e.qty}주 @${e.price.toLocaleString()} — ${STALE_ORDER_CANCEL_MIN}분 미체결`);
      }
      // 실패(이미 체결 등)는 잔고 대조가 곧 상태를 정리함
    } catch (err) {}
    });
  }
}
setInterval(() => { cancelStaleOrders().catch(() => {}); }, 60000).unref();

// ── 장중 SWR 캐시(종목정보·호가·체결) KST 자정 정리 ──
// 코드별로 무한 누적되던 메모리 + 익일 개장 전 전일값 서빙을 차단. _priceCache는 디스크 영속·stale 처리가 있어 제외.
function scheduleIntradayCacheClear() {
  const t = setTimeout(() => {
    global._stockinfoCache = {}; global._obCache = {}; global._tickCache = {};
    console.log('[캐시] 장중 SWR 캐시 자정 정리 (stockinfo/ob/tick)');
    scheduleIntradayCacheClear();
  }, msToKstMidnight() + 1000);
  if (t.unref) t.unref();
}
scheduleIntradayCacheClear();

// ════════════════════════════════════════
// HTTP 서버
// ════════════════════════════════════════
const server = http.createServer((req, res) => {
  // 세션은 동기로 먼저 확정한 뒤, 그 userId를 요청 전용 als 컨텍스트에 담아 핸들러를 실행.
  // 이렇게 하면 await가 끼어들어도 이 요청의 userId가 다른 요청에 의해 바뀌지 않는다.
  let session = null;
  try {
    const cookies = auth.parseCookies(req);
    session = auth.getUserBySession(cookies.session);
  } catch (_) {}
  _als.run({ userId: session ? session.userId : null }, () => {
    handleRequest(req, res, session).catch(err => {
      console.error('요청 처리 오류:', err && err.message);
      try { jsonRes(res, 500, { ok: false, message: '서버 오류' }); } catch (_) {}
    });
  });
});
async function handleRequest(req, res, session) {
  setCors(res, req);
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const parsed  = new URL(req.url, 'http://localhost');
  const pathname = parsed.pathname;
  const query    = Object.fromEntries(parsed.searchParams);

  // ── 정적 파일 — 화이트리스트 방식 (서버 소스 .js·설정 파일 노출 차단) ──
  const STATIC_WHITELIST = {
    '/': 'app.html', '/index.html': 'app.html', '/app.html': 'app.html',
    '/manifest.webmanifest': 'manifest.webmanifest', '/sw.js': 'sw.js',
    '/icon-192.png': 'icon-192.png', '/icon-512.png': 'icon-512.png'
  };
  if (STATIC_WHITELIST[pathname]) {
    serveStatic(res, path.join(__dirname, STATIC_WHITELIST[pathname])); return;
  }
  if (pathname.endsWith('.html') || pathname.endsWith('.js') || pathname.endsWith('.css')) {
    jsonRes(res, 404, { ok: false, message: 'not found' }); return;
  }

  // ══════════════════════════════════════════
  // 인증 API (로그인 불필요)
  // ══════════════════════════════════════════
  if (pathname === '/api/auth/register' && req.method === 'POST') {
    const body = await parseBody(req);
    // 가입 남용 방지: IP당 하루 3회 + 비밀번호 최소 8자
    const g = authGuardOf(req);
    const day = new Date().toISOString().slice(0, 10);
    if (g.regDay !== day) { g.regDay = day; g.regs = 0; }
    if (g.regs >= 10) { jsonRes(res, 429, { ok: false, message: '가입 시도 초과 — 내일 다시 시도하세요' }); return; } // 같은 IP 하루 10회 (NAT 공유 사용자 고려)
    if ((body.password || '').length < 8) { jsonRes(res, 400, { ok: false, message: '비밀번호는 8자 이상이어야 합니다' }); return; }
    g.regs++;
    const r = await auth.register(body.username, body.password);
    if (r.ok) {
      // 가입 후 자동 로그인
      const lr = await auth.login(body.username, body.password);
      if (lr.ok) {
        res.setHeader('Set-Cookie', `session=${lr.token}; Max-Age=2592000; ${cookieFlags(req)}`);
        jsonRes(res, 200, { ok:true, username: lr.username, role: lr.role });
        return;
      }
    }
    jsonRes(res, r.ok ? 200 : 400, r);
    return;
  }
  if (pathname === '/api/auth/login' && req.method === 'POST') {
    const body = await parseBody(req);
    // 무차별 대입 방어: 5회 실패 → 5분 잠금
    const g = authGuardOf(req);
    if (Date.now() < g.lockUntil) {
      jsonRes(res, 429, { ok: false, message: `로그인 시도 초과 — ${Math.ceil((g.lockUntil - Date.now()) / 60000)}분 후 다시 시도하세요` });
      return;
    }
    const r = await auth.login(body.username, body.password);
    if (!r.ok) {
      g.fails++;
      if (g.fails >= 5) { g.lockUntil = Date.now() + 5 * 60 * 1000; g.fails = 0; }
    } else { g.fails = 0; g.lockUntil = 0; }
    if (r.ok) {
      res.setHeader('Set-Cookie', `session=${r.token}; Max-Age=2592000; ${cookieFlags(req)}`);
      jsonRes(res, 200, { ok:true, username: r.username, role: r.role });
    } else {
      jsonRes(res, 401, r);
    }
    return;
  }
  if (pathname === '/api/auth/logout' && req.method === 'POST') {
    auth.logout(auth.parseCookies(req).session); // cookies는 handleRequest 스코프 밖이었음 → 직접 파싱 (로그아웃 500 수정)
    res.setHeader('Set-Cookie', `session=; Max-Age=0; ${cookieFlags(req)}`);
    jsonRes(res, 200, { ok:true });
    return;
  }
  if (pathname === '/api/auth/me') {
    if (session) {
      const users = auth.loadUsers();
      const u = users[session.username];
      jsonRes(res, 200, { ok:true, loggedIn:true, username: session.username, role: u?.role || 'user' });
    } else {
      jsonRes(res, 200, { ok:true, loggedIn:false });
    }
    return;
  }

  // ── 이하 API는 로그인 필요 ──
  if (pathname.startsWith('/api/') && !session) {
    jsonRes(res, 401, { ok:false, message:'로그인이 필요합니다', needLogin:true });
    return;
  }

  // ── API 라우트 ──

  // POST /api/config — KIS 설정 저장
  if (pathname === '/api/config' && req.method === 'POST') {
    const body = await parseBody(req);
    const cfg = loadConfig();
    Object.assign(cfg, {
      appKey:    body.appKey    || cfg.appKey,
      appSecret: body.appSecret || cfg.appSecret,
      accNo:     body.accNo     || cfg.accNo,
      txMode:    body.txMode    || cfg.txMode,
      htsId:     body.htsId     || cfg.htsId, // 체결통보 WebSocket 구독용 HTS ID (선택)
      token: '', tokenExpiry: 0
    });
    saveConfig(cfg);
    jsonRes(res, 200, { ok: true, message: '설정이 저장되었습니다.' });
    return;
  }

  // GET /api/config/status — 연결 상태 확인
  // GET /api/config/export — 설정 전체 내보내기 (API 키 포함)
  if (pathname === '/api/config/export') {
    const cfg = loadConfig();
    // ★ 보안: appKey/appSecret은 평문으로 절대 내보내지 않는다(GET+SameSite=Lax라 CSRF로 유출 가능).
    //   식별용 마스킹만 노출하고, 이전 시 재입력하게 한다. 토큰·소유자각인도 제외.
    const { token, tokenExpiry, __userId, appKey, appSecret, ...exportable } = cfg;
    exportable.appKey = appKey ? (appKey.slice(0, 4) + '****' + appKey.slice(-4)) : '';
    exportable.appSecret = appSecret ? '********(보안상 미노출 — 이전 시 재입력)' : '';
    res.setHeader && res.setHeader('Cache-Control', 'no-store');
    jsonRes(res, 200, { ok: true, data: exportable, note: 'API 키는 보안상 마스킹되었습니다. 다른 기기 이전 시 KIS 키를 재입력하세요.' });
    return;
  }

  if (pathname === '/api/config/status') {
    const cfg = loadConfig();
    jsonRes(res, 200, {
      ok: true,
      connected: !!(cfg.appKey && cfg.appSecret),
      txMode: cfg.txMode,
      hasToken: !!(cfg.token && cfg.tokenExpiry > Date.now()),
      accNo: cfg.accNo ? cfg.accNo.slice(0,4) + '****' : ''
    });
    return;
  }

  // POST /api/token — 토큰 발급 테스트
  if (pathname === '/api/token' && req.method === 'POST') {
    const cfg = loadConfig();
    if (!cfg.appKey || !cfg.appSecret) {
      jsonRes(res, 400, { ok: false, message: 'App Key / App Secret이 설정되지 않았습니다.' });
      return;
    }
    try {
      cfg.token = ''; cfg.tokenExpiry = 0;
      const token = await getKisToken(cfg);
      jsonRes(res, 200, { ok: true, message: '토큰 발급 성공', hasToken: true });
    } catch(e) {
      jsonRes(res, 500, { ok: false, message: '토큰 발급 실패: ' + e.message });
    }
    return;
  }

  // ════════════════════════════════════════
  // 자동매매 엔진 API (KIS 설정 무관하게 동작)
  // ════════════════════════════════════════

  // GET /api/auto/status — 엔진 상태
  if (pathname === '/api/auto/status') {
    const ut = getTrader(session.userId);
    jsonRes(res, 200, { ok: true, status: ut.getStatus() });
    return;
  }

  // GET /api/auto/logs — 매매 로그 (유저별)
  if (pathname === '/api/auto/logs') {
    const ut = getTrader(session.userId);
    const logs = ut.getLogs ? ut.getLogs() : getLogs();
    jsonRes(res, 200, { ok: true, logs: logs.slice(0, 100) });
    return;
  }

  // POST /api/auto/start — 시작
  if (pathname === '/api/auto/start' && req.method === 'POST') {
    const cfg = loadConfig();
    if (!cfg.appKey) { jsonRes(res, 400, { ok:false, message:'KIS API 미설정 — 먼저 설정에서 연결하세요.' }); return; }
    const ut = getTrader(session.userId);
    ut.start();
    jsonRes(res, 200, { ok: true, status: ut.getStatus() });
    return;
  }

  // POST /api/auto/stop — 정지
  if (pathname === '/api/auto/stop' && req.method === 'POST') {
    const ut = getTrader(session.userId);
    ut.stop();
    jsonRes(res, 200, { ok: true, status: ut.getStatus() });
    return;
  }

  // POST /api/auto/settings — 설정 변경
  if (pathname === '/api/auto/settings' && req.method === 'POST') {
    const body = await parseBody(req);
    const ut = getTrader(session.userId);
    const status = ut.updateSettings(body);
    jsonRes(res, 200, { ok: true, status });
    return;
  }

  // GET /api/debug — 서버 내부 상태 (큐 적체·토큰·업타임) 진단용 [관리자 전용]
  if (pathname === '/api/debug') {
    if (!isAdminSession(session)) { jsonRes(res, 403, { ok: false, message: '관리자 전용' }); return; }
    const qs = {};
    for (const k in _kisQueues) {
      const q = _kisQueues[k];
      qs[k.slice(0, 8)] = { high: q.high.length, low: q.low.length, pumping: q.pumping, sinceLastMs: Date.now() - q.last, lastJobMs: q.lastJobMs || 0, penaltyMs: q.penalty || 0 };
    }
    const tok = Object.keys(_tokenIssue).map(k => ({
      key: k.slice(0, 8), inFlight: !!_tokenIssue[k].p,
      cooldownSec: Math.max(0, Math.round((_tokenIssue[k].failUntil - Date.now()) / 1000))
    }));
    jsonRes(res, 200, { ok: true, uptimeSec: Math.round(process.uptime()), queues: qs, token: tok, memMB: Math.round(process.memoryUsage().rss / 1048576) });
    return;
  }

  // ── KIS API 프록시 ──
  const cfg = loadConfig();
  // 무키(미설정) 유저도 '공용 시세'(전역 캐시)는 볼 수 있게 — 빈 화면 금지. 키 없을 땐 KIS 호출이
  // 단락(NO_KIS_KEY)되어 캐시/폴백만 응답한다. 계좌·주문 등 민감/실호출 엔드포인트는 그대로 차단.
  const PUBLIC_READ = new Set(['/api/prices','/api/chart','/api/stockinfo','/api/orderbook','/api/tick','/api/volume100','/api/market']);
  if (!cfg.appKey || !cfg.appSecret) {
    if (!PUBLIC_READ.has(pathname)) {
      // 에러가 아니라 "설정 필요" 상태 — 200으로 응답해 키 입력 전 대시보드 콘솔이 503으로 도배되지 않게.
      jsonRes(res, 200, { ok: false, needConfig: true, message: 'KIS API 미설정. 설정에서 키를 입력하세요.', simulation: true });
      return;
    }
    // PUBLIC_READ 통과 — 아래 핸들러가 전역 캐시(또는 무키 폴백)로 응답
  }

  try {
    // POST /api/kisraw — KIS GET TR 원시 호출 (개발/디버그용) [관리자 전용]
    // body: { path, trId, params } — 파라미터 실험을 서버 재시작 없이 하기 위함
    if (pathname === '/api/kisraw' && req.method === 'POST') {
      if (!isAdminSession(session)) { jsonRes(res, 403, { ok: false, message: '관리자 전용' }); return; }
      const b = await parseBody(req);
      if (!b.path || !b.trId) { jsonRes(res, 400, { ok: false, message: 'path/trId 필요' }); return; }
      const r = await kisProxy(cfg, b.path, b.trId, b.params || {}, 'high');
      jsonRes(res, 200, { ok: true, data: r.body });
      return;
    }

    // GET /api/stream?codes=005930,000660&ob=005930 — 실시간 시세 SSE (Phase 2)
    // KIS WebSocket을 구독해 체결가/호가를 브라우저로 푸시. 수신 시세는 가격캐시에도 반영.
    if (pathname === '/api/stream') {
      const streamUserId = session ? session.userId : null; // 이 SSE의 소유 유저 — 체결통보를 이 유저 저널로만
      realtime.handleStream(req, res, {
        cfg, query,
        onPrice: (code, data) => {
          if (!global._priceCache) global._priceCache = {};
          global._priceCache[code] = { t: Date.now(), data };
        },
        // 체결통보 → 해당 유저 저널만 확정 (실제 체결가·수량) — 타 유저 주문 오염 방지
        onExecution: (ex) => {
          if (!ex.filled || !ex.odno) return;
          const okJ = orderJournal.markFilled(ex.odno, ex.qty, ex.price, streamUserId);
          console.log(`[체결통보] ${ex.code} ${ex.qty}주 @${(ex.price || 0).toLocaleString()} (주문 ${ex.odno})${okJ ? ' — 저널 확정' : ''}`);
        }
      });
      return;
    }

    // GET /api/prices?codes=005930,000660 — 여러 종목 현재가 배치 (stale-while-revalidate)
    // 캐시값이 있으면 만료 여부와 무관하게 즉시 반환하고, 만료된 종목만 백그라운드(low)로 갱신.
    // 캐시가 전혀 없는 종목만 동기(high)로 채운다 → 첫 화면 외에는 항상 0ms 체감.
    if (pathname === '/api/prices') {
      const codes = (query.codes || '').split(',').filter(Boolean).slice(0, 30);
      if (!global._priceCache) global._priceCache = {};
      const now = Date.now();
      const out = {};
      const missing = [];
      for (const code of codes) {
        const cached = global._priceCache[code];
        if (cached) {
          out[code] = cached.data; // 즉시 반환(만료여도)
          if (now - cached.t >= SWR_TTL.price) refreshPrice(cfg, code, 'low'); // 만료 → 백그라운드 갱신(대기 안 함)
        } else {
          missing.push(code); // 캐시 전무 → 동기 fetch 필요
        }
      }
      // 캐시 없는 종목: 앞 6개만 병렬 동기(첫 화면용), 나머지는 백그라운드 — 응답이 타임아웃에 걸리지 않게.
      // 백그라운드 분은 다음 폴링(4~10초)에서 캐시로 채워져 점진 표시된다.
      const syncFetch = missing.slice(0, 6);
      const bgFetch = missing.slice(6);
      await Promise.all(syncFetch.map(async c => {
        try { out[c] = (await refreshPrice(cfg, c, 'high')) || null; } catch (_) { out[c] = null; }
      }));
      bgFetch.forEach(c => { try { refreshPrice(cfg, c, 'low'); } catch (_) {} });
      jsonRes(res, 200, { ok: true, data: out, pending: bgFetch.length });
      return;
    }

    // GET /api/price?code=005930 — 현재가 조회
    if (pathname === '/api/price') {
      const trId = cfg.txMode === 'vts' ? 'FHKST01010100' : 'FHKST01010100';
      const result = await kisProxy(cfg, '/uapi/domestic-stock/v1/quotations/inquire-price', trId, {
        FID_COND_MRKT_DIV_CODE: 'J',
        FID_INPUT_ISCD: query.code || '005930'
      });
      jsonRes(res, 200, { ok: true, data: result.body });
      return;
    }

    // GET /api/chart?code=005930&period=D&years=3 — 일/주/월/년봉
    if (pathname === '/api/chart') {
      let period = (query.period || 'D').toUpperCase();
      const code = query.code || '005930';
      const market = query.market || 'J';
      const years = Math.min(30, Math.max(1, parseInt(query.years || '1')));

      // 연봉은 월봉 받아서 집계
      const kisPeriod = period === 'Y' ? 'M' : period;
      const trId = 'FHKST03010100';
      const msPerDay = 24*60*60*1000;
      const today = new Date();

      // ── 서버 캐시 (당일 유효) ──
      if (!global._chartCache) global._chartCache = {};
      const cacheKey = `${code}_${period}_${years}_${today.toISOString().slice(0,10)}`;
      if (global._chartCache[cacheKey]) {
        jsonRes(res, 200, global._chartCache[cacheKey]);
        return;
      }
      // 무키 유저 + 캐시 미스 — KIS 호출 불가. 빈 캔들로 깔끔히 응답(차트만 비고 화면은 유지).
      if (!cfg.appKey || !cfg.appSecret) { jsonRes(res, 200, { ok: true, candles: [], needConfig: true }); return; }

      // ── KIS는 날짜 범위를 넓게 줘도 한 번에 최대 ~600건 반환 ──
      // 일봉: 600건 ≈ 약 2.4년치 (영업일 기준)
      // 주봉: 600건 ≈ 약 11년치
      // 월봉: 600건 ≈ 50년치 (사실상 전체)
      // → years ≤ 2이면 1번 호출로 충분, 그 이상이면 2~3번으로 해결
      const totalDays = years * 365;
      // 한 번 호출로 커버 가능한 일수 (실제 KIS 한도 반영)
      const coverDays = kisPeriod === 'D' ? 730 : kisPeriod === 'W' ? 4000 : 18000;
      const chunks = Math.min(5, Math.ceil(totalDays / coverDays)); // 최대 5번

      let allRows = [];
      let output1 = null;
      let cursorEnd = new Date(today);

      for (let i = 0; i < chunks; i++) {
        const endStr = cursorEnd.toISOString().slice(0,10).replace(/-/g,'');
        const startDate = new Date(today - totalDays * msPerDay);
        const startStr = startDate.toISOString().slice(0,10).replace(/-/g,'');

        const result = await kisProxy(cfg, '/uapi/domestic-stock/v1/quotations/inquire-daily-itemchartprice', trId, {
            FID_COND_MRKT_DIV_CODE: market,
            FID_INPUT_ISCD: code,
            FID_INPUT_DATE_1: startStr,
            FID_INPUT_DATE_2: endStr,
            FID_PERIOD_DIV_CODE: kisPeriod,
            FID_ORG_ADJ_PRC: '0'
          }, 'high'); // 사용자가 보고 있는 차트 — 백그라운드 폴링 새치기

        if (result.body?.rt_cd !== '0') break;
        if (!output1 && result.body.output1) output1 = result.body.output1;
        const rows = result.body.output2 || [];
        if (!rows.length) break;
        allRows = allRows.concat(rows);

        // 이미 충분한 데이터가 있으면 추가 호출 불필요
        if (rows.length < 400) break;

        // 다음 청크: 이번 결과의 가장 오래된 날짜 전날부터
        const oldest = rows[rows.length-1]?.stck_bsop_date;
        if (!oldest) break;
        const oldestDate = new Date(oldest.slice(0,4), parseInt(oldest.slice(4,6))-1, oldest.slice(6,8));
        cursorEnd = new Date(oldestDate - msPerDay);
        if (cursorEnd < new Date(today - totalDays*msPerDay)) break;
      }

      // 중복 제거
      const seen = new Set();
      allRows = allRows.filter(r => {
        const d = r.stck_bsop_date;
        if (seen.has(d)) return false;
        seen.add(d); return true;
      });

      // 연봉 집계
      if (period === 'Y') {
        const byYear = {};
        allRows.slice().sort((a,b)=>a.stck_bsop_date.localeCompare(b.stck_bsop_date)).forEach(r => {
          const y = r.stck_bsop_date.slice(0,4);
          if (!byYear[y]) byYear[y] = { open:r.stck_oprc, high:r.stck_hgpr, low:r.stck_lwpr, close:r.stck_clpr, vol:0, date:y+'1231', first:r.stck_oprc };
          const b = byYear[y];
          b.high = String(Math.max(parseInt(b.high), parseInt(r.stck_hgpr)));
          b.low  = String(Math.min(parseInt(b.low),  parseInt(r.stck_lwpr)));
          b.close = r.stck_clpr;
          b.vol += parseInt(r.acml_vol||0);
        });
        allRows = Object.keys(byYear).sort().reverse().map(y => ({
          stck_bsop_date: byYear[y].date,
          stck_oprc: byYear[y].first, stck_hgpr: byYear[y].high,
          stck_lwpr: byYear[y].low,   stck_clpr: byYear[y].close,
          acml_vol: String(byYear[y].vol)
        }));
      }

      const response = { ok: true, data: { output1, output2: allRows, rt_cd:'0', count: allRows.length } };
      // 캐시 저장 (장 마감 후 자정에 삭제) + 디스크 보존 — 재시작에도 차트 즉시
      global._chartCache[cacheKey] = response;
      persistCachesSoon();
      const mid = setTimeout(() => { delete global._chartCache[cacheKey]; }, msToKstMidnight()); // KST 자정 — UTC 서버 호환
      if (mid.unref) mid.unref();

      jsonRes(res, 200, response);
      return;
    }

    // GET /api/minchart?code=005930&unit=5&days=30 — 분봉 (과거 지원)
    // 핵심: KIS는 당일 분봉만 제공 → 과거 일봉을 N분봉으로 변환해 이어붙임
    // 오늘 → 실제 1분봉 수집 후 N분 집계
    // 과거 → 하루치 OHLCV를 장중 균등 분할해 분봉처럼 렌더링
    if (pathname === '/api/minchart') {
      const code = query.code || '005930';
      const unit = Math.max(1, Math.min(60, parseInt(query.unit) || 5)); // 1~60 범위 강제 — unit=0 무한루프 차단
      const days = Math.min(90, Math.max(1, parseInt(query.days) || 30)); // 최대 90일
      const market = query.market || 'J';

      // 60초 응답 캐시 — 기간 전환/재진입 시 즉시 응답
      if (!global._minChartCache) global._minChartCache = {};
      const mcKey = `${code}_${unit}_${days}`;
      const mcHit = global._minChartCache[mcKey];
      if (mcHit && Date.now() - mcHit.t < 60000) { jsonRes(res, 200, mcHit.resp); return; }

      let output1 = null;
      const allCandles = []; // 최종 분봉 목록 (과거→현재)

      // ── 1) 과거 일봉 데이터 받아서 분봉으로 변환 ──
      if (days > 1) {
        const today = new Date();
        const toDate = today.toISOString().slice(0,10).replace(/-/g,'');
        const fromDate = new Date(today - days*24*60*60*1000).toISOString().slice(0,10).replace(/-/g,'');
        // 일봉 부분은 당일 캐시 — 분봉 단위(1/5/15분) 전환 시 재호출 없이 즉시
        if (!global._minDayCache) global._minDayCache = {};
        const mdKey = `${code}_${days}_${toDate}`;
        let dayResult = global._minDayCache[mdKey];
        if (!dayResult) {
          dayResult = await kisProxy(cfg, '/uapi/domestic-stock/v1/quotations/inquire-daily-itemchartprice', 'FHKST03010100', {
            FID_COND_MRKT_DIV_CODE: market, FID_INPUT_ISCD: code,
            FID_INPUT_DATE_1: fromDate, FID_INPUT_DATE_2: toDate,
            FID_PERIOD_DIV_CODE: 'D', FID_ORG_ADJ_PRC: '0'
          }, 'high');
          if (dayResult.body?.output2?.length) {
            // toDate가 매일 바뀌어 키가 영구 누적되던 메모리 누수 차단 — 오늘 키 외엔 제거
            for (const k in global._minDayCache) if (!k.endsWith('_' + toDate)) delete global._minDayCache[k];
            global._minDayCache[mdKey] = dayResult;
          }
        }
        if (dayResult.body?.output1) output1 = dayResult.body.output1;
        const dayRows = (dayResult.body?.output2 || [])
          .slice().reverse() // 과거→현재 정렬
          .slice(0, -1);     // 오늘 제외 (실제 분봉으로 대체)

        // 각 일봉 → 장중 시간대에 분봉 N개로 분할 (09:00~15:30 = 390분)
        // 단순히 균등 선형 보간하면 캔들이 너무 평평해 보여서
        // OHLC를 활용한 자연스러운 패턴으로 분할
        const tradingMins = 390; // 09:00~15:30
        const barsPerDay = Math.floor(tradingMins / unit);

        for (const d of dayRows) {
          const dateStr = d.stck_bsop_date; // YYYYMMDD
          const open  = parseInt(d.stck_oprc||0);
          const high  = parseInt(d.stck_hgpr||0);
          const low   = parseInt(d.stck_lwpr||0);
          const close = parseInt(d.stck_clpr||0);
          const vol   = parseInt(d.acml_vol||0);
          if (!close) continue;

          // 하루를 barsPerDay개 봉으로 분할 (자연스러운 가격 경로 생성)
          const prices = interpolateDayCandles(open, high, low, close, barsPerDay);
          const volPerBar = Math.round(vol / barsPerDay);

          for (let i = 0; i < prices.length; i++) {
            const mins = 9*60 + i*unit; // 09:00부터 시작
            const hh = String(Math.floor(mins/60)).padStart(2,'0');
            const mm = String(mins%60).padStart(2,'0');
            allCandles.push({
              date: dateStr,
              time: hh+mm+'00',
              open: prices[i].o,
              high: prices[i].h,
              low:  prices[i].l,
              close: prices[i].c,
              vol: volPerBar
            });
          }
        }
      }

      // ── 2) 오늘 실제 분봉 수집 ──
      const todayCandles = [];
      const todayStr = new Date().toISOString().slice(0,10).replace(/-/g,'');
      // 현재(KST) 시각까지의 30분 슬롯만 역순 조회 — 장전 0회, 오전 2~4회, 종일도 최대 14회
      // (예전엔 무조건 14연속 호출 ≈ 3~5초 낭비 → 분봉 로딩이 느렸던 주범)
      const kstNow = new Date(Date.now() + 9*60*60*1000);
      const kstMin = kstNow.getUTCHours()*60 + kstNow.getUTCMinutes();
      const kstDay = kstNow.getUTCDay();
      const times = [];
      if (kstDay >= 1 && kstDay <= 5 && kstMin >= 9*60) {
        for (let m = Math.min(kstMin, 15*60+30); m >= 9*60; m -= 30) {
          times.push(String(Math.floor(m/60)).padStart(2,'0') + String(m%60).padStart(2,'0') + '00');
        }
      }

      // 슬롯들을 동시에 큐 투입 — 발사 간격(초당 한도)은 큐가 보장하고, 응답은 병렬로 기다린다.
      // (예전엔 슬롯 하나가 끝나야 다음을 불러서 KIS가 느린 날 7슬롯 × 수 초 = 분봉 13초+)
      const slotResults = await Promise.all(times.map(hhmmss =>
        kisProxy(cfg, '/uapi/domestic-stock/v1/quotations/inquire-time-itemchartprice', 'FHKST03010200', {
          FID_ETC_CLS_CODE: '', FID_COND_MRKT_DIV_CODE: market,
          FID_INPUT_ISCD: code, FID_INPUT_HOUR_1: hhmmss, FID_PW_DATA_INCU_YN: 'N'
        }, 'high').catch(() => null)
      ));
      for (const r of slotResults) {
        if (!r) continue;
        if (!output1 && r.body?.output1) output1 = r.body.output1;
        todayCandles.push(...(r.body?.output2 || []));
      }

      // 오늘 1분봉 중복 제거 + 정렬 + N분 집계
      const seenT = new Set();
      const todayFiltered = todayCandles
        .filter(d => { const t = d.stck_cntg_hour; if(!t||seenT.has(t)||parseInt(d.stck_prpr||0)<=0) return false; seenT.add(t); return true; })
        .sort((a,b) => a.stck_cntg_hour.localeCompare(b.stck_cntg_hour));

      // N분 집계
      for (let i=0; i<todayFiltered.length; i+=unit) {
        const chunk = todayFiltered.slice(i, i+unit);
        if (!chunk.length) continue;
        const hh = chunk[0].stck_cntg_hour.slice(0,2);
        const mm = chunk[0].stck_cntg_hour.slice(2,4);
        allCandles.push({
          date: todayStr,
          time: hh+mm+'00',
          open:  parseInt(chunk[0].stck_oprc||chunk[0].stck_prpr||0),
          high:  Math.max(...chunk.map(c=>parseInt(c.stck_hgpr||c.stck_prpr||0))),
          low:   Math.min(...chunk.map(c=>parseInt(c.stck_lwpr||c.stck_prpr||0))),
          close: parseInt(chunk[chunk.length-1].stck_prpr||0),
          vol:   chunk.reduce((s,c)=>s+parseInt(c.cntg_vol||0),0)
        });
      }

      const mcResp = {
        ok: true,
        data: { output1, output2: allCandles, rt_cd:'0', count: allCandles.length, isMinute: true }
      };
      if (allCandles.length) global._minChartCache[mcKey] = { t: Date.now(), resp: mcResp };
      jsonRes(res, 200, mcResp);
      return;
    }

    // GET /api/search?q=삼성 — 종목 검색 (로컬 마스터 + KIS 실시간 검색)
    if (pathname === '/api/search') {
      const q = (query.q || '').trim();
      if (!q) { jsonRes(res, 200, { ok: true, results: [] }); return; }

      // 1) 로컬 마스터에서 먼저 검색
      const master = loadStockMaster();
      const results = [];
      const seen = new Set();
      for (const [name, code] of Object.entries(master.nameToCode)) {
        if (name.includes(q) || code.includes(q)) {
          results.push({ name, code });
          seen.add(code);
          if (results.length >= 10) break;
        }
      }

      // 2) KIS 종목 검색 API로 보완 (전체 상장종목 커버)
      try {
        const r = await kisProxy(cfg, '/uapi/domestic-stock/v1/quotations/search-stock-info', 'CTPF1002R', {
          PRDT_TYPE_CD: '300', PDNO: /^[0-9]+$/.test(q) ? q : '',
          PRDT_NAME: /^[0-9]+$/.test(q) ? '' : q,
          PRDT_NAME_SRCH_TP: '1', PDNO_OR_PRDT_NAME_SRCH_TP: '1',
          CTS: ''
        });
        const items = r.body?.output || [];
        for (const d of items) {
          const code = d.pdno || d.PDNO;
          const name = d.prdt_name || d.PRDT_NAME;
          if (code && name && !seen.has(code)) {
            results.push({ name, code });
            seen.add(code);
            addToMaster(code, name); // 발견한 종목을 마스터에 추가
            if (results.length >= 30) break;
          }
        }
      } catch(e) { /* KIS 검색 실패 시 로컬 결과만 반환 */ }

      jsonRes(res, 200, { ok: true, results: results.slice(0, 30) });
      return;
    }

    // GET /api/stockinfo?code=005930 — 종목 기본 정보 (SWR: 캐시 즉시 + 백그라운드 갱신)
    if (pathname === '/api/stockinfo') {
      const code = query.code || '005930';
      if (!global._stockinfoCache) global._stockinfoCache = {};
      const c = global._stockinfoCache[code];
      if (c) { // 캐시 있으면 0ms 응답, 만료면 백그라운드만 갱신
        jsonRes(res, 200, { ok: true, ...c.resp });
        if (Date.now() - c.t >= SWR_TTL.stockinfo) refreshStockinfo(cfg, code, 'low');
        return;
      }
      const resp = await refreshStockinfo(cfg, code, 'high'); // 캐시 없을 때만 동기
      if (resp) jsonRes(res, 200, { ok: true, ...resp });
      else jsonRes(res, 500, { ok: false, message: '조회 실패' });
      return;
    }

    // GET /api/volume100?market=J — 거래량 상위 100 (stale-while-revalidate)
    if (pathname === '/api/volume100') {
      if (!global._volCache) global._volCache = { data: null, ts: 0 };
      if (global._volCache.data) {
        if (Date.now() - global._volCache.ts >= SWR_TTL.vol) refreshVol100(cfg, 'low'); // 만료 → 백그라운드 갱신
        jsonRes(res, 200, { ok: true, ...global._volCache.data, cached: true });
        return;
      }
      const payload = await refreshVol100(cfg, 'high'); // 캐시 없을 때만 동기
      jsonRes(res, 200, { ok: true, ...(payload || {}) });
      return;
    }

    // GET /api/orderbook?code=005930 — 호가창 (SWR: 캐시 즉시 + 백그라운드 갱신, 빈 호가 폴백)
    if (pathname === '/api/orderbook') {
      const obc = query.code || '005930';
      if (!global._obCache) global._obCache = {};
      const c = global._obCache[obc];
      if (c) {
        jsonRes(res, 200, { ok: true, ...c.resp });
        if (Date.now() - c.t >= SWR_TTL.ob) refreshOrderbook(cfg, obc, 'low');
        return;
      }
      const resp = await refreshOrderbook(cfg, obc, 'high');
      if (resp) jsonRes(res, 200, { ok: true, ...resp });
      else jsonRes(res, 200, { ok: true, data: { rt_cd: '1' } });
      return;
    }

    // GET /api/account — 계좌 잔고 (stale-while-revalidate, 유저별 분리)
    // 캐시값이 있으면 즉시 반환하고, 2초 지났으면 백그라운드로 갱신. 캐시 없을 때만 동기 fetch.
    if (pathname === '/api/account') {
      if (!global._acctCache) global._acctCache = {};
      const ck = session.userId || 'default';
      // 보유종목의 "매수 출처"를 표시 — 현재 봇 보유면 bot, 아니면 저널의 최근 매수 source(manual/bot),
      // 둘 다 없으면 null(레거시=과거 등록, 사용자가 산 게 아님). 프론트가 🤖봇/👤직접/📋레거시로 구분.
      const annotate = (payload) => {
        try {
          const bp = getTrader(ck).state.botPositions || {};
          const bc = new Set(Object.keys(bp).filter(c => (bp[c].qty || 0) > 0));
          if (payload && payload.data && Array.isArray(payload.data.output1)) {
            return { ...payload, data: { ...payload.data, output1: payload.data.output1.map(p => {
              const holder = bc.has(p.pdno) ? 'bot' : orderJournal.lastBuySource(ck, p.pdno); // 'bot'/'manual'/null
              return { ...p, _holder: holder, _bot: holder === 'bot' };
            }) } };
          }
        } catch (e) {}
        return payload;
      };
      const cached = global._acctCache[ck];
      if (cached) {
        if (Date.now() - cached.t >= SWR_TTL.acct) refreshAccount(cfg, ck, 'low'); // 만료 → 백그라운드 갱신
        jsonRes(res, 200, annotate(cached.data));
        return;
      }
      const payload = await refreshAccount(cfg, ck, 'high');
      jsonRes(res, 200, annotate(payload || { ok: true, data: null }));
      return;
    }

    // GET /api/buyable?code=005930&price=70000 — 매수가능조회 (정확한 주문가능현금·최대수량)
    // inquire-balance의 예수금과 달리 미수·증거금·미결제를 반영한 실제 주문가능액.
    if (pathname === '/api/buyable') {
      const code = query.code || '005930';
      if (!/^[0-9A-Z]{6}$/.test(code)) { jsonRes(res, 400, { ok: false, message: '종목코드 형식 오류' }); return; }
      const price = parseInt(query.price || 0);
      const trId = cfg.txMode === 'vts' ? 'VTTC8908R' : 'TTTC8908R';
      const [cano, prd] = (cfg.accNo || '').split('-');
      try {
        const r = await kisProxy(cfg, '/uapi/domestic-stock/v1/trading/inquire-psbl-order', trId, {
          CANO: cano || '', ACNT_PRDT_CD: prd || '01', PDNO: code,
          ORD_UNPR: String(price || 0), ORD_DVSN: price > 0 ? '00' : '01', // 가격 있으면 지정가, 없으면 시장가 기준
          CMA_EVLU_AMT_ICLD_YN: 'N', OVRS_ICLD_YN: 'N'
        }, 'high');
        const o = r.body?.output || {};
        jsonRes(res, 200, { ok: r.body?.rt_cd === '0', data: {
          cash: parseInt(o.ord_psbl_cash || o.nrcvb_buy_amt || 0),  // 주문가능현금
          maxQty: parseInt(o.max_buy_qty || o.nrcvb_buy_qty || 0)    // 최대 매수 가능 수량
        }, msg: r.body?.msg1 });
      } catch (e) { jsonRes(res, 200, { ok: false, message: '매수가능 조회 실패' }); }
      return;
    }

    // POST /api/ai — 사용자 전용 세팅 어시스턴트 (claude CLI 헤드리스)
    // 보안: 도구 전면 차단(--disallowedTools) + cwd를 프로젝트 밖(/tmp)으로 격리 + 시스템 프롬프트로
    //       서버·코드·파일·주문 접근 금지. AI는 '조언/설명 + 설정 변경 제안'만, 적용은 사용자 승인.
    if (pathname === '/api/ai' && req.method === 'POST') {
      const body = await parseBody(req);
      const msg = String(body.message || '').slice(0, 1000).trim();
      if (!msg) { jsonRes(res, 400, { ok: false, message: '메시지를 입력하세요' }); return; }
      // rate limit — 사용자당 동시 1건만(claude 서브프로세스 폭증 → 자원고갈/서버정체 방지)
      if (!global._aiInFlight) global._aiInFlight = new Set();
      if (global._aiInFlight.has(session.userId)) { jsonRes(res, 429, { ok: false, message: '이전 AI 요청을 처리 중이에요. 잠시 후 다시 보내주세요.' }); return; }
      global._aiInFlight.add(session.userId);
      let ctx = '';
      try {
        const sf = getTrader(session.userId).state.settings.safety;
        ctx = `[현재 자동매매 설정]\n거래당리스크 ${sf.riskPerTradePct}% · 종목당한도 ${sf.maxPerStockPct}%(자본대비) · 최대보유 ${sf.maxPositions}종목 · 노출상한 ${sf.maxExposurePct}% · 손절 ATR×${sf.stopAtrMult} · 익절 ${sf.takeProfitR}R · 일일손실한도 ${sf.dailyLossLimitPct}% · 연속손실서킷 ${sf.maxConsecLosses}회 · 일일거래 ${sf.maxTradesPerDay}회 · 추세필터 ${sf.trendFilter?'ON':'OFF'} · 장중반등 ${sf.intradayRebound?'ON':'OFF'}`;
      } catch (e) {}
      const SYS = `너는 이 사용자만의 한국 주식 자동매매 '세팅 어시스턴트'다. 한국어로 친근하고 간결하게(보통 3~6줄) 답한다. 너는 서버·코드·파일·실제 주문·외부 시스템에 절대 접근할 수 없고, 오직 자동매매 '설정'에 대한 조언·설명과 변경 제안만 한다. 설정 변경을 제안할 때는 답변 맨 끝에 줄을 바꿔 정확히 [[set 키=값]] 형식으로 적어라(여러 개면 여러 줄). 허용 키만 제안: riskPerTradePct, maxPerStockPct(종목당 한도, 자본대비 %), maxPositions, maxExposurePct, stopAtrMult, takeProfitR, dailyLossLimitPct, maxConsecLosses, maxTradesPerDay, trendFilter(true/false), intradayRebound(true/false), rbMinDrop, rbReboundPct. 시스템·코드·파일·서버·해킹 관련 요청은 정중히 거절하라.`;
      try {
        const reply = await new Promise((resolve, reject) => {
          execFile('claude', ['-p', '--strict-mcp-config', '--disallowedTools',
            'Bash', 'Read', 'Write', 'Edit', 'MultiEdit', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'Task', 'Agent', 'NotebookEdit', 'TodoWrite', 'ExitPlanMode',
            '--append-system-prompt', SYS, ctx + '\n\n[사용자 질문] ' + msg],
            { timeout: 90000, cwd: '/tmp', maxBuffer: 1 << 20 },
            (err, stdout) => err ? reject(err) : resolve(String(stdout || '').trim()));
        });
        // 설정 변경 제안 파싱 — 화이트리스트 키만, 적용은 프론트에서 사용자 승인 후
        const WL = new Set(['riskPerTradePct','maxPerStock','maxPositions','maxExposurePct','stopAtrMult','takeProfitR','dailyLossLimitPct','maxConsecLosses','maxTradesPerDay','trendFilter','intradayRebound','rbMinDrop','rbReboundPct']);
        const sets = [];
        const re = /\[\[set\s+([a-zA-Z]+)\s*=\s*([^\]]+)\]\]/g; let mm;
        while ((mm = re.exec(reply))) { if (WL.has(mm[1])) sets.push({ key: mm[1], value: mm[2].trim() }); }
        const cleanReply = reply.replace(/\[\[set[^\]]*\]\]/g, '').trim();
        jsonRes(res, 200, { ok: true, reply: cleanReply || reply, suggestions: sets });
      } catch (e) {
        jsonRes(res, 200, { ok: false, message: 'AI 응답 실패 (시간 초과 또는 일시 오류) — 잠시 후 다시' });
      } finally {
        global._aiInFlight.delete(session.userId); // 처리 완료 — 다음 요청 허용
      }
      return;
    }

    // POST /api/ai/apply — AI가 제안한 설정 변경을 사용자 승인 후 적용 (화이트리스트 키만)
    if (pathname === '/api/ai/apply' && req.method === 'POST') {
      const body = await parseBody(req);
      const WL = { riskPerTradePct:'num', maxPerStockPct:'num', maxPositions:'num', maxExposurePct:'num',
        stopAtrMult:'num', takeProfitR:'num', dailyLossLimitPct:'num', maxConsecLosses:'num',
        maxTradesPerDay:'num', trendFilter:'bool', intradayRebound:'bool', rbMinDrop:'num', rbReboundPct:'num' };
      const key = String(body.key || '');
      if (!WL[key]) { jsonRes(res, 400, { ok: false, message: '허용되지 않은 설정 키' }); return; }
      let v = body.value;
      if (WL[key] === 'bool') v = (v === true || /^(true|on|켜|켜기|1|yes)$/i.test(String(v)));
      else { v = parseFloat(v); if (!Number.isFinite(v)) { jsonRes(res, 400, { ok: false, message: '숫자 값이 아닙니다' }); return; } }
      const status = getTrader(session.userId).updateSettings({ safety: { [key]: v } }); // _clampSafety가 안전범위 보정
      jsonRes(res, 200, { ok: true, status, applied: { key, value: v } });
      return;
    }

    // POST /api/order — 주문
    if (pathname === '/api/order' && req.method === 'POST') {
      const body = await parseBody(req);
      // ★ 서버측 입력 검증 — 멀티유저 서비스에서 서버가 신뢰경계. 변조 클라이언트의 음수/NaN/거대값 차단.
      const ordType = (body.orderType === '01') ? '01' : '00';
      const qtyN = Number(body.qty), priceN = Number(body.price || 0);
      if (!/^[0-9A-Z]{6}$/.test(String(body.code || ''))) { jsonRes(res, 400, { ok: false, message: '종목코드 형식 오류' }); return; }
      if (body.side !== 'buy' && body.side !== 'sell') { jsonRes(res, 400, { ok: false, message: 'side 오류' }); return; }
      if (!Number.isInteger(qtyN) || qtyN < 1 || qtyN > 1000000) { jsonRes(res, 400, { ok: false, message: '수량은 1 이상의 정수여야 합니다' }); return; }
      if (ordType === '00' && (!Number.isFinite(priceN) || priceN <= 0)) { jsonRes(res, 400, { ok: false, message: '지정가 주문은 0보다 큰 가격이 필요합니다' }); return; }
      const isBuy  = body.side === 'buy';
      const trId   = cfg.txMode === 'vts'
        ? (isBuy ? 'VTTC0802U' : 'VTTC0801U')
        : (isBuy ? 'TTTC0802U' : 'TTTC0801U');
      const [cano, acntPrdtCd] = (cfg.accNo || '').split('-');
      const orderObj = {
        CANO: cano || '',
        ACNT_PRDT_CD: acntPrdtCd || '01',
        PDNO: body.code,
        ORD_DVSN: ordType,
        ORD_QTY: String(qtyN),
        ORD_UNPR: ordType === '01' ? '0' : String(priceN) // 시장가는 단가 0
      };
      // 큐를 통해 직렬화 + 초당 한도 거부 시 자동 재시도
      const result = await kisPost(cfg, '/uapi/domestic-stock/v1/trading/order-cash', trId, orderObj);
      console.log(`[주문] ${isBuy?'매수':'매도'} ${body.code} ${body.qty}주 → ${result.body?.rt_cd==='0'?'✅접수':'❌'+(result.body?.msg1||'실패')}`);
      if (result.body?.rt_cd === '0') {
        orderJournal.add({
          userId: session.userId, side: body.side, code: body.code, qty: qtyN,
          price: ordType === '01' ? 0 : priceN, orderType: ordType,
          odno: result.body?.output?.ODNO, orgNo: result.body?.output?.KRX_FWDG_ORD_ORGNO,
          qtyBefore: heldQtyOf(session.userId || 'default', body.code),
          source: 'manual' // 직접 주문 — 거래내역/배지 출처 표시(MED1)
        });
      }
      jsonRes(res, 200, { ok: true, data: result.body });
      return;
    }

    // GET /api/orders?startDate=&endDate= — 주문 내역 (기본: 당일, KST 기준)
    if (pathname === '/api/orders') {
      const trId = cfg.txMode === 'vts' ? 'VTTC8001R' : 'TTTC8001R';
      const [cano, acntPrdtCd] = (cfg.accNo || '').split('-');
      const kstToday = orderJournal._kstDateKey().replace(/-/g, '');
      const sd = (query.startDate || kstToday).replace(/-/g, '') || kstToday;
      const ed = (query.endDate || kstToday).replace(/-/g, '') || kstToday;
      // 로컬 주문 저널(SQLite) — 항상 즉시(수 ms). 1차 소스.
      const jEntriesEarly = (sd === kstToday && ed === kstToday)
        ? orderJournal.todayList(session.userId)
        : orderJournal.listRange(session.userId, sd, ed);
      const jRowsEarly = orderJournal.toKisFormat(jEntriesEarly, codeToNameLookup);
      // ★ 모의투자(VTS)는 KIS 당일체결 API가 빈 응답 → KIS 왕복·큐 대기 없이 저널만으로 즉시 응답.
      //   (거래내역 화면이 장중 high 큐 적체에 걸려 느려지던 문제 제거)
      if (cfg.txMode === 'vts') {
        jsonRes(res, 200, { ok: true, data: { output1: jRowsEarly, rt_cd: '0' }, journal: true });
        return;
      }
      let result = null;
      try {
        result = await kisProxy(cfg, '/uapi/domestic-stock/v1/trading/inquire-daily-ccld', trId, {
          CANO: cano || '',
          ACNT_PRDT_CD: acntPrdtCd || '01',
          INQR_STRT_DT: sd,
          INQR_END_DT: ed,
          SLL_BUY_DVSN_CD: '00',
          INQR_DVSN: '00',
          PDNO: '',
          CCLD_DVSN: '00',
          ORD_GNO_BRNO: '',
          ODNO: '',
          INQR_DVSN_3: '00',
          INQR_DVSN_1: '',
          CTX_AREA_FK100: '',
          CTX_AREA_NK100: ''
        }, 'high'); // 사용자 화면 — 백그라운드 새치기
      } catch (e) { result = null; } // KIS 타임아웃/큐 거부에도 저널 폴백으로 진행 — 내역 화면이 죽지 않게
      const kisRows = result?.body?.output1 || [];
      // 로컬 주문 저널 — 주문 직후·장마감·VTS 반영지연에도 즉시 표시되는 1차 소스
      const jEntries = (sd === kstToday && ed === kstToday)
        ? orderJournal.todayList(session.userId)
        : orderJournal.listRange(session.userId, sd, ed);
      const jRows = orderJournal.toKisFormat(jEntries, codeToNameLookup);
      if (!kisRows.length) {
        // KIS(특히 모의)가 내역을 안 줌 → 저널만으로 응답
        jsonRes(res, 200, { ok: true, data: { output1: jRows, rt_cd: '0' }, journal: true });
        return;
      }
      // ★ 병합: KIS 미반영(접수 직후) 주문을 저널에서 보충 — "빠딱빠딱" 표시
      const kisOdnos = new Set(kisRows.map(o => String(parseInt(o.odno || 0)))); // 선행 0 무시 비교
      const extra = jRows.filter(j => j.odno && !kisOdnos.has(String(parseInt(j.odno))));
      const merged = [...extra, ...kisRows]; // 최신(저널 미반영분)을 위로
      jsonRes(res, 200, { ok: true, data: { ...result.body, output1: merged }, merged: extra.length });
      return;
    }

    // GET /api/tick?code=005930 — 당일 체결 내역 (SWR: 캐시 즉시 + 백그라운드 갱신)
    if (pathname === '/api/tick') {
      const code = query.code || '005930';
      if (!global._tickCache) global._tickCache = {};
      const c = global._tickCache[code];
      if (c) {
        jsonRes(res, 200, { ok: true, ...c.resp });
        if (Date.now() - c.t >= SWR_TTL.tick) refreshTick(cfg, code, 'low');
        return;
      }
      const resp = await refreshTick(cfg, code, 'high');
      if (resp) jsonRes(res, 200, { ok: true, ...resp });
      else jsonRes(res, 200, { ok: true, data: { rt_cd: '1' }, cached: false });
      return;
    }

    // GET /api/cancel — 주문 취소
    if (pathname === '/api/cancel' && req.method === 'POST') {
      const body = await parseBody(req);
      if (!/^[0-9]{1,20}$/.test(String(body.ordNo || ''))) { jsonRes(res, 400, { ok: false, message: '주문번호 형식 오류' }); return; }
      const trId = cfg.txMode === 'vts' ? 'VTTC0803U' : 'TTTC0803U';
      const [cano, acntPrdtCd] = (cfg.accNo||'').split('-');
      const cq = parseInt(body.qty) || 0; // 문자열 "0"도 전량취소로 일관 처리
      const cancelObj = {
        CANO: cano||'', ACNT_PRDT_CD: acntPrdtCd||'01',
        KRX_FWDG_ORD_ORGNO: body.orgNo||'', ORGN_ODNO: body.ordNo||'',
        ORD_DVSN: '00', RVSE_CNCL_DVSN_CD: '02', // 02=취소
        ORD_QTY: String(cq), ORD_UNPR: '0',      // 취소는 단가 0 필수 (누락 시 '주문 금액 확인' 거부)
        QTY_ALL_ORD_YN: cq > 0 ? 'N' : 'Y'
      };
      // 큐를 통해 직렬화 + 초당 한도 거부 시 자동 재시도
      const result = await kisPost(cfg, '/uapi/domestic-stock/v1/trading/order-rvsecncl', trId, cancelObj);
      console.log(`[주문취소] ${body.ordNo} → ${result.body?.rt_cd==='0'?'✅성공':'❌'+(result.body?.msg1||'')}`);
      if (result.body?.rt_cd === '0') orderJournal.markCancel(body.ordNo, session && session.userId); // 저널에도 취소 반영 (본인 주문만)
      jsonRes(res, 200, { ok: true, data: result.body });
      return;
    }

    // GET /api/news?code=005930 — 종목 뉴스 (SWR 캐시: 즉시 응답 + 5분 경과 시 백그라운드 갱신)
    if (pathname === '/api/news') {
      const code = query.code || '005930';
      const fallbackUrl = `https://finance.naver.com/item/news.naver?code=${code}`;
      if (!global._newsCache) global._newsCache = {};
      if (!global._newsRefreshing) global._newsRefreshing = {};
      const nc = global._newsCache[code];
      if (nc && nc.payload) {
        jsonRes(res, 200, nc.payload); // 캐시 즉시 응답 — 뉴스 체감 0ms
        if (Date.now() - nc.t > 5 * 60 * 1000 && !global._newsRefreshing[code]) {
          global._newsRefreshing[code] = true; // 백그라운드 갱신 (아래 본문 재사용 위해 내부 요청처럼 재실행)
          _fetchNews(cfg, code, fallbackUrl)
            .then(p => { if (p) global._newsCache[code] = { t: Date.now(), payload: p }; })
            .catch(() => {})
            .finally(() => { global._newsRefreshing[code] = false; });
        }
        return;
      }
      const payload = await _fetchNews(cfg, code, fallbackUrl);
      if (payload && payload.data && payload.data.output && payload.data.output.length) {
        global._newsCache[code] = { t: Date.now(), payload };
      }
      jsonRes(res, 200, payload || { ok: true, data: { output: [], rt_cd: '1', noPermission: true }, fallbackUrl });
      return;
    }
    // (구 인라인 뉴스 로직은 _fetchNews 함수로 이동)
    // GET /api/investor?code=005930 — 외국인·기관 수급 (SWR 캐시 5분: 즉시 응답 + 백그라운드 갱신)
    if (pathname === '/api/investor') {
      const code = query.code || '005930';
      if (!global._invCache) global._invCache = {};
      if (!global._invRefreshing) global._invRefreshing = {};
      const fetchInvestor = async () => {
        const r = await withRetry(() =>
          kisProxy(cfg, '/uapi/domestic-stock/v1/quotations/inquire-investor', 'FHKST01010900', {
            FID_COND_MRKT_DIV_CODE: 'J', FID_INPUT_ISCD: code
          }), `수급:${code}`);
        // 외국인 보유율은 투자자 TR에 없음 → 현재가 API(hts_frgn_ehrt)에서 가져옴
        let frgnRate = 0;
        try {
          const pr = await kisProxy(cfg, '/uapi/domestic-stock/v1/quotations/inquire-price', 'FHKST01010100', {
            FID_COND_MRKT_DIV_CODE: 'J', FID_INPUT_ISCD: code
          });
          frgnRate = parseFloat(pr.body?.output?.hts_frgn_ehrt || 0);
        } catch(_) {}
        return { ok: true, data: r.body, frgnRate };
      };
      const ic = global._invCache[code];
      if (ic && ic.payload) {
        jsonRes(res, 200, ic.payload); // 캐시 즉시 응답 — 수급 체감 0ms
        if (Date.now() - ic.t > 5 * 60 * 1000 && !global._invRefreshing[code]) {
          global._invRefreshing[code] = true;
          fetchInvestor()
            .then(p => { if (p?.data?.output?.length) global._invCache[code] = { t: Date.now(), payload: p }; })
            .catch(() => {})
            .finally(() => { global._invRefreshing[code] = false; });
        }
        return;
      }
      const payload = await fetchInvestor();
      if (payload?.data?.output?.length) global._invCache[code] = { t: Date.now(), payload };
      jsonRes(res, 200, payload);
      return;
    }

    // GET /api/financial?code=005930 — 재무 정보
    if (pathname === '/api/financial') {
      const code = query.code || '005930';
      const r = await withRetry(() =>
        kisProxy(cfg, '/uapi/domestic-stock/v1/finance/income-statement', 'FHKST66430200', {
          FID_DIV_CLS_CODE: '1', fid_cond_mrkt_div_code: 'J', fid_input_iscd: code
        })
      , `재무:${code}`);
      jsonRes(res, 200, { ok: true, data: r.body });
      return;
    }

    // GET /api/market — KOSPI/KOSDAQ 지수 + 환율 (stale-while-revalidate)
    if (pathname === '/api/market') {
      if (!global._marketCache) global._marketCache = { data: null, ts: 0 };
      if (global._marketCache.data) {
        if (Date.now() - global._marketCache.ts >= SWR_TTL.market) refreshMarket(cfg, 'low'); // 만료 → 백그라운드 갱신
        jsonRes(res, 200, { ok: true, data: global._marketCache.data, cached: true });
        return;
      }
      const data = await refreshMarket(cfg, 'high'); // 캐시 없을 때만 동기
      jsonRes(res, 200, { ok: true, data: data || {} });
      return;
    }

    // POST /api/telegram — 텔레그램 알림 설정 저장 및 테스트
    if (pathname === '/api/telegram' && req.method === 'POST') {
      const body = await parseBody(req);
      if (body.action === 'save') {
        const cfg2 = loadConfig();
        cfg2.telegramToken = body.token || '';
        cfg2.telegramChatId = body.chatId || '';
        saveConfig(cfg2);
        jsonRes(res, 200, { ok: true, message: '텔레그램 설정 저장됨' });
      } else if (body.action === 'test') {
        const cfg2 = loadConfig();
        await sendTelegram(cfg2, '✅ AutoTrade KR 텔레그램 알림 연결 테스트 성공!');
        jsonRes(res, 200, { ok: true, message: '테스트 메시지 발송됨' });
      }
      return;
    }

    jsonRes(res, 404, { ok: false, message: '알 수 없는 API 경로: ' + pathname });

  } catch(e) {
    console.error('[API Error]', pathname, e.message); // 상세는 서버 로그에만
    jsonRes(res, 500, { ok: false, message: '요청 처리 중 오류가 발생했습니다.' }); // 내부 메시지 노출 안 함
  }
}

// ════════════════════════════════════════
// 서버 시작
// ════════════════════════════════════════
server.listen(PORT, HOST, () => {
  console.log('');
  console.log('╔════════════════════════════════════════╗');
  console.log('║     AutoTrade KR — 프록시 서버 실행    ║');
  console.log('╠════════════════════════════════════════╣');
  console.log(`║  웹 대시보드: http://localhost:${PORT}      ║`);
  console.log(`║  API 엔드포인트:                        ║`);
  console.log(`║    GET  /api/price?code=005930          ║`);
  console.log(`║    GET  /api/chart?code=005930&period=D ║`);
  console.log(`║    GET  /api/volume100                  ║`);
  console.log(`║    GET  /api/orderbook?code=005930      ║`);
  console.log(`║    GET  /api/account                    ║`);
  console.log(`║    POST /api/order                      ║`);
  console.log(`║    POST /api/config                     ║`);
  console.log('╚════════════════════════════════════════╝');
  console.log('');

  // ── 전역(하위호환) 설정 ──
  const cfg = (() => { try { return JSON.parse(fs.readFileSync(CONFIG_FILE,'utf8')); } catch(e){ return {}; } })();
  if (cfg.appKey && cfg.appSecret) {
    console.log('✅ (전역) KIS API 설정 로드됨');
    setCurrentUser(null);
    getKisToken(cfg).then(()=>console.log('🔑 (전역) 토큰 준비 완료')).catch(()=>{});
  }

  // ── 멀티유저: 가입된 유저 중 자동매매 켜져있던 사람 엔진 재개 ──
  try {
    const users = auth.loadUsers();
    for (const username of Object.keys(users)) {
      const uid = users[username].userId;
      const ut = getTrader(uid);
      if (ut.getStatus().enabled) {
        console.log(`🤖 [${username}] 이전 자동매매 설정 감지 — 엔진 재개`);
        ut.start();
      }
    }
    const n = Object.keys(users).length;
    console.log(`👥 가입 유저: ${n}명`);
  } catch(e) { console.log('유저 로드 보류:', e.message); }
  try { auth.purgeExpiredSessions(); } catch (_) {} // 만료 세션 정리(서버 부팅 시 1회)
  console.log('🤖 자동매매 엔진 로드됨 — 웹의 [전략 설정] 탭에서 제어하세요.');

  // ── Phase 1: 서버 prefetch 루프 시작 (관심종목/거래량 캐시 워밍) ──
  schedulePrefetch();
  console.log('🔥 prefetch 루프 시작 — 관심종목/거래량 시세 백그라운드 워밍');
  console.log('');
});

server.on('error', e => {
  if (e.code === 'EADDRINUSE') {
    console.error(`❌ 포트 ${PORT} 이미 사용 중. 다른 포트로 변경하거나 기존 프로세스를 종료하세요.`);
  } else {
    console.error('서버 오류:', e.message);
  }
  process.exit(1);
});

process.on('uncaughtException', e => console.error('[Uncaught]', e && e.stack || e));
// 미처리 promise reject — Node 15+ 기본은 프로세스 강제 종료. 가드 밖 reject 한 건이
// 멀티유저 서버 전체를 즉사시키는 것을 막는다(로그만 남기고 생존).
process.on('unhandledRejection', e => console.error('[Rejection]', e && e.stack || e));
// Phase 0+1 속도 개선 적용 (앱키별 큐 · 이중 스로틀 제거 · SWR · prefetch)
