// 一時的な調査用エンドポイント。原因が分かり次第、削除する。
import { get, list } from '@vercel/blob';
import { sessionFromRequest, EMAIL_KEY_OF } from './_lib/auth.js';
import { withErrors } from './_lib/wrap.js';

export default withErrors(async function handler(req, res) {
  const s = await sessionFromRequest(req);
  if (!s) return res.status(401).json({ error: 'not_logged_in' });
  const k = EMAIL_KEY_OF(s.email);
  const key = `data/${k}/current.json`;

  const listed = await list({ prefix: `data/${k}/` });
  let getResult = null;
  let getError = null;
  try {
    getResult = await get(key, { access: 'private' });
  } catch (e) {
    getError = { message: e.message, name: e.name, stack: e.stack };
  }

  let text = null;
  if (getResult && getResult.stream) {
    try {
      text = await new Response(getResult.stream).text();
    } catch (e) {
      text = `<stream read error: ${e.message}>`;
    }
  }

  res.status(200).json({
    key,
    listedBlobs: listed.blobs.map((b) => ({ pathname: b.pathname, size: b.size, uploadedAt: b.uploadedAt })),
    getResultShape: getResult ? Object.keys(getResult) : null,
    getResultStatusCode: getResult ? getResult.statusCode : null,
    getError,
    text,
  });
});
