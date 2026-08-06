/**
 * 전략 백테스트 — 구 전략(골든크로스+RSI) vs 신 전략(추세 돌파+트레일링) 성과 비교
 *
 * 실행 (저장소 루트에서):
 *   node tools/backtest.js                 # 네이버 일봉 실데이터 (기본 3년, 기본 종목 50)
 *   node tools/backtest.js --years 5       # 기간 변경
 *   node tools/backtest.js --codes 005930,000660
 *   node tools/backtest.js --synthetic     # 네트워크 불가 환경: 합성 시나리오(상승/하락/횡보 혼합, 시드 고정)
 *
 * 정직한 비교를 위한 원칙:
 *   - 신 전략 신호는 운영 코드(auto-trader.js decideSignal/isMarketBear)를 그대로 사용 (별도 재구현 없음)
 *   - 두 전략 모두 동일한 리스크 사이징(자본 1,000만, 거래당 0.7%)·동일 데이터·동일 거래비용 적용
 *   - 진입은 신호 다음날 시가(당일 종가 진입의 낙관 편향 제거), 손절은 당일 저가가 스치면 체결로 간주(보수적)
 *   - 거래비용: 수수료 0.015%×2 + 매도 거래세 0.15% + 슬리피지 왕복 0.15% ≈ 왕복 0.33%
 *
 * ⚠️ 백테스트는 미래 수익 보장이 아니다. 과최적화를 피하려 파라미터는 운영 기본값 그대로만 검증한다.
 */
const path = require('path');
const https = require('https');
const { decideSignal, isMarketBear, calcRSI, calcATR, sma } = require(path.join(__dirname, '..', 'auto-trader.js'));

// ── 설정 ──
const CAPITAL = 10_000_000;          // 가상 자본 1,000만원
const RISK_PCT = 0.7;                // 거래당 위험 0.7% (균형 프리셋)
const COST_RATE = 0.0033 / 2;        // 왕복 0.33% → 편도 0.165% (진입·청산 각각 명목가에 부과)
const STOP_ATR = 1.5, TRAIL_R = 1.0; // 운영 기본값
const OLD = { maShort: 5, maLong: 20, rsiPeriod: 14, rsiOversold: 30, rsiOverbought: 70, takeProfitR: 2.0 };
const NEW_S = { strategies: { breakout: true, regimeFilter: true },
                params: { breakoutPeriod: 20, exitPeriod: 10, bkVolMult: 1.5, maLong: 20, atrPeriod: 14 } };
const DEFAULT_CODES = ['005930','000660','373220','207940','005380','000270','068270','005490','105560','028260',
  '051910','012330','055550','086790','323410','006400','066570','035720','035420','015760',
  '034020','096770','011170','000720','003670','010130','033780','000120','010950','003490',
  '032830','000810','316140','024110','138040','329180','012450','003550','034730','017670',
  '030200','032640','009150','402340','259960','036570','251270','042700','011200','047050'];
const MARKET_PROXY = '069500'; // KODEX 200 — 시장 레짐용

// ── 인자 ──
const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d; };
const YEARS = parseInt(arg('years', '3')) || 3;
const CODES = (arg('codes', '') || DEFAULT_CODES.join(',')).split(',').map(s => s.trim()).filter(Boolean);
const SYNTHETIC = argv.includes('--synthetic');

// ── 데이터: 네이버 일봉 ──
function fetchNaver(code, years) {
  return new Promise((resolve, reject) => {
    const end = new Date(), start = new Date(end.getTime() - years * 365 * 86400e3);
    const fmt = d => d.toISOString().slice(0, 10).replace(/-/g, '');
    const req = https.request({
      hostname: 'api.finance.naver.com',
      path: `/siseJson.naver?symbol=${code}&requestType=1&startTime=${fmt(start)}&endTime=${fmt(end)}&timeframe=day`,
      method: 'GET', headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://finance.naver.com/' }, timeout: 15000
    }, res => {
      let buf = ''; res.on('data', c => buf += c);
      res.on('end', () => {
        try {
          const rows = JSON.parse(buf.replace(/'/g, '"').replace(/,\s*]/g, ']'));
          const bars = rows.slice(1).map(r => ({ date: String(r[0]), open: +r[1], high: +r[2], low: +r[3], close: +r[4], vol: +r[5] }))
            .filter(b => b.close > 0 && b.open > 0);
          resolve(bars);
        } catch (e) { reject(new Error('파싱 실패: ' + e.message)); }
      });
    });
    req.on('error', reject); req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

// ── 합성 데이터 (시드 고정 — 재현 가능) : 상승/하락/횡보 레짐 블록 + 노이즈 + 급등일 거래량 스파이크 ──
function mulberry32(a) { return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
function genSynthetic(seed, days) {
  const rnd = mulberry32(seed);
  const bars = []; let px = 50000 + rnd() * 100000;
  let day = 0;
  while (day < days) {
    const r = rnd();
    const regime = r < 0.35 ? 'up' : r < 0.6 ? 'down' : 'side';    // 35% 상승 / 25% 하락 / 40% 횡보
    const len = 15 + Math.floor(rnd() * 40);                        // 레짐 15~55일 지속
    const drift = regime === 'up' ? 0.004 : regime === 'down' ? -0.004 : 0;
    for (let i = 0; i < len && day < days; i++, day++) {
      const chg = drift + (rnd() - 0.5) * 0.03;                     // 일 변동 ±1.5% 노이즈
      const open = px * (1 + (rnd() - 0.5) * 0.008);
      px = Math.max(1000, px * (1 + chg));
      const hi = Math.max(open, px) * (1 + rnd() * 0.012);
      const lo = Math.min(open, px) * (1 - rnd() * 0.012);
      const vol = Math.round(1e6 * (0.6 + rnd() * 0.8) * (Math.abs(chg) > 0.02 ? 2.5 : 1)); // 급등락일 거래량 스파이크
      bars.push({ date: 'D' + day, open: Math.round(open), high: Math.round(hi), low: Math.round(lo), close: Math.round(px), vol });
    }
  }
  return bars;
}

// ── 구 전략 신호 (제거 전 로직 재현 — 골든크로스+레짐, RSI 눌림목/과매수) ──
function oldSignal(closes) {
  const p = OLD;
  if (closes.length < p.maLong + 1) return null;
  const cur = closes[closes.length - 1];
  const maLongAll = sma(closes, p.maLong);
  const sN = sma(closes, p.maShort), lN = sma(closes, p.maLong);
  const prev = closes.slice(0, -1);
  const sP = sma(prev, p.maShort), lP = sma(prev, p.maLong);
  const sig = [];
  if (sP && lP && sN && lN) {
    if (sP <= lP && sN > lN && lN > lP) sig.push({ side: 'BUY' });
    if (sP >= lP && sN < lN) sig.push({ side: 'SELL' });
  }
  const rsi = calcRSI(closes, p.rsiPeriod);
  if (rsi !== null) {
    if (rsi <= p.rsiOversold && maLongAll != null && cur > maLongAll) sig.push({ side: 'BUY' });
    if (rsi >= p.rsiOverbought) sig.push({ side: 'SELL' });
  }
  if (!sig.length) return null;
  return sig.find(s => s.side === 'SELL') || sig[0];
}

// ── 시뮬레이션 코어 ──
// mode 'old': 고정 2R 익절 + 신호 매도(데드크로스/RSI70) + 1R 후 본전/ATR 트레일
// mode 'new': 부분익절(+1R 절반) + 샹들리에 트레일 + 10일 저가 이탈, 시장 레짐 필터
function simulate(bars, mode, idxBearByDate) {
  const trades = []; let pos = null;
  const WARM = 30;
  for (let i = WARM; i < bars.length - 1; i++) {
    const hist = bars.slice(0, i + 1);            // i일 종가까지 확정
    const closes = hist.map(b => b.close);
    const today = bars[i], next = bars[i + 1];    // 신호는 i일 확정 후 → i+1일 시가에 집행

    if (pos) {
      // ── 보유 관리 (i+1일 봉으로 판정) ──
      const b = next;
      // 트레일 갱신 (전일까지 고점 기준 — 당일 고점으로 당일 스탑을 올리는 선견 편향 방지)
      if (pos.armed) {
        let ns = Math.max(pos.stop, pos.entry);
        if (pos.atr > 0) ns = Math.max(ns, pos.hw - STOP_ATR * pos.atr);
        if (ns > pos.stop) pos.stop = ns;
      }
      // 1) 갭/장중 손절
      if (b.open <= pos.stop || b.low <= pos.stop) {
        const px = Math.min(b.open, pos.stop);
        exit(pos, px, b.date, pos.qty); pos = null; continue;
      }
      // 2) 신호 매도 (전일 확정 신호)
      const sig = mode === 'old' ? oldSignal(closes) : decideSignal(hist, NEW_S);
      if (sig && sig.side === 'SELL') { exit(pos, b.open, b.date, pos.qty); pos = null; continue; }
      // 3) 익절/부분익절
      const armPx = pos.entry + TRAIL_R * pos.risk0;
      if (mode === 'old') {
        const tp = pos.entry + OLD.takeProfitR * pos.risk0;
        if (b.high >= tp) { exit(pos, tp, b.date, pos.qty); pos = null; continue; }
        if (b.high >= armPx) pos.armed = true;
      } else {
        if (b.high >= armPx) {
          pos.armed = true;
          if (!pos.partial && pos.qty >= 2) { const h = Math.floor(pos.qty / 2); exit(pos, Math.max(armPx, b.open), b.date, h); pos.qty -= h; pos.partial = true; }
        }
      }
      pos.hw = Math.max(pos.hw, b.high);
      continue;
    }

    // ── 진입 (i일 확정 신호 → i+1일 시가) ──
    if (idxBearByDate && mode === 'new' && idxBearByDate[today.date]) continue; // 시장 하락 국면 — 신규진입 금지
    const sig = mode === 'old' ? oldSignal(closes) : decideSignal(hist, NEW_S);
    if (!sig || sig.side !== 'BUY') continue;
    // 구 전략도 당시 운영과 동일하게 추세필터(가격>20MA) 적용
    const maL = sma(closes, 20);
    if (!maL || today.close < maL) continue;
    const atr = calcATR(hist, 14);
    const entry = next.open;
    const stopDist = (atr && atr > 0) ? STOP_ATR * atr : entry * 0.03;
    const qty = Math.floor((CAPITAL * RISK_PCT / 100) / stopDist);
    if (qty < 1) continue;
    pos = { entry, stop: entry - stopDist, atr: atr || 0, risk0: stopDist, qty, qty0: qty,
            hw: entry, armed: false, partial: false, date: next.date, fills: [] };
  }
  if (pos) exit(pos, bars[bars.length - 1].close, 'EOD', pos.qty), pos = null;

  function exit(p, px, date, q) {
    const cost = (p.entry + px) * q * COST_RATE;
    const pnl = (px - p.entry) * q - cost;
    p.fills.push({ px, q, pnl });
    const filled = p.fills.reduce((a, f) => a + f.q, 0);
    if (filled >= p.qty0) {
      const total = p.fills.reduce((a, f) => a + f.pnl, 0);
      trades.push({ in: p.date, out: date, pnl: total, R: total / (p.risk0 * p.qty0) });
    }
  }
  return trades;
}

function stats(name, trades) {
  const n = trades.length;
  if (!n) return { name, n: 0, line: `${name.padEnd(26)} 거래 0건` };
  const wins = trades.filter(t => t.pnl > 0), losses = trades.filter(t => t.pnl <= 0);
  const gw = wins.reduce((a, t) => a + t.pnl, 0), gl = Math.abs(losses.reduce((a, t) => a + t.pnl, 0));
  const total = gw - gl;
  const expR = trades.reduce((a, t) => a + t.R, 0) / n;
  // 손익 순차 누적 최대낙폭
  let eq = 0, peak = 0, mdd = 0;
  for (const t of trades.slice().sort((a, b) => String(a.out).localeCompare(String(b.out)))) {
    eq += t.pnl; peak = Math.max(peak, eq); mdd = Math.min(mdd, eq - peak);
  }
  return { name, n, total, expR,
    line: `${name.padEnd(26)} 거래 ${String(n).padStart(4)}건 | 승률 ${(wins.length / n * 100).toFixed(1).padStart(5)}% | ` +
      `기대값 ${expR >= 0 ? '+' : ''}${expR.toFixed(3)}R/건 | PF ${gl > 0 ? (gw / gl).toFixed(2) : '∞'} | ` +
      `누적 ${total >= 0 ? '+' : ''}${Math.round(total).toLocaleString()}원 | MDD ${Math.round(mdd).toLocaleString()}원` };
}

(async () => {
  console.log(`\n═══ 전략 백테스트 (자본 ${(CAPITAL / 1e4).toLocaleString()}만원 · 거래당 ${RISK_PCT}% · 왕복비용 ${(COST_RATE * 2 * 100).toFixed(2)}%) ═══`);
  let series = {}, idxBars = null;
  if (SYNTHETIC) {
    console.log(`데이터: 합성 시나리오 (종목 ${CODES.length}개 × ${YEARS * 250}일, 시드 고정 — 재현 가능)`);
    CODES.forEach((c, i) => { series[c] = genSynthetic(1000 + i * 7, YEARS * 250); });
    idxBars = genSynthetic(99, YEARS * 250);
  } else {
    console.log(`데이터: 네이버 일봉 ${YEARS}년 × ${CODES.length}종목 로딩 중…`);
    try { idxBars = await fetchNaver(MARKET_PROXY, YEARS); } catch (e) { console.log(`⚠️ 지수 프록시(069500) 로드 실패(${e.message}) — 레짐 필터 없이 진행`); }
    for (const c of CODES) {
      try { series[c] = await fetchNaver(c, YEARS); await new Promise(r => setTimeout(r, 150)); }
      catch (e) { console.log(`  ⚠️ ${c} 로드 실패: ${e.message}`); }
    }
    if (!Object.keys(series).length) {
      console.error('\n❌ 데이터 로드 전부 실패 — 네트워크 차단 환경이면 --synthetic 으로 메커니즘 검증만 가능합니다.');
      process.exit(1);
    }
  }
  // 시장 레짐 시계열: 날짜 → bear 여부 (신 전략만 사용)
  let idxBearByDate = null;
  if (idxBars && idxBars.length > 30) {
    idxBearByDate = {};
    for (let i = 25; i < idxBars.length; i++) idxBearByDate[idxBars[i].date] = isMarketBear(idxBars.slice(0, i + 1), 20);
  }
  const oldTrades = [], newTrades = [];
  for (const c of Object.keys(series)) {
    const bars = series[c];
    if (!bars || bars.length < 60) continue;
    oldTrades.push(...simulate(bars, 'old', null));
    newTrades.push(...simulate(bars, 'new', idxBearByDate));
  }
  console.log('\n' + stats('구 전략 (골든크로스+RSI)', oldTrades).line);
  console.log(stats('신 전략 (돌파+트레일+레짐)', newTrades).line);
  const o = stats('', oldTrades), nw = stats('', newTrades);
  if (o.n && nw.n) {
    const d = (nw.total || 0) - (o.total || 0);
    console.log(`\n차이: 신 전략이 ${d >= 0 ? '+' : ''}${Math.round(d).toLocaleString()}원 (${((nw.expR || 0) - (o.expR || 0)).toFixed(3)}R/건)`);
  }
  console.log('\n⚠️ 과거 성과는 미래를 보장하지 않습니다. 실전 전 모의(VTS)에서 최소 2주 검증 권장.');
})();
