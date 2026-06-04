/**
 * 멀티유저 인증 모듈
 * - 회원가입/로그인 (비밀번호 해시)
 * - 세션 토큰 관리
 * - 유저별 KIS 설정 분리 + 간단 암호화
 * Node.js 빌트인 crypto만 사용
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const USERS_FILE = path.join(__dirname, 'users.json');
const SESSIONS_FILE = path.join(__dirname, 'sessions.json');
const USER_CONFIG_DIR = path.join(__dirname, 'user-configs');

// 유저 설정 폴더 생성
if (!fs.existsSync(USER_CONFIG_DIR)) {
  try { fs.mkdirSync(USER_CONFIG_DIR); } catch(e) {}
}

// ── 서버 고유 암호화 키 (최초 1회 생성, 파일 저장) ──
const KEY_FILE = path.join(__dirname, '.enckey');
let ENC_KEY;
function getEncKey() {
  if (ENC_KEY) return ENC_KEY;
  try {
    if (fs.existsSync(KEY_FILE)) {
      ENC_KEY = Buffer.from(fs.readFileSync(KEY_FILE, 'utf8'), 'hex');
      return ENC_KEY;
    }
  } catch(e) {}
  ENC_KEY = crypto.randomBytes(32);
  try { fs.writeFileSync(KEY_FILE, ENC_KEY.toString('hex'), { mode: 0o600 }); } catch(e) {} // 소유자만 읽기 — 키 유출 방지
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

// ── 비밀번호 해시 (scrypt) ──
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return salt + ':' + hash;
}
function verifyPassword(password, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt, hash] = stored.split(':');
  const test = crypto.scryptSync(password, salt, 64).toString('hex');
  const a = Buffer.from(hash), b = Buffer.from(test);
  if (a.length !== b.length) return false; // 길이 다르면 timingSafeEqual이 throw → 방어
  return crypto.timingSafeEqual(a, b);
}
// 더미 검증 — 존재하지 않는 아이디에도 scrypt를 돌려 응답시간을 맞춤 (유저 존재 여부 누설 차단)
const _DUMMY_HASH = hashPassword('::dummy::');
function dummyVerify(password) { try { verifyPassword(password || '', _DUMMY_HASH); } catch (_) {} }

// 세션 토큰은 SHA-256 해시로 저장 — sessions.json 유출 시에도 원본 토큰 복원 불가
function hashToken(token) { return crypto.createHash('sha256').update(String(token)).digest('hex'); }

// ── 원자적 파일 쓰기 (temp → rename) ──
// 쓰기 도중 크래시로 파일이 절단되면 loadUsers가 {}를 반환 → 전 계정 소실 + 다음 가입자가 admin.
// temp에 다 쓴 뒤 rename(원자적)하면 절단된 파일이 절대 안 남는다.
function _atomicWrite(file, text) {
  const tmp = file + '.tmp-' + process.pid + '-' + Date.now();
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

// ── 유저 저장소 ──
function loadUsers() {
  try {
    if (fs.existsSync(USERS_FILE)) return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
  } catch(e) {}
  return {};
}
function saveUsers(users) {
  _atomicWrite(USERS_FILE, JSON.stringify(users, null, 2)); // 원자적 — 절단으로 인한 전 계정 소실 방지
}

// ── 세션 저장소 ──
function loadSessions() {
  try {
    if (fs.existsSync(SESSIONS_FILE)) return JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
  } catch(e) {}
  return {};
}
function saveSessions(s) {
  _atomicWrite(SESSIONS_FILE, JSON.stringify(s));
}

// ── 회원가입 ──
function register(username, password) {
  username = (username || '').trim().toLowerCase();
  if (!username || !password) return { ok:false, message:'아이디와 비밀번호를 입력하세요' };
  if (username.length < 3) return { ok:false, message:'아이디는 3자 이상이어야 합니다' };
  if (password.length < 8) return { ok:false, message:'비밀번호는 8자 이상이어야 합니다' };
  const users = loadUsers();
  if (users[username]) return { ok:false, message:'이미 존재하는 아이디입니다' };
  const userId = 'u_' + crypto.randomBytes(6).toString('hex');
  users[username] = {
    userId, username,
    passwordHash: hashPassword(password),
    createdAt: new Date().toISOString(),
    role: Object.keys(users).length === 0 ? 'admin' : 'user' // 첫 가입자가 관리자
  };
  saveUsers(users);
  return { ok:true, userId, username, role: users[username].role };
}

// ── 로그인 ──
function login(username, password) {
  username = (username || '').trim().toLowerCase();
  const users = loadUsers();
  const user = users[username];
  if (!user) { dummyVerify(password); return { ok:false, message:'아이디 또는 비밀번호가 틀렸습니다' }; } // 더미 검증 — 타이밍 누설 차단
  if (!verifyPassword(password, user.passwordHash)) return { ok:false, message:'아이디 또는 비밀번호가 틀렸습니다' };
  // 세션 발급 — 원본 토큰은 쿠키로만 주고, 서버엔 해시만 저장
  const token = crypto.randomBytes(32).toString('hex');
  const sessions = loadSessions();
  sessions[hashToken(token)] = { userId: user.userId, username, createdAt: Date.now() };
  saveSessions(sessions);
  return { ok:true, token, userId: user.userId, username, role: user.role };
}

// ── 세션 → userId 조회 ──
function getUserBySession(token) {
  if (!token) return null;
  const sessions = loadSessions();
  const key = hashToken(token);
  const s = sessions[key] || sessions[token]; // 해시 우선, 레거시(원본키) 하위호환
  if (!s) return null;
  // 30일 만료
  if (Date.now() - s.createdAt > 30*24*60*60*1000) {
    delete sessions[key]; delete sessions[token]; saveSessions(sessions); return null;
  }
  return s; // { userId, username }
}

// ── 로그아웃 ──
function logout(token) {
  const sessions = loadSessions();
  const key = hashToken(token);
  let changed = false;
  if (sessions[key]) { delete sessions[key]; changed = true; }
  if (sessions[token]) { delete sessions[token]; changed = true; } // 레거시 키
  if (changed) saveSessions(sessions);
  return { ok:true };
}

// ── 유저별 KIS 설정 (API 키는 암호화 저장) ──
function userConfigPath(userId) {
  return path.join(USER_CONFIG_DIR, `${userId}.json`);
}
function loadUserConfig(userId) {
  try {
    const p = userConfigPath(userId);
    if (fs.existsSync(p)) {
      const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
      // 복호화해서 반환
      return {
        __userId: userId, // 소유자 각인 — 어떤 컨텍스트에서 저장하든 올바른 유저 파일로 가게
        appKey: decrypt(raw.appKey),
        appSecret: decrypt(raw.appSecret),
        accNo: raw.accNo || '',
        txMode: raw.txMode || 'vts',
        token: raw.token || '',
        tokenExpiry: raw.tokenExpiry || 0,
        telegramToken: decrypt(raw.telegramToken),
        telegramChatId: raw.telegramChatId || ''
      };
    }
  } catch(e) {}
  return { __userId: userId, appKey:'', appSecret:'', accNo:'', txMode:'vts', token:'', tokenExpiry:0, telegramToken:'', telegramChatId:'' };
}
function saveUserConfig(userId, cfg) {
  const p = userConfigPath(userId);
  // API 키는 암호화해서 저장
  const toSave = {
    appKey: encrypt(cfg.appKey),
    appSecret: encrypt(cfg.appSecret),
    accNo: cfg.accNo || '',
    txMode: cfg.txMode || 'vts',
    token: cfg.token || '',
    tokenExpiry: cfg.tokenExpiry || 0,
    telegramToken: encrypt(cfg.telegramToken),
    telegramChatId: cfg.telegramChatId || ''
  };
  _atomicWrite(p, JSON.stringify(toSave, null, 2)); // 원자적 — 설정 파일 절단 방지
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
  register, login, logout, getUserBySession,
  loadUserConfig, saveUserConfig,
  loadUsers, parseCookies, encrypt, decrypt
};
