import { getUser, verifyPassword, createSession, setCookie, normalizeEmail } from '../_lib/auth.js';
import { withErrors } from '../_lib/wrap.js';

export default withErrors(async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });
  const { email, password } = req.body || {};
  const e = normalizeEmail(email);
  const user = await getUser(e);
  if (!user || !verifyPassword(password, user.passwordHash)) {
    return res.status(401).json({ error: 'invalid_credentials', message: 'メールアドレスかパスワードが違います' });
  }
  const token = await createSession(e);
  setCookie(res, token);
  res.status(200).json({ email: e, name: user.name });
});
