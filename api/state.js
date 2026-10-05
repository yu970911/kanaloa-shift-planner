// 今のデータの読み書き。current.json は { savedAt, state } の形で持つ。
// POST は、history が false でなければ「履歴」にも1件残す（＝過去の生成例・戻る機能のもと）。
// 自動保存は history:false（または間引き）で呼ぶので、履歴が入力のたびに増えることはない。
import { sessionFromRequest, EMAIL_KEY_OF } from './_lib/auth.js';
import { readJSON, writeJSON, listByPrefix, deleteBlob } from './_lib/blob.js';
import { withErrors } from './_lib/wrap.js';
import { unwrapCurrent } from './_lib/current.js';

const MAX_HISTORY = 200; // 1人あたりの履歴の上限（古い順に消す）

export default withErrors(async function handler(req, res) {
  const s = await sessionFromRequest(req);
  if (!s) return res.status(401).json({ error: 'not_logged_in' });
  const k = EMAIL_KEY_OF(s.email);
  const currentKey = `data/${k}/current.json`;

  if (req.method === 'GET') {
    const cur = unwrapCurrent(await readJSON(currentKey));
    return res.status(200).json({ state: cur ? cur.state : null, savedAt: cur ? cur.savedAt : null });
  }

  if (req.method === 'POST') {
    const { state, label, history, baseSavedAt, force, historyOnly } = req.body || {};
    if (!state || typeof state !== 'object') return res.status(400).json({ error: 'invalid_state' });

    // 「今のデータ」は変えずに、履歴にだけ1件残す（読み込みで置き換わる前の、このブラウザの内容を残すため）
    if (historyOnly) {
      const t = new Date().toISOString();
      await writeJSON(`data/${k}/history/${t}.json`, { savedAt: t, label: label || '', state });
      return res.status(200).json({ ok: true, savedAt: t });
    }

    // 別のパソコンが先に保存していたら、気づかず上書きしないように止める
    // （読み込みが古いデータを返しても、それは baseSavedAt 以前になるので誤検知しない）
    const cur = unwrapCurrent(await readJSON(currentKey));
    if (cur && cur.savedAt && (!baseSavedAt || cur.savedAt > baseSavedAt)) {
      if (!force) {
        return res.status(409).json({ error: 'conflict', savedAt: cur.savedAt, message: '別のパソコンで、より新しい内容が保存されています' });
      }
      // 承知のうえで上書きするときも、上書きされる側の内容は履歴に残す
      const t = new Date().toISOString();
      await writeJSON(`data/${k}/history/${t}.json`, { savedAt: t, label: '（上書きされる前のクラウドの内容）', state: cur.state });
    }

    const savedAt = new Date().toISOString();
    await writeJSON(currentKey, { savedAt, state });
    if (history !== false) {
      await writeJSON(`data/${k}/history/${savedAt}.json`, { savedAt, label: label || '', state });

      // 履歴が多くなりすぎたら、古い分から消す
      const items = await listByPrefix(`data/${k}/history/`);
      if (items.length > MAX_HISTORY) {
        const toDelete = items.slice(MAX_HISTORY); // listByPrefixは新しい順なので、末尾＝古い分
        await Promise.all(toDelete.map((b) => deleteBlob(b.pathname)));
      }
    }
    return res.status(200).json({ ok: true, savedAt });
  }

  res.status(405).json({ error: 'method_not_allowed' });
});
