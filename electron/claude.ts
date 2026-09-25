import Anthropic from '@anthropic-ai/sdk'

export type JsonSchema = { [key: string]: unknown }
// Plain text, or blocks that can mix text with PDFs and images
export type Content = string | Anthropic.ContentBlockParam[]

// A busy Claude can hold a request open for a long time; give up after 2 minutes (the SDK then retries it)
export const REQUEST_TIMEOUT_MS = 120_000
// Replies that come back as broken JSON are asked for again, up to this many times in total
const JSON_ATTEMPTS = 3

class RefusalError extends Error {}

// The SDK retries rate limits, overloads, timeouts and network errors by itself, with backoff.
// authToken: null stops it from also picking up an ANTHROPIC_AUTH_TOKEN set elsewhere on the machine.
export function createClient(apiKey: string): Anthropic {
  return new Anthropic({ apiKey, authToken: null, maxRetries: 4, timeout: REQUEST_TIMEOUT_MS })
}

// Sends one prompt and returns the parsed JSON reply. With a schema, Claude is forced to match it exactly.
export async function askForJson(client: Anthropic, model: string, content: Content, schema?: JsonSchema): Promise<unknown> {
  for (let attempt = 1; ; attempt++) {
    const text = await ask(client, model, content, schema)
    try {
      return JSON.parse(stripCodeFences(text))
    } catch {
      if (attempt >= JSON_ATTEMPTS) throw new Error("Claude's reply wasn't valid JSON, even after retrying. Try again.")
    }
  }
}

export async function askForText(client: Anthropic, model: string, content: Content): Promise<string> {
  return ask(client, model, content)
}

async function ask(client: Anthropic, model: string, content: Content, schema?: JsonSchema): Promise<string> {
  const response = await client.messages.create({
    model,
    max_tokens: 16000,
    messages: [{ role: 'user', content }],
    ...(schema && { output_config: { format: { type: 'json_schema' as const, schema } } }),
  })
  if (response.stop_reason === 'refusal') throw new RefusalError('Claude declined to process this text.')
  if (response.stop_reason === 'max_tokens') throw new Error("Claude's reply was too long and got cut off.")
  return response.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('')
}

// Claude sometimes wraps JSON in ```json fences even when told not to
function stripCodeFences(text: string): string {
  return text
    .replace(/^```json\s*/m, '')
    .replace(/^```\s*/m, '')
    .replace(/\s*```$/m, '')
    .trim()
}

// Errors that would fail every remaining request the same way (bad key, no credit, limit reached, no internet)
export function isRequestLevelError(err: unknown): boolean {
  return err instanceof Anthropic.APIError && (err.status === undefined || err.status < 500)
}

// The narrower set no other file would get past either: bad key, no credit, spend or rate limit, unknown model, no internet.
// Any other bad request (an image Claude can't read, say) only concerns the file that caused it.
export function isAccountLevelError(err: unknown): boolean {
  if (!(err instanceof Anthropic.APIError)) return false
  if (err.status === undefined || [401, 402, 403, 404, 429].includes(err.status)) return true
  return err.status === 400 && /credit balance|billing|usage limit|spend limit/i.test(err.message)
}

// Turns API errors into one readable sentence for the UI
export function describeClaudeError(err: unknown): string {
  if (err instanceof Anthropic.APIConnectionTimeoutError) {
    return "Claude didn't answer within 2 minutes, so it's probably overloaded. Try again in a few minutes."
  }
  if (err instanceof Anthropic.APIConnectionError) return "Couldn't reach Anthropic. Check your internet connection."
  if (err instanceof Anthropic.APIError) {
    switch (err.type) {
      case 'authentication_error':
        return 'Anthropic rejected your API key. Check CLAUDE_API_KEY in .env.'
      case 'billing_error':
        return 'Your Anthropic account is out of credit. Add some in the Claude Console under Settings → Billing.'
      case 'permission_error':
        return "Your Anthropic API key isn't allowed to use this model."
      case 'not_found_error':
        return "This Claude model isn't available to your API key. Set CLAUDE_MODEL in .env to one that is."
      case 'overloaded_error':
        return 'Claude is overloaded right now. Try again in a few minutes.'
    }
    // Spend limits, rate limits and bad requests come with a clear explanation from the API itself
    const body = err.error as { error?: { message?: string } } | undefined
    return `Anthropic: ${body?.error?.message ?? err.message}`
  }
  return err instanceof Error ? err.message : String(err)
}
