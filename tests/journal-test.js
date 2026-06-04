/**
 * order-journal.js 검증 — 실행: node tests/journal-test.js
 */
const path = require('path');
const fs = require('fs');
const J_FILE = path.join(__dirname, '..', 'order-journal.json');
try { fs.unlinkSync(J_FILE); } catch (e) {}
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

try { fs.unlinkSync(J_FILE); } catch (e) {}
console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
