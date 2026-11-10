/** Translates English text to Spanish. Throws when no translation is available. */
export type Translator = (text: string) => Promise<string>;

export interface MyMemoryConfig {
  /**
   * A contact email for MyMemory. Without one, the free limit is about 5,000
   * characters a day; with one, about 50,000. No key or account is needed.
   */
  email?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

/** MyMemory sometimes returns HTML entities, such as &#39; for an apostrophe. */
function decodeEntities(text: string): string {
  return text.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (entity, code: string) => {
    if (code[0] !== '#') return ENTITIES[code.toLowerCase()] ?? entity;
    const point = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
    return Number.isFinite(point) && point <= 0x10ffff ? String.fromCodePoint(point) : entity;
  });
}

/**
 * MyMemory's free API (https://mymemory.translated.net/doc/spec.php). It answers
 * HTTP 200 even on failure, with the real status in responseStatus and the
 * error message in place of the translation.
 */
export function createMyMemoryTranslator({
  email,
  fetch: fetchFn = globalThis.fetch,
  timeoutMs = 8000,
}: MyMemoryConfig = {}): Translator {
  return async (text) => {
    const url = new URL('https://api.mymemory.translated.net/get');
    url.searchParams.set('q', text);
    url.searchParams.set('langpair', 'en|es');
    if (email) url.searchParams.set('de', email);

    const response = await fetchFn(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) throw new Error(`MyMemory answered HTTP ${response.status}`);
    const body: any = await response.json().catch(() => null);
    const translated = body?.responseData?.translatedText;
    if (Number(body?.responseStatus) !== 200 || typeof translated !== 'string' || !translated.trim()) {
      throw new Error(`MyMemory refused: ${String(body?.responseDetails ?? translated ?? 'no details').slice(0, 200)}`);
    }
    if (/^MYMEMORY WARNING/i.test(translated)) throw new Error(`MyMemory refused: ${translated.slice(0, 200)}`);
    return decodeEntities(translated.trim());
  };
}
