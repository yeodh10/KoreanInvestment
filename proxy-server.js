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
const url   = require('url');

const PORT = 3000;
const CONFIG_FILE = path.join(__dirname, 'kis-config.json');
const STOCK_FILE = path.join(__dirname, 'stocks-data.json');

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

// ── 설정 로드 ──
function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    }
  } catch(e) {}
  return { appKey:'', appSecret:'', accNo:'', txMode:'vts', token:'', tokenExpiry:0 };
}

function saveConfig(cfg) {
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
async function kisProxy(cfg, kispath, trId, queryParams) {
  const token = await getKisToken(cfg);
  const host = cfg.txMode === 'vts' ? KIS_HOST_VTS : KIS_HOST_REAL;
  const [hostname, port] = host.split(':');

  const qs = new URLSearchParams(queryParams).toString();
  const fullPath = kispath + (qs ? '?' + qs : '');

  const res = await httpsRequest({
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
  return res;
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

const trader = new AutoTrader({
  loadConfig,
  getStockChart:   fetchChart,
  getCurrentPrice: fetchCurrentPrice,
  placeOrder:      executeOrder,
  getAccount:      fetchAccount,
  getVolTop:       fetchVolTop,
  codeToName:      codeToNameLookup,
  sendTelegram:    sendTelegram
});

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

  // ── 정적 파일 ──
  if (pathname === '/' || pathname === '/index.html') {
    serveStatic(res, path.join(__dirname, 'app.html')); return;
  }
  if (pathname.endsWith('.html') || pathname.endsWith('.js') || pathname.endsWith('.css')) {
    serveStatic(res, path.join(__dirname, pathname.slice(1))); return;
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
  if (pathname === '/api/config/status') {
    const cfg = loadConfig();
    jsonRes(res, 200, {
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
    jsonRes(res, 200, { ok: true, status: trader.getStatus() });
    return;
  }

  // GET /api/auto/logs — 매매 로그
  if (pathname === '/api/auto/logs') {
    jsonRes(res, 200, { ok: true, logs: getLogs().slice(0, 100) });
    return;
  }

  // POST /api/auto/start — 시작
  if (pathname === '/api/auto/start' && req.method === 'POST') {
    const cfg = loadConfig();
    if (!cfg.appKey) { jsonRes(res, 400, { ok:false, message:'KIS API 미설정 — 먼저 설정에서 연결하세요.' }); return; }
    trader.start();
    jsonRes(res, 200, { ok: true, status: trader.getStatus() });
    return;
  }

  // POST /api/auto/stop — 정지
  if (pathname === '/api/auto/stop' && req.method === 'POST') {
    trader.stop();
    jsonRes(res, 200, { ok: true, status: trader.getStatus() });
    return;
  }

  // POST /api/auto/settings — 설정 변경
  if (pathname === '/api/auto/settings' && req.method === 'POST') {
    const body = await parseBody(req);
    const status = trader.updateSettings(body);
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
        const [priceR, infoR] = await Promise.all([
          kisProxy(cfg, '/uapi/domestic-stock/v1/quotations/inquire-price', 'FHKST01010100', {
            FID_COND_MRKT_DIV_CODE: 'J', FID_INPUT_ISCD: code
          }),
          kisProxy(cfg, '/uapi/domestic-stock/v1/quotations/search-stock-info', 'CTPF1002R', {
            PRDT_TYPE_CD: '300', PDNO: code, PRDT_NAME: '', PRDT_NAME_SRCH_TP: '1',
            PDNO_OR_PRDT_NAME_SRCH_TP: '2', CTS: ''
          })
        ]);
        const p = priceR.body?.output || {};
        const i = (infoR.body?.output || [])[0] || {};
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
          hi52: parseInt(p.stck_mxpr||0),
          lo52: parseInt(p.stck_llam||0),
          rt_cd: priceR.body?.rt_cd
        }});
      } catch(e) {
        jsonRes(res, 500, { ok: false, message: e.message });
      }
      return;
    }

    // GET /api/volume100?market=J — 거래량 상위 100
    if (pathname === '/api/volume100') {
      const trId = cfg.txMode === 'vts' ? 'FHPST01710000' : 'FHPST01710000';
      const result = await kisProxy(cfg, '/uapi/domestic-stock/v1/ranking/volume', trId, {
        fid_cond_mrkt_div_code: 'J',
        fid_cond_scr_div_code: '20171',
        fid_input_iscd: '0000',
        fid_div_cls_code: '0',
        fid_blng_cls_code: '0',
        fid_trgt_cls_code: '111111111',
        fid_trgt_exls_cls_code: '000000',
        fid_input_price_1: '',
        fid_input_price_2: '',
        fid_vol_cnt: '',
        fid_input_date_1: ''
      });
      jsonRes(res, 200, { ok: true, data: result.body });
      return;
    }

    // GET /api/orderbook?code=005930 — 호가창
    if (pathname === '/api/orderbook') {
      const trId = 'FHKST01010200';
      const result = await kisProxy(cfg, '/uapi/domestic-stock/v1/quotations/inquire-asking-price-exp-ccn', trId, {
        FID_COND_MRKT_DIV_CODE: 'J',
        FID_INPUT_ISCD: query.code || '005930'
      });
      jsonRes(res, 200, { ok: true, data: result.body });
      return;
    }

    // GET /api/account — 계좌 잔고
    if (pathname === '/api/account') {
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
      jsonRes(res, 200, { ok: true, data: result.body });
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

    // POST /api/cancel — 주문 취소
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
      const r = await rateLimitedCall(() =>
        kisProxy(cfg, '/uapi/domestic-stock/v1/quotations/inquire-daily-itemchartprice', 'FHKST03010100', {})
      ).catch(()=>({body:{}}));
      // KIS 뉴스 API (실제 엔드포인트)
      try {
        const r2 = await rateLimitedCall(() =>
          kisProxy(cfg, '/uapi/domestic-stock/v1/news/inquire-news-title', 'YNAAPP00650000', {
            FID_NEWS_OFER_ENTP_CODE: '', FID_COND_MRKT_DIV_CODE: 'J',
            FID_INPUT_ISCD: code, FID_INPUT_DATE_1: '', FID_INPUT_DATE_2: ''
          })
        );
        jsonRes(res, 200, { ok: true, data: r2.body });
      } catch(e) {
        jsonRes(res, 200, { ok: true, data: { output: [], rt_cd:'1' } });
      }
      return;
    }

    // GET /api/investor?code=005930 — 외국인·기관 수급
    if (pathname === '/api/investor') {
      const code = query.code || '005930';
      const r = await withRetry(() => rateLimitedCall(() =>
        kisProxy(cfg, '/uapi/domestic-stock/v1/quotations/inquire-investor', 'FHKST01010900', {
          FID_COND_MRKT_DIV_CODE: 'J', FID_INPUT_ISCD: code
        })
      ), `수급:${code}`);
      jsonRes(res, 200, { ok: true, data: r.body });
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

    // GET /api/market — KOSPI/KOSDAQ 실시간 지수
    if (pathname === '/api/market') {
      const indices = [
        { code:'0001', name:'KOSPI',  trId:'FHPUP02100000' },
        { code:'1001', name:'KOSDAQ', trId:'FHPUP02100000' }
      ];
      const results = {};
      for (const idx of indices) {
        try {
          const r = await rateLimitedCall(() =>
            kisProxy(cfg, '/uapi/domestic-stock/v1/quotations/inquire-index-price', idx.trId, {
              FID_COND_MRKT_DIV_CODE: 'U', FID_INPUT_ISCD: idx.code
            })
          );
          results[idx.name] = r.body?.output || {};
        } catch(e) { results[idx.name] = {}; }
      }
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

  const cfg = loadConfig();
  if (cfg.appKey && cfg.appSecret) {
    console.log('✅ KIS API 설정 로드됨 (모드:', cfg.txMode === 'vts' ? '모의투자' : '실전투자', ')');
    // 서버 시작 시 토큰 자동 발급/검증 → 웹에서 재인증 불필요
    getKisToken(cfg)
      .then(() => {
        console.log('🔑 인증 토큰 준비 완료 — 웹에서 바로 사용 가능합니다.');
        // 이전에 자동매매가 켜져 있었으면 자동 재개
        if (trader.getStatus().enabled) {
          console.log('🤖 이전 자동매매 설정 감지 — 엔진 재개');
          trader.start();
        }
      })
      .catch(e => console.log('⚠️  토큰 발급 보류:', e.message, '(첫 API 호출 시 자동 재시도)'));
  } else {
    console.log('⚠️  KIS API 미설정 — 대시보드 설정 탭에서 App Key를 입력하세요. (최초 1회만)');
  }
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
