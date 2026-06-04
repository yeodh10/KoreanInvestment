/**
 * data-fallback.js 검증 — 실행: node tests/fallback-test.js
 */
const path = require('path');
const fs = require('fs');
const fb = require(path.join(__dirname, '..', 'data-fallback.js'));

let pass = 0, fail = 0;
function ok(name, cond) { cond ? (pass++, console.log('  ✅', name)) : (fail++, console.log('  ❌', name)); }

(async () => {
  console.log('== 호가단위 (KRX) ==');
  ok('1,500원 → 1', fb.tickSize(1500) === 1);
  ok('3,000원 → 5', fb.tickSize(3000) === 5);
  ok('15,000원 → 10', fb.tickSize(15000) === 10);
  ok('45,000원 → 50', fb.tickSize(45000) === 50);
  ok('71,900원 → 100', fb.tickSize(71900) === 100);
  ok('350,000원 → 500', fb.tickSize(350000) === 500);
  ok('700,000원 → 1000', fb.tickSize(700000) === 1000);

  console.log('== 호가 사다리 ==');
  const lad = fb.buildLadder(71900);
  ok('합성 플래그', lad.synthetic === true);
  ok('매도1 > 매수1', parseInt(lad.askp1) > parseInt(lad.bidp1));
  ok('매도 오름차순', parseInt(lad.askp10) > parseInt(lad.askp1));
  ok('매수 내림차순', parseInt(lad.bidp1) > parseInt(lad.bidp10));
  ok('호가단위 100 간격', parseInt(lad.askp2) - parseInt(lad.askp1) === 100);
  ok('가격 0 → null', fb.buildLadder(0) === null);

  console.log('== 빈 호가 판정 ==');
  ok('빈 객체 → empty', fb.isOrderbookEmpty({}) === true);
  ok('null → empty', fb.isOrderbookEmpty(null) === true);
  ok('전부 0 → empty', fb.isOrderbookEmpty({ askp1: '0', bidp1: '0' }) === true);
  ok('값 있음 → not empty', fb.isOrderbookEmpty({ askp1: '71900' }) === false);

  console.log('== lastGood 영속 캐시 ==');
  fb.save('test:tick', { output: [{ stck_prpr: '71900' }] });
  ok('저장 후 조회', fb.get('test:tick').output[0].stck_prpr === '71900');
  fb.flush(true);
  const raw = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data-cache.json'), 'utf8'));
  ok('디스크 영속화', raw['test:tick'].v.output[0].stck_prpr === '71900');

  console.log('== 환율 폴백 ==');
  fb._setFxFetcher(async () => ({ rates: { KRW: 1387.55 } }));
  // 캐시된 값이 있을 수 있으니 키 제거 후 테스트
  fb.save('fx:USDKRW', undefined); // no-op (undefined는 저장 안 됨)
  const v1 = await fb.fetchUsdKrw();
  ok('환율 수신 (공개소스)', v1 > 1000 && v1 < 3000);
  fb._setFxFetcher(async () => { throw new Error('down'); });
  const v2 = await fb.fetchUsdKrw();
  ok('소스 다운 시 마지막 값', v2 === v1);

  console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
  process.exit(fail ? 1 : 0);
})();
