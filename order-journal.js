/**
 * order-journal.js — 로컬 주문 저널 + 체결 판정
 *
 * 배경: KIS 모의투자는 당일 주문체결 내역 API(inquire-daily-ccld)가 빈 응답을 준다
 *       (체결 자체는 잔고에 반영됨). 그래서 우리가 접수한 주문을 서버가 직접 기록하고,
 *       잔고 수량 변화를 대조해 체결 여부를 판정한다. 실전에서도 보조 기록으로 유용.
 *
 * 상태: 접수 → 체결(추정) / 취소
 * 판정: 매수 = 보유수량이 (주문 시점 수량 + 주문수량) 이상으로 증가
 *       매도 = 보유수량이 (주문 시점 수량 - 주문수량) 이하로 감소
 */

const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, 'order-journal.json');
const MAX_ENTRIES = 500;

let _entries = null;
let _writeTimer = null;

function _load() {
  if (_entries) return _entries;
  try { _entries = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (e) { _entries = []; }
  return _entries;
}
function _saveSoon() {
  if (_writeTimer) return;
  _writeTimer = setTimeout(() => {
    _writeTimer = null;
    try { fs.promises.writeFile(FILE, JSON.stringify(_entries)).catch(() => {}); } catch (e) {}
  }, 800); // 비동기 디바운스 — 파일 잠금에 서버가 멈추지 않게
}

function _kstDateKey(ts) {
  return new Date((ts || Date.now()) + 9 * 3600 * 1000).toISOString().slice(0, 10);
}

// ── 주문 접수 기록 ──
// e: { userId, side('buy'|'sell'), code, qty, price, orderType, odno, orgNo, qtyBefore(주문 시점 보유수량|null) }
function add(e) {
  const list = _load();
  list.unshift({
    t: Date.now(),
    status: '접수',
    ...e,
    qty: parseInt(e.qty) || 0,
    price: parseInt(e.price) || 0,
    qtyBefore: (e.qtyBefore === null || e.qtyBefore === undefined) ? null : parseInt(e.qtyBefore)
  });
  if (list.length > MAX_ENTRIES) list.length = MAX_ENTRIES;
  _saveSoon();
  return list[0];
}

// ── 체결통보 기반 체결 처리 (실제 체결가·수량 반영, 부분체결 누적) ──
function markFilled(odno, qty, price) {
  const list = _load();
  const e = list.find(x => x.odno === odno && x.status !== '취소');
  if (e) {
    const q = parseInt(qty) || 0;
    e.fillQty = (e.fillQty || 0) + q;            // 부분체결 누적 합산
    if (price) { e.fillPrice = parseInt(price); e.price = parseInt(price); } // 실제 체결가로 갱신
    if (!q || e.fillQty >= e.qty) {              // 수량 미상(구버전 호환) 또는 전량 도달 = 체결 확정
      e.status = '체결';
      e.fillQty = Math.min(e.fillQty || e.qty, e.qty);
    } else {
      e.status = '부분체결';                      // 잔량 남음 — '접수'와 구분해 자동취소·재매도 가드가 인지
    }
    e.filledAt = Date.now();
    _saveSoon();
  }
  return !!e;
}

// ── 취소 처리 — 부분체결분 이력은 보존 ──
function markCancel(odno) {
  const list = _load();
  const e = list.find(x => x.odno === odno && (x.status === '접수' || x.status === '부분체결'));
  if (e) {
    // 일부라도 체결된 주문의 취소 = 잔량 취소. 체결 이력을 '취소'로 덮어 지우지 않는다.
    e.status = (e.fillQty > 0) ? '체결' : '취소';
    if (e.fillQty > 0) e.qty = e.fillQty; // 실제 체결 수량으로 확정
    e.canceledRemainder = true;
    _saveSoon();
  }
  return !!e;
}

// ── 체결 판정: 잔고 대조 ──
// holdings: { code: 보유수량(number) }  — 계좌 갱신 때마다 호출
function reconcile(userId, holdings) {
  const list = _load();
  let changed = 0;
  for (const e of list) {
    if (e.status !== '접수' || (userId && e.userId && e.userId !== userId)) continue;
    if (e.qtyBefore === null || e.qtyBefore === undefined) continue; // 기준 없으면 판정 보류
    const nowQty = parseInt(holdings[e.code] || 0);
    if (e.side === 'buy'  && nowQty >= e.qtyBefore + e.qty) { e.status = '체결'; e.filledAt = Date.now(); changed++; }
    if (e.side === 'sell' && nowQty <= e.qtyBefore - e.qty) { e.status = '체결'; e.filledAt = Date.now(); changed++; }
  }
  if (changed) _saveSoon();
  return changed;
}

// ── 오늘(KST) 주문 목록 ──
function todayList(userId) {
  const today = _kstDateKey();
  return _load().filter(e => _kstDateKey(e.t) === today && (!userId || !e.userId || e.userId === userId));
}

// ── 미체결(접수·부분체결 잔량) 목록 ──
function pendingList(userId) {
  return todayList(userId).filter(e => e.status === '접수' || e.status === '부분체결');
}

// ── 기간 목록 (KST yyyymmdd ~ yyyymmdd) ──
function listRange(userId, fromYmd, toYmd) {
  return _load().filter(e => {
    const d = _kstDateKey(e.t).replace(/-/g, '');
    return d >= fromYmd && d <= toYmd && (!userId || !e.userId || e.userId === userId);
  });
}

// ── KIS 당일내역(output1) 형식으로 변환 — 기존 UI 그대로 사용 ──
function toKisFormat(entries, nameOf) {
  return entries.map(e => {
    const d = new Date(e.t + 9 * 3600 * 1000); // KST
    const hh = String(d.getUTCHours()).padStart(2, '0');
    const mm = String(d.getUTCMinutes()).padStart(2, '0');
    const ss = String(d.getUTCSeconds()).padStart(2, '0');
    const filled = e.status === '체결';
    const partial = e.status === '부분체결';
    const canceled = e.status === '취소';
    return {
      ord_dt: _kstDateKey(e.t).replace(/-/g, ''),
      ord_tmd: hh + mm + ss,
      pdno: e.code,
      prdt_name: (nameOf && nameOf(e.code)) || e.code,
      sll_buy_dvsn_cd: e.side === 'buy' ? '02' : '01',
      sll_buy_dvsn_cd_name: e.side === 'buy' ? '매수' : '매도',
      ord_dvsn_name: e.orderType === '01' ? '시장가' : '지정가',
      ord_qty: String(e.qty),
      ord_unpr: String(e.price),
      tot_ccld_qty: filled ? String(e.qty) : partial ? String(e.fillQty || 0) : '0',
      avg_prvs: (filled || partial) ? String(e.fillPrice || e.price) : '0',
      rmn_qty: (filled || canceled) ? '0' : partial ? String(e.qty - (e.fillQty || 0)) : String(e.qty),
      cncl_yn: canceled ? 'Y' : 'N',
      odno: e.odno || '',
      ord_gno_brno: e.orgNo || '',
      _journal: true,
      _status: e.status
    };
  });
}

module.exports = { add, markFilled, markCancel, reconcile, todayList, pendingList, listRange, toKisFormat, _kstDateKey };
