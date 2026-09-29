// 今のデータの読み書き。POSTのたびに「履歴」にも1件残す（＝過去の生成例・戻る機能のもと）。
import { sessionFromRequest } from './_lib/auth.js';
import { readJSON, writeJSON, listByPrefix, deleteBlob } from './_lib/blob.js';
import { withErrors } from './_lib/wrap.js';

const MAX_HISTORY = 200; // 1人あたりの履歴の上限（古い順に消す）

function keyOf(email) {
  return encodeURIComponent(email);
}

export default withErrors(async function handler(req, res) {
  const s = await sessionFromRequest(req);
  if (!s) return res.status(401).json({ error: 'not_logged_in' });
  const k = keyOf(s.email);

  if (req.method === 'GET') {
    const state = await readJSON(`data/${k}/current.json`);
    return res.status(200).json({ state });
  }

  if (req.method === 'POST') {
    const { state, label } = req.body || {};
    if (!state || typeof state !== 'object') return res.status(400).json({ error: 'invalid_state' });
    const savedAt = new Date().toISOString();
    await writeJSON(`data/${k}/current.json`, state);
    const histKey = `data/${k}/history/${savedAt}.json`;
    await writeJSON(histKey, { savedAt, label: label || '', state });

    // 履歴が多くなりすぎたら、古い分から消す
    const items = await listByPrefix(`data/${k}/history/`);
    if (items.length > MAX_HISTORY) {
      const toDelete = items.slice(MAX_HISTORY); // listByPrefixは新しい順なので、末尾＝古い分
      await Promise.all(toDelete.map((b) => deleteBlob(b.pathname)));
    }
    return res.status(200).json({ ok: true, savedAt });
  }

  res.status(405).json({ error: 'method_not_allowed' });
});
