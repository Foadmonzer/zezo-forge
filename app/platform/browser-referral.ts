'use client';

type Attribution = { attributed: boolean; code?: string };
const pendingKey = 'zezo-platform-pending-referral';
let capture: { code: string; promise: Promise<Attribution> } | undefined;

function pendingCode() {
  try { return sessionStorage.getItem(pendingKey) || ''; }
  catch { return ''; }
}

/** Only the existing server endpoint can validate the first referral and issue its cookie. */
export function ensurePlatformReferral({ includeExisting = false } = {}): Promise<Attribution | null> {
  const url = new URL(location.href);
  const incoming = (url.searchParams.get('ref') || '').trim().slice(0, 100);
  const code = incoming || pendingCode();
  if (capture && (capture.code === code || (!code && capture.code))) return capture.promise;
  if (!code && !includeExisting) return Promise.resolve(null);
  if (code) {
    try { sessionStorage.setItem(pendingKey, code); } catch { /* Continue with the URL value. */ }
  }
  const endpoint = code ? `/api/referral-attribution?${new URLSearchParams({ ref: code })}` : '/api/referral-attribution';
  const promise = fetch(endpoint, { cache: 'no-store', credentials: 'same-origin', signal: AbortSignal.timeout(5000) })
    .then(async response => {
      if (!response.ok) throw new Error('Referral capture unavailable');
      const data = await response.json() as Attribution;
      if (code && pendingCode() === code) {
        try { sessionStorage.removeItem(pendingKey); } catch { /* The server cookie is already set. */ }
      }
      if (incoming && data.attributed) {
        const current = new URL(location.href);
        if (current.searchParams.get('ref') === incoming) {
          current.searchParams.delete('ref');
          history.replaceState(history.state, '', `${current.pathname}${current.search}${current.hash}`);
        }
      }
      return data;
    }).catch(error => {
      if (capture?.promise === promise) capture = undefined;
      throw error;
    });
  capture = { code, promise };
  return promise;
}
