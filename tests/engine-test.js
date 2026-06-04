/**
 * 자동매매 엔진 회귀 테스트
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

const { AutoTrader, decideSignal, calcRSI, sma } = require(path.join(__dirname, '..', 'auto-trader.js'));

let pass = 0, fail = 0;
function ok(name, cond) { cond ? (pass++, console.log('  ✅', name)) : (fail++, console.log('  ❌', name)); }

// ── 콘솔 로그 소음 줄이기 ──
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

// ════════ 2. tick() 안전성 ════════
const orders = [];
function mkDeps(opts) {
  const { chart, account, slowChartMs } = opts;
  return {
    userId: 'test_' + Math.random().toString(36).slice(2, 7),
    loadConfig: () => ({ appKey: 'K', txMode: 'vts' }),
    getVolTop: async () => ({ output: [] }),
    getStockChart: async () => { if (slowChartMs) await new Promise(r => setTimeout(r, slowChartMs)); return chart; },
    getCurrentPrice: async () => 70000,
    getAccount: async () => account,
    placeOrder: async (cfg, o) => { orders.push({ ...o }); return { rt_cd: '0' }; },
    codeToName: c => c, sendTelegram: null
  };
}
function mkTrader(deps) {
  const t = new AutoTrader(deps);
  t.state.settings.enabled = true;
  t.state.settings.watchList = ['005930'];
  t.running = true;
  return t;
}
const decChart = [...Array(30).keys()].map(i => ({ close: 300000 - i*1000 }));
const incChart = [...Array(30).keys()].map(i => ({ close: 100000 + i*1000 }));
const heldAcct = { output1: [{ pdno:'005930', hldg_qty:'10', pchs_avg_pric:'60000', prpr:'70000', evlu_pfls_rt:'16.6', evlu_amt:'700000' }] };

(async () => {
  quiet(true);

  realLog('== tick() 안전성 ==');
  // 1) 한 틱 내 중복 매도 금지 (익절 루프 + 전략 매도 이중 발화 방지)
  orders.length = 0;
  let t = mkTrader(mkDeps({ chart: incChart, account: heldAcct }));
  await t.tick();
  ok('보유종목 매도 정확히 1회/틱', orders.filter(o => o.side === 'sell').length === 1);

  // 2) 계좌 미갱신 틱에서 같은 주식 재매도 금지
  const before = orders.length;
  await t.tick();
  ok('판 주식 재매도 0회', orders.length === before);

  // 3) 같은 신호 반복 매수 금지 (쿨다운)
  orders.length = 0;
  t = mkTrader(mkDeps({ chart: decChart, account: { output1: [] } }));
  await t.tick(); await t.tick(); await t.tick();
  ok('과매도 지속 시 3틱에 매수 1회', orders.filter(o => o.side === 'buy').length === 1);

  // 4) 틱 겹침(재진입) 방지
  orders.length = 0;
  t = mkTrader(mkDeps({ chart: decChart, account: { output1: [] }, slowChartMs: 80 }));
  await Promise.all([t.tick(), t.tick()]);
  ok('동시 2틱에 매수 1회(재진입 가드)', orders.filter(o => o.side === 'buy').length === 1);

  // 5) maxPerStock 누적 상한 (낙관적 보유 반영)
  orders.length = 0;
  t = mkTrader(mkDeps({ chart: decChart, account: { output1: [] } }));
  t.state.settings.safety.maxPerStock = 1500000;
  await t.tick();
  t.lastAction['005930'] = 0; await t.tick(); // 쿨다운 만료 가정
  t.lastAction['005930'] = 0; await t.tick();
  const buys = orders.filter(o => o.side === 'buy');
  const total = buys.reduce((s, o) => s + o.qty * o.price, 0);
  ok(`누적 매수 ₩${total.toLocaleString()} ≤ 상한 ₩1,500,000`, total <= 1500000);

  // 6) KST 시간대 (서버 타임존 무관)
  realLog('== KST 시간대 ==');
  ok('KST 10:00 목요일 → 장중', t.getStatus().marketOpen === true);
  FIXED = new RealDate(RealDate.UTC(2026, 5, 4, 10, 0, 0)).getTime(); // KST 19:00
  ok('KST 19:00 → 장마감', t.getStatus().marketOpen === false);
  FIXED = new RealDate(RealDate.UTC(2026, 5, 6, 2, 0, 0)).getTime(); // 토요일 KST 11:00
  ok('토요일 → 휴장', t.getStatus().marketOpen === false);

  quiet(false);

  // ── 테스트가 만든 임시 유저 파일 정리 ──
  try {
    const ucDir = path.join(__dirname, '..', 'user-configs');
    for (const f of fs.readdirSync(ucDir)) {
      if (/^autotrade-(log|state)-test_/.test(f)) fs.unlinkSync(path.join(ucDir, f));
    }
  } catch (e) {}

  console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
  process.exit(fail ? 1 : 0);
})().catch(e => { quiet(false); console.error('테스트 오류:', e); process.exit(2); });
