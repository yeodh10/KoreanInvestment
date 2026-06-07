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
J.add({ userId: 'u1', side: 'buy', code: '005930', qty: 1, price: 0, orderType: '01', odno: 'A2', orgNo: '00950', qtyBefore: 5 });
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

// 멀티유저 동시 기록 — 한 유저 기록이 다른 유저 것에 덮여 사라지지 않음(SQLite 원자성)
const NU = 200;
for (let i = 0; i < NU; i++) {
  J.add({ userId: 'mu_a', side: 'buy', code: '000001', qty: 1, price: 100, orderType: '00', odno: 'MA' + i, orgNo: '1', qtyBefore: 0 });
  J.add({ userId: 'mu_b', side: 'buy', code: '000002', qty: 1, price: 100, orderType: '00', odno: 'MB' + i, orgNo: '1', qtyBefore: 0 });
}
ok('멀티유저 대량 기록 무손실 A', J.todayList('mu_a').length === NU);
ok('멀티유저 대량 기록 무손실 B', J.todayList('mu_b').length === NU);
ok('유저 격리 — A는 B 주문 안 보임', J.todayList('mu_a').every(e => e.userId === 'mu_a'));

[DB, DB + '-wal', DB + '-shm'].forEach(f => { try { fs.unlinkSync(f); } catch (e) {} });
console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
