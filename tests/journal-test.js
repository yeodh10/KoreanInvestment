/**
 * order-journal.js 검증 — 실행: node tests/journal-test.js
 */
const path = require('path');
const fs = require('fs');
// 격리된 임시 DB로 테스트 (운영 order-journal.db 오염 방지)
const DB = path.join(__dirname, '..', 'order-journal.test.db');
process.env.JOURNAL_DB = DB;
[DB, DB + '-wal', DB + '-shm'].forEach(f => { try { fs.unlinkSync(f); } catch (e) {} });
const J = require(path.join(__dirname, '..', 'order-journal.js'));

let pass = 0, fail = 0;
function ok(name, cond) { cond ? (pass++, console.log('  ✅', name)) : (fail++, console.log('  ❌', name)); }

// 접수 기록
J.add({ userId: 'u1', side: 'buy', code: '035720', qty: 2, price: 41600, orderType: '00', odno: 'A1', orgNo: '00950', qtyBefore: 0 });
J.add({ userId: 'u1', side: 'buy', code: '005930', qty: 1, price: 41700, orderType: '00', odno: 'A2', orgNo: '00950', qtyBefore: 5 });
J.add({ userId: 'u1', side: 'sell', code: '005490', qty: 12, price: 400000, orderType: '00', odno: 'A3', orgNo: '00950', qtyBefore: 12 });
ok('오늘 목록 3건', J.todayList('u1').length === 3);
ok('미체결 3건', J.pendingList('u1').length === 3);

// 취소
ok('취소 처리', J.markCancel('A3') === true);
ok('취소 후 미체결 2건', J.pendingList('u1').length === 2);
ok('없는 주문 취소 false', J.markCancel('ZZZ') === false);

// 체결 판정 (잔고 대조)
// 카카오: 0 → 2 (체결), 삼성: 5 → 5 (미체결 유지)
let n = J.reconcile(null, { '035720': 2, '005930': 5 });
ok('체결 판정 1건', n === 1);
ok('카카오 체결 상태', J.todayList('u1').find(e => e.odno === 'A1').status === '체결');
ok('삼성 접수 유지', J.todayList('u1').find(e => e.odno === 'A2').status === '접수');
// 삼성 5 → 6 도달 시 체결
n = J.reconcile(null, { '035720': 2, '005930': 6 });
ok('나머지 체결 판정', n === 1 && J.pendingList('u1').length === 0);

// KIS 형식 변환
const rows = J.toKisFormat(J.todayList('u1'), c => ({ '035720': '카카오' }[c]));
ok('형식 변환 3행', rows.length === 3);
const kk = rows.find(r => r.pdno === '035720');
ok('매수 코드/이름', kk.sll_buy_dvsn_cd_name === '매수' && kk.prdt_name === '카카오');
ok('체결수량 반영', kk.tot_ccld_qty === '2' && kk.rmn_qty === '0');
const sold = rows.find(r => r.pdno === '005490');
ok('취소 표시', sold.cncl_yn === 'Y' && sold._status === '취소');

// 동일 odno 다건(유저 간 ODNO 충돌) — userId로 정확히 자기 주문만 체결/취소
J.add({ userId: 'ju1', side: 'buy', code: '111111', qty: 5, price: 100, orderType: '00', odno: 'DUP', orgNo: '1', qtyBefore: 0 });
J.add({ userId: 'ju2', side: 'buy', code: '222222', qty: 3, price: 100, orderType: '00', odno: 'DUP', orgNo: '1', qtyBefore: 0 }); // 더 최신(id 큼)
ok('동일 odno: u1 체결통보가 u1 주문에 기록', J.markFilled('DUP', 5, 100, 'ju1') === true);
ok('u1 주문 체결 확정', J.todayList('ju1').find(e => e.odno === 'DUP').status === '체결');
ok('u2 주문은 영향 없음(접수 유지)', J.todayList('ju2').find(e => e.odno === 'DUP').status === '접수');
ok('동일 odno: u2 취소가 u2 주문에만 적용', J.markCancel('DUP', 'ju2') === true && J.todayList('ju2').find(e => e.odno === 'DUP').status === '취소');
ok('u1 주문은 취소 영향 없음(체결 유지)', J.todayList('ju1').find(e => e.odno === 'DUP').status === '체결');

// 시장가('01')는 접수=체결 즉시 확정 — qtyBefore NULL(개장 직후 콜드 캐시)이어도 영원히 '접수'로
//   방치되지 않게. 모의투자는 체결통보가 없어도 거래내역·손익이 즉시 반영된다.
J.add({ userId: 'mk', side: 'sell', code: '000660', qty: 3, price: 200000, orderType: '01', odno: 'MK1', orgNo: '1', qtyBefore: null });
const mk1 = J.todayList('mk').find(e => e.odno === 'MK1');
ok('시장가 매도 즉시 체결 확정', !!mk1 && mk1.status === '체결' && mk1.fillQty === 3);
ok('시장가는 qtyBefore NULL이어도 미체결에 안 남음', J.pendingList('mk').length === 0);
J.add({ userId: 'mk', side: 'buy', code: '000660', qty: 2, price: 0, orderType: '01', odno: 'MK2', orgNo: '1', qtyBefore: 0 });
ok('시장가 매수도 즉시 체결', J.todayList('mk').find(e => e.odno === 'MK2').status === '체결');

// source(봇/수동) 기록 — 거래내역 배지용
J.add({ userId: 'sc', side: 'buy', code: '005930', qty: 1, price: 60000, orderType: '00', odno: 'SC1', orgNo: '1', qtyBefore: 0, source: 'bot' });
J.add({ userId: 'sc', side: 'buy', code: '005930', qty: 1, price: 60000, orderType: '00', odno: 'SC2', orgNo: '1', qtyBefore: 0, source: 'manual' });
const scRows = J.toKisFormat(J.todayList('sc'), c => c);
ok('봇 주문 source=bot 노출', scRows.find(r => r.odno === 'SC1')._source === 'bot');
ok('수동 주문 source=manual 노출', scRows.find(r => r.odno === 'SC2')._source === 'manual');

// 멀티유저 동시 기록 — 한 유저 기록이 다른 유저 것에 덮여 사라지지 않음(SQLite 원자성)
const NU = 200;
for (let i = 0; i < NU; i++) {
  J.add({ userId: 'mu_a', side: 'buy', code: '000001', qty: 1, price: 100, orderType: '00', odno: 'MA' + i, orgNo: '1', qtyBefore: 0 });
  J.add({ userId: 'mu_b', side: 'buy', code: '000002', qty: 1, price: 100, orderType: '00', odno: 'MB' + i, orgNo: '1', qtyBefore: 0 });
}
ok('멀티유저 대량 기록 무손실 A', J.todayList('mu_a').length === NU);
ok('멀티유저 대량 기록 무손실 B', J.todayList('mu_b').length === NU);
ok('유저 격리 — A는 B 주문 안 보임', J.todayList('mu_a').every(e => e.userId === 'mu_a'));

// ── C1: 같은 종목·방향 다중 주문 동시 — 한 건만 체결되면 한 건만 확정(이중 체결 방지) ──
J.add({ userId: 'c1', side: 'buy', code: '333333', qty: 10, price: 100, orderType: '00', odno: 'C1A', orgNo: '1', qtyBefore: 0 });
J.add({ userId: 'c1', side: 'buy', code: '333333', qty: 10, price: 100, orderType: '00', odno: 'C1B', orgNo: '1', qtyBefore: 0 }); // 잔고 갱신 전이라 둘 다 qtyBefore=0
let c1n = J.reconcile('c1', { '333333': 10 }); // 실제로는 10주만 체결
ok('C1 이중 체결 방지 — 1건만 체결', c1n === 1);
ok('C1 FIFO — 오래된 주문(C1A) 체결', J.todayList('c1').find(e => e.odno === 'C1A').status === '체결');
ok('C1 나머지(C1B) 미체결 유지', J.todayList('c1').find(e => e.odno === 'C1B').status === '접수');
J.reconcile('c1', { '333333': 20 }); // 잔량까지 도달
ok('C1 잔량 도달 시 둘째도 체결', J.todayList('c1').find(e => e.odno === 'C1B').status === '체결');

// ── C1(매도): 같은 종목 매도 둘, 한 건만 체결 ──
J.add({ userId: 'c1s', side: 'sell', code: '333334', qty: 4, price: 100, orderType: '00', odno: 'C1S1', orgNo: '1', qtyBefore: 10 });
J.add({ userId: 'c1s', side: 'sell', code: '333334', qty: 6, price: 100, orderType: '00', odno: 'C1S2', orgNo: '1', qtyBefore: 10 });
let c1sn = J.reconcile('c1s', { '333334': 6 }); // 4주만 체결되어 10→6
ok('C1 매도 이중 체결 방지 — 1건만', c1sn === 1 && J.todayList('c1s').find(e => e.odno === 'C1S1').status === '체결');
ok('C1 매도 나머지 미체결', J.todayList('c1s').find(e => e.odno === 'C1S2').status === '접수');

// ── H8: 부분체결 → 잔고대조로 완결(부분체결도 reconcile 대상) ──
J.add({ userId: 'h8', side: 'buy', code: '444444', qty: 10, price: 100, orderType: '00', odno: 'H8A', orgNo: '1', qtyBefore: 0 });
J.markFilled('H8A', 6, 100, 'h8'); // 6주 부분체결
ok('H8 부분체결 상태', J.todayList('h8').find(e => e.odno === 'H8A').status === '부분체결');
let h8n = J.reconcile('h8', { '444444': 10 });
ok('H8 부분체결도 reconcile 완결', h8n === 1 && J.todayList('h8').find(e => e.odno === 'H8A').status === '체결');
ok('H8 완결 시 fillQty=원수량(10)', J.todayList('h8').find(e => e.odno === 'H8A').fillQty === 10);

// ── H8: 부분체결 후 취소 — 원주문 수량 보존 + 취소 잔량 기록 ──
J.add({ userId: 'h8c', side: 'buy', code: '555555', qty: 10, price: 100, orderType: '00', odno: 'H8C', orgNo: '1', qtyBefore: 0 });
J.markFilled('H8C', 3, 100, 'h8c'); // 3주 부분체결
J.markCancel('H8C', 'h8c');         // 잔량 7주 취소
const h8c = J.todayList('h8c').find(e => e.odno === 'H8C');
ok('H8 취소 후 원주문 수량 보존(10)', h8c.qty === 10);
ok('H8 부분체결분 보존(fillQty 3)', h8c.fillQty === 3);
ok('H8 취소 잔량 기록(7)', h8c.canceledRemainder === 7);
const h8row = J.toKisFormat([h8c], c => c)[0];
ok('H8 거래내역 체결수량=3, 취소표시 Y', h8row.tot_ccld_qty === '3' && h8row.cncl_yn === 'Y');

[DB, DB + '-wal', DB + '-shm'].forEach(f => { try { fs.unlinkSync(f); } catch (e) {} });
console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
