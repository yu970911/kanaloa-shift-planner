// Vercel Blob の薄いラッパー。JSONを1個の「ファイル」として読み書きする。
// すべて access:'private' で保存する。誰でも触れる公開URLは作らず、
// このAPI（下のハンドラでログインを確認した後）からトークン付きでしか読み書きできない。
import { put, list, del, get } from '@vercel/blob';

export async function readJSON(key) {
  try {
    // useCache:false … CDNのキャッシュを通さず、常に最新を読む（上書き保存した直後に古い内容が返るのを防ぐ）
    const result = await get(key, { access: 'private', useCache: false });
    if (!result || result.statusCode !== 200) return null;
    const text = await new Response(result.stream).text();
    return JSON.parse(text);
  } catch (e) {
    return null; // 無ければ null（初回保存前など）
  }
}

export async function writeJSON(key, value) {
  const body = JSON.stringify(value);
  // 同じキー（例: current.json）に毎回保存し直すので、上書きを許可する
  await put(key, body, { access: 'private', addRandomSuffix: false, allowOverwrite: true, contentType: 'application/json; charset=utf-8' });
}

export async function deleteBlob(key) {
  await del(key).catch(() => {});
}

/** 指定した接頭辞のキーを新しい順に並べて返す（最大1000件） */
export async function listByPrefix(prefix) {
  const out = [];
  let cursor;
  do {
    const res = await list({ prefix, cursor, limit: 1000 });
    out.push(...res.blobs);
    cursor = res.cursor;
  } while (cursor);
  out.sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt));
  return out;
}
