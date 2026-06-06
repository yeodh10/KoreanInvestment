/**
 * 자동매매 엔진 회귀 테스트 (리스크 재설계판)
 * 실행: node tests/engine-test.js   (저장소 루트에서)
 * 외부 의존성 없음 — KIS API 호출 없이 mock으로 검증
 */
const path = require('path');
const fs = require('fs');

// ── 시간 고정: UTC 01:00 = KST 10:00 (목요일, 장중) ──
const RealDate = Date;
let FIXED = new RealDate(RealDate.UTC(2026, 5, 4, 1, 0, 0)).getTime();
global.Date = class extends RealDate {
  constructor(...a) { a.length ? super(...a) : super(FIXED); }
  static now() { return FIXED; }
};

const { AutoTrader, decideSignal, calcRSI, calcATR, sma, RISK_PRESETS } = require(path.join(__dirname, '..', 'auto-trader.js'));

let pass = 0, fail = 0;
function ok(name, cond) { cond ? (pass++, console.log('  ✅', name)) : (fail++, console.log('  ❌', name)); }

const realLog = console.log;
function quiet(on) { console.log = on ? (...a) => { if (String(a[0]).startsWith('  ')) realLog(...a); } : realLog; }

// ════════ 1. 순수 함수 ════════
realLog('== 지표/신호 단위 테스트 ==');
ok('sma 평균', sma([1,2,3,4,5],5) === 3);
ok('sma 데이터 부족 → null', sma([1,2],5) === null);
ok('RSI 단조상승 = 100', calcRSI([...Array(20).keys()].map(i=>100+i),14) === 100);
ok('RSI 단조하락 = 0', calcRSI([...Array(20).keys()].map(i=>200-i),14) === 0);
const S = { strategies:{goldenCross:true,rsi:true}, params:{maShort:5,maLong:20,rsiPeriod:14,rsiOversold:30,rsiOverbought:70} };
ok('하락장 → BUY(RSI 과매도)', decideSignal([...Array(30).keys()].map(i=>300-i), S)?.side === 'BUY');
ok('상승장 → SELL(RSI 과매수)', decideSignal([...Array(30).keys()].map(i=>100+i), S)?.side === 'SELL');
// ATR
const flatBars = [...Array(20)].map(() => ({ high: 101, low: 99, close: 100 })); // TR=2 매일
ok('calcATR 일정 변동성 = 2', calcATR(flatBars, 14) === 2);
ok('calcATR 데이터 부족 → null', calcATR(flatBars.slice(0,5), 14) === null);
ok('RISK_PRESETS 3종 존재', !!(RISK_PRESETS.conservative && RISK_PRESETS.balanced && RISK_PRESETS.aggressive));

// ════════ 2. mock 헬퍼 ════════
const orders = [];
// OHLC 차트 생성 (ATR 계산 가능)
function chartFrom(closes, band=500) { return closes.map(c => ({ open:c, high:c+band, low:c-band, close:c, vol:1000000 })); }
const decCloses = [...Array(30).keys()].map(i => 300000 - i*1000); // 하락 → RSI 과매도(BUY), 추세 아래
const incCloses = [...Array(30).keys()].map(i => 100000 + i*1000); // 상승 → RSI 과매수(SELL), 추세 위
const decChart = chartFrom(decCloses);
const incChart = chartFrom(incCloses);
// 보유: 평단 60000, 현재가 70000 (+16.6%)
const heldAcct = { output1: [{ pdno:'005930', hldg_qty:'10', pchs_avg_pric:'60000', prpr:'70000', evlu_pfls_rt:'16.6', evlu_amt:'700000' }],
                   output2: [{ dnca_tot_amt:'10000000' }] };
const cashAcct = (cash=10000000) => ({ output1: [], output2: [{ dnca_tot_amt:String(cash) }] });

function mkDeps(opts) {
  const { chart, account, slowChartMs, price } = opts;
  return {
    userId: 'test_' + Math.random().toString(36).slice(2, 7),
    loadConfig: () => ({ appKey: 'K', txMode: 'vts' }),
    getVolTop: async () => ({ output: [] }),
    getStockChart: async () => { if (slowChartMs) await new Promise(r => setTimeout(r, slowChartMs)); return chart; },
    getCurrentPrice: async () => price || 70000,
    getAccount: async () => account,
    placeOrder: async (cfg, o) => { orders.push({ ...o }); return { rt_cd: '0' }; },
    codeToName: c => c, sendTelegram: null
  };
}
function mkTrader(deps) {
  const t = new AutoTrader(deps);
  t.state.settings.enabled = true;
  t.state.settings.watchList = ['005930'];
  t.state.settings.safety.trendFilter = false; // 사이징/쿨다운 테스트는 추세필터 끔(따로 검증)
  t.running = true;
  return t;
}

(async () => {
  quiet(true);
  realLog('== tick() 안전성 (기존 보장 보존) ==');

  // 1) 한 틱 내 중복 매도 금지
  orders.length = 0;
  let t = mkTrader(mkDeps({ chart: incChart, account: heldAcct }));
  t.state.botPositions = { '005930': { qty: 10 } }; // 봇 보유(손절정보 없음 → 폴백 익절)
  await t.tick();
  ok('보유종목 매도 정확히 1회/틱', orders.filter(o => o.side === 'sell').length === 1);

  // 2) 계좌 미갱신 틱에서 재매도 금지
  const before = orders.length;
  await t.tick();
  ok('판 주식 재매도 0회', orders.length === before);

  // 2-1) 수동 보유 보호 — 봇이 안 산 주식은 매도 금지
  orders.length = 0;
  t = mkTrader(mkDeps({ chart: incChart, account: heldAcct }));
  await t.tick();
  ok('수동 매수분 매도 0회 (보호 ON)', orders.filter(o => o.side === 'sell').length === 0);

  // 2-2) 봇 지분만큼만 부분 매도 (10주 중 봇 4주)
  orders.length = 0;
  t = mkTrader(mkDeps({ chart: incChart, account: heldAcct }));
  t.state.botPositions = { '005930': { qty: 4 } };
  await t.tick();
  const ps = orders.find(o => o.side === 'sell');
  ok('봇 지분 4주만 매도 (수동 6주 보존)', !!ps && ps.qty === 4);

  // 2-3) 보호 OFF → 전량 매도
  orders.length = 0;
  t = mkTrader(mkDeps({ chart: incChart, account: heldAcct }));
  t.state.settings.safety.protectManual = false;
  await t.tick();
  const f2 = orders.find(o => o.side === 'sell');
  ok('보호 OFF 시 전량(10주) 매도', !!f2 && f2.qty === 10);

  // 3) 쿨다운 — 과매도 지속 3틱에 매수 1회
  orders.length = 0;
  t = mkTrader(mkDeps({ chart: decChart, account: cashAcct() }));
  await t.tick(); await t.tick(); await t.tick();
  ok('과매도 지속 시 3틱에 매수 1회', orders.filter(o => o.side === 'buy').length === 1);

  // 4) 틱 겹침(재진입) 방지
  orders.length = 0;
  t = mkTrader(mkDeps({ chart: decChart, account: cashAcct(), slowChartMs: 80 }));
  await Promise.all([t.tick(), t.tick()]);
  ok('동시 2틱에 매수 1회(재진입 가드)', orders.filter(o => o.side === 'buy').length === 1);

  realLog('== 리스크 모델 ==');

  // 5) 리스크 기반 사이징 — 종목당 한도(자본 20%) 초과 금지
  orders.length = 0;
  t = mkTrader(mkDeps({ chart: decChart, account: cashAcct(10000000), price: 270000 }));
  await t.tick();
  const buy = orders.find(o => o.side === 'buy');
  ok('매수 발생', !!buy);
  ok('종목당 한도(자본 20%=200만) 이내', !!buy && buy.qty * buy.price <= 2000000);
  ok('거래당 위험 ≈ 자본 0.7% 이하로 사이징', (() => {
    const bp = t.state.botPositions['005930']; if (!bp) return false;
    const risk = bp.qty * (bp.entry - bp.stop); return risk <= 70000 * 1.05; // 70000=10M*0.7%
  })());

  // 6) 포지션에 손절/목표 기록 (stop < 진입 < target)
  ok('포지션 손절<진입<목표 기록', (() => {
    const bp = t.state.botPositions['005930'];
    return bp && bp.stop > 0 && bp.stop < bp.entry && bp.target > bp.entry;
  })());

  // 7) 추세 필터 — 하락추세(가격<MA20)면 매수 금지
  orders.length = 0;
  t = mkTrader(mkDeps({ chart: decChart, account: cashAcct(), price: 270000 }));
  t.state.settings.safety.trendFilter = true;
  await t.tick();
  ok('추세필터 ON → 하락추세 매수 0회', orders.filter(o => o.side === 'buy').length === 0);

  // 8) 일일 손실 서킷브레이커 — 자본 -2% 도달 시 신규매수 정지
  orders.length = 0;
  t = mkTrader(mkDeps({ chart: decChart, account: cashAcct(10000000), price: 270000 }));
  await t.tick(); // capital 세팅(1틱) — 첫틱에서 매수 1회 날 수 있음
  orders.length = 0;
  t.state.dailyRealizedPnl = -250000; // -2.5% < -2%
  t.lastAction['005930'] = 0; // 쿨다운 해제
  await t.tick();
  ok('일일손실 -2% 초과 → 신규매수 정지', orders.filter(o => o.side === 'buy').length === 0);
  ok('stoppedByLoss 플래그 set', t.state.stoppedByLoss === true);

  // 9) 연속손실 서킷브레이커 (균형=3패)
  orders.length = 0;
  t = mkTrader(mkDeps({ chart: decChart, account: cashAcct(10000000), price: 270000 }));
  await t.tick();
  orders.length = 0;
  t.state.consecLosses = 3;
  t.lastAction['005930'] = 0;
  await t.tick();
  ok('연속 3패 → 신규매수 정지', orders.filter(o => o.side === 'buy').length === 0);

  // 10) 동시보유 종목수 상한 (균형=5) — 이미 5종목이면 신규 종목 매수 금지
  // (계좌가 5종목을 실제 보유해야 잔고대조에서 봇 포지션이 유지됨)
  orders.length = 0;
  const five = ['A','B','C','D','E'];
  const acct5 = { output2:[{dnca_tot_amt:'10000000'}],
    output1: five.map(c => ({ pdno:c, hldg_qty:'1', pchs_avg_pric:'1000', prpr:'1000', evlu_pfls_rt:'0', evlu_amt:'1000' })) };
  t = mkTrader(mkDeps({ chart: decChart, account: acct5, price: 270000 }));
  t.state.botPositions = { A:{qty:1},B:{qty:1},C:{qty:1},D:{qty:1},E:{qty:1} }; // 5종목
  await t.tick();
  ok('동시보유 5 초과 신규 매수 금지', orders.filter(o => o.side === 'buy').length === 0);

  // 11) 손실 서킷이어도 보유 포지션 손절은 계속 (리스크 축소)
  orders.length = 0;
  t = mkTrader(mkDeps({ chart: incChart, account: heldAcct, price: 70000 }));
  t.state.botPositions = { '005930': { qty: 10, entry: 60000, stop: 65000, target: 90000, atr: 1000, initRisk: 1000, hw: 70000 } };
  t.state.stoppedByLoss = true; // 신규매수 정지 상태
  await t.tick();
  ok('정지 상태에서도 익절(목표 도달) 매도 실행', orders.filter(o => o.side === 'sell').length === 1);

  realLog('== KST 시간대 ==');
  t = mkTrader(mkDeps({ chart: decChart, account: cashAcct() }));
  ok('KST 10:00 목요일 → 장중', t.getStatus().marketOpen === true);
  FIXED = new RealDate(RealDate.UTC(2026, 5, 4, 10, 0, 0)).getTime();
  ok('KST 19:00 → 장마감', t.getStatus().marketOpen === false);
  FIXED = new RealDate(RealDate.UTC(2026, 5, 6, 2, 0, 0)).getTime();
  ok('토요일 → 휴장', t.getStatus().marketOpen === false);

  quiet(false);

  // 임시 유저 파일 정리
  try {
    const ucDir = path.join(__dirname, '..', 'user-configs');
    for (const f of fs.readdirSync(ucDir)) {
      if (/^autotrade-(log|state)-test_/.test(f)) fs.unlinkSync(path.join(ucDir, f));
    }
  } catch (e) {}

  console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
  process.exit(fail ? 1 : 0);
})().catch(e => { quiet(false); console.error('테스트 오류:', e); process.exit(2); });
