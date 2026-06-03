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
    if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

// ── KIS 토큰 발급 ──
async function getKisToken(cfg) {
  const now = Date.now();
  // 유효한 토큰이 있으면 무조건 재사용 (재인증 불필요)
  if (cfg.token && cfg.tokenExpiry > now + 60000) return cfg.token;

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
    cfg.tokenExpiry = now + (res.body.expires_in - 600) * 1000; // 10분 여유
    saveConfig(cfg);
    return cfg.token;
  }
  // 재발급 실패했지만 기존 토큰이 아직 안 죽었으면 그거라도 사용
  if (cfg.token && cfg.tokenExpiry > now) return cfg.token;
  throw new Error('토큰 발급 실패: ' + JSON.stringify(res.body));
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
// ── 전역 우선순위 큐: 모든 KIS 호출을 최소 간격으로 줄 세워 초당 한도(EGW00201) 방지 ──
// high = 사용자 동작(호가/체결/현재가) — 백그라운드 폴링을 새치기한다
const KIS_MIN_GAP_MS = 350;
let _kisLast = 0;
const _kisHigh = [], _kisLow = [];
let _kisPumping = false;
function kisSchedule(fn, priority) {
  return new Promise((resolve, reject) => {
    (priority === 'high' ? _kisHigh : _kisLow).push({ fn, resolve, reject });
    pumpKis();
  });
}
async function pumpKis() {
  if (_kisPumping) return;
  _kisPumping = true;
  try {
    while (_kisHigh.length || _kisLow.length) {
      const job = _kisHigh.length ? _kisHigh.shift() : _kisLow.shift();
      const wait = KIS_MIN_GAP_MS - (Date.now() - _kisLast);
      if (wait > 0) await new Promise(r => setTimeout(r, wait));
      _kisLast = Date.now();
      try { job.resolve(await job.fn()); }
      catch (e) { job.reject(e); }
    }
  } finally { _kisPumping = false; }
}

async function kisProxy(cfg, kispath, trId, queryParams, priority) {
  const host = cfg.txMode === 'vts' ? KIS_HOST_VTS : KIS_HOST_REAL;
  const [hostname, port] = host.split(':');
  const qs = new URLSearchParams(queryParams).toString();
  const fullPath = kispath + (qs ? '?' + qs : '');

  // 우선순위 큐로 간격 보장 + EGW00201(초당 한도 초과) 시 백오프 재시도
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await kisSchedule(async () => {
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
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await kisSchedule(async () => {
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

// ════════════════════════════════════════
// 자동매매 엔진용 재사용 헬퍼
// ════════════════════════════════════════

// ── Rate Limiter: KIS 모의투자는 초당 1회 제한 ──
let _lastApiCall = 0;
const API_MIN_INTERVAL_MS = 350; // 0.35초 간격 (안전하게)

async function rateLimitedCall(fn) {
  const now = Date.now();
  const wait = API_MIN_INTERVAL_MS - (now - _lastApiCall);
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  _lastApiCall = Date.now();
  return fn();
}

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
  return withRetry(() => rateLimitedCall(async () => {
    const r = await kisProxy(cfg, '/uapi/domestic-stock/v1/quotations/inquire-price', 'FHKST01010100', {
      FID_COND_MRKT_DIV_CODE: 'J', FID_INPUT_ISCD: code
    });
    return parseInt(r.body?.output?.stck_prpr || 0);
  }), `현재가:${code}`);
}

// 일봉 차트 (캐시 적용)
async function fetchChart(cfg, code, period) {
  const key = chartCacheKey(code, period || 'D');
  if (_chartCache[key]) return _chartCache[key]; // 캐시 히트

  const result = await withRetry(() => rateLimitedCall(async () => {
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
  }), `차트:${code}`);

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
  return withRetry(() => rateLimitedCall(async () => {
    const trId = cfg.txMode === 'vts' ? 'VTTC8434R' : 'TTTC8434R';
    const [cano, acntPrdtCd] = (cfg.accNo || '').split('-');
    const r = await kisProxy(cfg, '/uapi/domestic-stock/v1/trading/inquire-balance', trId, {
      CANO: cano||'', ACNT_PRDT_CD: acntPrdtCd||'01',
      AFHR_FLPR_YN:'N', OFL_YN:'', INQR_DVSN:'02', UNPR_DVSN:'01',
      FUND_STTL_ICLD_YN:'N', FNCG_AMT_AUTO_RDPT_YN:'N', PRCS_DVSN:'01',
      CTX_AREA_FK100:'', CTX_AREA_NK100:''
    });
    return r.body;
  }), '계좌잔고');
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
  const orderBody = JSON.stringify(orderObj);
  const host = cfg.txMode === 'vts' ? KIS_HOST_VTS : KIS_HOST_REAL;
  const [hostname, port] = host.split(':');
  const token = await getKisToken(cfg);
  const hashkey = await getHashkey(cfg, orderObj);
  const r = await httpsRequest({
    hostname, port: parseInt(port),
    path: '/uapi/domestic-stock/v1/trading/order-cash', method: 'POST',
    headers: {
      'Content-Type':'application/json', 'Content-Length':Buffer.byteLength(orderBody),
      'authorization':'Bearer '+token, 'appkey':cfg.appKey, 'appsecret':cfg.appSecret,
      'tr_id':trId, 'custtype':'P', 'hashkey':hashkey
    }
  }, orderBody);
  return r.body;
}

// 코드→이름
function codeToNameLookup(code) {
  const master = loadStockMaster();
  return master.codeToName?.[code] || code;
}

// ── 엔진 초기화 ──
const { AutoTrader, getLogs } = require('./auto-trader.js');
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
  return withRetry(() => rateLimitedCall(async () => {
    const r = await kisProxy(cfg, '/uapi/domestic-stock/v1/ranking/volume', 'FHPST01710000', {
      fid_cond_mrkt_div_code: 'J', fid_cond_scr_div_code: '20171',
      fid_input_iscd: '0000', fid_div_cls_code: '0', fid_blng_cls_code: '0',
      fid_trgt_cls_code: '111111111', fid_trgt_exls_cls_code: '000000',
      fid_input_price_1: '', fid_input_price_2: '', fid_vol_cnt: '', fid_input_date_1: ''
    });
    return r.body;
  }), '거래량상위');
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

  // ── KIS API 프록시 ──
  const cfg = loadConfig();
  if (!cfg.appKey || !cfg.appSecret) {
    jsonRes(res, 503, { ok: false, message: 'KIS API 미설정. /api/config 로 설정하세요.', simulation: true });
    return;
  }

  try {
    // GET /api/prices?codes=005930,000660 — 여러 종목 현재가 배치
    if (pathname === '/api/prices') {
      const codes = (query.codes || '').split(',').filter(Boolean).slice(0, 30);
      if (!global._priceCache) global._priceCache = {};
      const now = Date.now();
      const TTL = 5000; // 5초 시세 캐시 — 잦은 갱신은 KIS 안 치고 즉시 응답
      const out = {};
      for (const code of codes) {
        const cached = global._priceCache[code];
        if (cached && now - cached.t < TTL) { out[code] = cached.data; continue; } // 캐시 적중
        try {
          // kisProxy 자체가 직렬 큐로 간격을 보장하므로 rateLimitedCall 이중 적용 제거(속도↑)
          const r = await withRetry(() =>
            kisProxy(cfg, '/uapi/domestic-stock/v1/quotations/inquire-price', 'FHKST01010100', {
              FID_COND_MRKT_DIV_CODE: 'J', FID_INPUT_ISCD: code
            }), `현재가:${code}`);
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
                FID_COND_MRKT_DIV_CODE: 'J', FID_INPUT_ISCD: code,
                FID_PERIOD_DIV_CODE: 'D', FID_ORG_ADJ_PRC: '0'
              });
              const days = dr.body?.output || [];
              if (days.length) {
                prev = parseInt(days[0].stck_clpr || 0);
                cur = 0;
              }
            } catch(e2) {}
          }
          const data = {
            price: cur,
            chgPct: parseFloat(o.prdy_ctrt || 0),
            sign: o.prdy_vrss_sign || '3',
            prev: prev || cur
          };
          out[code] = data;
          if (data.price > 0 || data.prev > 0) global._priceCache[code] = { t: Date.now(), data }; // 유효할 때만 캐시
        } catch(e) { out[code] = global._priceCache[code]?.data || null; } // 실패 시 직전 캐시 사용(빈칸 방지)
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

        const result = await rateLimitedCall(() =>
          kisProxy(cfg, '/uapi/domestic-stock/v1/quotations/inquire-daily-itemchartprice', trId, {
            FID_COND_MRKT_DIV_CODE: market,
            FID_INPUT_ISCD: code,
            FID_INPUT_DATE_1: startStr,
            FID_INPUT_DATE_2: endStr,
            FID_PERIOD_DIV_CODE: kisPeriod,
            FID_ORG_ADJ_PRC: '0'
          })
        );

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

      let output1 = null;
      const allCandles = []; // 최종 분봉 목록 (과거→현재)

      // ── 1) 과거 일봉 데이터 받아서 분봉으로 변환 ──
      if (days > 1) {
        const today = new Date();
        const toDate = today.toISOString().slice(0,10).replace(/-/g,'');
        const fromDate = new Date(today - days*24*60*60*1000).toISOString().slice(0,10).replace(/-/g,'');
        const dayResult = await rateLimitedCall(() =>
          kisProxy(cfg, '/uapi/domestic-stock/v1/quotations/inquire-daily-itemchartprice', 'FHKST03010100', {
            FID_COND_MRKT_DIV_CODE: market, FID_INPUT_ISCD: code,
            FID_INPUT_DATE_1: fromDate, FID_INPUT_DATE_2: toDate,
            FID_PERIOD_DIV_CODE: 'D', FID_ORG_ADJ_PRC: '0'
          })
        );
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
      const times = ['153000','150000','143000','140000','133000','130000',
                     '123000','120000','113000','110000','103000','100000','093000','090000'];

      for (const hhmmss of times) {
        try {
          const r = await rateLimitedCall(() =>
            kisProxy(cfg, '/uapi/domestic-stock/v1/quotations/inquire-time-itemchartprice', 'FHKST03010200', {
              FID_ETC_CLS_CODE: '', FID_COND_MRKT_DIV_CODE: market,
              FID_INPUT_ISCD: code, FID_INPUT_HOUR_1: hhmmss, FID_PW_DATA_INCU_YN: 'N'
            })
          );
          if (!output1 && r.body?.output1) output1 = r.body.output1;
          const rows = r.body?.output2 || [];
          todayCandles.push(...rows);
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

      jsonRes(res, 200, {
        ok: true,
        data: { output1, output2: allCandles, rt_cd:'0', count: allCandles.length, isMinute: true }
      });
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
        let infoR = null;
        try {
          infoR = await kisProxy(cfg, '/uapi/domestic-stock/v1/quotations/search-stock-info', 'CTPF1002R', {
            PRDT_TYPE_CD: '300', PDNO: code, PRDT_NAME: '', PRDT_NAME_SRCH_TP: '1',
            PDNO_OR_PRDT_NAME_SRCH_TP: '2', CTS: ''
          }, 'high');
        } catch(_) { /* 종목상세 실패는 무시 (이름 폴백만 잃음) */ }
        const p = priceR.body?.output || {};
        const i = (infoR?.body?.output || [])[0] || {};
        jsonRes(res, 200, { ok: true, data: {
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
        }});
      } catch(e) {
        jsonRes(res, 500, { ok: false, message: e.message });
      }
      return;
    }

    // GET /api/volume100?market=J — 거래량 상위 100
    if (pathname === '/api/volume100') {
      // 90초 캐시
      if (!global._volCache) global._volCache = { data: null, ts: 0 };
      if (global._volCache.data && Date.now() - global._volCache.ts < 90000) {
        jsonRes(res, 200, { ok: true, ...global._volCache.data, cached: true });
        return;
      }
      // 1) 실전 도메인 순위 API 시도 (실전 키가 있으면 진짜 TOP)
      try {
        const result = await kisProxyReal(cfg, '/uapi/domestic-stock/v1/ranking/volume', 'FHPST01710000', {
          fid_cond_mrkt_div_code: 'J', fid_cond_scr_div_code: '20171', fid_input_iscd: '0000',
          fid_div_cls_code: '0', fid_blng_cls_code: '0', fid_trgt_cls_code: '111111111',
          fid_trgt_exls_cls_code: '000000', fid_input_price_1: '', fid_input_price_2: '',
          fid_vol_cnt: '', fid_input_date_1: ''
        }, 'high');
        const out = result.body?.output || [];
        if (out.length) {
          global._volCache = { data: { data: result.body }, ts: Date.now() };
          jsonRes(res, 200, { ok: true, data: result.body });
          return;
        }
      } catch (e) { /* 실전 도메인 불가 → 아래 폴백 */ }

      // 2) 폴백: 모의 키로도 되는 개별 시세 조회 → 주요 종목 거래량 정렬
      const VOL_CODES = ['005930','000660','373220','207940','005380','000270','035420','035720','068270','005490','051910','006400','105560','066570'];
      const rows = [];
      for (const code of VOL_CODES) {
        try {
          const pr = await kisProxy(cfg, '/uapi/domestic-stock/v1/quotations/inquire-price', 'FHKST01010100',
            { FID_COND_MRKT_DIV_CODE: 'J', FID_INPUT_ISCD: code }, 'low');
          const o = pr.body?.output;
          if (o && parseInt(o.stck_prpr || 0) > 0) {
            rows.push({
              stck_shrn_iscd: code, hts_kor_isnm: o.hts_kor_isnm || code,
              stck_prpr: o.stck_prpr, prdy_ctrt: o.prdy_ctrt,
              acml_vol: o.acml_vol, acml_tr_pbmn: o.acml_tr_pbmn
            });
          }
        } catch (e) { /* 개별 실패는 건너뜀 */ }
      }
      rows.sort((a, b) => parseInt(b.acml_vol || 0) - parseInt(a.acml_vol || 0));
      const payload = { data: { output: rows }, fallback: 'curated' };
      global._volCache = { data: payload, ts: Date.now() };
      jsonRes(res, 200, { ok: true, ...payload });
      return;
    }

    // GET /api/orderbook?code=005930 — 호가창
    if (pathname === '/api/orderbook') {
      const trId = 'FHKST01010200';
      const result = await kisProxy(cfg, '/uapi/domestic-stock/v1/quotations/inquire-asking-price-exp-ccn', trId, {
        FID_COND_MRKT_DIV_CODE: 'J',
        FID_INPUT_ISCD: query.code || '005930'
      }, 'high');
      jsonRes(res, 200, { ok: true, data: result.body });
      return;
    }

    // GET /api/account — 계좌 잔고 (2초 캐시 — 잦은 갱신에도 즉시 응답, 유저별 분리)
    if (pathname === '/api/account') {
      if (!global._acctCache) global._acctCache = {};
      const ck = session.userId || 'default';
      const cached = global._acctCache[ck];
      if (cached && Date.now() - cached.t < 2000) { jsonRes(res, 200, cached.data); return; }
      const trId = cfg.txMode === 'vts' ? 'VTTC8434R' : 'TTTC8434R';
      const [cano, acntPrdtCd] = (cfg.accNo || '').split('-');
      const result = await kisProxy(cfg, '/uapi/domestic-stock/v1/trading/inquire-balance', trId, {
        CANO: cano || '',
        ACNT_PRDT_CD: acntPrdtCd || '01',
        AFHR_FLPR_YN: 'N',
        OFL_YN: '',
        INQR_DVSN: '02',
        UNPR_DVSN: '01',
        FUND_STTL_ICLD_YN: 'N',
        FNCG_AMT_AUTO_RDPT_YN: 'N',
        PRCS_DVSN: '01',
        CTX_AREA_FK100: '',
        CTX_AREA_NK100: ''
      });
      const payload = { ok: true, data: result.body };
      // 성공 응답만 캐시 (EGW00201 등 에러는 캐시하지 않고 다음 호출에서 재시도)
      if (result.body && result.body.rt_cd === '0') global._acctCache[ck] = { t: Date.now(), data: payload };
      jsonRes(res, 200, payload);
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
      const orderBody = JSON.stringify(orderObj);
      const host = cfg.txMode === 'vts' ? KIS_HOST_VTS : KIS_HOST_REAL;
      const [hostname, port] = host.split(':');
      const token = await getKisToken(cfg);
      const hashkey = await getHashkey(cfg, orderObj);
      const result = await httpsRequest({
        hostname, port: parseInt(port),
        path: '/uapi/domestic-stock/v1/trading/order-cash',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(orderBody),
          'authorization': 'Bearer ' + token,
          'appkey': cfg.appKey,
          'appsecret': cfg.appSecret,
          'tr_id': trId,
          'custtype': 'P',
          'hashkey': hashkey
        }
      }, orderBody);
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
      });
      jsonRes(res, 200, { ok: true, data: result.body });
      return;
    }

    // GET /api/tick?code=005930 — 당일 체결 내역
    if (pathname === '/api/tick') {
      const code = query.code || '005930';
      const r = await withRetry(() => rateLimitedCall(() =>
        kisProxy(cfg, '/uapi/domestic-stock/v1/quotations/inquire-ccnl', 'FHKST01010300', {
          FID_COND_MRKT_DIV_CODE: 'J', FID_INPUT_ISCD: code
        }, 'high')
      ), `체결:${code}`);
      jsonRes(res, 200, { ok: true, data: r.body });
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
        ORD_QTY: body.qty||'0', QTY_ALL_ORD_YN: body.qty?'N':'Y'
      };
      const cancelBody = JSON.stringify(cancelObj);
      const host = cfg.txMode==='vts'?KIS_HOST_VTS:KIS_HOST_REAL;
      const [hostname,port] = host.split(':');
      const token = await getKisToken(cfg);
      const hashkey = await getHashkey(cfg, cancelObj);
      const result = await httpsRequest({
        hostname,port:parseInt(port),
        path:'/uapi/domestic-stock/v1/trading/order-rvsecncl',
        method:'POST',
        headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(cancelBody),
          'authorization':'Bearer '+token,'appkey':cfg.appKey,'appsecret':cfg.appSecret,
          'tr_id':trId,'custtype':'P','hashkey':hashkey}
      }, cancelBody);
      console.log(`[주문취소] ${body.ordNo} → ${result.body?.rt_cd==='0'?'✅성공':'❌'+(result.body?.msg1||'')}`);
      jsonRes(res, 200, { ok: true, data: result.body });
      return;
    }

    // GET /api/news?code=005930 — 종목 뉴스
    if (pathname === '/api/news') {
      const code = query.code || '005930';
      const fallbackUrl = `https://finance.naver.com/item/news.naver?code=${code}`;
      // 1) KIS 뉴스 (권한 있을 때만 데이터가 옴)
      try {
        const r = await rateLimitedCall(() =>
          kisProxy(cfg, '/uapi/domestic-stock/v1/quotations/news-title', 'FHKST01011800', {
            FID_NEWS_OFER_ENTP_CODE: '', FID_COND_MRKT_DIV_CODE: 'J',
            FID_INPUT_ISCD: code, FID_TITL_CNTT: '',
            FID_INPUT_DATE_1: '', FID_INPUT_HOUR_1: '',
            FID_RANK_SORT_CLS_CODE: '', FID_INPUT_SRNO: ''
          })
        );
        const list = r.body?.output || [];
        if (list.length) {
          jsonRes(res, 200, { ok: true, source: 'kis', data: { output: list, rt_cd: '0' } });
          return;
        }
      } catch(e) { /* KIS 뉴스 실패 → 구글 뉴스로 폴백 */ }

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
      const r = await withRetry(() => rateLimitedCall(() =>
        kisProxy(cfg, '/uapi/domestic-stock/v1/finance/income-statement', 'FHKST66430200', {
          FID_DIV_CLS_CODE: '1', fid_cond_mrkt_div_code: 'J', fid_input_iscd: code
        })
      ), `재무:${code}`);
      jsonRes(res, 200, { ok: true, data: r.body });
      return;
    }

    // GET /api/market — KOSPI/KOSDAQ 지수 + 환율 (30초 캐시)
    if (pathname === '/api/market') {
      if (!global._marketCache) global._marketCache = { data:null, ts:0 };
      // 30초 캐시 (rate limit 절약)
      if (global._marketCache.data && Date.now() - global._marketCache.ts < 30000) {
        jsonRes(res, 200, { ok: true, data: global._marketCache.data, cached: true });
        return;
      }
      const results = {};
      const indices = [
        { code:'0001', name:'KOSPI' },
        { code:'1001', name:'KOSDAQ' }
      ];
      for (const idx of indices) {
        try {
          const r = await rateLimitedCall(() =>
            kisProxy(cfg, '/uapi/domestic-stock/v1/quotations/inquire-index-price', 'FHPUP02100000', {
              FID_COND_MRKT_DIV_CODE: 'U', FID_INPUT_ISCD: idx.code
            })
          );
          if (r.body?.output) results[idx.name] = r.body.output;
        } catch(e) { /* 캐시된 이전 값 유지 */ }
      }
      // 환율 (USD/KRW) — 해외주식 현재가 API로 달러원 환율 조회
      try {
        const fx = await rateLimitedCall(() =>
          kisProxy(cfg, '/uapi/domestic-stock/v1/quotations/inquire-price', 'FHKST01010100', {
            FID_COND_MRKT_DIV_CODE: 'X', FID_INPUT_ISCD: 'FX@KRW'
          })
        );
        if (fx.body?.output?.stck_prpr) results.USDKRW = { rate: fx.body.output.stck_prpr };
      } catch(e) {}
      // 이전 캐시값으로 빈 항목 보완
      if (global._marketCache.data) {
        for (const k of ['KOSPI','KOSDAQ','USDKRW']) {
          if (!results[k] && global._marketCache.data[k]) results[k] = global._marketCache.data[k];
        }
      }
      global._marketCache = { data: results, ts: Date.now() };
      jsonRes(res, 200, { ok: true, data: results });
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
