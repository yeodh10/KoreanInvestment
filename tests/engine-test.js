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

const { AutoTrader, decideSignal, decideIntradayRebound, calcRSI, calcATR, sma, RISK_PRESETS } = require(path.join(__dirname, '..', 'auto-trader.js'));

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

// ════════ 1-b. 장중 반등 모멘텀 (decideIntradayRebound) ════════
realLog('== 장중 반등 신호 ==');
const mbars = (closes, vols) => closes.map((c, i) => ({ open: c - 1, high: c + 1, low: c - 2, close: c, vol: vols ? vols[i] : 1000 }));
// 상승 꼬리 분봉(단기이평 상향) + 마지막 거래량 급증
const rbCloses = [96000, 95800, 95500, 95300, 95000, 95500, 96000, 96500, 97000, 97000];
const rbVols   = [1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 3000];
const rbBars = mbars(rbCloses, rbVols);
const ctxOK = { prevClose: 100000, curPrice: 97000, dayLow: 95000 }; // 당일 -3%, 저가대비 +2.1%
const rb = decideIntradayRebound(rbBars, ctxOK);
ok('4조건 충족 → BUY', rb && rb.side === 'BUY');
ok('손절 = 현재가 -2%', rb && rb.stop === Math.round(97000 * 0.98));
ok('낙폭 부족(-1.5%) → null', decideIntradayRebound(rbBars, { prevClose: 100000, curPrice: 98500, dayLow: 95000 }) === null);
ok('저가대비 반등 부족 → null', decideIntradayRebound(rbBars, { prevClose: 100000, curPrice: 97000, dayLow: 96500 }) === null);
ok('거래량 미급증 → null', decideIntradayRebound(mbars(rbCloses), ctxOK) === null); // vol 전부 1000
ok('분봉 이평 하락 → null', decideIntradayRebound(mbars([97000,96800,96500,96300,96000,95800,95500,95300,95000,95000], rbVols), ctxOK) === null);
ok('데이터 부족 → null', decideIntradayRebound(rbBars.slice(0, 3), ctxOK) === null);

// ════════ 2. mock 헬퍼 ════════
const orders = [];
// OHLC 차트 생성 (ATR 계산 가능)
function chartFrom(closes, band=500) { return closes.map(c => ({ open:c, high:c+band, low:c-band, close:c, vol:1000000 })); }
const decCloses = [...Array(30).keys()].map(i => 300000 - i*1000); // 하락 → RSI 과매도(BUY), 추세 아래
const incCloses = [...Array(30).keys()].map(i => 100000 + i*1000); // 상승 → RSI 과매수(SELL), 추세 위
const decChart = chartFrom(decCloses);
const incChart = chartFrom(incCloses);
// 보유: 평단 60000, 현재가 70000 (+16.6%)
const heldAcct = { rt_cd:'0', output1: [{ pdno:'005930', hldg_qty:'10', pchs_avg_pric:'60000', prpr:'70000', evlu_pfls_rt:'16.6', evlu_amt:'700000' }],
                   output2: [{ dnca_tot_amt:'10000000' }] };
const cashAcct = (cash=10000000) => ({ rt_cd:'0', output1: [], output2: [{ dnca_tot_amt:String(cash) }] });

function mkDeps(opts) {
  const { chart, account, slowChartMs, price } = opts;
  return {
    userId: 'test_' + Math.random().toString(36).slice(2, 7),
    loadConfig: () => ({ appKey: 'K', txMode: 'vts' }),
    getVolTop: async () => ({ output: [] }),
    getStockChart: async () => { if (slowChartMs) await new Promise(r => setTimeout(r, slowChartMs)); return chart; },
    getCurrentPrice: async () => price || 70000,
    getMinuteBars: async () => opts.minBars || null,
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

  // 5-2) 종목당 절대 한도(원) — maxPerStock 설정 시 그 금액 이내로 사이징 (자본%보다 작으면 절대값이 바인딩)
  orders.length = 0;
  t = mkTrader(mkDeps({ chart: decChart, account: cashAcct(10000000), price: 270000 }));
  t.state.settings.safety.maxPerStock = 1000000; // 절대 100만 한도 (자본20%=200만보다 작음 → 이게 바인딩)
  await t.tick();
  const absBuy = orders.find(o => o.side === 'buy');
  ok('절대 종목당한도(100만) 이내로 매수', !!absBuy && absBuy.qty * absBuy.price <= 1000000);

  // 5-3) 절대 한도 0(미설정) → 자본%(20%=200만)만 적용, 100만 초과 가능 (절대값이 비활성임을 확인)
  orders.length = 0;
  t = mkTrader(mkDeps({ chart: decChart, account: cashAcct(10000000), price: 270000 }));
  t.state.settings.safety.maxPerStock = 0; // 미설정 → 자본 20% 한도(200만)만 적용
  await t.tick();
  const pctBuy = orders.find(o => o.side === 'buy');
  ok('절대한도 0이면 %한도(200만)까지 허용', !!pctBuy && pctBuy.qty * pctBuy.price > 1000000 && pctBuy.qty * pctBuy.price <= 2000000);

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

  // 7-1) 위험종목 필터 — 관리/투자경고/거래정지 종목 매수 차단
  orders.length = 0;
  t = mkTrader(mkDeps({ chart: decChart, account: cashAcct() }));
  t.deps.getStockFlags = async () => ({ blocked: true, reason: '관리종목' });
  await t.tick();
  ok('위험종목(blocked) 매수 0회', orders.filter(o => o.side === 'buy').length === 0);

  // 7-2) 정상 종목(blocked=false)은 매수 진행
  orders.length = 0;
  t = mkTrader(mkDeps({ chart: decChart, account: cashAcct() }));
  t.deps.getStockFlags = async () => ({ blocked: false });
  await t.tick();
  ok('정상종목(blocked=false) 매수 진행', orders.filter(o => o.side === 'buy').length === 1);

  // 7-3) avoidWarnStocks OFF → 필터 미적용(위험종목도 매수)
  orders.length = 0;
  t = mkTrader(mkDeps({ chart: decChart, account: cashAcct() }));
  t.state.settings.safety.avoidWarnStocks = false;
  t.deps.getStockFlags = async () => ({ blocked: true, reason: '관리종목' });
  await t.tick();
  ok('avoidWarnStocks OFF → 위험종목도 매수', orders.filter(o => o.side === 'buy').length === 1);

  // 7-4) getStockFlags 조회 예외 → 차단 안 함(과차단 방지)
  orders.length = 0;
  t = mkTrader(mkDeps({ chart: decChart, account: cashAcct() }));
  t.deps.getStockFlags = async () => { throw new Error('조회 실패'); };
  await t.tick();
  ok('getStockFlags 예외 시 매수 진행(과차단 방지)', orders.filter(o => o.side === 'buy').length === 1);

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

  // 8-1) 미실현 손실까지 더해 한도 도달 → 신규매수 비고착 보류(H3) — 실현손익 0이라도 평가손실이 크면 진입 차단
  const uT = mkTrader(mkDeps({ chart: decChart, account: cashAcct() }));
  uT.state.botPositions = { '000660': { qty: 10, entry: 100000 } };
  ok('_botUnrealized 평가손익(-300,000)', uT._botUnrealized({ '000660': { curPrice: 70000 } }) === -300000);
  orders.length = 0;
  const lossAcct = { rt_cd:'0',
    output1: [{ pdno:'000660', hldg_qty:'10', pchs_avg_pric:'100000', prpr:'70000', evlu_pfls_rt:'-30', evlu_amt:'700000' }],
    output2: [{ dnca_tot_amt:'9300000', nass_amt:'10000000' }] };
  t = mkTrader(mkDeps({ chart: decChart, account: lossAcct, price: 270000 }));
  t.state.botPositions = { '000660': { qty:10, entry:100000, stop:50000, target:500000, atr:1000, initRisk:1000, hw:100000 } };
  t.tickCount = 0; // 잔고 갱신 틱
  await t.tick();
  ok('미실현 손실 포함 한도 도달 → 신규매수 보류', orders.filter(o => o.side === 'buy').length === 0);
  ok('비고착 — stoppedByLoss는 set 안 됨(회복 시 재개)', t.state.stoppedByLoss === false);

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
  const acct5 = { rt_cd:'0', output2:[{dnca_tot_amt:'10000000'}],
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

  realLog('== 체결 정합성 (접수≠체결, 고아화 방지) ==');
  const flatChart = chartFrom([...Array(30)].map(() => 70000)); // 신호 없음 — 보유 관리만 격리 검증

  // 12) 손절 트리거 → 시장가('01') 주문 + 접수만으로 봇지분/실현손익 불변 (고아화 방지)
  orders.length = 0;
  t = mkTrader(mkDeps({ chart: flatChart, account: heldAcct, price: 70000 }));
  t.state.botPositions = { '005930': { qty:10, entry:60000, stop:75000, target:120000, atr:1000, initRisk:1000, hw:70000 } };
  await t.tick();
  const stopSell = orders.find(o => o.side === 'sell');
  ok('손절 트리거 시 시장가(01) 매도', !!stopSell && stopSell.orderType === '01');
  ok('매도 접수만으로 봇 지분 차감 안 함', t.state.botPositions['005930'] && t.state.botPositions['005930'].qty === 10);
  ok('매도 접수 시점 실현손익 미확정(0)', t.state.dailyRealizedPnl === 0);

  // 13) 잔고 대조로 매도 체결 확정 → 실현손익 계상 + 봇 지분 제거 (_sellPending=실제 낸 매도분)
  orders.length = 0;
  t = mkTrader(mkDeps({ chart: flatChart, account: cashAcct(10000000) })); // 실보유 0 = 전량 체결됨
  t.state.botPositions = { '005930': { qty:10, entry:60000, stop:0, lastSellPrice:66000, _sellPending:10 } };
  t.tickCount = 0; // 다음 틱에서 잔고 갱신(tickCount%5===1)
  await t.tick();
  // gross +60,000 에서 왕복 거래비용(0.15%)을 차감해 보수적으로 계상
  const cost13 = (66000 + 60000) * 10 * 0.0015; // 1,890
  ok('잔고 대조로 체결 확정 — 실현손익(거래비용 차감) 계상', t.state.dailyRealizedPnl === 60000 - cost13);
  ok('체결 확정 후 봇 지분 제거', !t.state.botPositions['005930']);

  // 13-1) 부분체결 매수 후 잔여취소 → 미체결분이 '매도'로 오계상되지 않음(유령 손익 방지)
  orders.length = 0;
  t = mkTrader(mkDeps({ chart: flatChart, account: heldAcct, price: 70000 })); // 실보유 005930 10주
  t.state.botPositions = { '005930': { qty:14, entry:60000, stop:50000, target:200000, atr:1000, initRisk:1000, hw:70000 } }; // 14주 낙관기록, _sellPending 없음
  t.deps.getPendingOrders = () => []; // 미체결 4주가 취소됨 → pendBuyQty 0
  t.tickCount = 0;
  await t.tick();
  ok('미체결 매수 취소분이 매도로 오계상 안 됨(손익 0)', t.state.dailyRealizedPnl === 0);
  ok('봇 지분은 실보유로 축소(14→10), 손익 미발생', t.state.botPositions['005930'] && t.state.botPositions['005930'].qty === 10);

  // 13-2) _sellPending 누수 정리 — 지정가 매도 미체결 취소 후 6분 경과 시 정리(수동매도 오귀속 방지)
  orders.length = 0;
  t = mkTrader(mkDeps({ chart: flatChart, account: heldAcct, price: 70000 })); // 보유 005930 10, 잔고 불변
  t.state.botPositions = { '005930': { qty:10, entry:60000, stop:50000, target:200000, atr:1000, initRisk:1000, hw:70000, lastSellPrice:55000, _sellPending:10, _sellAt: FIXED - 7*60*1000 } };
  t.deps.getPendingOrders = () => []; // 미체결 매도 없음(취소됨)
  t.tickCount = 0;
  await t.tick();
  ok('미체결 취소된 _sellPending 6분 후 0으로 정리', (t.state.botPositions['005930']._sellPending||0) === 0);
  ok('정리 과정에서 손익 오계상 없음', t.state.dailyRealizedPnl === 0);

  // 13-3) 결합버그 — 체결로 잔고가 빠졌고 _sellAt>6분이어도 손실이 누수정리에 먹히지 않고 정상 계상
  orders.length = 0;
  t = mkTrader(mkDeps({ chart: flatChart, account: cashAcct(10000000) })); // 실보유 0 = 전량 체결
  t.state.botPositions = { '005930': { qty:10, entry:60000, stop:0, lastSellPrice:55000, _sellPending:10, _sellAt: FIXED - 7*60*1000 } };
  t.tickCount = 0;
  await t.tick();
  const cost133 = (55000 + 60000) * 10 * 0.0015; // 1,725 (왕복 거래비용)
  ok('체결+_sellAt>6분 → 실현손실(거래비용 차감) 정상 계상(누수정리에 안 먹힘)', t.state.dailyRealizedPnl === -50000 - cost133);
  ok('연속손실 +1 반영', t.state.consecLosses === 1);
  ok('체결 확정 후 봇 지분 제거', !t.state.botPositions['005930']);

  // 15-2) 빈 잔고 일시 유예 — 직전 보유가 있었는데 갑자기 빈 응답이면 한 틱 보류, 연속이면 청산 확정
  orders.length = 0;
  t = mkTrader(mkDeps({ chart: flatChart, account: heldAcct, price: 70000 }));
  t.state.botPositions = { '005930': { qty:10, entry:60000, stop:50000, target:200000, atr:1000, initRisk:1000, hw:70000 } };
  t.tickCount = 0; await t.tick(); // 첫 잔고 반영
  t.deps.getAccount = async () => ({ rt_cd:'0', output1: [], output2:[{dnca_tot_amt:'10000000'}] }); // 빈 응답
  t.tickCount = 0; await t.tick();
  ok('빈 잔고 1회 — 봇 지분 보존(유예)', t.state.botPositions['005930'] && t.state.botPositions['005930'].qty === 10);
  t.tickCount = 0; await t.tick();
  ok('빈 잔고 연속 — 청산 확정(봇 지분 제거)', !t.state.botPositions['005930']);

  // 14) 부분체결: 미체결 매수 잔량이 있으면 봇 지분을 매도로 오삭감하지 않음
  orders.length = 0;
  t = mkTrader(mkDeps({ chart: flatChart, account: heldAcct, price: 70000 })); // 실보유 10
  t.state.botPositions = { '005930': { qty:14, entry:60000, stop:50000, target:200000, atr:1000, initRisk:1000, hw:70000 } }; // 봇 14주 주문분
  t.deps.getPendingOrders = () => [{ code:'005930', side:'buy', qty:4, fillQty:0, price:60000 }]; // 4주 미체결
  t.tickCount = 0;
  await t.tick();
  ok('부분체결 중 봇 지분 오삭감 안 함 (실보유10+미체결4=14)', t.state.botPositions['005930'] && t.state.botPositions['005930'].qty === 14);
  ok('부분체결 중 실현손익 오계상 안 함(0)', t.state.dailyRealizedPnl === 0);

  // 15) 잔고 오류 응답(rt_cd≠0)이 봇 지분을 지우지 않음
  orders.length = 0;
  t = mkTrader(mkDeps({ chart: flatChart, account: { rt_cd:'1', msg1:'오류', output1: [] } }));
  t.state.botPositions = { '005930': { qty:10, entry:60000, stop:0 } };
  t.tickCount = 0;
  await t.tick();
  ok('오류 응답 시 봇 지분 보존 (전 포지션 무관리화 방지)', t.state.botPositions['005930'] && t.state.botPositions['005930'].qty === 10);

  // 16) 설정 검증·클램프 — 비수치/극단값이 "NaN"/Infinity 주문으로 이어지지 않음
  orders.length = 0;
  t = mkTrader(mkDeps({ chart: decChart, account: cashAcct(10000000), price: 270000 }));
  t.updateSettings({ safety: { riskPerTradePct: 'abc', stopAtrMult: 0, maxPerStockPct: NaN, dailyLossLimitPct: 5 } });
  ok('riskPerTradePct 비수치 → 기본 0.7 클램프', t.state.settings.safety.riskPerTradePct === 0.7);
  ok('stopAtrMult 0 → 하한(≥0.3) 클램프', t.state.settings.safety.stopAtrMult >= 0.3);
  ok('maxPerStockPct NaN → 기본 20', t.state.settings.safety.maxPerStockPct === 20);
  ok('dailyLossLimitPct 양수 입력 → 음수로 클램프', t.state.settings.safety.dailyLossLimitPct < 0);
  await t.tick();
  ok('극단 설정에도 유한·≥1 수량 주문만', orders.filter(o => o.side === 'buy').every(o => Number.isFinite(o.qty) && o.qty >= 1));

  realLog('== 장중 반등 전략 (엔진 통합) ==');
  const rebBars = [66000,65800,65500,65300,65000,65500,66000,66500,67000,67000].map((c,i)=>({open:c-1,high:c+1,low:c-2,close:c,vol:i===9?3000:1000}));
  // 17) ON + 낙폭과대(-4.3%) + 분봉 반등 → 매수, 추세필터 켜져 있어도 면제
  // (캐시-우선 1차 필터를 위해 _priceCache에 라이브가 들어와 있는 실제 장중 상황을 재현)
  orders.length = 0;
  global._priceCache = { '005930': { t: Date.now(), data: { price: 67000, prev: 70000 } } };
  t = mkTrader(mkDeps({ chart: flatChart, account: cashAcct(10000000), price: 67000, minBars: rebBars }));
  t.state.settings.safety.intradayRebound = true;
  t.state.settings.safety.trendFilter = true; // 면제 확인용
  await t.tick();
  ok('장중반등 ON → 낙폭과대 반등 매수(추세필터 면제)', orders.filter(o => o.side === 'buy').length === 1);
  ok('장중반등 손절 -2% 반영', !!t.state.botPositions['005930'] && t.state.botPositions['005930'].stop === Math.round(67000 * 0.98));

  // 18) OFF → 매수 0 (기본 동작 불변)
  orders.length = 0;
  t = mkTrader(mkDeps({ chart: flatChart, account: cashAcct(10000000), price: 67000, minBars: rebBars }));
  t.state.settings.safety.intradayRebound = false;
  await t.tick();
  ok('장중반등 OFF → 매수 0(기본 불변)', orders.filter(o => o.side === 'buy').length === 0);

  // 19) 낙폭 부족(-1%)이면 라이브/분봉 조회 없이 미진입 (캐시 1차 필터에서 컷)
  orders.length = 0;
  global._priceCache = { '005930': { t: Date.now(), data: { price: 69300, prev: 70000 } } };
  t = mkTrader(mkDeps({ chart: flatChart, account: cashAcct(10000000), price: 69300, minBars: rebBars }));
  t.state.settings.safety.intradayRebound = true;
  await t.tick();
  ok('낙폭 부족(-1%) → 장중반등 미진입', orders.filter(o => o.side === 'buy').length === 0);
  global._priceCache = {}; // 정리

  // 20) 이미 봇이 보유한 종목은 BUY 신호가 떠도 추가매수 안 함 (분할 몰빵·한도찬 종목 헛시도 방지)
  //     heldAcct(005930 10주 보유)와 botPositions를 일치시켜 잔고대조에 안 지워지게 한 뒤 BUY 신호 확인
  orders.length = 0;
  t = mkTrader(mkDeps({ chart: decChart, account: heldAcct, price: 60000 }));
  t.state.botPositions = { '005930': { qty: 10, entry: 60000, stop: 58000 } }; // 실보유와 일치
  await t.tick();
  ok('이미 봇 보유 종목은 추가매수 안 함(몰빵 방지)', orders.filter(o => o.side === 'buy').length === 0);

  realLog('== KST 시간대 ==');
  t = mkTrader(mkDeps({ chart: decChart, account: cashAcct() }));
  ok('KST 10:00 목요일 → 장중', t.getStatus().marketOpen === true);
  FIXED = new RealDate(RealDate.UTC(2026, 5, 4, 10, 0, 0)).getTime();
  ok('KST 19:00 → 장마감', t.getStatus().marketOpen === false);
  FIXED = new RealDate(RealDate.UTC(2026, 5, 6, 2, 0, 0)).getTime();
  ok('토요일 → 휴장', t.getStatus().marketOpen === false);

  // 2027 휴장일 — 설 대체공휴일(2/8 월) 정오 → 휴장
  FIXED = new RealDate(RealDate.UTC(2027, 1, 8, 3, 0, 0)).getTime(); // KST 12:00
  ok('2027 설 대체공휴일 → 휴장', t.getStatus().marketOpen === false);
  // 단축장(수능 2026-11-19, 10:00~16:30) — 늦장개장 전/중/연장마감 검증
  FIXED = new RealDate(RealDate.UTC(2026, 10, 19, 0, 30, 0)).getTime(); // KST 09:30
  ok('수능일 09:30(늦장개장 전) → 휴장', t.getStatus().marketOpen === false);
  FIXED = new RealDate(RealDate.UTC(2026, 10, 19, 1, 30, 0)).getTime(); // KST 10:30
  ok('수능일 10:30 → 장중', t.getStatus().marketOpen === true);
  FIXED = new RealDate(RealDate.UTC(2026, 10, 19, 7, 0, 0)).getTime();  // KST 16:00
  ok('수능일 16:00(연장 마감 전) → 장중', t.getStatus().marketOpen === true);

  // 매도/관리 컷오프 = 세션 마감 10분 전 (단축장 자동 반영) — 손절 트리거 포지션으로 검증
  const stopPos = () => ({ '005930': { qty:10, entry:60000, stop:75000, target:120000, atr:1000, initRisk:1000, hw:70000 } });
  // 정규장 2026-06-04(목) 15:25 — 마감 15:30, 컷오프 15:20 지남 → 손절 관리 보류
  orders.length = 0;
  FIXED = new RealDate(RealDate.UTC(2026, 5, 4, 6, 25, 0)).getTime();
  t = mkTrader(mkDeps({ chart: flatChart, account: heldAcct, price: 70000 }));
  t.state.botPositions = stopPos();
  await t.tick();
  ok('정규장 15:25(컷오프 후) 손절 관리 보류', orders.filter(o => o.side === 'sell').length === 0);
  // 단축장 2026-11-19(수능) 15:25 — 마감 16:30, 컷오프 16:20 전 → 아직 손절 관리 실행
  orders.length = 0;
  FIXED = new RealDate(RealDate.UTC(2026, 10, 19, 6, 25, 0)).getTime();
  t = mkTrader(mkDeps({ chart: flatChart, account: heldAcct, price: 70000 }));
  t.state.botPositions = stopPos();
  await t.tick();
  ok('단축장 15:25(컷오프 전) 손절 관리 실행', orders.filter(o => o.side === 'sell').length === 1);

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
