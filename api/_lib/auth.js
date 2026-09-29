// パスワードのハッシュ化・セッションの発行と確認。
// パスワードは PBKDF2（Node組み込みのcrypto、外部ライブラリなし）でハッシュ化して保存する。平文は一切保存しない。
import crypto from 'node:crypto';
import { readJSON, writeJSON, deleteBlob } from './blob.js';

const ITER = 210000; // OWASP 推奨の目安（2023年版）に合わせた反復回数
const SESSION_DAYS = 30;

export function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}
/**
 * メールアドレスをBlobのキーに使える形にする。
 * encodeURIComponent（%40 等）だと、Vercel Blobの get() が list() と食い違って
 * 「保存はできるが読み込めない」ことがあったため、記号を含まないハッシュ値にする。
 */
function emailKey(email) {
  return crypto.createHash('sha256').update(normalizeEmail(email)).digest('hex');
}

export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(String(password), salt, ITER, 32, 'sha256').toString('hex');
  return `${ITER}$${salt}$${hash}`;
}
export function verifyPassword(password, stored) {
  const [iterStr, salt, hash] = String(stored || '').split('$');
  const iter = Number(iterStr) || ITER;
  if (!salt || !hash) return false;
  const check = crypto.pbkdf2Sync(String(password), salt, iter, 32, 'sha256').toString('hex');
  // タイミング攻撃を避けるため、長さを揃えてから定時間比較する
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(check, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export async function getUser(email) {
  return readJSON(`users/${emailKey(email)}.json`);
}
export async function createUser(email, password, name) {
  const key = `users/${emailKey(email)}.json`;
  const exists = await readJSON(key);
  if (exists) return null;
  const user = { email: normalizeEmail(email), name: name || '', passwordHash: hashPassword(password), createdAt: new Date().toISOString() };
  await writeJSON(key, user);
  return user;
}

const COOKIE_NAME = 'kanaloa_session';

export async function createSession(email) {
  const token = crypto.randomBytes(32).toString('base64url');
  const expiresAt = Date.now() + SESSION_DAYS * 86400000;
  await writeJSON(`sessions/${token}.json`, { email: normalizeEmail(email), expiresAt });
  return token;
}
export async function destroySession(token) {
  if (token) await deleteBlob(`sessions/${token}.json`);
}
/** リクエストのCookieから、ログイン中のメールアドレスを取り出す（無効・期限切れなら null） */
export async function sessionFromRequest(req) {
  const token = parseCookie(req.headers.cookie || '')[COOKIE_NAME];
  if (!token) return null;
  const s = await readJSON(`sessions/${token}.json`);
  if (!s || s.expiresAt < Date.now()) return null;
  return { email: s.email, token };
}

export function setCookie(res, token) {
  const maxAge = SESSION_DAYS * 86400;
  // 同じVercelドメインからしか使わない前提（別オリジンをまたがないので SameSite=Lax で足りる）
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`);
}
export function clearCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`);
}
function parseCookie(str) {
  const out = {};
  for (const part of String(str).split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export const EMAIL_KEY_OF = emailKey;
