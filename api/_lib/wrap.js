// ハンドラを包んで、失敗時に一貫した形でエラーを返す。
// 詳細（スタックトレース等）はVercelのログにだけ出し、レスポンスには含めない。
export function withErrors(handler) {
  return async (req, res) => {
    try {
      await handler(req, res);
    } catch (e) {
      console.error(e);
      if (!res.headersSent) {
        res.status(500).json({ error: 'internal', message: '内部エラーが発生しました' });
      }
    }
  };
}
