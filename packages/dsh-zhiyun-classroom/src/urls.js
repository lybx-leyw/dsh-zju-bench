// Older classroom records still return HTTP links for this media service.
// It serves the same signed paths over HTTPS; preserve the query verbatim.
export function resourceUrl(value) {
  const text = String(value);
  if (!/^http:/i.test(text)) return text;
  try {
    if (new URL(text).hostname === 'video.cmc.zju.edu.cn') return text.replace(/^http:/i, 'https:');
  } catch { /* Validation remains at the transport boundary. */ }
  return text;
}
