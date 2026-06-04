/**
 * AutoTrade KR — 자동매매 엔진 (auto-trader.js)
 * 프록시 서버 안에서 돌아가는 매매 두뇌
 *
 * 전략: 골든크로스(MA 교차) + RSI 과매도/과매수
 * 안전장치: 1회/종목당 매수한도, 하루 손실한도 자동정지, 손절·익절 자동실행
 */

const fs = require('fs');
const path = require('path');

const STATE_FILE = path.join(__dirname, 'autotrade-state.json');
const LOG_FILE   = path.join(__dirname, 'autotrade-log.json');
const ORDER_COOLDOWN_MS = 5 * 60 * 1000; // 같은 종목 재주문 금지 시간 (중복 주문 방지, 계좌 갱신 주기와 정렬)

// ── 기본 설정값 (화면에서 덮어쓸 수 있음) ──
const DEFAULT_SETTINGS = {
  enabled: false,              // 자동매매 on/off
  strategies: {
    goldenCross: true,         // 골든크로스 사용
    rsi: true                  // RSI 사용
  },
  params: {
    maShort: 5,                // 단기 이동평균
    maLong: 20,                // 장기 이동평균
    rsiPeriod: 14,             // RSI 기간
    rsiOversold: 30,           // 과매도 (이하면 매수 후보)
    rsiOverbought: 70          // 과매수 (이상이면 매도 후보)
  },
  safety: {
    maxPerOrder: 1000000,      // 1회 최대 매수금액 (원)
    maxPerStock: 5000000,      // 종목당 최대 보유금액 (원)
    dailyLossLimit: -300000,   // 하루 손실 한도 (원, 음수). 도달 시 자동 정지
    takeProfitPct: 5,          // 익절 목표 (%)
    stopLossPct: -3,           // 손절 기준 (%)
    tradeStartTime: '09:05',   // 매수 시작 시간
    tradeEndTime: '15:00',     // 신규 매수 종료 시간 (매도는 15:20까지)
    avoidFirst30min: true      // 장 시작 30분 신규매수 금지
  },
  // 자동매매 대상 종목 — KOSPI 시총 상위 우량주 30 (반도체·2차전지·바이오·자동차·금융·통신·소재 분산)
  watchList: [
    '005930','000660','373220','207940','005380', // 삼성전자 SK하이닉스 LG엔솔 삼성바이오 현대차
    '000270','068270','005490','035420','035720', // 기아 셀트리온 POSCO홀딩스 NAVER 카카오
    '051910','006400','105560','055550','086790', // LG화학 삼성SDI KB금융 신한지주 하나금융
    '316140','032830','015760','034730','003550', // 우리금융 삼성생명 한국전력 SK LG
    '017670','030200','012330','009150','066570', // SKT KT 현대모비스 삼성전기 LG전자
    '096770','028260','010130','011200','024110'  // SK이노베이션 삼성물산 고려아연 HMM 기업은행
  ],
  intervalSec: 30              // 시세 점검 주기 (초)
};

// ── 유저별 파일 경로 ──
function stateFileFor(userId) {
  return userId && userId !== '_global'
    ? path.join(__dirname, 'user-configs', `autotrade-state-${userId}.json`)
    : STATE_FILE;
}
function logFileFor(userId) {
  return userId && userId !== '_global'
    ? path.join(__dirname, 'user-configs', `autotrade-log-${userId}.json`)
    : LOG_FILE;
}

// ── 비동기 디바운스 파일 쓰기 ──
// 동기 쓰기(writeFileSync)는 파일 잠금(백업·동기화 프로그램 등)에 걸리면
// Node 전체가 멈춘다 → 비동기 + 0.8초 디바운스로 절대 블로킹되지 않게.
const _writeTimers = {};
function writeSoon(file, dataFn) {
  if (_writeTimers[file]) return;
  _writeTimers[file] = setTimeout(() => {
    delete _writeTimers[file];
    try { fs.promises.writeFile(file, dataFn()).catch(() => {}); } catch (e) {}
  }, 800);
}

// ── 상태 로드/저장 ──
function loadState(userId) {
  const file = stateFileFor(userId);
  try {
    if (fs.existsSync(file)) {
      const s = JSON.parse(fs.readFileSync(file, 'utf8'));
      // 마이그레이션: 구버전 기본값(3종목)으로 저장된 watchList는 우량주 30으로 확장
      if (Array.isArray(s.settings?.watchList) && s.settings.watchList.length <= 3) delete s.settings.watchList;
      return {
        settings: { ...DEFAULT_SETTINGS, ...(s.settings||{}),
          strategies: { ...DEFAULT_SETTINGS.strategies, ...(s.settings?.strategies||{}) },
          params: { ...DEFAULT_SETTINGS.params, ...(s.settings?.params||{}) },
          safety: { ...DEFAULT_SETTINGS.safety, ...(s.settings?.safety||{}) }
        },
        today: s.today || todayKey(),
        dailyRealizedPnl: s.dailyRealizedPnl || 0,
        stoppedByLoss: s.stoppedByLoss || false,
        positions: s.positions || {}
      };
    }
  } catch(e) {}
  return {
    settings: JSON.parse(JSON.stringify(DEFAULT_SETTINGS)),
    today: todayKey(),
    dailyRealizedPnl: 0,
    stoppedByLoss: false,
    positions: {}
  };
}

function saveState(state, userId) {
  writeSoon(stateFileFor(userId), () => JSON.stringify(state, null, 2)); // 비동기 — 블로킹 없음
}

function todayKey() {
  return kstParts().dateKey; // 한국시간 기준 거래일
}

// ── 로그 (전역 — 하위호환용) ──
let _logs = [];
function loadLogs() {
  try { if (fs.existsSync(LOG_FILE)) _logs = JSON.parse(fs.readFileSync(LOG_FILE,'utf8')); } catch(e){ _logs=[]; }
  return _logs;
}
function addLog(type, message, meta) {
  const entry = { time: new Date().toISOString(), type, message, meta: meta||null };
  _logs.unshift(entry);
  if (_logs.length > 500) _logs = _logs.slice(0, 500);
  const t = new Date().toLocaleTimeString('ko-KR');
  console.log(`[자동매매 ${t}] ${message}`);
  writeSoon(LOG_FILE, () => JSON.stringify(_logs)); // 비동기 — 블로킹 없음
  return entry;
}
function getLogs() { return _logs; }

// ════════════════════════════════════════
// 기술적 지표 계산
// ════════════════════════════════════════

// 단순이동평균 (마지막 값)
function sma(closes, period) {
  if (closes.length < period) return null;
  const slice = closes.slice(-period);
  return slice.reduce((a,b)=>a+b,0) / period;
}

// RSI (직전 N일 단순평균 방식, Cutler RSI — Wilder 평활 아님)
function calcRSI(closes, period) {
  if (closes.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i-1];
    if (diff >= 0) gains += diff; else losses -= diff;
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgGain === 0 && avgLoss === 0) return 50; // 무변동(거래정지 등) = 중립 — RSI 100 오판으로 인한 불필요 매도 방지
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

// ════════════════════════════════════════
// 매매 신호 판단
// closes: 과거→현재 순서의 종가 배열
// 반환: 'BUY' | 'SELL' | null  + 사유
// ════════════════════════════════════════
function decideSignal(closes, settings) {
  const { strategies, params } = settings;
  const signals = [];

  // ── 골든크로스 / 데드크로스 ──
  if (strategies.goldenCross && closes.length >= params.maLong + 1) {
    const shortNow  = sma(closes, params.maShort);
    const longNow   = sma(closes, params.maLong);
    const prevCloses = closes.slice(0, -1);
    const shortPrev = sma(prevCloses, params.maShort);
    const longPrev  = sma(prevCloses, params.maLong);
    if (shortPrev && longPrev && shortNow && longNow) {
      // 골든크로스: 단기선이 장기선을 아래→위로 돌파
      if (shortPrev <= longPrev && shortNow > longNow) {
        signals.push({ side:'BUY', reason:`골든크로스 (${params.maShort}MA가 ${params.maLong}MA 상향돌파)` });
      }
      // 데드크로스: 단기선이 장기선을 위→아래로 이탈
      if (shortPrev >= longPrev && shortNow < longNow) {
        signals.push({ side:'SELL', reason:`데드크로스 (${params.maShort}MA가 ${params.maLong}MA 하향이탈)` });
      }
    }
  }

  // ── RSI ──
  if (strategies.rsi) {
    const rsi = calcRSI(closes, params.rsiPeriod);
    if (rsi !== null) {
      if (rsi <= params.rsiOversold) {
        signals.push({ side:'BUY', reason:`RSI 과매도 (${rsi.toFixed(1)} ≤ ${params.rsiOversold})` });
      }
      if (rsi >= params.rsiOverbought) {
        signals.push({ side:'SELL', reason:`RSI 과매수 (${rsi.toFixed(1)} ≥ ${params.rsiOverbought})` });
      }
    }
  }

  if (!signals.length) return null;
  // 매도 신호가 하나라도 있으면 매도 우선 (리스크 회피)
  const sell = signals.find(s => s.side === 'SELL');
  if (sell) return sell;
  return signals.find(s => s.side === 'BUY');
}

// ════════════════════════════════════════
// 시간 체크
// ════════════════════════════════════════
// 한국시간(KST, UTC+9) — 서버 타임존과 무관하게 정확
// epoch에 9시간을 더한 뒤 UTC 필드로 읽으면 그 값이 곧 KST 값이다.
function kstParts() {
  const d = new Date(Date.now() + 9*60*60*1000);
  return {
    day: d.getUTCDay(),
    min: d.getUTCHours()*60 + d.getUTCMinutes(),
    dateKey: d.toISOString().slice(0,10)
  };
}
// KRX 휴장일 (주말 외) — 매년 갱신 필요. 누락 시 KIS가 주문을 거부하므로 2차 방어는 됨.
const KRX_HOLIDAYS = new Set([
  // 2026년
  '2026-01-01',                            // 신정
  '2026-02-16','2026-02-17','2026-02-18',  // 설 연휴
  '2026-03-02',                            // 삼일절 대체
  '2026-05-05',                            // 어린이날
  '2026-05-25',                            // 부처님오신날 대체
  '2026-08-17',                            // 광복절 대체
  '2026-09-24','2026-09-25',               // 추석 연휴
  '2026-09-28',                            // 추석 대체
  '2026-10-05',                            // 개천절 대체
  '2026-10-09',                            // 한글날
  '2026-12-25',                            // 성탄절
  '2026-12-31'                             // 연말 휴장
]);
function isMarketOpen() {
  const k = kstParts();
  if (k.day === 0 || k.day === 6) return false;
  if (KRX_HOLIDAYS.has(k.dateKey)) return false; // 공휴일 — 헛스캔·휴장일 주문 방지
  return k.min >= 9*60 && k.min <= 15*60+30;
}
function timeToMin(hhmm) {
  const [h,m] = hhmm.split(':').map(Number);
  return h*60 + m;
}
function nowMin() {
  return kstParts().min; // KST 기준
}

// ════════════════════════════════════════
// 자동매매 엔진 메인 루프
// deps = { loadConfig, getStockChart, getCurrentPrice, placeOrder, getAccount }
// ════════════════════════════════════════
class AutoTrader {
  constructor(deps) {
    this.deps = deps;
    this.userId = deps.userId || '_global';
    this.state = loadState(this.userId);
    this.timer = null;
    this.running = false;
    this.scanList = [];
    this.scanListUpdated = 0;
    this.tickCount = 0;
    this._ticking = false;     // 틱 재진입(겹침) 방지 플래그
    this.lastAction = {};      // 종목별 마지막 주문 시각 (재주문 쿨다운)
    // 인스턴스별 로그 (유저별 파일)
    this._logs = [];
    this._logFile = logFileFor(this.userId);
    try { if (fs.existsSync(this._logFile)) this._logs = JSON.parse(fs.readFileSync(this._logFile,'utf8')); } catch(e){ this._logs=[]; }
  }

  // 인스턴스 로그 (유저별)
  log(type, message, meta) {
    const entry = { time: new Date().toISOString(), type, message, meta: meta||null };
    this._logs.unshift(entry);
    if (this._logs.length > 500) this._logs = this._logs.slice(0, 500);
    console.log(`[자동매매:${this.userId} ${new Date().toLocaleTimeString('ko-KR')}] ${message}`);
    writeSoon(this._logFile, () => JSON.stringify(this._logs)); // 비동기 — 블로킹 없음
    return entry;
  }
  getLogs() { return this._logs; }
  save() { saveState(this.state, this.userId); }

  // 같은 종목 재주문 쿨다운 — 중복 주문 방지
  inCooldown(code) {
    return Date.now() - (this.lastAction[code] || 0) < ORDER_COOLDOWN_MS;
  }

  getStatus() {
    return {
      enabled: this.state.settings.enabled,
      running: this.running,
      stoppedByLoss: this.state.stoppedByLoss,
      dailyRealizedPnl: this.state.dailyRealizedPnl,
      settings: this.state.settings,
      marketOpen: isMarketOpen(),
      scanListSize: this.scanList.length
    };
  }

  updateSettings(newSettings) {
    this.state.settings = {
      ...this.state.settings,
      ...newSettings,
      strategies: { ...this.state.settings.strategies, ...(newSettings.strategies||{}) },
      params: { ...this.state.settings.params, ...(newSettings.params||{}) },
      safety: { ...this.state.settings.safety, ...(newSettings.safety||{}) }
    };
    this.save();
    this.log('config', '설정이 업데이트되었습니다.');
    if (this.state.settings.enabled && !this.running) this.start();
    if (!this.state.settings.enabled && this.running) this.stop();
    return this.getStatus();
  }

  start() {
    if (this.running) return;
    this.state.settings.enabled = true;
    this.state.stoppedByLoss = false;
    this.save();
    this.running = true;
    this.tickCount = 0;
    // 스캔 목록 크기에 따라 최소 간격 자동 조정
    // 종목당 최소 0.4초 × 예상 50종목 = 20초. 안전하게 최소 60초.
    const minInterval = 60;
    const interval = Math.max(minInterval, this.state.settings.intervalSec);
    this.log('system', `🟢 자동매매 시작 (점검주기 ${interval}초, 거래량상위+관심종목 스캔)`);
    this.tick();
    this.timer = setInterval(() => this.tick(), interval * 1000);
  }

  stop() {
    this.running = false;
    this.state.settings.enabled = false;
    this.save();
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    this.log('system', '🔴 자동매매 정지');
  }

  checkDayReset() {
    const tk = todayKey();
    if (this.state.today !== tk) {
      this.state.today = tk;
      this.state.dailyRealizedPnl = 0;
      this.state.stoppedByLoss = false;
      this.log('system', '📅 새로운 거래일 — 일일 손익/정지 상태 초기화');
      this.save();
    }
  }

  // ── 스캔 목록 갱신: 거래량 상위 + watchList (10분마다) ──
  async updateScanList(cfg) {
    const now = Date.now();
    if (now - this.scanListUpdated < 10*60*1000 && this.scanList.length > 0) return;
    try {
      const r = await this.deps.getVolTop(cfg);
      const topCodes = (r?.output||[]).slice(0,50).map(d=>d.stck_shrn_iscd).filter(Boolean);
      const watchCodes = this.state.settings.watchList || [];
      // 합치고 중복 제거
      const merged = [...new Set([...watchCodes, ...topCodes])];
      this.scanList = merged;
      this.scanListUpdated = now;
      this.log('system', `🔍 스캔 목록 갱신: ${merged.length}종목 (거래량상위 ${topCodes.length}개 + 관심 ${watchCodes.length}개)`);
    } catch(e) {
      // 실패 시 watchList만 사용
      this.scanList = this.state.settings.watchList || [];
      this.log('system', `🔍 거래량 상위 조회 실패, watchList ${this.scanList.length}종목으로 진행`);
    }
  }

  async tick() {
    if (this._ticking) return; // 이전 틱이 아직 실행 중 — 겹침(중복 주문) 방지
    this._ticking = true;
    try {
      this.checkDayReset();
      this.tickCount++;
      const s = this.state.settings;

      if (!s.enabled) return;
      if (!isMarketOpen()) return;

      if (this.state.stoppedByLoss) return;
      if (this.state.dailyRealizedPnl <= s.safety.dailyLossLimit) {
        this.state.stoppedByLoss = true;
        this.save();
        this.log('safety', `🛑 하루 손실 한도 도달 (${this.state.dailyRealizedPnl.toLocaleString()}원 ≤ ${s.safety.dailyLossLimit.toLocaleString()}원). 오늘 자동매매 중지.`);
        return;
      }

      const cfg = this.deps.loadConfig();
      if (!cfg.appKey) return;

      // 10분마다 스캔 목록 갱신
      await this.updateScanList(cfg);

      // 계좌 잔고 (5틱마다 갱신, API 절약)
      let heldPositions = {};
      if (this.tickCount % 5 === 1) {
        const account = await this.deps.getAccount(cfg);
        if (account?.output1) {
          account.output1.forEach(p => {
            const qty = parseInt(p.hldg_qty||0);
            if (qty > 0) heldPositions[p.pdno] = {
              qty, avgPrice: parseInt(p.pchs_avg_pric||0),
              curPrice: parseInt(p.prpr||0),
              pnlPct: parseFloat(p.evlu_pfls_rt||0),
              evalAmt: parseInt(p.evlu_amt||0)
            };
          });
          this._lastHeld = heldPositions;
        }
      }
      heldPositions = this._lastHeld || {};

      // 미체결 주문 맵 — 잔고 캐시(5틱)와 실제 사이의 공백을 메움
      // (미체결 매도 종목 재매도 = 공매도성 사고, 미체결 매수 누락 = 한도 초과 매수)
      const pending = this._pendingMap();

      // ── 1) 보유 종목 손절/익절 체크 ──
      for (const code of Object.keys(heldPositions)) {
        const pos = heldPositions[code];
        if (nowMin() > timeToMin('15:20')) continue;
        if (this.inCooldown(code)) continue; // 방금 주문한 종목 건너뜀 (중복 매도 방지)
        if (pending[code]?.hasSell) continue; // 미체결 매도 진행 중 — 중복 매도 방지
        if (pos.pnlPct >= s.safety.takeProfitPct) {
          await this.sell(cfg, code, pos.qty, pos.curPrice, `익절 (+${pos.pnlPct}% ≥ +${s.safety.takeProfitPct}%)`, pos);
        } else if (pos.pnlPct <= s.safety.stopLossPct) {
          await this.sell(cfg, code, pos.qty, pos.curPrice, `손절 (${pos.pnlPct}% ≤ ${s.safety.stopLossPct}%)`, pos);
        }
      }

      // ── 2) 스캔 목록 전체: 전략 신호 체크 (순차 처리, 딜레이 적용) ──
      const scanTarget = this.scanList.length > 0 ? this.scanList : (s.watchList || []);
      this.log('system', `⏱ 스캔 시작 (${scanTarget.length}종목)`);

      for (const code of scanTarget) {
        if (!this.running) break; // 중간에 정지됐으면 중단
        const name = this.deps.codeToName(code) || code;

        let chart;
        try {
          chart = await this.deps.getStockChart(cfg, code, 'D');
        } catch(e) {
          this.log('error', `${name} 차트 조회 실패: ${e.message}`);
          await new Promise(r => setTimeout(r, 500)); // 오류 후 0.5초 대기
          continue;
        }

        if (!chart || !chart.length) continue;
        const closes = chart.map(c => c.close).filter(v => v > 0);
        if (closes.length < s.params.maLong + 2) continue;

        const signal = decideSignal(closes, s);
        const held = heldPositions[code];

        if (signal?.side === 'BUY') {
          if (this.inCooldown(code)) continue; // 쿨다운 내 반복 매수 방지
          const startMin = s.safety.avoidFirst30min
            ? Math.max(timeToMin(s.safety.tradeStartTime), 9*60+30)
            : timeToMin(s.safety.tradeStartTime);
          const n = nowMin();
          if (n < startMin || n > timeToMin(s.safety.tradeEndTime)) continue;

          let price;
          try {
            price = await this.deps.getCurrentPrice(cfg, code);
          } catch(e) { continue; }
          if (!price || price <= 0) continue;

          // 미체결 매수 금액도 한도에 합산 — 체결 전 추가 매수로 maxPerStock 초과 방지
          const pendBuyAmt = pending[code]?.buyAmt || 0;
          const curHoldAmt = (held ? held.evalAmt : 0) + pendBuyAmt;
          if (curHoldAmt >= s.safety.maxPerStock) continue;

          const budget = Math.min(s.safety.maxPerOrder, s.safety.maxPerStock - curHoldAmt);
          const qty = Math.floor(budget / price);
          if (qty < 1) {
            this.log('system', `${name} 예산 부족 (₩${budget.toLocaleString()} / 현재가 ₩${price.toLocaleString()})`);
            continue;
          }
          await this.buy(cfg, code, qty, price, signal.reason);

        } else if (signal?.side === 'SELL' && held && held.qty > 0) {
          if (this.inCooldown(code)) continue; // 쿨다운 내 중복 매도 방지
          if (pending[code]?.hasSell) continue; // 미체결 매도 진행 중 — 중복 매도 방지
          if (nowMin() <= timeToMin('15:20')) {
            await this.sell(cfg, code, held.qty, held.curPrice, signal.reason, held);
          }
        }

        // 종목 사이 딜레이 (KIS 제한 준수)
        await new Promise(r => setTimeout(r, 400));
      }

      this.log('system', `✅ 스캔 완료 (${scanTarget.length}종목)`);
      this.save();
    } catch(e) {
      this.log('error', '엔진 오류: ' + e.message);
    } finally {
      this._ticking = false;
    }
  }

  // 미체결 주문 맵: { code: { buyAmt, hasBuy, hasSell } }
  _pendingMap() {
    let list = [];
    try { list = (this.deps.getPendingOrders && this.deps.getPendingOrders()) || []; } catch (_) {}
    const m = {};
    for (const e of list) {
      if (!m[e.code]) m[e.code] = { buyAmt: 0, hasBuy: false, hasSell: false };
      if (e.side === 'buy') { m[e.code].hasBuy = true; m[e.code].buyAmt += (e.qty || 0) * (e.price || 0); }
      else if (e.side === 'sell') m[e.code].hasSell = true;
    }
    return m;
  }

  async buy(cfg, code, qty, price, reason) {
    const name = this.deps.codeToName(code) || code;
    this.log('signal', `📈 매수신호 ${name}(${code}) ${qty}주 @ ₩${price.toLocaleString()} — ${reason}`);
    let result;
    try {
      result = await this.deps.placeOrder(cfg, { side:'buy', code, qty, price, orderType:'00' });
    } catch (e) {
      // 타임아웃이어도 KIS에 접수됐을 수 있음 — 보수적으로 쿨다운 걸어 다음 틱 중복 주문 방지
      this.lastAction[code] = Date.now();
      this.log('error', `❌ 매수주문 예외 ${name}: ${e.message} (쿨다운 적용, 틱 계속)`);
      return;
    }
    if (result?.rt_cd === '0') {
      this.lastAction[code] = Date.now(); // 쿨다운 시작
      // 낙관적 보유 반영 — 계좌 갱신 전에도 maxPerStock이 누적 매수에 적용되게
      if (!this._lastHeld) this._lastHeld = {};
      const prevPos = this._lastHeld[code];
      this._lastHeld[code] = {
        qty: (prevPos?.qty || 0) + qty,
        avgPrice: price, curPrice: price, pnlPct: 0,
        evalAmt: (prevPos?.evalAmt || 0) + qty * price
      };
      const msg = `📈 <b>매수 접수</b>\n종목: ${name} (${code})\n수량: ${qty}주 @ ₩${price.toLocaleString()}\n사유: ${reason}`;
      this.log('buy', `✅ 매수주문 접수 ${name} ${qty}주 @ ₩${price.toLocaleString()}`, { code, qty, price, reason });
      if (this.deps.sendTelegram) await this.deps.sendTelegram(cfg, msg);
    } else {
      this.log('error', `❌ 매수 실패 ${name}: ${result?.msg1 || '알수없음'}`);
    }
  }

  async sell(cfg, code, qty, price, reason, pos) {
    const name = this.deps.codeToName(code) || code;
    this.log('signal', `📉 매도신호 ${name}(${code}) ${qty}주 @ ₩${price.toLocaleString()} — ${reason}`);
    let result;
    try {
      result = await this.deps.placeOrder(cfg, { side:'sell', code, qty, price, orderType:'00' });
    } catch (e) {
      // 한 종목 매도 예외가 다른 보유 종목의 손절을 막지 않도록 틱을 끊지 않음 + 보수적 쿨다운
      this.lastAction[code] = Date.now();
      this.log('error', `❌ 매도주문 예외 ${name}: ${e.message} (쿨다운 적용)`);
      return;
    }
    if (result?.rt_cd === '0') {
      this.lastAction[code] = Date.now(); // 쿨다운 시작
      if (this._lastHeld && this._lastHeld[code]) delete this._lastHeld[code]; // 낙관적 제거 — 같은 주식 중복 매도 방지
      let realized = 0;
      if (pos?.avgPrice) realized = (price - pos.avgPrice) * qty;
      const pnlStr = (realized>=0?'+':'') + realized.toLocaleString();
      const msg = `📉 <b>매도 접수</b>\n종목: ${name} (${code})\n수량: ${qty}주 @ ₩${price.toLocaleString()}\n추정손익: ${pnlStr}원\n사유: ${reason}`;
      this.state.dailyRealizedPnl += realized;
      this.log('sell', `✅ 매도주문 접수 ${name} ${qty}주 @ ₩${price.toLocaleString()} (추정손익 ${pnlStr}원)`, { code, qty, price, reason, realized });
      this.save();
      if (this.deps.sendTelegram) await this.deps.sendTelegram(cfg, msg);
    } else {
      this.log('error', `❌ 매도 실패 ${name}: ${result?.msg1 || '알수없음'}`);
    }
  }
}

module.exports = { AutoTrader, getLogs, decideSignal, calcRSI, sma };
