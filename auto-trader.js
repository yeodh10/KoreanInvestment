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

// ── 리스크 프리셋 (보수/균형/공격) — 화면에서 선택, safety 기본값을 결정 ──
const RISK_PRESETS = {
  conservative: { riskPerTradePct:0.4, dailyLossLimitPct:-1.2, maxPositions:3, maxExposurePct:40, maxPerStockPct:15, stopAtrMult:1.2, takeProfitR:2.5, trailAfterR:1, maxConsecLosses:2, maxTradesPerDay:12 },
  balanced:     { riskPerTradePct:0.7, dailyLossLimitPct:-2.0, maxPositions:5, maxExposurePct:60, maxPerStockPct:20, stopAtrMult:1.5, takeProfitR:2.0, trailAfterR:1, maxConsecLosses:3, maxTradesPerDay:20 },
  aggressive:   { riskPerTradePct:1.2, dailyLossLimitPct:-3.5, maxPositions:8, maxExposurePct:85, maxPerStockPct:25, stopAtrMult:2.0, takeProfitR:1.8, trailAfterR:1, maxConsecLosses:4, maxTradesPerDay:30 }
};

// ── 기본 설정값 (화면에서 덮어쓸 수 있음) — 균형 프리셋 기준 ──
const DEFAULT_SETTINGS = {
  enabled: false,              // 자동매매 on/off
  riskPreset: 'balanced',      // 선택한 프리셋(표시용)
  strategies: {
    goldenCross: true,         // 골든크로스 사용
    rsi: true                  // RSI 사용
  },
  params: {
    maShort: 5,                // 단기 이동평균
    maLong: 20,                // 장기 이동평균
    rsiPeriod: 14,             // RSI 기간
    rsiOversold: 30,           // 과매도 (이하면 매수 후보)
    rsiOverbought: 70,         // 과매수 (이상이면 매도 후보)
    atrPeriod: 14              // ATR 기간 (변동성 기반 손절)
  },
  safety: {
    // ── 리스크 기반 사이징 ──
    riskPerTradePct: 0.7,      // 거래당 위험 = 자본의 0.7% (손절까지 거리로 수량 역산)
    maxPerStockPct: 20,        // 종목당 최대 보유 = 자본의 20% (집중 방지)
    maxPerStock: 0,            // 종목당 최대 보유 = 절대금액(원). 0=미설정(%만 적용). 설정 시 %와 함께 더 작은 쪽 적용
    // ── 변동성 기반 손절/익절 + 트레일링 ──
    stopAtrMult: 1.5,          // 손절 = 진입 − 1.5×ATR
    takeProfitR: 2.0,          // 익절 = +2R (손익비 2:1)
    trailAfterR: 1.0,          // +1R 도달 시 손절을 본전으로 + ATR 트레일링 시작
    // ── 포트폴리오 서킷브레이커 ──
    dailyLossLimitPct: -2.0,   // 일일 손실 한도 = 자본의 −2% (도달 시 당일 신규매수 정지)
    maxPositions: 5,           // 동시 보유(봇) 최대 종목 수
    maxExposurePct: 60,        // 총 노출 상한 = 자본의 60% (현금버퍼 유지)
    maxConsecLosses: 3,        // 연속 N패 시 당일 신규매수 정지
    maxTradesPerDay: 20,       // 일일 최대 거래(매수) 수 — 과매매 방지
    // ── 장중 반등 모멘텀(분봉) — 기본 OFF. 검증 후 전략 화면에서 켠다. ──
    intradayRebound: false,    // 일봉 전략이 못 잡는 장중 V자 반등 포착(균형형)
    rbMinDrop: -2.5,           // 당일 전일대비 이 이하(낙폭과대)만 대상
    rbReboundPct: 1.5,         // 당일 저가 대비 이 이상 반등(바닥 확인)
    rbVolMult: 1.5,            // 직전 분봉 거래량 ≥ 평균×배수(매수세)
    rbStopPct: 2.0,            // 진입 즉시 좁은 손절(%)
    // ── 진입 품질 필터 ──
    trendFilter: true,         // 가격 > 장기MA 일 때만 매수 (하락추세 칼 잡기 방지)
    // ── 시간/보호 ──
    tradeStartTime: '09:05',   // 매수 시작 시간
    tradeEndTime: '15:00',     // 신규 매수 종료 시간 (매도는 15:20까지)
    avoidFirst30min: true,     // 장 시작 30분 신규매수 금지
    protectManual: true,       // ★ 수동 보유 보호: 엔진이 직접 매수한 수량만 매도
    avoidWarnStocks: true      // ★ 위험종목 회피: 관리/투자경고·위험/거래정지/정리매매 종목 자동매수 차단
  },
  // 자동매매 대상 종목 — KOSPI 시총 상위 우량주 50 (반도체·2차전지·바이오·자동차·금융·통신·소재·조선·방산 분산)
  watchList: [
    '005930','000660','373220','207940','005380','000270','068270','005490','105560','028260',
    '051910','012330','055550','086790','323410','006400','066570','035720','035420','015760',
    '034020','096770','011170','000720','003670','010130','033780','000120','010950','003490',
    '032830','000810','316140','024110','138040','329180','012450','003550','034730','017670',
    '030200','032640','009150','402340','259960','036570','251270','042700','011200','047050'
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
        consecLosses: s.consecLosses || 0,   // 연속 손실 횟수 (서킷브레이커)
        tradesToday: s.tradesToday || 0,     // 당일 매수 체결 수 (과매매 방지)
        positions: s.positions || {},
        botPositions: migrateBotPositions(s.botPositions) // 종목→{qty,entry,stop,target,hw,atr,initRisk}
      };
    }
  } catch(e) {}
  return {
    settings: JSON.parse(JSON.stringify(DEFAULT_SETTINGS)),
    today: todayKey(),
    dailyRealizedPnl: 0,
    stoppedByLoss: false,
    consecLosses: 0,
    tradesToday: 0,
    positions: {},
    botPositions: {}
  };
}

// 구버전 botPositions(종목→주수 number)를 객체 형태로 승격. 손절정보 없는 건 관리 시 폴백.
function migrateBotPositions(bp) {
  const out = {};
  if (!bp || typeof bp !== 'object') return out;
  for (const code of Object.keys(bp)) {
    const v = bp[code];
    if (typeof v === 'number') { if (v > 0) out[code] = { qty: v }; }       // 레거시: 수량만
    else if (v && typeof v === 'object' && (v.qty|0) > 0) out[code] = v;    // 신버전 객체
  }
  return out;
}
function botQtyOf(bp, code) { const p = bp && bp[code]; return p ? (p.qty|0) : 0; }

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

// ATR (Average True Range) — 변동성. bars: [{high,low,close}] 과거→현재
// TR = max(고-저, |고-전일종가|, |저-전일종가|), ATR = 최근 period TR의 평균
function calcATR(bars, period) {
  if (!Array.isArray(bars) || bars.length < period + 1) return null;
  const trs = [];
  for (let i = bars.length - period; i < bars.length; i++) {
    const h = bars[i].high, l = bars[i].low, pc = bars[i-1].close;
    if (!(h > 0) || !(l > 0) || !(pc > 0)) return null;
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  return trs.reduce((a,b)=>a+b,0) / period;
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
// 장중 반등 모멘텀 (분봉 기반) — "균형형"
// 일봉 전략이 못 잡는 장중 V자 반등을 안전하게 포착한다.
// 철학: 바닥을 예측해 떨어지는 칼을 잡는 게 아니라, 반등이 시작된 걸 거래량으로 확인하고
//       올라타되 틀리면 즉시 좁게(-2%) 손절. 4개 조건을 모두 충족해야 진입.
// bars: 당일 분봉 [{open,high,low,close,vol}] 과거→현재
// ctx:  { prevClose(전일종가), curPrice(현재가), dayLow(당일저가) }
// p:    파라미터(설정에서 주입). 반환: { side:'BUY', reason, stop } | null
// ════════════════════════════════════════
function decideIntradayRebound(bars, ctx, p) {
  p = p || {};
  const minDropPct   = (p.minDropPct   != null) ? p.minDropPct   : -2.5; // 당일 전일대비 이 이하(낙폭과대)만 대상
  const reboundPct   = (p.reboundPct   != null) ? p.reboundPct   : 1.5;  // 당일 저가 대비 이 이상 반등(바닥 확인)
  const volMult      = (p.volMult      != null) ? p.volMult      : 1.5;  // 직전 분봉 거래량 ≥ 평균×배수(매수세)
  const imaShort     = (p.imaShort     != null) ? p.imaShort     : 5;    // 분봉 단기 이평
  const stopPct      = (p.stopPct      != null) ? p.stopPct      : 2.0;  // 손절 폭(%)
  if (!Array.isArray(bars) || bars.length < imaShort + 2) return null;
  const prevClose = ctx && ctx.prevClose, curPrice = ctx && ctx.curPrice, dayLow = ctx && ctx.dayLow;
  if (!(prevClose > 0) || !(curPrice > 0) || !(dayLow > 0)) return null;

  // 1) 낙폭과대: 당일 전일대비가 minDropPct 이하
  const chgPct = (curPrice - prevClose) / prevClose * 100;
  if (chgPct > minDropPct) return null;

  // 2) 반등 확인: 당일 저가 대비 reboundPct 이상 회복 (V자 바닥을 직접 안 잡고 올라온 뒤 진입)
  const upFromLow = (curPrice - dayLow) / dayLow * 100;
  if (upFromLow < reboundPct) return null;

  // 3) 거래량 급증: 직전 분봉 거래량이 최근 평균 대비 volMult배 이상 (수급 유입 = 진짜 매수세)
  const vols = bars.map(b => b.vol || 0);
  const lastVol = vols[vols.length - 1];
  const win = Math.min(20, vols.length);
  const avgVol = vols.slice(-win).reduce((a, b) => a + b, 0) / win;
  if (!(avgVol > 0) || lastVol < avgVol * volMult) return null;

  // 4) 분봉 단기이평 상향 전환 + 직전 분봉 양봉 (단기 모멘텀이 위로 꺾였는지)
  const closes = bars.map(b => b.close).filter(v => v > 0);
  const maNow = sma(closes, imaShort), maPrev = sma(closes.slice(0, -1), imaShort);
  if (!(maNow > 0) || !(maPrev > 0) || maNow <= maPrev) return null;
  const lb = bars[bars.length - 1];
  if (!(lb.close >= lb.open)) return null; // 직전 분봉이 양봉(상승 마감)일 것

  // 손절: 현재가 -stopPct% (좁은 손절). 진입 즉시 리스크를 좁게 고정.
  const stop = Math.round(curPrice * (1 - stopPct / 100));
  return { side: 'BUY', reason: `장중반등 (당일 ${chgPct.toFixed(1)}%, 저가대비 +${upFromLow.toFixed(1)}%, 거래량 ${(lastVol / avgVol).toFixed(1)}x)`, stop };
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
// ⚠️ 음력 기반(설·부처님오신날·추석)은 1~2년 뒤 윤달 변동으로 ±1일 오차 가능 — 매년 KRX 공식 캘린더로 확정할 것.
const KRX_HOLIDAYS = new Set([
  // 2026년 (확정)
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
  '2026-12-31',                            // 연말 휴장
  // 2027년 — 양력·대체공휴일은 요일로 검증(확실), 음력은 추정(⚠️ 공식 캘린더로 재확인 필요)
  '2027-01-01',                            // 신정 (금)
  '2027-02-05','2027-02-08',               // ⚠️음력 설(2/6 토) 연휴 전날(금) + 대체공휴일(월)
  '2027-03-01',                            // 삼일절 (월)
  '2027-05-05',                            // 어린이날 (수)
  '2027-05-13',                            // ⚠️음력 부처님오신날 (목, 추정)
  '2027-08-16',                            // 광복절(8/15 일) 대체 (월)
  '2027-09-14','2027-09-15','2027-09-16',  // ⚠️음력 추석 연휴 (화·수·목, 추정)
  '2027-10-04',                            // 개천절(10/3 일) 대체 (월)
  '2027-10-11',                            // 한글날(10/9 토) 대체 (월)
  '2027-12-27',                            // 성탄절(12/25 토) 대체 (월)
  '2027-12-31'                             // 연말 휴장 (금)
]);

// ── 단축장/늦장개장 (분 단위, KST). 미등록일은 정규장 09:00~15:30. ──
// 수능일은 통상 1시간 늦게 개장(10:00~16:30). 날짜는 매년 확정 필요(⚠️ 공식 발표로 재확인).
const SHORTENED_SESSIONS = {
  '2026-11-19': { open: 10*60, close: 16*60+30 } // ⚠️ 2027학년도 수능 예정일(목) — 공식 확정 시 수정
};
function marketHours(dateKey) {
  return SHORTENED_SESSIONS[dateKey] || { open: 9*60, close: 15*60+30 };
}
function isMarketOpen() {
  const k = kstParts();
  if (k.day === 0 || k.day === 6) return false;
  if (KRX_HOLIDAYS.has(k.dateKey)) return false; // 공휴일 — 헛스캔·휴장일 주문 방지
  const h = marketHours(k.dateKey);              // 단축장(늦장개장) 반영 — 개장 전 헛주문 방지
  return k.min >= h.open && k.min <= h.close;
}
// 주말 외 KRX 휴장일 판정 — 외부 점검 스크립트(market-check.js)가 휴장일 거짓경보를
// 막기 위해 재사용. 인자는 Date(KST 변환 전 UTC ms 기준) 또는 'YYYY-MM-DD' 문자열.
function isHoliday(date) {
  let dateKey;
  if (typeof date === 'string') dateKey = date.slice(0, 10);
  else { const d = date ? new Date(date) : new Date(); dateKey = new Date(d.getTime() + 9 * 3600 * 1000).toISOString().slice(0, 10); }
  return KRX_HOLIDAYS.has(dateKey);
}
// 오늘 세션 기준 시각(분) — 단축장 대응. 정규장에선 open=540(09:00)/close=930(15:30)로 기존과 동일.
function sessionOpenMin()  { return marketHours(kstParts().dateKey).open; }
// 매도/포지션 관리 종료 = 마감 10분 전(동시호가 직전). 정규장 15:20, 수능 등 단축장은 16:20 자동.
function manageCutoffMin() { return marketHours(kstParts().dateKey).close - 10; }

// 휴장일 테이블 신선도 경고 — 등록된 최신 연도가 올해를 못 덮으면 부팅 시 1회 경고
(function warnHolidayTableStale() {
  try {
    let maxYear = 0;
    for (const d of KRX_HOLIDAYS) { const y = parseInt(d.slice(0, 4)); if (y > maxYear) maxYear = y; }
    const curYear = new Date(Date.now() + 9 * 60 * 60 * 1000).getUTCFullYear();
    if (maxYear < curYear) console.warn(`⚠️ KRX 휴장일 테이블이 ${maxYear}년까지만 등록됨 (현재 ${curYear}년) — auto-trader.js KRX_HOLIDAYS/SHORTENED_SESSIONS 갱신 필요`);
  } catch (_) {}
})();
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
    // 디스크에 저장된 옛 설정에 극단/NaN 값이 있어도 안전 범위로 — 부팅 자동재개는 updateSettings를 안 거치므로 여기서 보정
    if (this.state.settings && this.state.settings.safety) this.state.settings.safety = this._clampSafety(this.state.settings.safety);
  }

  // 인스턴스 로그 (유저별)
  log(type, message, meta) {
    const entry = { time: new Date().toISOString(), type, message, meta: meta||null };
    // 반복 노이즈(스캔 진행/목록갱신)는 콘솔·저장 모두 제외 — 매수/매도/손절/신호/알림 이력이
    // 분당 수건의 스캔 로그에 밀려 500건 캡에서 사라지던 문제 차단. (봇 활동은 매매·상태로 확인)
    if (type === 'system' && /스캔 시작|스캔 완료|스캔 목록 갱신/.test(message)) return entry;
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
    const cap = this._capital || 0;
    const pnl = this.state.dailyRealizedPnl || 0;
    const bp = this.state.botPositions || {};
    const priceCache = (typeof global !== 'undefined' && global._priceCache) || {};
    const positions = Object.keys(bp).map(code => ({
      code, name: (this.deps.codeToName && this.deps.codeToName(code)) || code,
      qty: bp[code].qty, entry: bp[code].entry || 0, stop: Math.round(bp[code].stop || 0),
      // 현재가: 잔고 캐시(_lastHeld) 우선, 없으면 시세 캐시 폴백 — 잔고 갱신(5틱) 전에도 현재가가 뜨게
      target: Math.round(bp[code].target || 0),
      cur: (this._lastHeld?.[code]?.curPrice) || (priceCache[code]?.data?.price) || 0
    }));
    const exposure = this._botExposure(this._lastHeld || {});
    return {
      enabled: this.state.settings.enabled,
      running: this.running,
      stoppedByLoss: this.state.stoppedByLoss,
      dailyRealizedPnl: pnl,
      dailyPnlPct: cap > 0 ? +(pnl / cap * 100).toFixed(2) : 0,
      capital: cap,
      dailyLossLimitAmt: cap > 0 ? Math.round(cap * (this.state.settings.safety.dailyLossLimitPct / 100)) : 0,
      consecLosses: this.state.consecLosses || 0,
      tradesToday: this.state.tradesToday || 0,
      openPositions: positions.length,
      positions,
      exposure,
      exposurePct: cap > 0 ? +(exposure / cap * 100).toFixed(1) : 0,
      settings: this.state.settings,
      marketOpen: isMarketOpen(),
      scanListSize: this.scanList.length
    };
  }

  // ── 리스크 설정 검증·클램프 ──
  // 외부 입력(API)이 비수치/극단값이면 사이징이 NaN("NaN"주문)·Infinity(풀베팅)·즉시손절로 폭주한다.
  // 각 항목을 안전 범위로 강제. dailyLossLimitPct는 반드시 음수.
  _clampSafety(sf) {
    const num = (v, d, lo, hi) => { v = Number(v); if (!Number.isFinite(v)) v = d; return Math.min(hi, Math.max(lo, v)); };
    sf.riskPerTradePct   = num(sf.riskPerTradePct, 0.7, 0.05, 5);
    sf.maxPerStockPct    = num(sf.maxPerStockPct, 20, 1, 100);
    sf.maxPerStock       = num(sf.maxPerStock, 0, 0, 1e10); // 0=미설정. 절대(원) 종목당 한도
    sf.stopAtrMult       = num(sf.stopAtrMult, 1.5, 0.3, 6);
    sf.takeProfitR       = num(sf.takeProfitR, 2.0, 0.5, 10);
    sf.trailAfterR       = num(sf.trailAfterR, 1.0, 0.1, 10);
    sf.dailyLossLimitPct = num(sf.dailyLossLimitPct, -2.0, -50, -0.1);
    sf.maxPositions      = Math.round(num(sf.maxPositions, 5, 1, 30));
    sf.maxExposurePct    = num(sf.maxExposurePct, 60, 1, 100);
    sf.maxConsecLosses   = Math.round(num(sf.maxConsecLosses, 3, 1, 20));
    sf.maxTradesPerDay   = Math.round(num(sf.maxTradesPerDay, 20, 1, 200));
    // 장중 반등 파라미터 클램프 (intradayRebound 토글은 boolean이라 클램프 제외 — undefined면 기존값 유지)
    sf.rbMinDrop    = num(sf.rbMinDrop, -2.5, -15, -0.5);
    sf.rbReboundPct = num(sf.rbReboundPct, 1.5, 0.3, 10);
    sf.rbVolMult    = num(sf.rbVolMult, 1.5, 1, 10);
    sf.rbStopPct    = num(sf.rbStopPct, 2.0, 0.5, 5);
    // 시간 문자열 검증 — 'abc' 등이면 timeToMin→NaN으로 시간 게이트가 무력화돼 매매창 무시
    const okTime = t => typeof t === 'string' && /^([01]?\d|2[0-3]):[0-5]\d$/.test(t);
    if (!okTime(sf.tradeStartTime)) sf.tradeStartTime = '09:05';
    if (!okTime(sf.tradeEndTime))   sf.tradeEndTime = '15:00';
    return sf;
  }

  updateSettings(newSettings) {
    // 프리셋 선택 시 해당 리스크 기본값을 safety에 먼저 깔고, 개별 safety 값이 있으면 그 위에 덮어씀
    const presetSafety = (newSettings.riskPreset && RISK_PRESETS[newSettings.riskPreset]) || {};
    this.state.settings = {
      ...this.state.settings,
      ...newSettings,
      strategies: { ...this.state.settings.strategies, ...(newSettings.strategies||{}) },
      params: { ...this.state.settings.params, ...(newSettings.params||{}) },
      safety: { ...this.state.settings.safety, ...presetSafety, ...(newSettings.safety||{}) }
    };
    this.state.settings.safety = this._clampSafety(this.state.settings.safety); // 극단값/NaN 방어
    this.save();
    this.log('config', '설정이 업데이트되었습니다.' + (newSettings.riskPreset ? ` (프리셋: ${newSettings.riskPreset})` : ''));
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
      this.state.consecLosses = 0;
      this.state.tradesToday = 0;
      this.log('system', '📅 새로운 거래일 — 일일 손익/연속손익/거래수/정지 상태 초기화');
      this.save();
    }
  }

  // 봇이 보유 중인 종목 수 / 총 노출금액
  _botPositionCount() { return Object.keys(this.state.botPositions || {}).length; }
  _botExposure(held) {
    let sum = 0; const bp = this.state.botPositions || {};
    for (const c of Object.keys(bp)) {
      const q = bp[c].qty || 0;
      const px = (held && held[c] && held[c].curPrice) || bp[c].entry || 0;
      sum += q * px;
    }
    return sum;
  }
  // 봇 보유분의 미실현 손익(현재가 - 진입가). 일일 손실 서킷이 실현손익만 보면
  // 손절 발동 전 동반 급락(미실현 손실)에는 신규매수를 못 막는다 → 미실현도 합산해 판정.
  _botUnrealized(held) {
    let sum = 0; const bp = this.state.botPositions || {};
    for (const c of Object.keys(bp)) {
      const q = bp[c].qty || 0;
      const entry = bp[c].entry || 0;
      const cur = (held && held[c] && held[c].curPrice) || 0;
      if (q > 0 && entry > 0 && cur > 0) sum += (cur - entry) * q;
    }
    return sum;
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

      const cfg = this.deps.loadConfig();
      if (!cfg.appKey) return;

      // 10분마다 스캔 목록 갱신
      await this.updateScanList(cfg);

      // 미체결 주문 맵 — 잔고 캐시(5틱)와 실제 사이의 공백을 메움
      // (미체결 매도 종목 재매도 = 공매도성 사고, 미체결 매수 누락 = 한도 초과 매수)
      // 잔고 대조보다 먼저 계산 — 부분체결 중 봇 지분 오삭감을 막는 데 쓰인다.
      const pending = this._pendingMap();

      // 계좌 잔고 (5틱마다 갱신, API 절약)
      let heldPositions = {};
      if (this.tickCount % 5 === 1) {
        let account = null;
        try { account = await this.deps.getAccount(cfg); }
        catch (e) { this.log('error', `계좌 조회 실패: ${e.message} (이전 잔고로 진행)`); }
        // ★ rt_cd 정상 + output1 배열일 때만 반영. 오류 응답(빈 output1)이 봇 지분을 통째로 지워
        //   전 포지션을 무관리 상태로 만드는 사고를 차단한다.
        if (account && account.rt_cd === '0' && Array.isArray(account.output1)) {
          let holdingsEval = 0;
          const holdMap = {};
          account.output1.forEach(p => {
            const qty = parseInt(p.hldg_qty||0);
            if (qty > 0) { heldPositions[p.pdno] = {
              qty, avgPrice: parseInt(p.pchs_avg_pric||0),
              curPrice: parseInt(p.prpr||0),
              pnlPct: parseFloat(p.evlu_pfls_rt||0),
              evalAmt: parseInt(p.evlu_amt||0)
            }; holdingsEval += parseInt(p.evlu_amt||0); holdMap[p.pdno] = qty; }
          });
          const bot = this.state.botPositions || (this.state.botPositions = {});
          const prevHeld = this._lastHeld || {};
          const holdEmpty = Object.keys(holdMap).length === 0;
          // ★ rt_cd=0인데 output1이 비거나 누락된 "일시적 빈 잔고"가 봇 지분을 통째로 지우는 사고 방지:
          //   직전엔 보유가 있었는데 갑자기 0이고 봇 포지션이 남아 있으면 잔고 대조 보류(직전 잔고 유지)하고 재확인.
          //   KIS는 정산/일시 구간에 rt_cd=0 + 빈 output1을 2회 이상 줄 수 있어(M-C) 유예를 2틱으로 둔다
          //   → 3회 연속 빈 응답일 때만 청산 확정. (단발/2연속 블립에 전 포지션 무관리화 방지)
          if (holdEmpty && Object.keys(prevHeld).length > 0 && Object.keys(bot).length > 0 && (this._emptyBalanceStreak||0) < 2) {
            this._emptyBalanceStreak = (this._emptyBalanceStreak||0) + 1;
            this.log('error', `⚠️ 빈 잔고 응답(일시 의심, ${this._emptyBalanceStreak}/2회 유예) — 이번 틱 잔고 대조 보류, 직전 잔고 유지`);
          } else {
            this._emptyBalanceStreak = holdEmpty ? (this._emptyBalanceStreak||0) + 1 : 0;
            this._lastHeld = heldPositions;
            // 저널 체결 확정 — 브라우저(SSE) 미접속 헤드리스 운영에서도 미체결 가드/자동취소가 정상 동작
            try { if (this.deps.reconcileOrders) this.deps.reconcileOrders(holdMap); } catch (_) {}
            // 운용 자본 = 순자산(있으면) 또는 예수금+보유평가액. 미결제 매수분 이중계상 방지로 순자산 우선.
            const o2 = account.output2?.[0] || {};
            const cash = parseInt(o2.dnca_tot_amt || o2.prvs_rcdl_excc_amt || 0);
            const cap = parseInt(o2.nass_amt || 0) || (cash + holdingsEval);
            if (cap > 0) this._capital = cap;
            // ★ 봇 지분 ↔ 실보유 대조. "체결되면 도달할 수량"(실보유+미체결 매수잔량)보다 실제가 적으면 축소.
            //   ★★ 실현손익은 "우리가 실제로 낸 매도분(_sellPending)"에만 계상한다. 낙관적으로 더했다
            //   미체결·취소된 매수분이 줄어든 것을 '매도'로 오인해 유령 손익이 일일손익/연속패 서킷을 오염시키던
            //   문제를 차단. 매도는 '접수'가 아니라 여기(실제 체결)에서만 확정 → 미체결 취소 시 고아화도 방지.
            const now = Date.now();
            for (const c of Object.keys(bot)) {
              const realQty = holdMap[c] || 0;
              const pendBuyQty = pending[c]?.buyQty || 0;
              const expected = realQty + pendBuyQty;
              if (expected < (bot[c].qty || 0)) {
                const shrink = bot[c].qty - expected;
                const soldByBot = Math.min(shrink, bot[c]._sellPending || 0); // 실제 낸 매도분만 손익 계상
                if (soldByBot > 0) {
                  const basis = bot[c].entry || 0;
                  const sellPx = bot[c].lastSellPrice || heldPositions[c]?.curPrice || basis;
                  if (basis > 0 && sellPx > 0) {
                    // 보수적 거래비용(매도세+수수료+슬리피지 왕복 추정)을 차감해 실현손익을 약간
                    // 더 보수적으로(손실은 더 크게) 잡는다 → 일일 손실 한도가 늦게가 아니라 제때 발동.
                    const COST_RATE = 0.0015;
                    const cost = (sellPx + basis) * soldByBot * COST_RATE;
                    const realized = (sellPx - basis) * soldByBot - cost;
                    this.state.dailyRealizedPnl += realized;
                    // 연속손실은 청크마다가 아니라 포지션 완전 종료 시 1회만 판정한다(M-A) →
                    // 부분체결이 여러 틱/청크로 쪼개져도 한 매매가 연속손실로 중복 집계되지 않게 누적만.
                    bot[c]._realizedAcc = (bot[c]._realizedAcc || 0) + realized;
                    this.log('sell', `🧾 체결 확정 ${this.deps.codeToName(c)||c} ${soldByBot}주 (실현손익 ${(realized>=0?'+':'')+Math.round(realized).toLocaleString()}원)`, { code:c, soldQty:soldByBot, realized });
                  }
                  bot[c]._sellPending = (bot[c]._sellPending || 0) - soldByBot;
                }
                bot[c].qty = expected; // 미체결 매수 취소분은 손익 없이 수량만 축소
              } else if ((bot[c]._sellPending || 0) > 0 && !(pending[c] && pending[c].hasSell) && bot[c]._sellAt && (now - bot[c]._sellAt) > 6*60*1000) {
                // ★ _sellPending 누수 정리는 "이번 틱에 계상할 체결 축소가 없을 때만" 한다. 체결로 잔고가
                //   빠진 경우(위 if)는 손익을 먼저 계상해야 하며, 여기서 먼저 0으로 지우면 실현손실이
                //   서킷에서 누락된다(빈잔고 유예로 정산이 밀려 _sellAt>6분이 된 경우 실측 재현된 버그).
                //   미체결 매도가 없고(취소·전량체결) 6분 지난 잔여 _sellPending(지정가 미체결 취소분)만 정리.
                bot[c]._sellPending = 0;
              }
              if ((bot[c].qty || 0) <= 0 && (pending[c]?.buyQty || 0) <= 0) {
                // 포지션 완전 종료 — 누적 실현손익 부호로 연속손실 1회만 갱신(M-A)
                const acc = bot[c]._realizedAcc;
                if (acc !== undefined && acc !== 0) {
                  if (acc < 0) this.state.consecLosses = (this.state.consecLosses || 0) + 1;
                  else this.state.consecLosses = 0;
                }
                delete bot[c];
              }
            }
            this.save();
          }
        }
      }
      heldPositions = this._lastHeld || {};
      const capital = this._capital || 0;

      // ── 1) 보유 포지션 관리: ATR 손절 / 트레일링 / R 익절 (항상 실행 — 리스크 축소는 정지와 무관) ──
      for (const code of Object.keys(heldPositions)) {
        const pos = heldPositions[code];
        if (nowMin() > manageCutoffMin()) continue; // 마감 10분 전 이후엔 신규 매도/관리 보류(단축장 자동 반영)
        if (this.inCooldown(code)) continue; // 방금 주문한 종목 건너뜀 (중복 매도 방지)
        if (pending[code]?.hasSell) continue; // 미체결 매도 진행 중 — 중복 매도 방지
        const sellable = this._sellableQty(code, pos.qty, s); // ★ 수동 보유 보호: 봇이 산 수량만
        if (sellable < 1) continue;
        // ★ 실시간 현재가로 손절/트레일 판정. 잔고의 prpr은 최대 5분 묵어 급락장 손절이 늦거나
        //   prpr 누락 시 cur=0으로 허위 손절(0≤stop)이 발동하던 문제를 막는다.
        let cur = pos.curPrice || 0;
        try { const live = await this.deps.getCurrentPrice(cfg, code); if (live > 0) cur = live; } catch (_) {}
        if (cur <= 0) continue; // 가격 미상 → 허위 손절 방지
        const bp = (this.state.botPositions || {})[code];
        let exit = null, exitMarket = false;
        if (bp && bp.stop > 0) {
          // 트레일링: 고점 갱신 → +trailAfterR 도달 시 손절선을 본전 이상/ATR 추적으로 끌어올림
          bp.hw = Math.max(bp.hw || bp.entry || cur, cur);
          if (bp.initRisk > 0 && cur >= bp.entry + s.safety.trailAfterR * bp.initRisk) {
            let ns = Math.max(bp.stop, bp.entry); // 최소 본전 확보
            if (bp.atr > 0) ns = Math.max(ns, bp.hw - s.safety.stopAtrMult * bp.atr); // ATR 트레일
            if (ns > bp.stop) bp.stop = ns;
          }
          // 손절/트레일은 시장가로 — 묵은 지정가가 미체결→자동취소되며 포지션이 방치되는 사고 방지
          if (cur <= bp.stop) { exit = `손절/트레일 (₩${cur.toLocaleString()} ≤ ₩${Math.round(bp.stop).toLocaleString()})`; exitMarket = true; }
          else if (bp.target > 0 && cur >= bp.target) exit = `익절 (₩${cur.toLocaleString()} ≥ ₩${Math.round(bp.target).toLocaleString()})`;
        } else {
          // 레거시/수동 보호분: 손절정보 없음 → 보수적 % 폴백
          if (pos.pnlPct <= -3) { exit = `손절 (${pos.pnlPct}% ≤ -3%)`; exitMarket = true; }
          else if (pos.pnlPct >= 6) exit = `익절 (+${pos.pnlPct}% ≥ +6%)`;
        }
        if (exit) await this.sell(cfg, code, sellable, cur, exit, pos, exitMarket);
      }

      // ── 마감 임박(마감 10분 전) 미청산 봇 포지션 알림 (1일 1회) — 동시호가/오버나이트 방치 경고 ──
      if (nowMin() >= manageCutoffMin() && this.state.today !== this._eodNotifiedDay) {
        const open = Object.keys(this.state.botPositions || {});
        if (open.length) {
          const names = open.map(c => this.deps.codeToName(c) || c).join(', ');
          this.log('safety', `⚠️ 마감 임박 미청산 봇 포지션 ${open.length}종목: ${names} — 동시호가/오버나이트 주의`);
          if (this.deps.sendTelegram) { try { await this.deps.sendTelegram(cfg, `⚠️ <b>미청산 알림</b>\n마감 임박 봇 보유 ${open.length}종목: ${names}`); } catch (_) {} }
        }
        this._eodNotifiedDay = this.state.today;
      }

      // ── 서킷브레이커: 신규매수 정지 판정 (포지션 관리/리스크 매도는 계속됨) ──
      const dailyLossLimit = capital > 0 ? capital * (s.safety.dailyLossLimitPct / 100) : -Infinity;
      const unrealized = this._botUnrealized(heldPositions);
      let buyingHalted = false;
      if (this.state.stoppedByLoss) buyingHalted = true;
      else if (capital > 0 && this.state.dailyRealizedPnl <= dailyLossLimit) {
        // 실현손익만으로 한도 도달 = 고착 정지(오늘 신규매수 영구 중지)
        this.state.stoppedByLoss = true; buyingHalted = true; this.save();
        this.log('safety', `🛑 일일 손실 한도 도달 (${Math.round(this.state.dailyRealizedPnl).toLocaleString()}원 ≤ 자본 ${s.safety.dailyLossLimitPct}% = ${Math.round(dailyLossLimit).toLocaleString()}원) — 오늘 신규매수 중지`);
      }
      else if (capital > 0 && (this.state.dailyRealizedPnl + unrealized) <= dailyLossLimit) {
        // 실현+미실현 합산이 한도 이하 = 비고착 보류(깊은 평가손실 중 추가 진입 차단, 회복 시 재개)
        buyingHalted = true;
        if (!this._drawdownHalted) {
          this._drawdownHalted = true;
          this.log('safety', `⏸ 평가손실 포함 손실 한도 도달 (실현 ${Math.round(this.state.dailyRealizedPnl).toLocaleString()} + 평가 ${Math.round(unrealized).toLocaleString()} ≤ ${Math.round(dailyLossLimit).toLocaleString()}원) — 회복 시까지 신규매수 보류`);
        }
      }
      else { this._drawdownHalted = false; }
      if (!buyingHalted && (this.state.consecLosses || 0) >= s.safety.maxConsecLosses) buyingHalted = true;
      else if (!buyingHalted && (this.state.tradesToday || 0) >= s.safety.maxTradesPerDay) buyingHalted = true;

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
          if (buyingHalted) continue;          // 서킷브레이커 — 신규매수 정지
          if (this.inCooldown(code)) continue; // 쿨다운 내 반복 매수 방지
          if (capital <= 0) continue;          // 자본 미파악 → 사이징 불가, 매수 보류
          const startMin = s.safety.avoidFirst30min
            ? Math.max(timeToMin(s.safety.tradeStartTime), sessionOpenMin() + 30) // 개장 30분 회피 — 단축장 개장시간 기준
            : timeToMin(s.safety.tradeStartTime);
          const n = nowMin();
          if (n < startMin || n > timeToMin(s.safety.tradeEndTime)) continue;

          // 추세 필터: 가격이 장기MA 위일 때만 매수 (하락추세 '떨어지는 칼' 회피)
          if (s.safety.trendFilter) {
            const maL = sma(closes, s.params.maLong);
            if (!maL || closes[closes.length - 1] < maL) continue;
          }
          // 이미 봇이 보유한 종목은 추가매수 금지 — 한 종목 1회 진입(분할 몰빵 방지) + 한도 찬 종목을
          // 매 틱 두드리며 "수량 0 보류" 로그를 도배하던 문제 차단. 종목 분산은 maxPositions로.
          if ((this.state.botPositions || {})[code]) continue;
          if (this._botPositionCount() >= s.safety.maxPositions) continue;

          let price;
          try {
            price = await this.deps.getCurrentPrice(cfg, code);
          } catch(e) { continue; }
          if (!price || price <= 0) continue;

          // ── 변동성(ATR) 기반 손절거리 → 리스크 기반 수량 ──
          const atr = calcATR(chart, s.params.atrPeriod);
          const stopDist = (atr && atr > 0) ? s.safety.stopAtrMult * atr : price * 0.03; // ATR 없으면 3% 폴백
          if (!(stopDist > 0)) continue;                                // stopAtrMult=0 등 → 0/Infinity 방지
          const stop = price - stopDist;
          if (stop <= 0) continue;
          const riskAmt = capital * (s.safety.riskPerTradePct / 100);   // 거래당 위험액
          let qty = Math.floor(riskAmt / stopDist);                     // 손절까지 거리로 수량 역산
          if (!Number.isFinite(qty)) continue;                          // NaN/Infinity 가드 (qty<1 비교는 NaN을 통과시킴)
          // 종목당 한도(자본%) — 미체결·보유 합산 초과 방지
          const pendBuyAmt = pending[code]?.buyAmt || 0;
          const curHoldAmt = (held ? held.evalAmt : 0) + pendBuyAmt;
          // 종목당 한도 = 자본%(maxPerStockPct)와 절대금액(maxPerStock, 원) 중 더 작은 쪽.
          //   ★ maxPerStock(절대)은 예전엔 무시돼 "500만 설정"이 실제로는 자본% 한도(~10%)까지 풀매수되던 버그 수정.
          const perStockCap = Math.min(capital * (s.safety.maxPerStockPct / 100),
                                       s.safety.maxPerStock > 0 ? s.safety.maxPerStock : Infinity);
          qty = Math.min(qty, Math.floor(Math.max(0, perStockCap - curHoldAmt) / price));
          // 총 노출 상한(자본%) — 현금버퍼 유지
          const expRoom = capital * (s.safety.maxExposurePct / 100) - this._botExposure(heldPositions) - pendBuyAmt;
          qty = Math.min(qty, Math.floor(Math.max(0, expRoom) / price));
          if (qty < 1) {
            this.log('system', `${name} 매수 보류 (리스크/한도 내 수량 0 — 현재가 ₩${price.toLocaleString()})`);
            continue;
          }
          if (await this._riskBlocked(cfg, code, name)) continue; // 관리/투자경고·위험/거래정지 종목 차단
          const target = price + s.safety.takeProfitR * stopDist;       // +R배수 익절
          await this.buy(cfg, code, qty, price, signal.reason, { stop, target, atr: atr || 0, initRisk: stopDist });

        } else if (signal?.side === 'SELL' && held && held.qty > 0) {
          if (this.inCooldown(code)) continue; // 쿨다운 내 중복 매도 방지
          if (pending[code]?.hasSell) continue; // 미체결 매도 진행 중 — 중복 매도 방지
          const sellable = this._sellableQty(code, held.qty, s); // ★ 수동 보유 보호
          if (sellable < 1) continue;
          if (nowMin() <= manageCutoffMin()) {
            // 실시간 현재가로 지정가 청산 — 묵은 잔고가(held.curPrice, 최대 5분 전)로 내면
            // 하락장에서 미체결로 손실 보유가 길어진다(M-B). 손절 경로처럼 라이브가 우선.
            let sx = held.curPrice || 0;
            try { const live = await this.deps.getCurrentPrice(cfg, code); if (live > 0) sx = live; } catch (_) {}
            if (sx > 0) await this.sell(cfg, code, sellable, sx, signal.reason, held);
          }
        } else if (!signal && s.safety.intradayRebound && !buyingHalted) {
          // ── 장중 반등 모멘텀(분봉) — 일봉 신호가 전혀 없을 때만(SELL 신호 종목을 같은 틱에 사는 구멍 차단). ──
          //   추세필터는 의도적으로 면제(하락추세 반등을 잡는 전략). 나머지 안전장치(쿨다운·자본·시간·
          //   동시보유·리스크 사이징·종목당한도·노출한도·서킷)는 일봉 매수와 동일하게 그대로 적용한다.
          if (this.inCooldown(code)) continue;
          if (capital <= 0) continue;
          const startMin = s.safety.avoidFirst30min
            ? Math.max(timeToMin(s.safety.tradeStartTime), sessionOpenMin() + 30) : timeToMin(s.safety.tradeStartTime);
          const n = nowMin();
          if (n < startMin || n > timeToMin(s.safety.tradeEndTime)) continue;
          if ((this.state.botPositions || {})[code]) continue; // 반등 전략도 이미 보유 종목엔 추가매수 안 함
          if (this._botPositionCount() >= s.safety.maxPositions) continue;
          const rbDrop = (s.safety.rbMinDrop != null ? s.safety.rbMinDrop : -2.5);
          // ★ 1차 필터를 라이브 호출 없이 캐시/일봉으로 — 무신호 전 종목에 매 틱 라이브 getCurrentPrice가
          //   터져 폭락장 high 큐가 폭증하던 문제 차단. 시세 캐시(없으면 일봉 종가)로 낙폭과대 후보만 추린 뒤
          //   그 종목만 라이브 가격으로 정밀 확인한다.
          const prevClose = closes[closes.length - 2] || 0;
          const pc = (typeof global !== 'undefined' && global._priceCache) ? global._priceCache[code] : null;
          let estPx = (pc && pc.data && pc.data.price) || 0;
          let estPrev = (pc && pc.data && pc.data.prev > 0) ? pc.data.prev : prevClose;
          if (!estPx) estPx = closes[closes.length - 1] || 0; // 캐시 없으면 일봉 마지막 종가
          const chgEst = estPrev > 0 && estPx > 0 ? (estPx - estPrev) / estPrev * 100 : 0;
          if (chgEst > rbDrop + 1) continue; // 캐시 기준 낙폭과대 근처(+1%p 여유)만 라이브로 정밀 확인
          let price; try { price = await this.deps.getCurrentPrice(cfg, code); } catch (e) { continue; }
          if (!price || price <= 0) continue;
          const chgPct = prevClose > 0 ? (price - prevClose) / prevClose * 100 : 0;
          if (chgPct > rbDrop) continue; // 라이브 가격으로 낙폭과대 재확인
          if (!this.deps.getMinuteBars) continue;
          let mbars; try { mbars = await this.deps.getMinuteBars(cfg, code); } catch (e) { continue; }
          if (!mbars || !mbars.length) continue;
          const lows = mbars.map(b => b.low).filter(v => v > 0);
          if (!lows.length) continue;
          // 진짜 당일 저가: 분봉(최근 ~30분) 저가와 종목정보 캐시의 당일 저가(stck_lwpr) 중 더 낮은 값.
          //   분봉만 쓰면 "최근 30분 저가"라 오전 폭락저점을 놓쳐 반등폭이 과소계산됨.
          let dayLow = Math.min(...lows);
          const si = (typeof global !== 'undefined' && global._stockinfoCache) ? global._stockinfoCache[code] : null;
          const siLow = si && si.resp && si.resp.data && si.resp.data.low || 0;
          if (siLow > 0) dayLow = Math.min(dayLow, siLow);
          const rb = decideIntradayRebound(mbars, { prevClose, curPrice: price, dayLow }, {
            minDropPct: s.safety.rbMinDrop, reboundPct: s.safety.rbReboundPct,
            volMult: s.safety.rbVolMult, stopPct: s.safety.rbStopPct
          });
          if (!rb) continue;
          const stopDist = price - rb.stop;
          if (!(stopDist > 0)) continue;
          const riskAmt = capital * (s.safety.riskPerTradePct / 100);
          let qty = Math.floor(riskAmt / stopDist);
          if (!Number.isFinite(qty)) continue;
          const pendBuyAmt = pending[code]?.buyAmt || 0;
          const curHoldAmt = (held ? held.evalAmt : 0) + pendBuyAmt;
          const perStockCap = Math.min(capital * (s.safety.maxPerStockPct / 100),
                                       s.safety.maxPerStock > 0 ? s.safety.maxPerStock : Infinity); // 자본%와 절대(원) 중 작은 쪽
          qty = Math.min(qty, Math.floor(Math.max(0, perStockCap - curHoldAmt) / price));
          const expRoom = capital * (s.safety.maxExposurePct / 100) - this._botExposure(heldPositions) - pendBuyAmt;
          qty = Math.min(qty, Math.floor(Math.max(0, expRoom) / price));
          if (qty < 1) continue;
          if (await this._riskBlocked(cfg, code, name)) continue; // 관리/투자경고·위험/거래정지 종목 차단
          const target = price + s.safety.takeProfitR * stopDist;
          await this.buy(cfg, code, qty, price, rb.reason, { stop: rb.stop, target, atr: 0, initRisk: stopDist });
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

  // ★ 위험종목 매수 차단 — 관리/투자경고·위험/거래정지/정리매매 종목은 자동매수하지 않는다.
  //   조회 실패 시(getStockFlags 예외/미주입)엔 막지 않음(과차단 방지, KIS가 2차 게이트).
  async _riskBlocked(cfg, code, name) {
    if (!this.state.settings.safety.avoidWarnStocks || !this.deps.getStockFlags) return false;
    let flags;
    try { flags = await this.deps.getStockFlags(cfg, code); } catch (_) { return false; }
    if (flags && flags.blocked) { this.log('safety', `🚫 ${name} 매수 차단 — ${flags.reason} 종목`); return true; }
    return false;
  }

  // ★ 매도 가능 수량 — 수동 보유 보호가 켜져 있으면 엔진이 직접 매수한 수량까지만
  // (사용자가 손으로 산 주식을 엔진이 멋대로 파는 사고 방지)
  _sellableQty(code, heldQty, s) {
    if (!s.safety.protectManual) return heldQty; // 보호 꺼짐 = 전량 관리 (기존 동작)
    const botQty = botQtyOf(this.state.botPositions, code);
    return Math.min(botQty, heldQty);
  }

  // 미체결 주문 맵: { code: { buyAmt, buyQty, hasBuy, hasSell } } — 잔량(qty-fillQty) 기준
  _pendingMap() {
    let list = [];
    try { list = (this.deps.getPendingOrders && this.deps.getPendingOrders()) || []; } catch (_) {}
    const m = {};
    for (const e of list) {
      if (!m[e.code]) m[e.code] = { buyAmt: 0, buyQty: 0, hasBuy: false, hasSell: false };
      const remain = Math.max(0, (e.qty || 0) - (e.fillQty || 0)); // 미체결 잔량
      if (e.side === 'buy') { m[e.code].hasBuy = true; m[e.code].buyQty += remain; m[e.code].buyAmt += remain * (e.price || 0); }
      else if (e.side === 'sell') m[e.code].hasSell = true;
    }
    return m;
  }

  async buy(cfg, code, qty, price, reason, plan) {
    plan = plan || {};
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
      this.state.tradesToday = (this.state.tradesToday || 0) + 1; // 과매매 서킷용
      // 봇 포지션 기록 — 손절/목표/ATR 포함. 이 수량만큼만 엔진이 매도할 권리를 가진다.
      if (!this.state.botPositions) this.state.botPositions = {};
      const ex = this.state.botPositions[code];
      if (ex && ex.qty > 0) {
        const nq = ex.qty + qty;
        ex.entry = Math.round((ex.entry * ex.qty + price * qty) / nq); // 가중평균 진입가
        ex.qty = nq;
        ex.stop = plan.stop || ex.stop; ex.target = plan.target || ex.target;
        ex.atr = plan.atr || ex.atr; ex.initRisk = plan.initRisk || ex.initRisk;
        ex.hw = Math.max(ex.hw || ex.entry, price);
      } else {
        this.state.botPositions[code] = { qty, entry: price, stop: plan.stop || 0, target: plan.target || 0, atr: plan.atr || 0, initRisk: plan.initRisk || 0, hw: price };
      }
      this.save();
      // 낙관적 보유 반영 — 계좌 갱신 전에도 한도/노출이 누적 매수에 적용되게
      if (!this._lastHeld) this._lastHeld = {};
      const prevPos = this._lastHeld[code];
      this._lastHeld[code] = {
        qty: (prevPos?.qty || 0) + qty,
        avgPrice: price, curPrice: price, pnlPct: 0,
        evalAmt: (prevPos?.evalAmt || 0) + qty * price
      };
      const stopStr = plan.stop ? `\n손절: ₩${Math.round(plan.stop).toLocaleString()} / 목표: ₩${Math.round(plan.target||0).toLocaleString()}` : '';
      const msg = `📈 <b>매수 접수</b>\n종목: ${name} (${code})\n수량: ${qty}주 @ ₩${price.toLocaleString()}${stopStr}\n사유: ${reason}`;
      this.log('buy', `✅ 매수주문 접수 ${name} ${qty}주 @ ₩${price.toLocaleString()}` + (plan.stop?` (손절 ₩${Math.round(plan.stop).toLocaleString()})`:''), { code, qty, price, reason, stop: plan.stop, target: plan.target });
      if (this.deps.sendTelegram) await this.deps.sendTelegram(cfg, msg);
    } else {
      this.log('error', `❌ 매수 실패 ${name}: ${result?.msg1 || '알수없음'}`);
    }
  }

  async sell(cfg, code, qty, price, reason, pos, market) {
    const name = this.deps.codeToName(code) || code;
    const orderType = market ? '01' : '00'; // 손절/트레일은 시장가(체결 보장), 그 외 지정가
    const pxStr = market ? '(시장가)' : `@ ₩${price.toLocaleString()}`;
    this.log('signal', `📉 매도신호 ${name}(${code}) ${qty}주 ${pxStr} — ${reason}`);
    let result;
    try {
      result = await this.deps.placeOrder(cfg, { side:'sell', code, qty, price, orderType });
    } catch (e) {
      // 한 종목 매도 예외가 다른 보유 종목의 손절을 막지 않도록 틱을 끊지 않음 + 보수적 쿨다운
      this.lastAction[code] = Date.now();
      // 시장가 매도는 타임아웃이어도 체결됐을 가능성이 높다 → 봇 매도분으로 기록해 잔고대조에서 손실이
      // 계상되게(손실 누락→손실한도 서킷 약화 방지). 지정가는 미체결 가능성이 있어 기록하지 않음.
      if (market) { const bp = this.state.botPositions && this.state.botPositions[code];
        if (bp) { bp.lastSellPrice = price; bp._sellPending = (bp._sellPending || 0) + qty; bp._sellAt = Date.now(); } }
      this.log('error', `❌ 매도주문 예외 ${name}: ${e.message} (쿨다운 적용${market?', 시장가는 체결 가정 기록':''})`);
      return;
    }
    if (result?.rt_cd === '0') {
      this.lastAction[code] = Date.now(); // 쿨다운 시작
      // ★ 실현손익·봇 지분 차감은 '접수'가 아니라 잔고 대조(실제 체결) 시 확정한다.
      //   접수 즉시 차감하면 미체결→자동취소 시 포지션이 봇 장부에서 사라져 손절 관리가
      //   영구 중단되는 고아화 사고가 난다. 여기선 체결 확정용 기준가만 기록.
      const bp = this.state.botPositions && this.state.botPositions[code];
      if (bp) { bp.lastSellPrice = price; bp._sellPending = (bp._sellPending || 0) + qty; bp._sellAt = Date.now(); } // 실제 낸 매도분 — 잔고대조에서 이 수량만 손익 계상
      const msg = `📉 <b>매도 접수</b>\n종목: ${name} (${code})\n수량: ${qty}주 ${pxStr}\n사유: ${reason}`;
      this.log('sell', `✅ 매도주문 접수 ${name} ${qty}주 ${pxStr} — ${reason}`, { code, qty, price, reason, market });
      this.save();
      if (this.deps.sendTelegram) await this.deps.sendTelegram(cfg, msg);
    } else {
      this.log('error', `❌ 매도 실패 ${name}: ${result?.msg1 || '알수없음'}`);
    }
  }
}

module.exports = { AutoTrader, getLogs, decideSignal, decideIntradayRebound, calcRSI, calcATR, sma, RISK_PRESETS, isMarketOpen, isHoliday };
