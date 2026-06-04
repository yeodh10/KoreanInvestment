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
const auth  = require('./auth');

const PORT = 3000;
const CONFIG_FILE = path.join(__dirname, 'kis-config.json');
const STOCK_FILE = path.join(__dirname, 'stocks-data.json');

// ── 멀티유저: 현재 요청의 userId (요청마다 설정됨) ──
// loadConfig/saveConfig가 이 값을 보고 해당 유저 설정을 읽고 씀
let _currentUserId = null;
function setCurrentUser(userId) { _currentUserId = userId; }

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
  if (_currentUserId) {
    return auth.loadUserConfig(_currentUserId);
  }
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    }
  } catch(e) {}
  return { appKey:'', appSecret:'', accNo:'', txMode:'vts', token:'', tokenExpiry:0 };
}

function saveConfig(cfg) {
  if (_currentUserId) {
    auth.saveUserConfig(_currentUserId, cfg);
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
  const st = _tokenIssue[tkey] || (_tokenIssue[tkey] = { p: null, failUntil: 0 });

  // 실패 쿨다운 중 — 기존 토큰이 아직 살아있으면 그것 사용, 아니면 대기 안내
  if (now < st.failUntil) {
    if (cfg.token && cfg.tokenExpiry > now) return cfg.token;
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
      saveConfig(cfg);
      st.failUntil = 0;
      return cfg.token;
    }
    // 발급 실패 — 65초 쿨다운 설정 (KIS 1분 제한 준수)
    st.failUntil = Date.now() + 65000;
    // 기존 토큰이 아직 안 죽었으면 그거라도 사용
    if (cfg.token && cfg.tokenExpiry > Date.now()) return cfg.token;
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
const KIS_GAP_MS = { vts: 250, live: 60 }; // vts 4/s — 한도(5/s) 여유분 확보로 EGW00201 페널티 예방
function kisGapFor(cfg) { return (cfg && cfg.txMode === 'live') ? KIS_GAP_MS.live : KIS_GAP_MS.vts; }

const _kisQueues = {}; // appKey → { high, low, last, pumping, gap }
function _kisQ(key) {
  return _kisQueues[key] || (_kisQueues[key] = { high: [], low: [], last: 0, pumping: false, gap: KIS_GAP_MS.vts });
}
function kisSchedule(key, gap, fn, priority) {
  const q = _kisQ(key);
  q.gap = gap;
  return new Promise((resolve, reject) => {
    // 백프레셔: KIS가 느려져 큐가 적체되면 — 백그라운드(low)는 즉시 포기(캐시 유지),
    // 사용자 요청(high)도 한계치를 넘으면 빠르게 실패시켜 폴백이 동작하게 한다.
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
      const job = q.high.length ? q.high.shift() : q.low.shift();
      const wait = q.gap - (Date.now() - q.last);
      if (wait > 0) await new Promise(r => setTimeout(r, wait));
      q.last = Date.now();
      try { job.resolve(await job.fn()); }
      catch (e) { job.reject(e); }
    }
  } finally { q.pumping = false; }
}

async function kisProxy(cfg, kispath, trId, queryParams, priority) {
  const host = cfg.txMode === 'vts' ? KIS_HOST_VTS : KIS_HOST_REAL;
  const [hostname, port] = host.split(':');
  const qs = new URLSearchParams(queryParams).toString();
  const fullPath = kispath + (qs ? '?' + qs : '');

  // 우선순위 큐로 간격 보장 + EGW00201(초당 한도 초과) 시 백오프 재시도
  const qKey = cfg.appKey || '_global';
  const gap = kisGapFor(cfg);
  for (let attempt = 0; attempt < 4; attempt++) {
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
    if (res?.body && res.body.msg_cd === 'EGW00201' && attempt < 3) {
      await new Promise(r => setTimeout(r, 400 * (attempt + 1)));
      continue;
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
  for (let attempt = 0; attempt < 4; attempt++) {
    const token = await getKisToken(cfg);
    const hashkey = await kisSchedule(qKey, gap, () => getHashkey(cfg, bodyObj), 'high');
    const body = JSON.stringify(bodyObj);
    res = await kisSchedule(qKey, gap, () => httpsRequest({
      hostname, port: parseInt(port), path: kispath, method: 'POST',
      headers: {
        'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body),
        'authorization': 'Bearer ' + token, 'appkey': cfg.appKey, 'appsecret': cfg.appSecret,
        'tr_id': trId, 'custtype': 'P', 'hashkey': hashkey
      }
    }, body), 'high');
    const msg = res?.body?.msg1 || '', cd = res?.body?.msg_cd || '';
    if (res?.body?.rt_cd !== '0' && (cd === 'EGW00201' || msg.includes('초당 거래건수')) && attempt < 3) {
      console.log(`[주문 재시도 ${attempt + 1}] 초당 한도 — 0.${5 * (attempt + 1)}초 후 재전송`);
      await new Promise(r => setTimeout(r, 500 * (attempt + 1)));
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
        // 토큰 초기화해서 재발급 유도
        const cfg = loadConfig();
        cfg.token = ''; cfg.tokenExpiry = 0;
        saveConfig(cfg);
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
    // 장 마감 후 자정에 캐시 초기화
    const msToMidnight = new Date().setHours(24,0,0,0) - Date.now();
    setTimeout(() => { delete _chartCache[key]; }, msToMidnight);
  }
  return result;
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
async function executeOrder(cfg, { side, code, qty, price, orderType }) {
  const isBuy = side === 'buy';
  const trId = cfg.txMode === 'vts'
    ? (isBuy ? 'VTTC0802U' : 'VTTC0801U')
    : (isBuy ? 'TTTC0802U' : 'TTTC0801U');
  const [cano, acntPrdtCd] = (cfg.accNo || '').split('-');
  const orderObj = {
    CANO: cano||'', ACNT_PRDT_CD: acntPrdtCd||'01',
    PDNO: code, ORD_DVSN: orderType||'00',
    ORD_QTY: String(qty), ORD_UNPR: String(price||0)
  };
  // 큐를 통해 직렬화 + 초당 한도 거부 시 자동 재시도
  const r = await kisPost(cfg, '/uapi/domestic-stock/v1/trading/order-cash', trId, orderObj);
  return r.body;
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
    placeOrder:      executeOrder,     // (cfg, order)
    getAccount:      fetchAccount,     // (cfg)
    getVolTop:       fetchVolTop,      // (cfg)
    codeToName:      codeToNameLookup,
    sendTelegram:    sendTelegram
  });
  _traders[userId] = t;
  return t;
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

// ── CORS 헤더 ──
function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

// ── JSON 응답 ──
function jsonRes(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

// ── 요청 바디 파싱 ──
function parseBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try { resolve(JSON.parse(body)); } catch(e) { resolve({}); }
    });
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
  };
  const mime = mimeTypes[ext] || 'text/plain';
  try {
    const content = fs.readFileSync(filepath);
    res.writeHead(200, { 'Content-Type': mime });
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
const SWR_TTL = { price: 5000, acct: 2000, market: 30000, vol: 90000 };
// 진행 중 백그라운드 갱신 중복 방지 (low 우선순위 갱신에만 적용; high는 항상 즉시 실행)
const _bgRefreshing = { price: {}, acct: {}, market: false, vol: false };

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
    // 현재가/전일종가 둘 다 0이면 — 일봉 마지막 종가로 폴백
    if (!cur && !prev) {
      try {
        const dr = await kisProxy(cfg, '/uapi/domestic-stock/v1/quotations/inquire-daily-price', 'FHKST01010400', {
          FID_COND_MRKT_DIV_CODE: 'J', FID_INPUT_ISCD: code, FID_PERIOD_DIV_CODE: 'D', FID_ORG_ADJ_PRC: '0'
        }, priority);
        const days = dr.body?.output || [];
        if (days.length) { prev = parseInt(days[0].stck_clpr || 0); cur = 0; }
      } catch (e2) {}
    }
    const data = { price: cur, chgPct: parseFloat(o.prdy_ctrt || 0), sign: o.prdy_vrss_sign || '3', prev: prev || cur };
    if (data.price > 0 || data.prev > 0) global._priceCache[code] = { t: Date.now(), data };
    return data;
  } catch (e) { return global._priceCache[code]?.data || null; }
  finally { if (priority === 'low') _bgRefreshing.price[code] = false; }
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
    if (result.body && result.body.rt_cd === '0') global._acctCache[userKey] = { t: Date.now(), data: payload };
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
    // 2) 폴백: 모의 키로도 되는 개별 시세 → 주요 종목 거래량 정렬
    const VOL_CODES = ['005930','000660','373220','207940','005380','000270','035420','035720','068270','005490','051910','006400','105560','066570'];
    const rows = [];
    for (const code of VOL_CODES) {
      try {
        const pr = await kisProxy(cfg, '/uapi/domestic-stock/v1/quotations/inquire-price', 'FHKST01010100',
          { FID_COND_MRKT_DIV_CODE: 'J', FID_INPUT_ISCD: code }, priority);
        const o = pr.body?.output;
        if (o && parseInt(o.stck_prpr || 0) > 0) {
          rows.push({ stck_shrn_iscd: code, hts_kor_isnm: o.hts_kor_isnm || code,
            stck_prpr: o.stck_prpr, prdy_ctrt: o.prdy_ctrt, acml_vol: o.acml_vol, acml_tr_pbmn: o.acml_tr_pbmn });
        }
      } catch (e) {}
    }
    rows.sort((a, b) => parseInt(b.acml_vol || 0) - parseInt(a.acml_vol || 0));
    const payload = { data: { output: rows }, fallback: 'curated' };
    global._volCache = { data: payload, ts: Date.now() };
    return payload;
  } catch (e) { return global._volCache?.data || null; }
  finally { if (priority === 'low') _bgRefreshing.vol = false; }
}

// ── 서버 prefetch 루프 ──
// 등록 유저의 관심종목 + 주요 거래량 종목 시세를 장중 주기적으로 미리 데워 캐시를 채운다.
// 우선순위 'low' — 사용자 동작(현재가/호가 등 high)을 절대 방해하지 않는다.
// TTL이 남은 캐시는 건드리지 않아 rate limit 낭비를 막는다.
const PREFETCH_VOL_CODES = ['005930','000660','373220','207940','005380','000270','035420','035720'];
function _isMarketHours() {
  const kst = new Date(Date.now() + 9 * 3600 * 1000); // UTC → KST
  const day = kst.getUTCDay();                         // 0=일, 6=토
  if (day === 0 || day === 6) return false;
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
      const codes = [...new Set([...watch, ...PREFETCH_VOL_CODES])].slice(0, 30);
      for (const code of codes) {
        const c = global._priceCache && global._priceCache[code];
        if (!c || now - c.t >= SWR_TTL.price) refreshPrice(cfg, code, 'low'); // 만료된 것만
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

// ════════════════════════════════════════
// HTTP 서버
// ════════════════════════════════════════
const server = http.createServer(async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const parsed  = new URL(req.url, 'http://localhost');
  const pathname = parsed.pathname;
  const query    = Object.fromEntries(parsed.searchParams);

  // ── 세션 → 현재 유저 결정 ──
  const cookies = auth.parseCookies(req);
  const session = auth.getUserBySession(cookies.session);
  setCurrentUser(session ? session.userId : null);

  // ── 정적 파일 ──
  if (pathname === '/' || pathname === '/index.html') {
    serveStatic(res, path.join(__dirname, 'app.html')); return;
  }
  if (pathname.endsWith('.html') || pathname.endsWith('.js') || pathname.endsWith('.css')) {
    serveStatic(res, path.join(__dirname, pathname.slice(1))); return;
  }

  // ══════════════════════════════════════════
  // 인증 API (로그인 불필요)
  // ══════════════════════════════════════════
  if (pathname === '/api/auth/register' && req.method === 'POST') {
    const body = await parseBody(req);
    const r = auth.register(body.username, body.password);
    if (r.ok) {
      // 가입 후 자동 로그인
      const lr = auth.login(body.username, body.password);
      if (lr.ok) {
        res.setHeader('Set-Cookie', `session=${lr.token}; HttpOnly; Path=/; Max-Age=2592000; SameSite=Lax`);
        jsonRes(res, 200, { ok:true, username: lr.username, role: lr.role });
        return;
      }
    }
    jsonRes(res, r.ok ? 200 : 400, r);
    return;
  }
  if (pathname === '/api/auth/login' && req.method === 'POST') {
    const body = await parseBody(req);
    const r = auth.login(body.username, body.password);
    if (r.ok) {
      res.setHeader('Set-Cookie', `session=${r.token}; HttpOnly; Path=/; Max-Age=2592000; SameSite=Lax`);
      jsonRes(res, 200, { ok:true, username: r.username, role: r.role });
    } else {
      jsonRes(res, 401, r);
    }
    return;
  }
  if (pathname === '/api/auth/logout' && req.method === 'POST') {
    auth.logout(cookies.session);
    res.setHeader('Set-Cookie', 'session=; HttpOnly; Path=/; Max-Age=0');
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
    // 토큰은 제외 (재발급되므로 불필요)
    const { token, tokenExpiry, ...exportable } = cfg;
    jsonRes(res, 200, { ok: true, data: exportable });
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

  // GET /api/debug — 서버 내부 상태 (큐 적체·토큰·업타임) 진단용
  if (pathname === '/api/debug') {
    const qs = {};
    for (const k in _kisQueues) {
      const q = _kisQueues[k];
      qs[k.slice(0, 8)] = { high: q.high.length, low: q.low.length, pumping: q.pumping, sinceLastMs: Date.now() - q.last };
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
  if (!cfg.appKey || !cfg.appSecret) {
    jsonRes(res, 503, { ok: false, message: 'KIS API 미설정. /api/config 로 설정하세요.', simulation: true });
    return;
  }

  try {
    // GET /api/stream?codes=005930,000660&ob=005930 — 실시간 시세 SSE (Phase 2)
    // KIS WebSocket을 구독해 체결가/호가를 브라우저로 푸시. 수신 시세는 가격캐시에도 반영.
    if (pathname === '/api/stream') {
      realtime.handleStream(req, res, {
        cfg, query,
        onPrice: (code, data) => {
          if (!global._priceCache) global._priceCache = {};
          global._priceCache[code] = { t: Date.now(), data };
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
      for (const code of missing) {
        out[code] = (await refreshPrice(cfg, code, 'high')) || null;
      }
      jsonRes(res, 200, { ok: true, data: out });
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
      // 캐시 저장 (장 마감 후 자정에 삭제)
      global._chartCache[cacheKey] = response;
      const msToMidnight = new Date().setHours(24,0,0,0) - Date.now();
      setTimeout(() => { delete global._chartCache[cacheKey]; }, msToMidnight);

      jsonRes(res, 200, response);
      return;
    }

    // GET /api/minchart?code=005930&unit=5&days=30 — 분봉 (과거 지원)
    // 핵심: KIS는 당일 분봉만 제공 → 과거 일봉을 N분봉으로 변환해 이어붙임
    // 오늘 → 실제 1분봉 수집 후 N분 집계
    // 과거 → 하루치 OHLCV를 장중 균등 분할해 분봉처럼 렌더링
    if (pathname === '/api/minchart') {
      const code = query.code || '005930';
      const unit = parseInt(query.unit || '5');
      const days = Math.min(90, Math.max(1, parseInt(query.days || '30'))); // 최대 90일
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
        const dayResult = await kisProxy(cfg, '/uapi/domestic-stock/v1/quotations/inquire-daily-itemchartprice', 'FHKST03010100', {
            FID_COND_MRKT_DIV_CODE: market, FID_INPUT_ISCD: code,
            FID_INPUT_DATE_1: fromDate, FID_INPUT_DATE_2: toDate,
            FID_PERIOD_DIV_CODE: 'D', FID_ORG_ADJ_PRC: '0'
          }, 'high');
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

      let emptyStreak = 0;
      for (const hhmmss of times) {
        try {
          const r = await kisProxy(cfg, '/uapi/domestic-stock/v1/quotations/inquire-time-itemchartprice', 'FHKST03010200', {
              FID_ETC_CLS_CODE: '', FID_COND_MRKT_DIV_CODE: market,
              FID_INPUT_ISCD: code, FID_INPUT_HOUR_1: hhmmss, FID_PW_DATA_INCU_YN: 'N'
            }, 'high');
          if (!output1 && r.body?.output1) output1 = r.body.output1;
          const rows = r.body?.output2 || [];
          todayCandles.push(...rows);
          if (!rows.length) { if (++emptyStreak >= 2) break; } else emptyStreak = 0; // 빈 구간 연속 2회 → 중단
        } catch(e) { break; }
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

    // GET /api/stockinfo?code=005930 — 종목 기본 정보 (증권사 상세 화면용)
    if (pathname === '/api/stockinfo') {
      const code = query.code || '005930';
      try {
        // 현재가는 필수. 종목상세(CTPF1002R)는 모의투자에서 자주 실패 → 실패해도 현재가는 살림
        const priceR = await kisProxy(cfg, '/uapi/domestic-stock/v1/quotations/inquire-price', 'FHKST01010100', {
          FID_COND_MRKT_DIV_CODE: 'J', FID_INPUT_ISCD: code
        }, 'high');
        // 종목상세(CTPF1002R)는 모의투자에서 무응답이 잦아 호출당 10초씩 낭비 → 제거.
        // 이름은 현재가 응답(hts_kor_isnm) 또는 로컬 종목 마스터에서 가져온다.
        const p = priceR.body?.output || {};
        const i = { prdt_name: codeToNameLookup(code) };
        let data = {
          code,
          name: p.hts_kor_isnm || i.prdt_name || code,
          price: parseInt(p.stck_prpr||0),
          change: parseInt(p.prdy_vrss||0),
          changePct: parseFloat(p.prdy_ctrt||0),
          sign: p.prdy_vrss_sign,
          open: parseInt(p.stck_oprc||0),
          high: parseInt(p.stck_hgpr||0),
          low: parseInt(p.stck_lwpr||0),
          vol: parseInt(p.acml_vol||0),
          amount: parseInt(p.acml_tr_pbmn||0),
          marketCap: parseInt(p.hts_avls||0),
          per: parseFloat(p.per||0),
          pbr: parseFloat(p.pbr||0),
          eps: parseFloat(p.eps||0),
          hi52: parseInt(p.w52_hgpr||p.stck_mxpr||0),
          lo52: parseInt(p.w52_lwpr||p.stck_llam||0),
          rt_cd: priceR.body?.rt_cd
        };
        if (data.price > 0) {
          fb.save('stockinfo:' + code, data); // 마지막 정상 데이터 보관
        } else {
          // 가격 0 (장전/빈 응답) — ① 마지막 정상 데이터 ② 일봉 종가 순으로 폴백 (₩0 표시 금지)
          const last = fb.get('stockinfo:' + code);
          if (last && last.price > 0) {
            data = { ...last, stale: true };
          } else {
            try {
              const candles = await fetchChart(cfg, code, 'D');
              const n = candles?.length || 0;
              if (n) {
                const c1 = candles[n-1].close, c0 = n > 1 ? candles[n-2].close : c1;
                data.price = c1;
                data.change = c1 - c0;
                data.changePct = c0 ? Math.round((c1-c0)/c0*10000)/100 : 0;
                data.sign = c1 >= c0 ? '2' : '5';
                data.stale = true;
              }
            } catch(_) {}
          }
        }
        jsonRes(res, 200, { ok: true, data });
      } catch(e) {
        jsonRes(res, 500, { ok: false, message: e.message });
      }
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

    // GET /api/orderbook?code=005930 — 호가창 (빈 호가 시 폴백)
    if (pathname === '/api/orderbook') {
      const obc = query.code || '005930';
      const result = await kisProxy(cfg, '/uapi/domestic-stock/v1/quotations/inquire-asking-price-exp-ccn', 'FHKST01010200', {
        FID_COND_MRKT_DIV_CODE: 'J',
        FID_INPUT_ISCD: obc
      }, 'high');
      if (!fb.isOrderbookEmpty(result.body?.output1)) {
        fb.save('ob:' + obc, result.body); // 마지막 정상 호가 보관
        jsonRes(res, 200, { ok: true, data: result.body });
        return;
      }
      // 빈 호가 — ① 마지막 정상 호가 ② 마지막 가격 기준 호가 사다리 (빈 화면 금지)
      const lastOb = fb.get('ob:' + obc);
      if (lastOb) { jsonRes(res, 200, { ok: true, data: lastOb, cached: true }); return; }
      let basePrice = global._priceCache?.[obc]?.data?.price || global._priceCache?.[obc]?.data?.prev || 0;
      if (!basePrice) basePrice = (fb.get('stockinfo:' + obc) || {}).price || 0;
      if (!basePrice) { try { const cs = await fetchChart(cfg, obc, 'D'); basePrice = cs?.[cs.length-1]?.close || 0; } catch(_) {} }
      const ladder = fb.buildLadder(basePrice);
      jsonRes(res, 200, { ok: true, data: ladder ? { output1: ladder, rt_cd: '0' } : result.body, synthetic: !!ladder });
      return;
    }

    // GET /api/account — 계좌 잔고 (stale-while-revalidate, 유저별 분리)
    // 캐시값이 있으면 즉시 반환하고, 2초 지났으면 백그라운드로 갱신. 캐시 없을 때만 동기 fetch.
    if (pathname === '/api/account') {
      if (!global._acctCache) global._acctCache = {};
      const ck = session.userId || 'default';
      const cached = global._acctCache[ck];
      if (cached) {
        if (Date.now() - cached.t >= SWR_TTL.acct) refreshAccount(cfg, ck, 'low'); // 만료 → 백그라운드 갱신
        jsonRes(res, 200, cached.data);
        return;
      }
      const payload = await refreshAccount(cfg, ck, 'high');
      jsonRes(res, 200, payload || { ok: true, data: null });
      return;
    }

    // POST /api/order — 주문
    if (pathname === '/api/order' && req.method === 'POST') {
      const body = await parseBody(req);
      const isBuy  = body.side === 'buy';
      const trId   = cfg.txMode === 'vts'
        ? (isBuy ? 'VTTC0802U' : 'VTTC0801U')
        : (isBuy ? 'TTTC0802U' : 'TTTC0801U');
      const [cano, acntPrdtCd] = (cfg.accNo || '').split('-');
      const orderObj = {
        CANO: cano || '',
        ACNT_PRDT_CD: acntPrdtCd || '01',
        PDNO: body.code,
        ORD_DVSN: body.orderType || '00',
        ORD_QTY: String(body.qty),
        ORD_UNPR: String(body.price || 0)
      };
      // 큐를 통해 직렬화 + 초당 한도 거부 시 자동 재시도
      const result = await kisPost(cfg, '/uapi/domestic-stock/v1/trading/order-cash', trId, orderObj);
      console.log(`[주문] ${isBuy?'매수':'매도'} ${body.code} ${body.qty}주 → ${result.body?.rt_cd==='0'?'✅접수':'❌'+(result.body?.msg1||'실패')}`);
      jsonRes(res, 200, { ok: true, data: result.body });
      return;
    }

    // GET /api/orders — 당일 주문 내역
    if (pathname === '/api/orders') {
      const trId = cfg.txMode === 'vts' ? 'VTTC8001R' : 'TTTC8001R';
      const [cano, acntPrdtCd] = (cfg.accNo || '').split('-');
      const today = new Date().toISOString().slice(0,10).replace(/-/g,'');
      const result = await kisProxy(cfg, '/uapi/domestic-stock/v1/trading/inquire-daily-ccld', trId, {
        CANO: cano || '',
        ACNT_PRDT_CD: acntPrdtCd || '01',
        INQR_STRT_DT: today,
        INQR_END_DT: today,
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
      jsonRes(res, 200, { ok: true, data: result.body });
      return;
    }

    // GET /api/tick?code=005930 — 당일 체결 내역
    if (pathname === '/api/tick') {
      const code = query.code || '005930';
      const r = await withRetry(() =>
        kisProxy(cfg, '/uapi/domestic-stock/v1/quotations/inquire-ccnl', 'FHKST01010300', {
          FID_COND_MRKT_DIV_CODE: 'J', FID_INPUT_ISCD: code
        }, 'high')
      , `체결:${code}`);
      const tickRows = r.body?.output || [];
      if (tickRows.length) {
        fb.save('tick:' + code, r.body); // 마지막 체결 내역 보관 (재시작에도 유지)
        jsonRes(res, 200, { ok: true, data: r.body });
      } else {
        // 장전/장마감 — 빈 화면 대신 마지막 거래 내역 표시
        const last = fb.get('tick:' + code);
        jsonRes(res, 200, { ok: true, data: last || r.body, cached: !!last });
      }
      return;
    }

    // GET /api/cancel — 주문 취소
    if (pathname === '/api/cancel' && req.method === 'POST') {
      const body = await parseBody(req);
      const trId = cfg.txMode === 'vts' ? 'VTTC0803U' : 'TTTC0803U';
      const [cano, acntPrdtCd] = (cfg.accNo||'').split('-');
      const cancelObj = {
        CANO: cano||'', ACNT_PRDT_CD: acntPrdtCd||'01',
        KRX_FWDG_ORD_ORGNO: body.orgNo||'', ORGN_ODNO: body.ordNo||'',
        ORD_DVSN: '00', RVSE_CNCL_DVSN_CD: '02', // 02=취소
        ORD_QTY: body.qty||'0', ORD_UNPR: '0',   // 취소는 단가 0 필수 (누락 시 '주문 금액 확인' 거부)
        QTY_ALL_ORD_YN: body.qty?'N':'Y'
      };
      // 큐를 통해 직렬화 + 초당 한도 거부 시 자동 재시도
      const result = await kisPost(cfg, '/uapi/domestic-stock/v1/trading/order-rvsecncl', trId, cancelObj);
      console.log(`[주문취소] ${body.ordNo} → ${result.body?.rt_cd==='0'?'✅성공':'❌'+(result.body?.msg1||'')}`);
      jsonRes(res, 200, { ok: true, data: result.body });
      return;
    }

    // GET /api/news?code=005930 — 종목 뉴스
    if (pathname === '/api/news') {
      const code = query.code || '005930';
      const fallbackUrl = `https://finance.naver.com/item/news.naver?code=${code}`;
      // 1) KIS 뉴스 — 권한 없는 키가 대부분. 한 번 실패하면 6시간 동안 건너뛰어
      //    매번 10초 타임아웃을 낭비하지 않고 바로 구글 RSS로 간다.
      if (!global._kisNewsFailAt || Date.now() - global._kisNewsFailAt > 6*3600*1000) {
        try {
          const r = await kisProxy(cfg, '/uapi/domestic-stock/v1/quotations/news-title', 'FHKST01011800', {
              FID_NEWS_OFER_ENTP_CODE: '', FID_COND_MRKT_DIV_CODE: 'J',
              FID_INPUT_ISCD: code, FID_TITL_CNTT: '',
              FID_INPUT_DATE_1: '', FID_INPUT_HOUR_1: '',
              FID_RANK_SORT_CLS_CODE: '', FID_INPUT_SRNO: ''
            });
          const list = r.body?.output || [];
          if (list.length) {
            jsonRes(res, 200, { ok: true, source: 'kis', data: { output: list, rt_cd: '0' } });
            return;
          }
          global._kisNewsFailAt = Date.now(); // 빈 응답 = 권한 없음으로 간주
        } catch(e) { global._kisNewsFailAt = Date.now(); }
      }

      // 2) 키 불필요한 구글 뉴스 RSS에서 종목명으로 검색
      try {
        const name = codeToNameLookup(code);
        const q = encodeURIComponent(`${name} 주가`);
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
        while ((m = itemRe.exec(xml)) && items.length < 15) {
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
            title = title.slice(0, idx);  // 항상 제거 — source 태그 있어도 제목 끝 중복 방지
          }
          items.push({ title, link: pick('link'), source, date: pick('pubDate') });
        }
        if (items.length) {
          jsonRes(res, 200, { ok: true, source: 'google', data: { output: items, rt_cd: '0' }, fallbackUrl });
          return;
        }
      } catch(e) { /* RSS 실패 → 링크 폴백 */ }

      // 3) 둘 다 실패 → 네이버 금융 링크
      jsonRes(res, 200, { ok: true, data: { output: [], rt_cd: '1', noPermission: true }, fallbackUrl });
      return;
    }

    // GET /api/investor?code=005930 — 외국인·기관 수급
    if (pathname === '/api/investor') {
      const code = query.code || '005930';
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
      jsonRes(res, 200, { ok: true, data: r.body, frgnRate });
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
    console.error('[API Error]', pathname, e.message);
    jsonRes(res, 500, { ok: false, message: e.message });
  }
});

// ════════════════════════════════════════
// 서버 시작
// ════════════════════════════════════════
server.listen(PORT, () => {
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

process.on('uncaughtException', e => console.error('[Uncaught]', e.message));
// Phase 0+1 속도 개선 적용 (앱키별 큐 · 이중 스로틀 제거 · SWR · prefetch)
