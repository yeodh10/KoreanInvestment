/**
 * 멀티유저 인증 모듈 (SQLite 백엔드)
 * - 회원가입/로그인 (scrypt 해시)
 * - 세션 토큰 관리 (토큰은 SHA-256 해시로만 저장)
 * - 유저별 KIS 설정 분리 + AES-256-GCM 암호화 (파일 유지 — 유저별 개별 파일이라 교차 위험 없음)
 *
 * 왜 users/sessions를 JSON에서 SQLite로 — 멀티유저 동시성.
 *  - 기존: 전역 users.json/sessions.json을 통째로 읽고 수정 후 통째 저장(read-modify-write).
 *    N명 동시 로그인/가입 시 한쪽 기록이 덮여 세션·계정이 사라질 수 있었다.
 *  - 지금: INSERT/DELETE/UPDATE가 단일 SQL(또는 트랜잭션)로 DB 락 하에 원자적. 유실 없음.
 *  - node 내장 node:sqlite — npm 의존성 0 유지. getUserBySession은 매 요청 PK 조회라 빠르다.
 * Node.js 빌트인만 사용.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

const USER_CONFIG_DIR = path.join(__dirname, 'user-configs');
const AUTH_DB = process.env.AUTH_DB || path.join(__dirname, 'auth.db');
const LEGACY_USERS = path.join(__dirname, 'users.json');
const LEGACY_SESSIONS = path.join(__dirname, 'sessions.json');
const SESSION_TTL = 30 * 24 * 60 * 60 * 1000; // 30일

// 유저 설정 폴더 생성
if (!fs.existsSync(USER_CONFIG_DIR)) {
  try { fs.mkdirSync(USER_CONFIG_DIR); } catch(e) {}
}

// ── DB 초기화 ──
const db = new DatabaseSync(AUTH_DB);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA synchronous = NORMAL');
db.exec('PRAGMA busy_timeout = 5000'); // market-check 등 타 프로세스와 락 경합 시 5초 대기(로그인 500 방지)
db.exec(`CREATE TABLE IF NOT EXISTS users (
  userId TEXT PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  passwordHash TEXT NOT NULL,
  createdAt TEXT,
  role TEXT
)`);
db.exec(`CREATE TABLE IF NOT EXISTS sessions (
  tokenHash TEXT PRIMARY KEY,
  userId TEXT NOT NULL,
  username TEXT,
  createdAt INTEGER NOT NULL
)`);
db.exec('CREATE INDEX IF NOT EXISTS idx_sessions_created ON sessions(createdAt)');

// ── 서버 고유 암호화 키 (최초 1회 생성) ──
const KEY_FILE = path.join(__dirname, '.enckey');
let ENC_KEY;
function getEncKey() {
  if (ENC_KEY) return ENC_KEY;
  if (fs.existsSync(KEY_FILE)) {
    const key = Buffer.from(fs.readFileSync(KEY_FILE, 'utf8').trim(), 'hex');
    // 손상/절단된 키로 진행하면 모든 user-configs 가 복호화 불가가 되므로 명확히 중단(무음 금지).
    if (key.length !== 32) throw new Error(`.enckey 손상(${key.length}바이트, 32 필요) — 백업 키로 교체 필요. 새 키를 만들면 기존 KIS 설정 복호화가 영구 불가해집니다.`);
    // 마이그레이션(scp/cp)으로 느슨해진 권한을 방어적으로 0600 재설정(마스터키는 전 유저 KIS키를 푼다).
    try { fs.chmodSync(KEY_FILE, 0o600); } catch (_) {}
    ENC_KEY = key;
    return ENC_KEY;
  }
  // 신규 키 생성은 '진짜 최초'에만 안전하다. .enckey가 없는데 user-configs/에 기존 설정이 있으면
  // (백업 분실·이관 누락) 새 키를 만드는 순간 기존 KIS 자격증명이 전부 영구 복호화 불가가 된다.
  // 무성 전손을 막기 위해 기동을 중단하고 복구를 안내한다(시작 시 키-데이터 정합 검증).
  let _hasExistingConfigs = false;
  try {
    _hasExistingConfigs = fs.existsSync(USER_CONFIG_DIR)
      && fs.readdirSync(USER_CONFIG_DIR).some((f) => f.endsWith('.json'));
  } catch (_) { _hasExistingConfigs = false; }
  if (_hasExistingConfigs) {
    throw new Error(
      '.enckey가 없는데 user-configs/에 기존 설정이 있습니다 — 새 키를 만들면 기존 KIS 자격증명이 ' +
      '영구 복호화 불가가 됩니다. 백업에서 .enckey를 복원하세요. (진짜 새 출발이면 user-configs/를 비우고 재시작.)',
    );
  }
  // 신규 생성. ★ 쓰기 실패는 절대 무시하지 않는다 — 미영속 키로 운영하면 재시작 때 새 키가
  //   생성돼 기존 user-configs 가 전부 영구 복호화 불가(무음 자격증명 전손)가 된다. 실패 시 기동 중단.
  const key = crypto.randomBytes(32);
  fs.writeFileSync(KEY_FILE, key.toString('hex'), { mode: 0o600 });
  ENC_KEY = key;
  return ENC_KEY;
}

// ── 문자열 암호화/복호화 (AES-256-GCM) ──
function encrypt(text) {
  if (!text) return '';
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getEncKey(), iv);
  const enc = Buffer.concat([cipher.update(String(text), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return iv.toString('hex') + ':' + tag.toString('hex') + ':' + enc.toString('hex');
}
function decrypt(blob) {
  if (!blob || !blob.includes(':')) return '';
  try {
    const [ivHex, tagHex, dataHex] = blob.split(':');
    const decipher = crypto.createDecipheriv('aes-256-gcm', getEncKey(), Buffer.from(ivHex, 'hex'));
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
    return Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()]).toString('utf8');
  } catch(e) { return ''; }
}

// ── 비밀번호 해시 (scrypt — 비동기) ──
// scryptSync는 CPU를 ~수십~수백ms 점유하며 그동안 이벤트 루프 전체를 멈춘다.
// 로그인/가입 폭주 시 모든 요청(시세·주문 포함)이 직렬로 밀리던 문제 → 비동기 scrypt로 전환.
// crypto.scrypt는 libuv 스레드풀에서 실행돼 메인 루프를 막지 않는다(동시 호출은 스레드풀에 큐잉).
function scryptAsync(password, salt, keylen) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, keylen, (err, dk) => err ? reject(err) : resolve(dk));
  });
}
async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = (await scryptAsync(password, salt, 64)).toString('hex');
  return salt + ':' + hash;
}
async function verifyPassword(password, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt, hash] = stored.split(':');
  const test = (await scryptAsync(password, salt, 64)).toString('hex');
  const a = Buffer.from(hash), b = Buffer.from(test);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
// 더미 검증 — 없는 아이디에도 scrypt를 돌려 응답시간을 맞춤 (유저 존재 여부 누설 차단)
// 더미 해시는 모듈 로드 시 백그라운드로 미리 만든다(블로킹 없음). ★ 이렇게 안 하면 첫 로그인 실패 시
// dummyVerify가 hashPassword+verifyPassword로 scrypt를 2번 돌려, 존재 유저(1회)와 응답시간이 달라져
// "아이디 존재 여부"가 타이밍으로 누설됨. 워밍으로 항상 정확히 1회만 돌게 한다.
let _DUMMY_HASH = null;
hashPassword('::dummy::').then(h => { _DUMMY_HASH = h; }).catch(() => {});
async function dummyVerify(password) {
  try {
    if (!_DUMMY_HASH) _DUMMY_HASH = await hashPassword('::dummy::'); // 워밍 전 첫 요청 폴백
    await verifyPassword(password || '', _DUMMY_HASH);
  } catch (_) {}
}

// 세션 토큰은 SHA-256 해시로 저장 — DB 유출 시에도 원본 토큰 복원 불가
function hashToken(token) { return crypto.createHash('sha256').update(String(token)).digest('hex'); }

// ── 원자적 파일 쓰기 (user-config용 — fsync + 0600) ──
function _atomicWrite(file, text) {
  const tmp = file + '.tmp-' + process.pid + '-' + Date.now();
  let fd;
  try { fd = fs.openSync(tmp, 'w', 0o600); fs.writeSync(fd, text); fs.fsyncSync(fd); }
  finally { if (fd !== undefined) fs.closeSync(fd); }
  try { fs.renameSync(tmp, file); }
  catch (e) { try { fs.unlinkSync(tmp); } catch (_) {} throw e; }
}

// ── 레거시 JSON 1회 이관 (DB가 비어 있을 때만) ──
(function migrateLegacy() {
  if (process.env.AUTH_DB) return; // 테스트 등 DB 경로 지정 시 루트 레거시 JSON을 끌어오지 않음
  try {
    const uCount = db.prepare('SELECT COUNT(*) c FROM users').get().c;
    if (uCount === 0 && fs.existsSync(LEGACY_USERS)) {
      const users = JSON.parse(fs.readFileSync(LEGACY_USERS, 'utf8'));
      const ins = db.prepare('INSERT OR IGNORE INTO users (userId,username,passwordHash,createdAt,role) VALUES (?,?,?,?,?)');
      db.exec('BEGIN');
      for (const k of Object.keys(users)) { const u = users[k];
        ins.run(u.userId, u.username || k, u.passwordHash, u.createdAt || '', u.role || 'user'); }
      db.exec('COMMIT');
      try { fs.renameSync(LEGACY_USERS, LEGACY_USERS + '.migrated'); } catch (_) {}
      console.log('[auth] 레거시 users.json 이관 완료');
    }
    const sCount = db.prepare('SELECT COUNT(*) c FROM sessions').get().c;
    if (sCount === 0 && fs.existsSync(LEGACY_SESSIONS)) {
      const sess = JSON.parse(fs.readFileSync(LEGACY_SESSIONS, 'utf8'));
      const ins = db.prepare('INSERT OR IGNORE INTO sessions (tokenHash,userId,username,createdAt) VALUES (?,?,?,?)');
      db.exec('BEGIN');
      for (const k of Object.keys(sess)) { const s = sess[k];
        // 해시 키로 저장된 것만 이관 (원본키 레거시는 보안상 폐기 — 재로그인 요구)
        if (/^[a-f0-9]{64}$/.test(k)) ins.run(k, s.userId, s.username || '', s.createdAt || Date.now()); }
      db.exec('COMMIT');
      try { fs.renameSync(LEGACY_SESSIONS, LEGACY_SESSIONS + '.migrated'); } catch (_) {}
      console.log('[auth] 레거시 sessions.json 이관 완료');
    }
  } catch (e) { try { db.exec('ROLLBACK'); } catch (_) {} console.log('[auth] 레거시 이관 보류:', e.message); }
})();

// ── 유저 저장소 ── (하위호환: {username: {userId, username, role, ...}} 형태 반환)
function loadUsers() {
  const rows = db.prepare('SELECT userId,username,passwordHash,createdAt,role FROM users').all();
  const out = Object.create(null); // __proto__ 키가 프로토타입을 건드리지 않게
  for (const u of rows) out[u.username] = u;
  return out;
}

// ── 회원가입 ── (첫 가입자 = admin). UNIQUE + 트랜잭션으로 동시 가입 레이스 방어.
async function register(username, password) {
  username = (username || '').trim().toLowerCase();
  if (!username || !password) return { ok:false, message:'아이디와 비밀번호를 입력하세요' };
  if (username.length < 3) return { ok:false, message:'아이디는 3자 이상이어야 합니다' };
  // 영문 소문자·숫자·_ 만 — '__proto__' 등 프로토타입 오염 키나 특수문자 차단
  if (!/^[a-z0-9_]{3,20}$/.test(username)) return { ok:false, message:'아이디는 영문 소문자·숫자·_ 3~20자만 가능합니다' };
  if (password.length < 8) return { ok:false, message:'비밀번호는 8자 이상이어야 합니다' }; // 실거래 서비스 — 무차별 대입 방어
  const userId = 'u_' + crypto.randomBytes(6).toString('hex');
  const createdAt = new Date().toISOString();
  // ★ 해시는 트랜잭션 밖에서 — scrypt(수십~수백ms) 동안 DB 쓰기 락을 잡고 있으면 동시 가입/로그인이 막힌다.
  const passwordHash = await hashPassword(password);
  try {
    db.exec('BEGIN IMMEDIATE');
    if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) {
      db.exec('ROLLBACK'); return { ok:false, message:'이미 존재하는 아이디입니다' };
    }
    const count = db.prepare('SELECT COUNT(*) c FROM users').get().c;
    const role = count === 0 ? 'admin' : 'user'; // 첫 가입자가 관리자
    db.prepare('INSERT INTO users (userId,username,passwordHash,createdAt,role) VALUES (?,?,?,?,?)')
      .run(userId, username, passwordHash, createdAt, role);
    db.exec('COMMIT');
    return { ok:true, userId, username, role };
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (_) {}
    if (/UNIQUE/i.test(e.message)) return { ok:false, message:'이미 존재하는 아이디입니다' };
    return { ok:false, message:'가입 처리 오류' };
  }
}

// ── 로그인 ──
async function login(username, password) {
  username = (username || '').trim().toLowerCase();
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user) { await dummyVerify(password); return { ok:false, message:'아이디 또는 비밀번호가 틀렸습니다' }; }
  if (!(await verifyPassword(password, user.passwordHash))) return { ok:false, message:'아이디 또는 비밀번호가 틀렸습니다' };
  // 세션 발급 — 원본 토큰은 쿠키로만, DB엔 해시만 저장
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions (tokenHash,userId,username,createdAt) VALUES (?,?,?,?)')
    .run(hashToken(token), user.userId, username, Date.now());
  return { ok:true, token, userId: user.userId, username, role: user.role };
}

// ── 세션 → userId 조회 ── (해시 키로만 조회 — 원본키 폴백 없음)
function getUserBySession(token) {
  if (!token) return null;
  const key = hashToken(token);
  const s = db.prepare('SELECT userId,username,createdAt FROM sessions WHERE tokenHash = ?').get(key);
  if (!s) return null;
  if (Date.now() - s.createdAt > SESSION_TTL) { // 30일 만료
    db.prepare('DELETE FROM sessions WHERE tokenHash = ?').run(key);
    return null;
  }
  return { userId: s.userId, username: s.username };
}

// ── 로그아웃 ──
function logout(token) {
  if (token) db.prepare('DELETE FROM sessions WHERE tokenHash = ?').run(hashToken(token));
  return { ok:true };
}

// ── 유저의 모든 세션 폐기 (도난 세션 회수 / 모든 기기 로그아웃) ──
// 로그아웃은 제출 토큰 1개만 지운다 → 세션 유출 시 30일 TTL 끝까지 회수 불가하던 갭(적대감사 MEDIUM) 보완.
function purgeUserSessions(userId) {
  if (!userId) return { ok:false, removed:0 };
  try { const r = db.prepare('DELETE FROM sessions WHERE userId = ?').run(userId); return { ok:true, removed: r.changes }; }
  catch (e) { return { ok:false, removed:0 }; }
}

// ── 만료 세션 일괄 정리 ── (서버 부팅 시 1회 명시 호출. require 시점 자동 실행하지 않아
//   market-check 등 단명 프로세스가 auth.js를 require해도 live DB에 DELETE 쓰기를 하지 않게 분리.)
function purgeExpiredSessions() {
  try { db.prepare('DELETE FROM sessions WHERE createdAt < ?').run(Date.now() - SESSION_TTL); } catch (_) {}
}

// ── 유저별 KIS 설정 (API 키는 암호화 저장, 유저별 개별 파일) ──
function userConfigPath(userId) { return path.join(USER_CONFIG_DIR, `${userId}.json`); }
function loadUserConfig(userId) {
  try {
    const p = userConfigPath(userId);
    if (fs.existsSync(p)) {
      const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
      return {
        __userId: userId,
        appKey: decrypt(raw.appKey),
        appSecret: decrypt(raw.appSecret),
        accNo: raw.accNo || '',
        txMode: raw.txMode || 'vts',
        htsId: raw.htsId || '',   // 체결통보 WS 구독용
        token: raw.token || '',
        tokenExpiry: raw.tokenExpiry || 0,
        telegramToken: decrypt(raw.telegramToken),
        telegramChatId: raw.telegramChatId || ''
      };
    }
  } catch(e) {}
  return { __userId: userId, appKey:'', appSecret:'', accNo:'', txMode:'vts', htsId:'', token:'', tokenExpiry:0, telegramToken:'', telegramChatId:'' };
}
function saveUserConfig(userId, cfg) {
  const p = userConfigPath(userId);
  try { if (!fs.existsSync(USER_CONFIG_DIR)) fs.mkdirSync(USER_CONFIG_DIR, { recursive: true }); } catch (e) {}
  const toSave = {
    appKey: encrypt(cfg.appKey),
    appSecret: encrypt(cfg.appSecret),
    accNo: cfg.accNo || '',
    txMode: cfg.txMode || 'vts',
    htsId: cfg.htsId || '',
    token: cfg.token || '',
    tokenExpiry: cfg.tokenExpiry || 0,
    telegramToken: encrypt(cfg.telegramToken),
    telegramChatId: cfg.telegramChatId || ''
  };
  _atomicWrite(p, JSON.stringify(toSave, null, 2));
}

// ── 쿠키 파싱 ──
function parseCookies(req) {
  const out = {};
  const c = req.headers.cookie;
  if (!c) return out;
  c.split(';').forEach(pair => {
    const idx = pair.indexOf('=');
    if (idx > 0) out[pair.slice(0,idx).trim()] = decodeURIComponent(pair.slice(idx+1).trim());
  });
  return out;
}

module.exports = {
  register, login, logout, purgeUserSessions, getUserBySession,
  loadUserConfig, saveUserConfig,
  loadUsers, parseCookies, encrypt, decrypt, purgeExpiredSessions
};
