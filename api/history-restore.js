// 選んだ履歴を「今のデータ」に戻す（＝戻る機能）。戻す前の状態も履歴に残すので、やり直しがきく。
import { sessionFromRequest, EMAIL_KEY_OF } from './_lib/auth.js';
import { readJSON, writeJSON } from './_lib/blob.js';
import { withErrors } from './_lib/wrap.js';
import { unwrapCurrent } from './_lib/current.js';

export default withErrors(async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });
  const s = await sessionFromRequest(req);
  if (!s) return res.status(401).json({ error: 'not_logged_in' });
  const k = EMAIL_KEY_OF(s.email);

  const { id } = req.body || {};
  // 必ず本人の履歴だけを指しているか確認する（他人の履歴パスを渡されても読ませない）
  if (typeof id !== 'string' || !id.startsWith(`data/${k}/history/`) || id.includes('..')) {
    return res.status(400).json({ error: 'invalid_id' });
  }
  const snap = await readJSON(id);
  if (!snap) return res.status(404).json({ error: 'not_found' });

  // 戻す前の「今のデータ」を、履歴として保存しておく（戻す操作自体もやり直せるように）
  const before = unwrapCurrent(await readJSON(`data/${k}/current.json`));
  if (before) {
    const t = new Date().toISOString();
    await writeJSON(`data/${k}/history/${t}.json`, { savedAt: t, label: '（元に戻す前）', state: before.state });
  }
  const savedAt = new Date().toISOString();
  await writeJSON(`data/${k}/current.json`, { savedAt, state: snap.state });
  res.status(200).json({ state: snap.state, savedAt });
});
