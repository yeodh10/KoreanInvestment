/**
 * order-journal.js — 주문 저널 + 체결 판정 (SQLite 백엔드)
 *
 * 배경: KIS 모의투자는 당일 주문체결 내역 API가 빈 응답을 주므로(체결은 잔고에 반영됨),
 *       우리가 접수한 주문을 직접 기록하고 잔고 변화를 대조해 체결을 판정한다.
 *
 * 왜 파일(JSON)에서 SQLite로 바꿨나 — 다중 사용자 동시성 때문이다.
 *  - 기존: 전역 order-journal.json을 통째로 읽고(메모리 배열) 수정 후 0.8초 디바운스로 통째 쓰기.
 *    두 유저가 거의 동시에 주문하면 read-modify-write가 겹쳐 한쪽 기록이 덮여 사라질 수 있었다(돈 기록 유실).
 *  - 지금: 각 연산이 단일 SQL 문(또는 트랜잭션)으로 DB 락 하에 원자적으로 처리된다. 유실 없음.
 *  - node 내장 node:sqlite 사용 — npm 의존성 0 유지. WAL 모드로 동시 읽기/쓰기 견고.
 *
 * 상태: 접수 → 부분체결 → 체결 / 취소.   export 인터페이스는 JSON판과 100% 동일(호출부 무수정).
 */

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const KST = 9 * 3600 * 1000;
const DB_FILE = process.env.JOURNAL_DB || path.join(__dirname, 'order-journal.db');
const LEGACY_JSON = path.join(__dirname, 'order-journal.json');

const db = new DatabaseSync(DB_FILE);
db.exec('PRAGMA journal_mode = WAL');   // 동시 읽기/쓰기 견고
db.exec('PRAGMA synchronous = NORMAL'); // 내구성/속도 균형 (WAL에서 안전)
db.exec('PRAGMA busy_timeout = 5000');  // 다른 프로세스와 락 경합 시 즉시 BUSY 대신 5초 대기
db.exec(`CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  t INTEGER NOT NULL,
  userId TEXT,
  side TEXT, code TEXT,
  qty INTEGER, price INTEGER,
  orderType TEXT,
  odno TEXT, orgNo TEXT,
  qtyBefore INTEGER,          -- NULL = 판정 기준 없음
  status TEXT,                -- 접수 / 부분체결 / 체결 / 취소
  fillQty INTEGER DEFAULT 0,
  fillPrice INTEGER,
  filledAt INTEGER,
  canceledRemainder INTEGER DEFAULT 0,
  source TEXT                 -- bot(자동매매) / manual(직접) / NULL(불명)
)`);
try { db.exec('ALTER TABLE orders ADD COLUMN source TEXT'); } catch (e) {} // 구버전 DB 마이그레이션(이미 있으면 무시)
db.exec('CREATE INDEX IF NOT EXISTS idx_orders_t ON orders(t)');
db.exec('CREATE INDEX IF NOT EXISTS idx_orders_odno ON orders(odno)');
db.exec('CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(userId)');

// ── 레거시 JSON 1회 이관 (DB가 비어 있을 때만) ──
(function migrateLegacy() {
  if (process.env.JOURNAL_DB) return; // 테스트 등 DB 경로 지정 시 루트 레거시 JSON을 끌어오지 않음
  try {
    const count = db.prepare('SELECT COUNT(*) c FROM orders').get().c;
    if (count > 0 || !fs.existsSync(LEGACY_JSON)) return;
    const old = JSON.parse(fs.readFileSync(LEGACY_JSON, 'utf8'));
    if (!Array.isArray(old) || !old.length) return;
    const ins = db.prepare(`INSERT INTO orders
      (t,userId,side,code,qty,price,orderType,odno,orgNo,qtyBefore,status,fillQty,fillPrice,filledAt,canceledRemainder)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    db.exec('BEGIN');
    for (const e of old) ins.run(
      e.t || Date.now(), e.userId ?? null, e.side ?? null, e.code ?? null,
      parseInt(e.qty) || 0, parseInt(e.price) || 0, e.orderType ?? '00',
      e.odno ?? null, e.orgNo ?? null,
      (e.qtyBefore === null || e.qtyBefore === undefined) ? null : parseInt(e.qtyBefore),
      e.status ?? '접수', parseInt(e.fillQty) || 0,
      e.fillPrice ?? null, e.filledAt ?? null, e.canceledRemainder ? 1 : 0);
    db.exec('COMMIT');
    try { fs.renameSync(LEGACY_JSON, LEGACY_JSON + '.migrated'); } catch (_) {}
    console.log(`[저널] 레거시 JSON ${old.length}건 SQLite로 이관 완료`);
  } catch (e) { try { db.exec('ROLLBACK'); } catch (_) {} }
})();

function _kstDateKey(ts) {
  return new Date((ts || Date.now()) + KST).toISOString().slice(0, 10);
}
// KST '오늘'의 [시작, 끝) UTC epoch (ms)
function _kstTodayBounds() {
  const start = Math.floor((Date.now() + KST) / 86400000) * 86400000 - KST;
  return [start, start + 86400000];
}
// 'yyyymmdd' → 그 날 KST 자정의 UTC epoch (ms)
function _ymdToKstStart(ymd) {
  const y = +ymd.slice(0, 4), m = +ymd.slice(4, 6) - 1, d = +ymd.slice(6, 8);
  return Date.UTC(y, m, d) - KST;
}

// ── 주문 접수 기록 ──
// e: { userId, side, code, qty, price, orderType, odno, orgNo, qtyBefore(null 가능) }
const _ins = db.prepare(`INSERT INTO orders
  (t,userId,side,code,qty,price,orderType,odno,orgNo,qtyBefore,status,fillQty,fillPrice,filledAt,canceledRemainder,source)
  VALUES (?,?,?,?,?,?,?,?,?,?, '접수', 0, NULL, NULL, 0, ?)`);
// 시장가('01')는 접수=체결로 즉시 확정. KIS가 주문 접수(odno 발급)를 응답한 시장가는 장중 즉시
// 체결되며, 모의투자(VTS)는 체결통보가 없어 잔고대조로만 확정되는데 개장 직후엔 계좌캐시가 콜드라
// qtyBefore를 못 기록 → 영원히 '접수'로 방치되던 문제(어제 손절 4건)를 차단한다.
const _insFilled = db.prepare(`INSERT INTO orders
  (t,userId,side,code,qty,price,orderType,odno,orgNo,qtyBefore,status,fillQty,fillPrice,filledAt,canceledRemainder,source)
  VALUES (?,?,?,?,?,?,?,?,?,?, '체결', ?, ?, ?, 0, ?)`);
function add(e) {
  const t = Date.now();
  const qty = parseInt(e.qty) || 0;
  const price = parseInt(e.price) || 0;
  const qtyBefore = (e.qtyBefore === null || e.qtyBefore === undefined) ? null : parseInt(e.qtyBefore);
  const orderType = e.orderType ?? '00';
  const source = e.source ?? null; // bot / manual
  if (orderType === '01') { // 시장가 → 즉시 체결 확정
    _insFilled.run(t, e.userId ?? null, e.side ?? null, e.code ?? null, qty, price,
                   orderType, e.odno ?? null, e.orgNo ?? null, qtyBefore, qty, price || null, t, source);
    return { t, status: '체결', ...e, qty, price, qtyBefore, fillQty: qty };
  }
  _ins.run(t, e.userId ?? null, e.side ?? null, e.code ?? null, qty, price,
           orderType, e.odno ?? null, e.orgNo ?? null, qtyBefore, source);
  return { t, status: '접수', ...e, qty, price, qtyBefore };
}

// ── 체결통보 기반 체결 처리 (실제 체결가·수량, 부분체결 누적) ──
// userId 지정 시 그 유저 주문만 매칭 — 타 유저 체결통보가 내 주문을 건드리는 것 방지
const _updFill = db.prepare(
  `UPDATE orders SET fillQty = ?, fillPrice = ?, price = ?, status = ?, filledAt = ? WHERE id = ?`);
// userId는 WHERE 조건에 포함한다. LIMIT 뒤에서 거르면, 같은 odno(계좌별 일련번호라 유저 간 충돌 가능)의
// 최신 행이 타 유저 것일 때 내 유저 체결이 누락된다. with/without 두 스테이트먼트로 분기.
const _findFillUser = db.prepare(
  `SELECT * FROM orders WHERE odno = ? AND status != '취소' AND userId = ? ORDER BY id DESC LIMIT 1`);
const _findFillAny = db.prepare(
  `SELECT * FROM orders WHERE odno = ? AND status != '취소' ORDER BY id DESC LIMIT 1`);
function _findFillByOdno(odno, userId) {
  return (userId ? _findFillUser.get(odno, userId) : _findFillAny.get(odno)) || null;
}
function markFilled(odno, qty, price, userId) {
  const e = _findFillByOdno(odno, userId);
  if (!e) return false;
  const q = parseInt(qty) || 0;
  let fillQty = (e.fillQty || 0) + q;            // 부분체결 누적 합산
  const fillPrice = price ? parseInt(price) : (e.fillPrice ?? null);
  const newPrice = price ? parseInt(price) : e.price;
  let status;
  if (!q || fillQty >= e.qty) {                  // 수량 미상(구버전) 또는 전량 도달 = 체결 확정
    status = '체결';
    fillQty = Math.min(fillQty || e.qty, e.qty);
  } else {
    status = '부분체결';                          // 잔량 남음 — 자동취소·재매도 가드가 구분
  }
  _updFill.run(fillQty, fillPrice, newPrice, status, Date.now(), e.id);
  return true;
}
// ── 취소 처리 — 부분체결분 이력은 보존 ──
// userId는 WHERE에 포함(markFilled와 동일 이유 — 동일 odno 타 유저 최신행이 가리는 것 방지)
const _findCancelUser = db.prepare(
  `SELECT * FROM orders WHERE odno = ? AND status IN ('접수','부분체결') AND userId = ? ORDER BY id DESC LIMIT 1`);
const _findCancelAny = db.prepare(
  `SELECT * FROM orders WHERE odno = ? AND status IN ('접수','부분체결') ORDER BY id DESC LIMIT 1`);
// 원주문 수량(qty)은 보존한다 — 감사 추적("10주 주문 / 3체결 / 7취소")이 가능하도록.
// 취소된 잔량은 canceledRemainder 에 수량으로 기록(과거엔 플래그 1로만 써 원수량이 소실됐다).
const _updCancel = db.prepare(
  `UPDATE orders SET status = ?, canceledRemainder = ?, filledAt = ? WHERE id = ?`);
function markCancel(odno, userId) {
  const e = userId ? _findCancelUser.get(odno, userId) : _findCancelAny.get(odno);
  if (!e) return false;
  // 일부라도 체결된 주문의 취소 = 잔량 취소. 체결 이력을 '취소'로 덮지 않는다.
  const filledQ = e.fillQty || 0;
  const remainder = Math.max(0, e.qty - filledQ); // 취소된 잔량
  const status = (filledQ > 0) ? '체결' : '취소';
  _updCancel.run(status, remainder, filledQ > 0 ? Date.now() : null, e.id);
  return true;
}

// ── 체결 판정: 잔고 대조 ── holdings: { code: 보유수량 }
// 부분체결(아직 잔량 남은 주문)도 완결 대상에 포함하고 id ASC(FIFO)로 정렬한다.
const _selPending = db.prepare(
  `SELECT * FROM orders WHERE status IN ('접수','부분체결') AND qtyBefore IS NOT NULL ORDER BY id ASC`);
const _markRecon = db.prepare(`UPDATE orders SET status = '체결', fillQty = ?, filledAt = ? WHERE id = ?`);
// 잔고 변화를 (userId, code, side) 그룹의 누적 임계로 판정한다.
//  - 같은 종목·방향 주문이 둘 이상 동시에 열려 있고 각자 같은 qtyBefore 를 잡았을 때,
//    주문마다 "현재 보유 ≥ qtyBefore + qty" 를 독립 적용하면 한 건만 체결돼도 전부 체결로 오판한다(이중 체결).
//  - 대신 그룹의 가장 오래된 주문 시점 보유량을 기준(baseline)으로, FIFO 로 실제 변동량이
//    허용하는 만큼만 차례로 체결 확정한다. 잔여 변동량이 다음 주문을 다 못 채우면 거기서 멈춘다.
function reconcile(userId, holdings) {
  const rows = _selPending.all(); // id ASC
  const groups = new Map();
  for (const e of rows) {
    if (userId && e.userId !== userId) continue; // 타 유저 주문 제외(userId 없는 엔트리도 제외)
    const key = (e.userId ?? '') + '|' + e.code + '|' + e.side;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(e); // 이미 id ASC
  }
  let changed = 0;
  db.exec('BEGIN');
  try {
    for (const list of groups.values()) {
      const code = list[0].code, side = list[0].side;
      const nowQty = parseInt(holdings[code] || 0);
      let expected = list[0].qtyBefore; // 그룹이 채워지기 전(가장 오래된 주문 시점) 보유량
      for (const e of list) {
        expected += (side === 'buy' ? e.qty : -e.qty);
        const reached = side === 'buy' ? (nowQty >= expected) : (nowQty <= expected);
        if (!reached) break; // 누적 임계 미도달 → 이 주문과 이후 주문은 아직 미체결
        _markRecon.run(e.qty, Date.now(), e.id); // 전량 체결 확정(부분체결분도 완결)
        changed++;
      }
    }
    db.exec('COMMIT');
  } catch (err) { db.exec('ROLLBACK'); throw err; }
  return changed;
}

// userId가 지정되면 그 유저 주문만 — 레거시(userId 없는) 엔트리 정보 유출 차단.
// userId가 falsy(전역/admin)일 때만 전체 조회.
// ── 오늘(KST) 주문 목록 ── (newest-first)
const _selTodayAll = db.prepare(
  `SELECT * FROM orders WHERE t >= ? AND t < ? ORDER BY t DESC, id DESC`);
const _selTodayUser = db.prepare(
  `SELECT * FROM orders WHERE t >= ? AND t < ? AND userId = ? ORDER BY t DESC, id DESC`);
function todayList(userId) {
  const [s, e] = _kstTodayBounds();
  return userId ? _selTodayUser.all(s, e, userId) : _selTodayAll.all(s, e);
}

// ── 보유종목의 최근 매수 출처 (bot / manual / null=기록없음=레거시) ──
// 포트폴리오 배지가 "현재 봇 보유 여부"가 아니라 "누가 샀는지"로 정확히 판단하게 한다.
const _lastBuySrc = db.prepare(
  `SELECT source FROM orders WHERE userId = ? AND code = ? AND side = 'buy' ORDER BY t DESC LIMIT 1`);
function lastBuySource(userId, code) {
  try { const r = _lastBuySrc.get(userId, code); return r ? (r.source || null) : null; } catch (e) { return null; }
}

// ── 미체결(접수·부분체결 잔량) 목록 ──
function pendingList(userId) {
  return todayList(userId).filter(e => e.status === '접수' || e.status === '부분체결');
}

// ── 기간 목록 (KST yyyymmdd ~ yyyymmdd, 양끝 포함) ──
const _selRangeAll = db.prepare(
  `SELECT * FROM orders WHERE t >= ? AND t < ? ORDER BY t DESC, id DESC`);
const _selRangeUser = db.prepare(
  `SELECT * FROM orders WHERE t >= ? AND t < ? AND userId = ? ORDER BY t DESC, id DESC`);
function listRange(userId, fromYmd, toYmd) {
  const s = _ymdToKstStart(fromYmd);
  const e = _ymdToKstStart(toYmd) + 86400000; // to 당일 끝까지 포함
  return userId ? _selRangeUser.all(s, e, userId) : _selRangeAll.all(s, e);
}

// ── KIS 당일내역(output1) 형식으로 변환 — 기존 UI 그대로 사용 ──
function toKisFormat(entries, nameOf) {
  return entries.map(e => {
    const d = new Date(e.t + KST); // KST
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
      tot_ccld_qty: filled ? String(e.fillQty || e.qty) : partial ? String(e.fillQty || 0) : '0',
      avg_prvs: (filled || partial) ? String(e.fillPrice || e.price) : '0',
      rmn_qty: (filled || canceled) ? '0' : partial ? String(e.qty - (e.fillQty || 0)) : String(e.qty),
      // 전량취소(취소) 또는 부분체결 후 잔량취소(체결+canceledRemainder>0) 모두 취소 표시
      cncl_yn: (canceled || e.canceledRemainder > 0) ? 'Y' : 'N',
      odno: e.odno || '',
      ord_gno_brno: e.orgNo || '',
      _journal: true,
      _status: e.status,
      _source: e.source || null   // bot / manual / null
    };
  });
}

module.exports = { add, markFilled, markCancel, reconcile, todayList, pendingList, listRange, toKisFormat, lastBuySource, _kstDateKey };
