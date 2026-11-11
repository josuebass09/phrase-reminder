import { describe, expect, it, vi } from 'vitest';
import type { AiUse } from '../src/db.js';
import { aiServiceOf, meteredFetch } from '../src/meter.js';

const CHAT = 'https://api.groq.com/openai/v1/chat/completions';
const SPEECH = 'https://api.groq.com/openai/v1/audio/transcriptions';
const MYMEMORY = 'https://api.mymemory.translated.net/get?q=Hello%20there&langpair=en%7Ces';

/** A fetch that answers every request with `response`, and the uses counted through it. */
function metered(response: () => Response | Promise<Response>) {
  const uses: AiUse[] = [];
  const record = vi.fn(async (use: AiUse) => {
    uses.push(use);
  });
  const fetch = meteredFetch(record, vi.fn(async () => response()));
  return { fetch, uses, record };
}

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), { ...init, headers: { 'Content-Type': 'application/json', ...init.headers } });

describe('aiServiceOf', () => {
  it.each([
    [CHAT, 'groq_chat'],
    [SPEECH, 'groq_speech'],
    [MYMEMORY, 'mymemory'],
    ['https://fcm.googleapis.com/fcm/send/abc', null],
    ['https://api.groq.com/openai/v1/models', null],
  ])('%s is %s', (url, service) => {
    expect(aiServiceOf(url)).toBe(service);
  });
});

describe('meteredFetch', () => {
  it("counts a chat answer's tokens and Groq's daily requests left, and still hands over the whole answer", async () => {
    const { fetch, uses } = metered(() =>
      json(
        { choices: [{ message: { content: '{}' } }], usage: { total_tokens: 321 } },
        { headers: { 'x-ratelimit-limit-requests': '1000', 'x-ratelimit-remaining-requests': '874' } },
      ),
    );

    const response = await fetch(CHAT, { method: 'POST' });

    expect((await response.json()).usage.total_tokens).toBe(321);
    await vi.waitFor(() => expect(uses).toHaveLength(1));
    expect(uses[0]).toEqual({ service: 'groq_chat', ok: true, rateLimited: false, units: 321, quota: { limit: 1000, left: 874 } });
  });

  it('counts the seconds of audio heard', async () => {
    const { fetch, uses } = metered(() => json({ text: 'Hello', duration: 2.4 }));

    await fetch(SPEECH, { method: 'POST' });

    await vi.waitFor(() => expect(uses).toHaveLength(1));
    expect(uses[0]).toMatchObject({ service: 'groq_speech', ok: true, units: 3 });
  });

  it("counts Groq's refusal for a limit as a rate-limited failure", async () => {
    const { fetch, uses } = metered(() => json({ error: { message: 'Rate limit reached' } }, { status: 429 }));

    const response = await fetch(CHAT, { method: 'POST' });

    expect(response.status).toBe(429);
    await vi.waitFor(() => expect(uses).toHaveLength(1));
    expect(uses[0]).toMatchObject({ service: 'groq_chat', ok: false, rateLimited: true, units: 0 });
  });

  it('counts the characters sent to MyMemory', async () => {
    const { fetch, uses } = metered(() => json({ responseStatus: 200, responseData: { translatedText: 'Hola' } }));

    await fetch(new URL(MYMEMORY));

    await vi.waitFor(() => expect(uses).toHaveLength(1));
    expect(uses[0]).toEqual({ service: 'mymemory', ok: true, rateLimited: false, units: 'Hello there'.length });
  });

  it("counts MyMemory's used-up daily limit as rate limited, though it answers HTTP 200", async () => {
    const { fetch, uses } = metered(() =>
      json({
        responseStatus: 429,
        responseData: { translatedText: 'MYMEMORY WARNING: YOU USED ALL AVAILABLE FREE TRANSLATIONS FOR TODAY.' },
      }),
    );

    await fetch(MYMEMORY);

    await vi.waitFor(() => expect(uses).toHaveLength(1));
    expect(uses[0]).toMatchObject({ service: 'mymemory', ok: false, rateLimited: true });
  });

  it('counts a request that never got an answer as a failure, and still throws', async () => {
    const uses: AiUse[] = [];
    const fetch = meteredFetch(
      async (use) => {
        uses.push(use);
      },
      vi.fn(async () => {
        throw new DOMException('The operation timed out.', 'TimeoutError');
      }),
    );

    await expect(fetch(CHAT, { method: 'POST' })).rejects.toThrow('timed out');
    await vi.waitFor(() => expect(uses).toEqual([{ service: 'groq_chat', ok: false, rateLimited: false, units: 0 }]));
  });

  it("doesn't count other requests", async () => {
    const { fetch, record } = metered(() => new Response(null, { status: 201 }));

    await fetch('https://fcm.googleapis.com/fcm/send/abc', { method: 'POST' });
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(record).not.toHaveBeenCalled();
  });

  it("doesn't fail the request when counting it fails", async () => {
    const quiet = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetch = meteredFetch(
      async () => {
        throw new Error('Database down');
      },
      vi.fn(async () => json({ usage: { total_tokens: 5 } })),
    );

    const response = await fetch(CHAT, { method: 'POST' });

    expect(response.ok).toBe(true);
    await vi.waitFor(() => expect(quiet).toHaveBeenCalledWith('Could not count an AI request:', expect.any(Error)));
    quiet.mockRestore();
  });
});
