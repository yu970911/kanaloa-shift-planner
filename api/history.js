// 過去に保存した状態の一覧（新しい順）。中身は返さず、選ぶための最小限の情報だけ返す。
import { sessionFromRequest } from './_lib/auth.js';
import { listByPrefix, readJSON } from './_lib/blob.js';
import { withErrors } from './_lib/wrap.js';

export default withErrors(async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'method_not_allowed' });
  const s = await sessionFromRequest(req);
  if (!s) return res.status(401).json({ error: 'not_logged_in' });
  const k = encodeURIComponent(s.email);

  const items = await listByPrefix(`data/${k}/history/`);
  const limit = Math.min(100, Number(req.query?.limit) || 60);
  const page = items.slice(0, limit);
  const detailed = await Promise.all(page.map(async (b) => {
    const snap = await readJSON(b.pathname);
    const st = snap && snap.state;
    return {
      id: b.pathname,
      savedAt: (snap && snap.savedAt) || b.uploadedAt,
      label: (snap && snap.label) || '',
      year: st ? st.year : null,
      month: st ? st.month : null,
      period: st ? st.period : null,
    };
  }));
  res.status(200).json({ items: detailed, total: items.length });
});
