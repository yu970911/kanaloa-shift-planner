// ハンドラを包んで、失敗時にエラー内容をJSONで返す（原因調査用）。
// ここに来る例外は「想定外のバグ」なので、内容を隠さず出す（パスワード等の値そのものは元々ログに出していない）。
export function withErrors(handler) {
  return async (req, res) => {
    try {
      await handler(req, res);
    } catch (e) {
      if (!res.headersSent) {
        res.status(500).json({ error: 'internal', message: e && e.message, stack: e && e.stack });
      }
    }
  };
}
