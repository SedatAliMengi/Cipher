import type Anthropic from '@anthropic-ai/sdk'
import { askForJson, describeClaudeError, isRequestLevelError, type JsonSchema } from './claude'
import {
  alpacaRows,
  approxTokens,
  chatRows,
  conversationRows,
  datasetCard,
  datasetTokens,
  jsonl,
  normalizeText,
  preferenceRows,
  type Chunk,
  type Conversation,
  type DatasetConfig,
  type Message,
  type Pair,
} from './formats'
import { StoppedError, type Hooks } from './jobs'

export type AiDataOptions = { review: boolean; extras: boolean }
export type Overview = { title: string; language: string; summary: string }
export type AiDataStats = {
  source: string
  title: string
  language: string
  model: string
  created_at: string
  options: AiDataOptions
  chunks: number
  pairs: number
  rows: { training: number; preferences: number; conversations: number }
  dropped: { unverified: number; review: number; duplicates: number }
  approx_source_tokens: number
  approx_dataset_tokens: number
  skipped_chunks: number[]
  unreviewed_chunks: number
}
export type AiDataResult = {
  overview: Overview
  chunks: Chunk[]
  pairs: Pair[]
  conversations: Conversation[]
  stats: AiDataStats
  warning?: string
}
export type AiDataInput = { client: Anthropic; model: string; source: string; text: string; options: AiDataOptions }

const CHUNK_CHARS = 8000 // ≈ 2,000 tokens
const CONCURRENCY = 3
// The start of a document is enough for its title, language and a summary
const OVERVIEW_CHARS = 15000
const MIN_REVIEW_SCORE = 3

// Split at paragraph breaks, falling back to sentence breaks and then hard cuts for oversized pieces
export function chunkText(text: string, maxChars = CHUNK_CHARS): string[] {
  const paragraphs = text
    .replace(/\r\n?/g, '\n')
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean)
    .flatMap((p) => (p.length > maxChars ? splitLong(p, maxChars) : [p]))
  return pack(paragraphs, maxChars, '\n\n')
}

function splitLong(paragraph: string, maxChars: number): string[] {
  const sentences = paragraph.match(/[^.!?]*[.!?]+\s*|[^.!?]+$/g) ?? [paragraph]
  const pieces = sentences.flatMap((s) => {
    const parts: string[] = []
    for (let i = 0; i < s.length; i += maxChars) parts.push(s.slice(i, i + maxChars))
    return parts
  })
  return pack(pieces, maxChars, '')
}

function pack(pieces: string[], maxChars: number, separator: string): string[] {
  const chunks: string[] = []
  let current = ''
  for (const piece of pieces) {
    if (current && current.length + separator.length + piece.length > maxChars) {
      chunks.push(current)
      current = piece
    } else {
      current = current ? current + separator + piece : piece
    }
  }
  if (current) chunks.push(current)
  return chunks
}

// A quote counts as found when each of its sentences appears word for word in the passage,
// ignoring case, spacing, curly quotes, dashes, ligatures and words hyphenated across line breaks
export function quoteFound(quote: string, passage: string): boolean {
  const text = matchable(passage)
  const parts = quote
    .split(/\.\.\.|…|(?<=[.!?])\s+/)
    .map((part) => matchable(part).replace(/^["'\s]+|["'\s.!?;:,]+$/g, ''))
    .filter((part) => part.split(' ').length >= 3)
  return parts.length > 0 && parts.every((part) => text.includes(part))
}

function matchable(text: string): string {
  return text
    .normalize('NFKC')
    .replace(/[‐‑‒–—―]/g, '-')
    .replace(/-\s*\n\s*/g, '')
    .replace(/-/g, ' ')
    .replace(/[‘’‚‛′]/g, "'")
    .replace(/[“”„‟″]/g, '"')
    .replace(/\s+/g, ' ')
    .toLowerCase()
    .trim()
}

const OVERVIEW_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    language: { type: 'string' },
    summary: { type: 'string' },
  },
  required: ['title', 'language', 'summary'],
  additionalProperties: false,
}

function overviewPrompt(text: string): string {
  return `Below is the beginning of a document. Return:
- title: the document's title, or a short descriptive title if it has none
- language: the ISO 639-1 code of the document's main language, such as "en" or "tr"
- summary: two sentences on what the whole document covers, written in the document's language

Document:
${text.slice(0, OVERVIEW_CHARS)}`
}

function chunkSchema(extras: boolean): JsonSchema {
  const pairProperties: Record<string, unknown> = {
    instruction: { type: 'string' },
    output: { type: 'string' },
    quote: { type: 'string' },
    ...(extras ? { variants: { type: 'array', items: { type: 'string' } }, rejected: { type: 'string' } } : {}),
  }
  const conversation = {
    type: 'array',
    items: {
      type: 'object',
      properties: { role: { type: 'string', enum: ['user', 'assistant'] }, content: { type: 'string' } },
      required: ['role', 'content'],
      additionalProperties: false,
    },
  }
  return {
    type: 'object',
    properties: {
      context: { type: 'string' },
      pairs: {
        type: 'array',
        items: { type: 'object', properties: pairProperties, required: Object.keys(pairProperties), additionalProperties: false },
      },
      ...(extras ? { conversation } : {}),
    },
    required: extras ? ['context', 'pairs', 'conversation'] : ['context', 'pairs'],
    additionalProperties: false,
  }
}

function chunkPrompt(passage: string, overview: Overview, extras: boolean): string {
  const about = overview.summary ? `"${overview.title}" — ${overview.summary}` : `"${overview.title}"`
  return `You are building a fine-tuning dataset that teaches a language model the knowledge contained in a document.

The document: ${about}

Below is one passage from that document. Based ONLY on this passage, return:

context: one or two sentences that place this passage within the whole document (which part it is and what it covers), so a search engine can find it later. Do not repeat the passage.

pairs: up to 6 instruction-response pairs.
- Mix the types: factual questions, "explain" requests, and short summaries of a specific idea.
- Every instruction must make sense on its own, without the passage. Never refer to "the passage", "the text", "the document" or "this section" — name the actual subject instead.
- Every output must be accurate and complete, and use only information from the passage. Answer directly, in full sentences.
- quote: copy, word for word, the sentence or sentences from the passage that the output is based on. Do not change, shorten or fix a single word.${
    extras
      ? `
- variants: two differently worded instructions that ask for exactly the same thing.
- rejected: a plausible-sounding but flawed answer to the instruction: subtly wrong, incomplete, or containing a claim the passage does not support.`
      : ''
  }
- No duplicate or near-duplicate pairs.
- Skip boilerplate such as tables of contents, reference lists, page headers and copyright notices. If the passage has little real content, return fewer pairs or an empty list.${
    extras
      ? `

conversation: a natural conversation of 4 to 6 messages between a curious user and an assistant about this passage. Start with the user and alternate. Follow-up questions should build on earlier answers, and the assistant must only state facts from the passage.`
      : ''
  }

Write everything in the same language as the passage.

Passage:
${passage}`
}

const REVIEW_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    reviews: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          index: { type: 'integer' },
          accurate: { type: 'boolean' },
          standalone: { type: 'boolean' },
          score: { type: 'integer' },
          issue: { type: 'string' },
        },
        required: ['index', 'accurate', 'standalone', 'score', 'issue'],
        additionalProperties: false,
      },
    },
  },
  required: ['reviews'],
  additionalProperties: false,
}

function reviewPrompt(passage: string, pairs: DraftPair[]): string {
  return `You are checking a fine-tuning dataset for quality. Below is a passage and a numbered list of question-answer pairs that were written from it.

For every pair, return:
- index: the pair's number
- accurate: true only if every claim in the answer is supported by the passage
- standalone: true if the question makes sense to someone who has not seen the passage
- score: 1 to 5 for how useful the pair is as training data (5 = excellent)
- issue: a few words on the main problem, or an empty string

Be strict: a single unsupported claim makes accurate false.

Passage:
${passage}

Pairs:
${pairs.map((p, i) => `${i}. Q: ${p.instruction}\n   A: ${p.output}`).join('\n')}`
}

type DraftPair = { instruction: string; output: string; quote: string; variants: string[]; rejected: string }
type Review = { index: number; accurate: boolean; standalone: boolean; score: number; issue: string }
type ChunkReply = {
  context?: string
  pairs?: { instruction?: string; output?: string; quote?: string; variants?: string[]; rejected?: string }[]
  conversation?: Message[]
}
type ChunkOutcome = {
  context: string
  pairs: DraftPair[]
  conversation: Message[] | null
  unverified: number
  failedReview: number
  reviewFailed: boolean
}

export async function generateAiData({ client, model, source, text, options }: AiDataInput, hooks: Hooks): Promise<AiDataResult> {
  const texts = chunkText(text)
  hooks.onProgress('Reading the document…', 0, texts.length)
  const overview = await getOverview(client, model, source, text)

  const outcomes: ChunkOutcome[] = []
  let firstError: unknown
  let next = 0
  let done = 0
  let failedHard = false
  let stoppedByUser = false

  const worker = async () => {
    while (!failedHard && next < texts.length) {
      if (hooks.shouldStop()) {
        stoppedByUser = true
        return
      }
      const index = next++
      try {
        outcomes[index] = await processChunk(client, model, texts[index], overview, options)
      } catch (err) {
        firstError ??= err
        // Request-level errors (bad key, no credit) would fail every remaining chunk the same way
        if (isRequestLevelError(err)) failedHard = true
      }
      hooks.onProgress(`Generating training data… ${++done} of ${texts.length} chunks done`, done, texts.length)
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, texts.length) }, worker))

  const chunks: Chunk[] = texts.map((t, i) => {
    const context = outcomes[i]?.context ?? ''
    return { source, chunk: i + 1, context, text: t, search_text: context ? `${context}\n\n${t}` : t, approx_tokens: approxTokens(t) }
  })

  const dropped = { unverified: 0, review: 0, duplicates: 0 }
  const seen = new Set<string>()
  const pairs: Pair[] = []
  const conversations: Conversation[] = []
  outcomes.forEach((outcome, i) => {
    dropped.unverified += outcome.unverified
    dropped.review += outcome.failedReview
    outcome.pairs.forEach((p, n) => {
      const key = `${normalizeText(p.instruction)}\n${normalizeText(p.output)}`
      if (seen.has(key)) {
        dropped.duplicates++
        return
      }
      seen.add(key)
      pairs.push({ id: `${source}#${i + 1}.${n + 1}`, source, chunk: i + 1, ...p })
    })
    if (outcome.conversation) conversations.push({ source, chunk: i + 1, messages: outcome.conversation })
  })

  if (pairs.length === 0) {
    if (stoppedByUser) throw new StoppedError()
    if (firstError) throw firstError
    throw new Error('No usable training pairs came out of this document: every pair failed the quote check or the double-check.')
  }

  const skipped = texts.map((_, i) => i + 1).filter((n) => !outcomes[n - 1])
  const unreviewed = outcomes.filter((o) => o.reviewFailed).length
  const stats: AiDataStats = {
    source,
    title: overview.title,
    language: overview.language,
    model,
    created_at: new Date().toISOString(),
    options: { review: options.review, extras: options.extras },
    chunks: texts.length,
    pairs: pairs.length,
    rows: { training: alpacaRows(pairs).length, preferences: preferenceRows(pairs).length, conversations: conversations.length },
    dropped,
    approx_source_tokens: approxTokens(text),
    approx_dataset_tokens: datasetTokens(pairs),
    skipped_chunks: skipped,
    unreviewed_chunks: unreviewed,
  }

  const warnings: string[] = []
  if (stoppedByUser) warnings.push(`Stopped early: ${texts.length - skipped.length} of ${texts.length} chunks were processed.`)
  else if (skipped.length) {
    warnings.push(`${skipped.length} of ${texts.length} chunks couldn't be processed, so their training data is missing. ${describeClaudeError(firstError)}`)
  }
  if (unreviewed) warnings.push(`${unreviewed} chunk${unreviewed === 1 ? '' : 's'} couldn't be double-checked, so their pairs only passed the quote check.`)

  return { overview, chunks, pairs, conversations, stats, ...(warnings.length ? { warning: warnings.join(' ') } : {}) }
}

async function getOverview(client: Anthropic, model: string, source: string, text: string): Promise<Overview> {
  try {
    const reply = (await askForJson(client, model, overviewPrompt(text), OVERVIEW_SCHEMA)) as Partial<Overview>
    const language = (reply.language ?? '').trim().toLowerCase()
    return { title: reply.title?.trim() || source, language: /^[a-z]{2}$/.test(language) ? language : '', summary: reply.summary?.trim() ?? '' }
  } catch (err) {
    // Only the title, language and summary depend on this, so carry on without them unless every request would fail
    if (isRequestLevelError(err)) throw err
    return { title: source, language: '', summary: '' }
  }
}

async function processChunk(client: Anthropic, model: string, passage: string, overview: Overview, options: AiDataOptions): Promise<ChunkOutcome> {
  const reply = (await askForJson(client, model, chunkPrompt(passage, overview, options.extras), chunkSchema(options.extras))) as ChunkReply
  const candidates = (reply.pairs ?? []).map(cleanPair).filter((p) => p.instruction && p.output)
  const verified = candidates.filter((p) => quoteFound(p.quote, passage))

  let kept = verified
  let reviewFailed = false
  if (options.review && verified.length > 0) {
    try {
      const reviews = await reviewPairs(client, model, passage, verified)
      kept = verified.filter((_, i) => passesReview(reviews.get(i)))
    } catch (err) {
      // These pairs are already paid for and passed the quote check, so keep them unless every request would fail
      if (isRequestLevelError(err)) throw err
      reviewFailed = true
    }
  }

  return {
    context: (reply.context ?? '').trim(),
    pairs: kept,
    conversation: validConversation(reply.conversation),
    unverified: candidates.length - verified.length,
    failedReview: verified.length - kept.length,
    reviewFailed,
  }
}

async function reviewPairs(client: Anthropic, model: string, passage: string, pairs: DraftPair[]): Promise<Map<number, Review>> {
  const reply = (await askForJson(client, model, reviewPrompt(passage, pairs), REVIEW_SCHEMA)) as { reviews?: Review[] }
  return new Map((reply.reviews ?? []).map((r) => [r.index, r]))
}

// A pair the reviewer skipped is kept: it has already passed the quote check
function passesReview(review: Review | undefined): boolean {
  return !review || (review.accurate && review.standalone && review.score >= MIN_REVIEW_SCORE)
}

function cleanPair(p: NonNullable<ChunkReply['pairs']>[number]): DraftPair {
  const instruction = (p.instruction ?? '').trim()
  const output = (p.output ?? '').trim()
  const rejected = (p.rejected ?? '').trim()
  const variants = [...new Set((p.variants ?? []).map((v) => v.trim()))].filter((v) => v && normalizeText(v) !== normalizeText(instruction))
  return {
    instruction,
    output,
    quote: (p.quote ?? '').trim(),
    variants,
    rejected: normalizeText(rejected) === normalizeText(output) ? '' : rejected,
  }
}

// Training needs a conversation that starts with the user, alternates, and ends with an answer
function validConversation(messages: Message[] | undefined): Message[] | null {
  const turns = (messages ?? []).map((m) => ({ role: m.role, content: m.content.trim() })).filter((m) => m.content)
  while (turns.length && turns[turns.length - 1].role !== 'assistant') turns.pop()
  const alternates = turns.every((m, i) => m.role === (i % 2 === 0 ? 'user' : 'assistant'))
  return turns.length >= 2 && alternates ? turns : null
}

export function aiDataFiles(result: AiDataResult): Record<string, string> {
  const { overview, pairs, conversations, chunks, stats } = result
  const preferences = preferenceRows(pairs)
  const configs: DatasetConfig[] = [
    { name: 'alpaca', train: 'alpaca.jsonl', rows: stats.rows.training },
    { name: 'chat', train: 'chat.jsonl', rows: stats.rows.training },
    ...(preferences.length ? [{ name: 'preferences', train: 'preferences.jsonl', rows: preferences.length }] : []),
    ...(conversations.length ? [{ name: 'conversations', train: 'conversations.jsonl', rows: conversations.length }] : []),
    { name: 'chunks', train: 'chunks.jsonl', rows: chunks.length },
    { name: 'pairs', train: 'pairs.jsonl', rows: pairs.length },
  ]

  return {
    'pairs.jsonl': jsonl(pairs),
    'alpaca.jsonl': jsonl(alpacaRows(pairs)),
    'chat.jsonl': jsonl(chatRows(pairs)),
    ...(preferences.length ? { 'preferences.jsonl': jsonl(preferences) } : {}),
    ...(conversations.length ? { 'conversations.jsonl': jsonl(conversationRows(conversations)) } : {}),
    'chunks.jsonl': jsonl(chunks),
    'stats.json': JSON.stringify(stats, null, 2),
    'README.md': datasetCard({
      title: overview.title,
      summary: overview.summary,
      languages: overview.language ? [overview.language] : [],
      sources: [{ source: stats.source, pairs: pairs.length }],
      models: [stats.model],
      createdAt: stats.created_at,
      reviewed: stats.options.review,
      configs,
    }),
  }
}
