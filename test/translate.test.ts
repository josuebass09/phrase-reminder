import { describe, expect, it, vi } from 'vitest';
import { createMyMemoryTranslator } from '../src/translate.js';

function fakeFetch(body: unknown, status = 200) {
  return vi.fn(async (_url: URL | RequestInfo, _init?: RequestInit) => new Response(JSON.stringify(body), { status }));
}

const ok = (translatedText: string) => ({ responseStatus: 200, responseData: { translatedText } });

describe('MyMemory translator', () => {
  it('asks for English to Spanish and returns the translation', async () => {
    const fetch = fakeFetch(ok('Te mantendré al corriente.'));

    const translation = await createMyMemoryTranslator({ fetch })("I'll keep you posted.");

    expect(translation).toBe('Te mantendré al corriente.');
    const url = new URL(String(fetch.mock.calls[0][0]));
    expect(url.origin + url.pathname).toBe('https://api.mymemory.translated.net/get');
    expect(url.searchParams.get('q')).toBe("I'll keep you posted.");
    expect(url.searchParams.get('langpair')).toBe('en|es');
    expect(url.searchParams.has('de')).toBe(false);
  });

  it('sends the contact email when there is one, for the higher free limit', async () => {
    const fetch = fakeFetch(ok('Hola.'));

    await createMyMemoryTranslator({ fetch, email: 'me@example.com' })('Hello.');

    expect(new URL(String(fetch.mock.calls[0][0])).searchParams.get('de')).toBe('me@example.com');
  });

  it('decodes HTML entities in the translation', async () => {
    const fetch = fakeFetch(ok('Es &quot;el bobo&quot; de Costa Rica &#39;tico&#39; &amp; m&#xE1;s'));

    expect(await createMyMemoryTranslator({ fetch })('x')).toBe(`Es "el bobo" de Costa Rica 'tico' & más`);
  });

  it.each([
    ['a refusal sent as HTTP 200', { responseStatus: '403', responseData: { translatedText: 'QUERY LENGTH LIMIT EXCEEDED' } }, 200],
    ['a used-up daily limit', ok('MYMEMORY WARNING: YOU USED ALL AVAILABLE FREE TRANSLATIONS FOR TODAY.'), 200],
    ['an empty translation', ok('   '), 200],
    ['an HTTP error', {}, 500],
    ['a body that is not a translation', { nothing: true }, 200],
  ])('throws for %s', async (_name, body, status) => {
    await expect(createMyMemoryTranslator({ fetch: fakeFetch(body, status) })('Hello.')).rejects.toThrow();
  });
});
