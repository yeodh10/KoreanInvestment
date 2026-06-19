/**
 * auth.js 검증 (SQLite 백엔드) — 실행: node tests/auth-test.js
 * 격리된 임시 DB 사용 (운영 auth.db 오염 방지)
 */
const path = require('path');
const fs = require('fs');
const DB = path.join(__dirname, '..', 'auth.test.db');
process.env.AUTH_DB = DB;
[DB, DB + '-wal', DB + '-shm'].forEach(f => { try { fs.unlinkSync(f); } catch (e) {} });
// 레거시 JSON 이관이 끼어들지 않게: 임시 DB라 비어 있고, 루트 users.json은 이미 .migrated 상태일 수 있음.
const A = require(path.join(__dirname, '..', 'auth.js'));

let pass = 0, fail = 0;
function ok(name, cond) { cond ? (pass++, console.log('  ✅', name)) : (fail++, console.log('  ❌', name)); }

// register/login은 scrypt 비동기 전환으로 Promise 반환 → async로 await
(async () => {
// 가입
const r1 = await A.register('Alice', 'password123');
ok('첫 가입 성공', r1.ok === true);
ok('첫 가입자 = admin', r1.role === 'admin');
ok('아이디 소문자 정규화', r1.username === 'alice');
const r2 = await A.register('bob', 'password123');
ok('둘째 가입자 = user', r2.ok && r2.role === 'user');
ok('중복 아이디 거부', (await A.register('alice', 'password123')).ok === false);
ok('짧은 비밀번호 거부(8자 미만)', (await A.register('carol', 'short')).ok === false);
ok('짧은 아이디 거부', (await A.register('ab', 'password123')).ok === false);

// loadUsers 형태 (하위호환: {username:{userId,role,...}})
const users = A.loadUsers();
ok('loadUsers 2명', Object.keys(users).length === 2);
ok('loadUsers 형태 유지', users.alice && users.alice.role === 'admin' && users.alice.userId === r1.userId);

// 로그인
const lr = await A.login('alice', 'password123');
ok('로그인 성공 + 토큰 발급', lr.ok && typeof lr.token === 'string' && lr.token.length >= 32);
ok('틀린 비밀번호 거부', (await A.login('alice', 'wrongpass1')).ok === false);
ok('없는 아이디 거부', (await A.login('nobody', 'password123')).ok === false);

// 세션 조회
const s = A.getUserBySession(lr.token);
ok('세션 → 올바른 userId', s && s.userId === r1.userId);
ok('위조 토큰 거부', A.getUserBySession('deadbeef'.repeat(8)) === null);
ok('빈 토큰 거부', A.getUserBySession('') === null);

// 로그아웃
A.logout(lr.token);
ok('로그아웃 후 세션 무효', A.getUserBySession(lr.token) === null);

// 모든 기기 로그아웃 — 한 유저의 전 세션 일괄 폐기(도난 세션 회수, 적대감사 MEDIUM 보완)
const _m1 = await A.login('alice', 'password123');
const _m2 = await A.login('alice', 'password123');
ok('전체폐기 전 두 세션 유효', !!A.getUserBySession(_m1.token) && !!A.getUserBySession(_m2.token));
const _pr = A.purgeUserSessions(r1.userId);
ok('purgeUserSessions 폐기 건수 ≥ 2', _pr.ok && _pr.removed >= 2);
ok('전체폐기 후 세션1 무효', A.getUserBySession(_m1.token) === null);
ok('전체폐기 후 세션2 무효', A.getUserBySession(_m2.token) === null);

// 세션 토큰은 해시로만 저장 — 원본 토큰이 DB 키로 그대로 들어가지 않음
const lr2 = await A.login('bob', 'password123');
const { DatabaseSync } = require('node:sqlite');
const raw = new DatabaseSync(DB);
const sessRows = raw.prepare('SELECT tokenHash FROM sessions').all();
ok('세션 토큰 원본 미저장(해시만)', sessRows.every(x => x.tokenHash !== lr2.token && /^[a-f0-9]{64}$/.test(x.tokenHash)));
raw.close();

// 멀티유저 대량 가입 무손실 (SQLite 원자성) — 비동기 동시 가입으로 이벤트루프 비블로킹·원자성 동시 검증
const N = 150;
await Promise.all(Array.from({ length: N }, (_, i) => A.register('user' + i, 'password123')));
ok('대량 동시가입 무손실', Object.keys(A.loadUsers()).length === 2 + N);

// H5: 설정 암호화 키 위생 — AES-GCM 라운드트립 + .enckey 32바이트(64 hex)
const ENC = path.join(__dirname, '..', '.enckey');
const enckeyPreexists = fs.existsSync(ENC);
ok('AES-GCM 암복호화 라운드트립', A.decrypt(A.encrypt('appkey-secret-123')) === 'appkey-secret-123');
ok('빈 입력은 빈 문자열', A.encrypt('') === '' && A.decrypt('') === '');
ok('.enckey 32바이트(64 hex)', fs.existsSync(ENC) && fs.readFileSync(ENC, 'utf8').trim().length === 64);
if (!enckeyPreexists) { try { fs.unlinkSync(ENC); } catch (_) {} } // 테스트가 만든 키만 정리(운영 키 보존)

[DB, DB + '-wal', DB + '-shm'].forEach(f => { try { fs.unlinkSync(f); } catch (e) {} });
console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
})();
