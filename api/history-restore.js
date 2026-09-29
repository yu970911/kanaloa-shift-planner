// 選んだ履歴を「今のデータ」に戻す（＝戻る機能）。戻す前の状態も履歴に残すので、やり直しがきく。
import { sessionFromRequest } from './_lib/auth.js';
import { readJSON, writeJSON } from './_lib/blob.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });
  const s = await sessionFromRequest(req);
  if (!s) return res.status(401).json({ error: 'not_logged_in' });
  const k = encodeURIComponent(s.email);

  const { id } = req.body || {};
  // 必ず本人の履歴だけを指しているか確認する（他人の履歴パスを渡されても読ませない）
  if (typeof id !== 'string' || !id.startsWith(`data/${k}/history/`)) {
    return res.status(400).json({ error: 'invalid_id' });
  }
  const snap = await readJSON(id);
  if (!snap) return res.status(404).json({ error: 'not_found' });

  // 戻す前の「今のデータ」を、履歴として保存しておく（戻す操作自体もやり直せるように）
  const before = await readJSON(`data/${k}/current.json`);
  if (before) {
    const savedAt = new Date().toISOString();
    await writeJSON(`data/${k}/history/${savedAt}.json`, { savedAt, label: '（元に戻す前）', state: before });
  }
  await writeJSON(`data/${k}/current.json`, snap.state);
  res.status(200).json({ state: snap.state });
}
