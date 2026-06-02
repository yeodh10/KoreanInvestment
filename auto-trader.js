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
  watchList: ['005930', '000660', '035720'],  // 자동매매 대상 종목
  intervalSec: 30              // 시세 점검 주기 (초)
};

// ── 상태 로드/저장 ──
function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      // 기본값과 병합 (새 옵션 추가 대비)
      return {
        settings: { ...DEFAULT_SETTINGS, ...(s.settings||{}),
          strategies: { ...DEFAULT_SETTINGS.strategies, ...(s.settings?.strategies||{}) },
          params: { ...DEFAULT_SETTINGS.params, ...(s.settings?.params||{}) },
          safety: { ...DEFAULT_SETTINGS.safety, ...(s.settings?.safety||{}) }
        },
        today: s.today || todayKey(),
        dailyRealizedPnl: s.dailyRealizedPnl || 0,
        stoppedByLoss: s.stoppedByLoss || false,
        positions: s.positions || {}  // {code: {avgPrice, qty, peakPrice}}
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

function saveState(state) {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2)); } catch(e) {}
}

function todayKey() {
  return new Date().toISOString().slice(0,10);
}

// ── 로그 ──
let _logs = [];
function loadLogs() {
  try { if (fs.existsSync(LOG_FILE)) _logs = JSON.parse(fs.readFileSync(LOG_FILE,'utf8')); } catch(e){ _logs=[]; }
  return _logs;
}
function addLog(type, message, meta) {
  const entry = { time: new Date().toISOString(), type, message, meta: meta||null };
  _logs.unshift(entry);
  if (_logs.length > 500) _logs = _logs.slice(0, 500);
  try { fs.writeFileSync(LOG_FILE, JSON.stringify(_logs, null, 2)); } catch(e){}
  const t = new Date().toLocaleTimeString('ko-KR');
  console.log(`[자동매매 ${t}] ${message}`);
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

// RSI (Wilder 방식)
function calcRSI(closes, period) {
  if (closes.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i-1];
    if (diff >= 0) gains += diff; else losses -= diff;
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
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
function isMarketOpen() {
  const now = new Date();
  const day = now.getDay();
  if (day === 0 || day === 6) return false;
  const t = now.getHours()*60 + now.getMinutes();
  return t >= 9*60 && t <= 15*60+30;
}
function timeToMin(hhmm) {
  const [h,m] = hhmm.split(':').map(Number);
  return h*60 + m;
}
function nowMin() {
  const now = new Date();
  return now.getHours()*60 + now.getMinutes();
}

// ════════════════════════════════════════
// 자동매매 엔진 메인 루프
// deps = { loadConfig, getStockChart, getCurrentPrice, placeOrder, getAccount }
// ════════════════════════════════════════
class AutoTrader {
  constructor(deps) {
    this.deps = deps;
    this.state = loadState();
    loadLogs();
    this.timer = null;
    this.running = false;
    this.scanList = []; // 현재 스캔 대상 목록 (거래량 상위 + watchList)
    this.scanListUpdated = 0; // 마지막 업데이트 시각
    this.tickCount = 0; // 틱 카운터
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
    saveState(this.state);
    addLog('config', '설정이 업데이트되었습니다.');
    if (this.state.settings.enabled && !this.running) this.start();
    if (!this.state.settings.enabled && this.running) this.stop();
    return this.getStatus();
  }

  start() {
    if (this.running) return;
    this.state.settings.enabled = true;
    this.state.stoppedByLoss = false;
    saveState(this.state);
    this.running = true;
    this.tickCount = 0;
    // 스캔 목록 크기에 따라 최소 간격 자동 조정
    // 종목당 최소 0.4초 × 예상 50종목 = 20초. 안전하게 최소 60초.
    const minInterval = 60;
    const interval = Math.max(minInterval, this.state.settings.intervalSec);
    addLog('system', `🟢 자동매매 시작 (점검주기 ${interval}초, 거래량상위+관심종목 스캔)`);
    this.tick();
    this.timer = setInterval(() => this.tick(), interval * 1000);
  }

  stop() {
    this.running = false;
    this.state.settings.enabled = false;
    saveState(this.state);
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    addLog('system', '🔴 자동매매 정지');
  }

  checkDayReset() {
    const tk = todayKey();
    if (this.state.today !== tk) {
      this.state.today = tk;
      this.state.dailyRealizedPnl = 0;
      this.state.stoppedByLoss = false;
      addLog('system', '📅 새로운 거래일 — 일일 손익/정지 상태 초기화');
      saveState(this.state);
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
      addLog('system', `🔍 스캔 목록 갱신: ${merged.length}종목 (거래량상위 ${topCodes.length}개 + 관심 ${watchCodes.length}개)`);
    } catch(e) {
      // 실패 시 watchList만 사용
      this.scanList = this.state.settings.watchList || [];
      addLog('system', `🔍 거래량 상위 조회 실패, watchList ${this.scanList.length}종목으로 진행`);
    }
  }

  async tick() {
    try {
      this.checkDayReset();
      this.tickCount++;
      const s = this.state.settings;

      if (!s.enabled) return;
      if (!isMarketOpen()) return;

      if (this.state.stoppedByLoss) return;
      if (this.state.dailyRealizedPnl <= s.safety.dailyLossLimit) {
        this.state.stoppedByLoss = true;
        saveState(this.state);
        addLog('safety', `🛑 하루 손실 한도 도달 (${this.state.dailyRealizedPnl.toLocaleString()}원 ≤ ${s.safety.dailyLossLimit.toLocaleString()}원). 오늘 자동매매 중지.`);
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

      // ── 1) 보유 종목 손절/익절 체크 ──
      for (const code of Object.keys(heldPositions)) {
        const pos = heldPositions[code];
        if (nowMin() > timeToMin('15:20')) continue;
        if (pos.pnlPct >= s.safety.takeProfitPct) {
          await this.sell(cfg, code, pos.qty, pos.curPrice, `익절 (+${pos.pnlPct}% ≥ +${s.safety.takeProfitPct}%)`, pos);
        } else if (pos.pnlPct <= s.safety.stopLossPct) {
          await this.sell(cfg, code, pos.qty, pos.curPrice, `손절 (${pos.pnlPct}% ≤ ${s.safety.stopLossPct}%)`, pos);
        }
      }

      // ── 2) 스캔 목록 전체: 전략 신호 체크 (순차 처리, 딜레이 적용) ──
      const scanTarget = this.scanList.length > 0 ? this.scanList : (s.watchList || []);
      addLog('system', `⏱ 스캔 시작 (${scanTarget.length}종목)`);

      for (const code of scanTarget) {
        if (!this.running) break; // 중간에 정지됐으면 중단
        const name = this.deps.codeToName(code) || code;

        let chart;
        try {
          chart = await this.deps.getStockChart(cfg, code, 'D');
        } catch(e) {
          addLog('error', `${name} 차트 조회 실패: ${e.message}`);
          await new Promise(r => setTimeout(r, 500)); // 오류 후 0.5초 대기
          continue;
        }

        if (!chart || !chart.length) continue;
        const closes = chart.map(c => c.close).filter(v => v > 0);
        if (closes.length < s.params.maLong + 2) continue;

        const signal = decideSignal(closes, s);
        const held = heldPositions[code];

        if (signal?.side === 'BUY') {
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

          const curHoldAmt = held ? held.evalAmt : 0;
          if (curHoldAmt >= s.safety.maxPerStock) continue;

          const budget = Math.min(s.safety.maxPerOrder, s.safety.maxPerStock - curHoldAmt);
          const qty = Math.floor(budget / price);
          if (qty < 1) {
            addLog('system', `${name} 예산 부족 (₩${budget.toLocaleString()} / 현재가 ₩${price.toLocaleString()})`);
            continue;
          }
          await this.buy(cfg, code, qty, price, signal.reason);

        } else if (signal?.side === 'SELL' && held && held.qty > 0) {
          if (nowMin() <= timeToMin('15:20')) {
            await this.sell(cfg, code, held.qty, held.curPrice, signal.reason, held);
          }
        }

        // 종목 사이 딜레이 (KIS 제한 준수)
        await new Promise(r => setTimeout(r, 400));
      }

      addLog('system', `✅ 스캔 완료 (${scanTarget.length}종목)`);
      saveState(this.state);
    } catch(e) {
      addLog('error', '엔진 오류: ' + e.message);
    }
  }

  async buy(cfg, code, qty, price, reason) {
    const name = this.deps.codeToName(code) || code;
    addLog('signal', `📈 매수신호 ${name}(${code}) ${qty}주 @ ₩${price.toLocaleString()} — ${reason}`);
    const result = await this.deps.placeOrder(cfg, { side:'buy', code, qty, price, orderType:'00' });
    if (result?.rt_cd === '0') {
      const msg = `📈 <b>매수 접수</b>\n종목: ${name} (${code})\n수량: ${qty}주 @ ₩${price.toLocaleString()}\n사유: ${reason}`;
      addLog('buy', `✅ 매수주문 접수 ${name} ${qty}주 @ ₩${price.toLocaleString()}`, { code, qty, price, reason });
      if (this.deps.sendTelegram) await this.deps.sendTelegram(cfg, msg);
    } else {
      addLog('error', `❌ 매수 실패 ${name}: ${result?.msg1 || '알수없음'}`);
    }
  }

  async sell(cfg, code, qty, price, reason, pos) {
    const name = this.deps.codeToName(code) || code;
    addLog('signal', `📉 매도신호 ${name}(${code}) ${qty}주 @ ₩${price.toLocaleString()} — ${reason}`);
    const result = await this.deps.placeOrder(cfg, { side:'sell', code, qty, price, orderType:'00' });
    if (result?.rt_cd === '0') {
      let realized = 0;
      if (pos?.avgPrice) realized = (price - pos.avgPrice) * qty;
      const pnlStr = (realized>=0?'+':'') + realized.toLocaleString();
      const msg = `📉 <b>매도 접수</b>\n종목: ${name} (${code})\n수량: ${qty}주 @ ₩${price.toLocaleString()}\n추정손익: ${pnlStr}원\n사유: ${reason}`;
      this.state.dailyRealizedPnl += realized;
      addLog('sell', `✅ 매도주문 접수 ${name} ${qty}주 @ ₩${price.toLocaleString()} (추정손익 ${pnlStr}원)`, { code, qty, price, reason, realized });
      saveState(this.state);
      if (this.deps.sendTelegram) await this.deps.sendTelegram(cfg, msg);
    } else {
      addLog('error', `❌ 매도 실패 ${name}: ${result?.msg1 || '알수없음'}`);
    }
  }
}

module.exports = { AutoTrader, getLogs, decideSignal, calcRSI, sma };
