import { destroySession, clearCookie, sessionFromRequest } from '../_lib/auth.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });
  const s = await sessionFromRequest(req);
  if (s) await destroySession(s.token);
  clearCookie(res);
  res.status(200).json({ ok: true });
}
