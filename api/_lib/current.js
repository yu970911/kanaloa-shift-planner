/** current.json の保存形式の違い（旧：stateそのまま／新：{savedAt,state}）を吸収する */
export function unwrapCurrent(raw) {
  if (!raw) return null;
  if (raw.state && raw.savedAt) return raw;
  return { savedAt: null, state: raw };
}
