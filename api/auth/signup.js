import { createUser, createSession, setCookie, normalizeEmail } from '../_lib/auth.js';
import { withErrors } from '../_lib/wrap.js';

export default withErrors(async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });
  const { email, password, name } = req.body || {};
  const e = normalizeEmail(email);
  if (!e || !e.includes('@')) return res.status(400).json({ error: 'invalid_email', message: 'メールアドレスの形が正しくありません' });
  if (!password || String(password).length < 8) return res.status(400).json({ error: 'weak_password', message: 'パスワードは8文字以上にしてください' });

  const user = await createUser(e, password, name);
  if (!user) return res.status(409).json({ error: 'exists', message: 'このメールアドレスは既に登録されています' });

  const token = await createSession(e);
  setCookie(res, token);
  res.status(200).json({ email: e, name: user.name });
});
