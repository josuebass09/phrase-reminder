import type { AiService, AiUse } from './db.js';
import { GROQ_API } from './groq.js';

const MYMEMORY_API = 'https://api.mymemory.translated.net/';

/** Which AI service a request goes to, from its URL, or null for any other request. */
export function aiServiceOf(url: string): AiService | null {
  if (url.startsWith(`${GROQ_API}/chat/completions`)) return 'groq_chat';
  if (url.startsWith(`${GROQ_API}/audio/transcriptions`)) return 'groq_speech';
  if (url.startsWith(MYMEMORY_API)) return 'mymemory';
  return null;
}

/** Groq's daily requests for the model and how many are left, from its rate-limit headers (https://console.groq.com/docs/rate-limits). */
function quotaOf(response: Response): AiUse['quota'] {
  const limit = response.headers.get('x-ratelimit-limit-requests');
  const left = response.headers.get('x-ratelimit-remaining-requests');
  if (limit === null || left === null) return undefined;
  const quota = { limit: Number(limit), left: Number(left) };
  return Number.isInteger(quota.limit) && Number.isInteger(quota.left) ? quota : undefined;
}

/** What one answer used, read from a copy of it so the caller still gets the whole body. */
async function measure(service: AiService, url: string, response: Response): Promise<AiUse> {
  const body: any = await response.json().catch(() => null);
  if (service === 'mymemory') {
    // MyMemory answers HTTP 200 even when it refuses, with the real status inside.
    const status = Number(body?.responseStatus);
    const usedUp = /^MYMEMORY WARNING/i.test(String(body?.responseData?.translatedText ?? ''));
    return {
      service,
      ok: response.ok && status === 200 && !usedUp,
      rateLimited: status === 429 || usedUp,
      units: new URL(url).searchParams.get('q')?.length ?? 0,
    };
  }
  return {
    service,
    ok: response.ok,
    rateLimited: response.status === 429,
    // Tokens count toward Groq's limits for chat, and seconds of audio for speech.
    units: !response.ok ? 0 : service === 'groq_chat' ? Number(body?.usage?.total_tokens) || 0 : Math.ceil(Number(body?.duration) || 0),
    quota: quotaOf(response),
  };
}

/**
 * Wraps fetch to count each request to an AI service with `record`, on top of making it.
 * Counting happens after the answer is passed on and never fails the request: a failure
 * to count is only logged.
 */
export function meteredFetch(record: (use: AiUse) => Promise<void>, base: typeof fetch = globalThis.fetch): typeof fetch {
  const count = (use: AiUse) => record(use).catch((error) => console.warn('Could not count an AI request:', error));
  return async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    const service = aiServiceOf(url);
    let response: Response;
    try {
      response = await base(input, init);
    } catch (error) {
      if (service) void count({ service, ok: false, rateLimited: false, units: 0 }); // Timed out or unreachable.
      throw error;
    }
    if (service) {
      const copy = response.clone(); // Before the caller reads the body.
      void measure(service, url, copy).then(count);
    }
    return response;
  };
}
