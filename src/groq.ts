/** Groq's OpenAI-compatible API. One free key covers the chat and speech models. */
export const GROQ_API = 'https://api.groq.com/openai/v1';

export interface GroqConfig {
  apiKey: string;
  model?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/** Free on Groq's free plan, with about 1,000 requests a day for the whole account. */
export const DEFAULT_GROQ_MODEL = 'openai/gpt-oss-120b';

export interface JsonRequest {
  apiKey: string;
  model: string;
  fetch: typeof fetch;
  timeoutMs: number;
  /** The instructions. What the user wrote goes in `user`, never here. */
  system: string;
  user: string;
  /** A name for the answer's shape, and the JSON schema it must match. */
  name: string;
  schema: object;
}

/** Throws with Groq's status and the start of its explanation. */
export async function failedRequest(response: Response): Promise<never> {
  const detail = await response.text().catch(() => '');
  throw new Error(`Groq answered HTTP ${response.status}: ${detail.slice(0, 200)}`);
}

/**
 * Asks a chat model for an answer that matches the schema, and returns it parsed
 * (https://console.groq.com/docs/structured-outputs). Strict structured outputs
 * make the model answer with JSON of that shape. Throws for anything else.
 */
export async function askForJson({ apiKey, model, fetch, timeoutMs, system, user, name, schema }: JsonRequest): Promise<any> {
  const response = await fetch(`${GROQ_API}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      response_format: { type: 'json_schema', json_schema: { name, strict: true, schema } },
      // These answers need little thought, and reasoning tokens count toward the free limits.
      reasoning_effort: 'low',
      include_reasoning: false,
      max_completion_tokens: 1024,
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) await failedRequest(response);

  const body: any = await response.json().catch(() => null);
  const choice = body?.choices?.[0];
  const content = choice?.message?.content;
  if (typeof content !== 'string' || !content.trim()) {
    throw new Error(`Groq gave no answer (${String(choice?.finish_reason ?? 'no choices')})`);
  }
  try {
    return JSON.parse(content);
  } catch {
    throw new Error('Groq answered with invalid JSON');
  }
}
