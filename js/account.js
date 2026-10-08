// ログイン・クラウド保存・履歴（/api、Vercel Functions + Blob）とやり取りする薄い関数群。
// 同じVercelのドメインから呼ぶので、合言葉やトークンの類はここでは扱わない（すべてサーバー側のCookieで判断する）。
async function call(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method || 'GET',
    headers: opts.body ? { 'Content-Type': 'application/json' } : undefined,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    credentials: 'same-origin',
  });
  let json;
  try { json = await res.json(); } catch (e) { json = null; }
  if (!res.ok) {
    const msg = (json && json.message) || (json && json.error)
      || (res.status === 413 ? '保存するデータが大きすぎて、クラウドに送れません' : `通信に失敗しました（${res.status}）`);
    const err = new Error(msg);
    err.code = json && json.error;
    throw err;
  }
  return json;
}

export const signup = (email, password) => call('/api/auth/signup', { method: 'POST', body: { email, password } });
export const login = (email, password) => call('/api/auth/login', { method: 'POST', body: { email, password } });
export const logout = () => call('/api/auth/logout', { method: 'POST' });
export const me = () => call('/api/auth/me').catch((e) => (e.code === 'not_logged_in' ? null : Promise.reject(e)));

// opts: { history（false で履歴に残さない）, baseSavedAt（最後に同期した時刻。これより新しい保存があれば 409）, force }
export const saveCloud = (state, label, opts = {}) => call('/api/state', { method: 'POST', body: { state, label, ...opts } });
export const loadCloud = () => call('/api/state');
export const listHistory = () => call('/api/history');
export const restoreHistory = (id) => call('/api/history-restore', { method: 'POST', body: { id } });
