import { sessionFromRequest, getUser } from '../_lib/auth.js';
import { withErrors } from '../_lib/wrap.js';

export default withErrors(async function handler(req, res) {
  const s = await sessionFromRequest(req);
  if (!s) return res.status(401).json({ error: 'not_logged_in' });
  const user = await getUser(s.email);
  res.status(200).json({ email: s.email, name: user ? user.name : '' });
});
