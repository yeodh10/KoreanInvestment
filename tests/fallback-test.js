/**
 * data-fallback.js 검증 — 실행: node tests/fallback-test.js
 */
const path = require('path');
const fs = require('fs');
// 격리된 임시 캐시 파일 — 운영 data-cache.json 오염·상태 의존 방지
const CACHE = path.join(__dirname, '..', 'data-cache.test.json');
process.env.CACHE_FILE = CACHE;
try { fs.unlinkSync(CACHE); } catch (e) {}
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
  // getEntry는 신선도 라벨(asOf)용 타임스탬프 t를 함께 반환
  const ent = fb.getEntry('test:tick');
  ok('getEntry → {t,v} (asOf 소스)', ent && typeof ent.t === 'number' && ent.t > 0 && ent.v.output[0].stck_prpr === '71900');
  ok('없는 키 getEntry → null', fb.getEntry('test:none') === null);
  fb.flush(true);
  const raw = JSON.parse(fs.readFileSync(CACHE, 'utf8'));
  ok('디스크 영속화', raw['test:tick'].v.output[0].stck_prpr === '71900');

  console.log('== 환율 폴백 ==');
  // 임시 캐시라 fx 키가 없어 fetcher가 실제로 호출됨 → 파싱·라운딩 경로를 진짜로 검증
  fb._setFxFetcher(async () => ({ rates: { KRW: 1387.55 } }));
  const v1 = await fb.fetchUsdKrw();
  ok('환율 수신·파싱 (공개소스)', Math.abs(v1 - 1387.55) < 1);
  fb._setFxFetcher(async () => { throw new Error('down'); });
  const v2 = await fb.fetchUsdKrw();
  ok('소스 다운 시 마지막 값 폴백', v2 === v1);

  try { fs.unlinkSync(CACHE); } catch (e) {}
  console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
  process.exit(fail ? 1 : 0);
})();
