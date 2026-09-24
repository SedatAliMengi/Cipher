import type Anthropic from '@anthropic-ai/sdk'
import { askForJson, createClient, describeClaudeError, isRequestLevelError, type JsonSchema } from './claude'

export type Chunk = { source: string; chunk: number; text: string; approx_tokens: number }
export type TrainingPair = { instruction: string; output: string; source: string; chunk: number }
export type AiDataStats = {
  source: string
  model: string
  created_at: string
  chunks: number
  pairs: number
  approx_source_tokens: number
  approx_dataset_tokens: number
  skipped_chunks: number[]
}
export type AiDataResult = {
  chunks: Chunk[]
  pairs: TrainingPair[]
  stats: AiDataStats
  warning?: string
}
export type AiDataInput = { apiKey: string; model: string; source: string; text: string }

const CHUNK_CHARS = 8000 // ≈ 2,000 tokens
const CONCURRENCY = 3

// Rough estimate (~4 characters per token in English); real counts vary by model and language
export function approxTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

export function datasetTokens(pairs: TrainingPair[]): number {
  return pairs.reduce((sum, p) => sum + approxTokens(p.instruction + p.output), 0)
}

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

const PAIRS_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    pairs: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          instruction: { type: 'string' },
          output: { type: 'string' },
        },
        required: ['instruction', 'output'],
        additionalProperties: false,
      },
    },
  },
  required: ['pairs'],
  additionalProperties: false,
}

function pairsPrompt(passage: string): string {
  return `You are building a fine-tuning dataset that teaches a language model the knowledge contained in a document. Below is one passage from that document.

Write up to 6 instruction-response pairs based ONLY on this passage:
- Mix the types: factual questions, "explain" requests, and short summaries of a specific idea.
- Every instruction must make sense on its own, without the passage. Never refer to "the passage", "the text", "the document" or "this section" — name the actual subject instead.
- Every response must be accurate and complete, and use only information from the passage. Answer directly, in full sentences.
- No duplicate or near-duplicate pairs.
- Write in the same language as the passage.
- Skip boilerplate such as tables of contents, reference lists, page headers and copyright notices. If the passage has little real content, return fewer pairs or an empty list.

Passage:
${passage}`
}

async function generatePairs(client: Anthropic, model: string, passage: string) {
  const parsed = (await askForJson(client, model, pairsPrompt(passage), PAIRS_SCHEMA)) as { pairs?: { instruction: string; output: string }[] }
  return (parsed.pairs ?? [])
    .map((p) => ({ instruction: p.instruction.trim(), output: p.output.trim() }))
    .filter((p) => p.instruction && p.output)
}

export async function generateAiData(
  { apiKey, model: modelName, source, text }: AiDataInput,
  onProgress: (done: number, total: number) => void
): Promise<AiDataResult> {
  const client = createClient(apiKey)

  const chunks: Chunk[] = chunkText(text).map((t, i) => ({ source, chunk: i + 1, text: t, approx_tokens: approxTokens(t) }))
  const pairsByChunk: TrainingPair[][] = []
  let firstError: unknown
  let next = 0
  let done = 0
  let stopped = false

  const worker = async () => {
    while (!stopped && next < chunks.length) {
      const { chunk, text: passage } = chunks[next++]
      try {
        const pairs = await generatePairs(client, modelName, passage)
        pairsByChunk[chunk - 1] = pairs.map((p) => ({ ...p, source, chunk }))
      } catch (err) {
        firstError ??= err
        if (isRequestLevelError(err)) stopped = true
      }
      onProgress(++done, chunks.length)
    }
  }

  onProgress(0, chunks.length)
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, chunks.length) }, worker))

  const pairs = pairsByChunk.flat()
  if (pairs.length === 0) {
    throw firstError ?? new Error('No training pairs could be generated from this document.')
  }

  const stats: AiDataStats = {
    source,
    model: modelName,
    created_at: new Date().toISOString(),
    chunks: chunks.length,
    pairs: pairs.length,
    approx_source_tokens: approxTokens(text),
    approx_dataset_tokens: datasetTokens(pairs),
    skipped_chunks: chunks.filter((c) => !pairsByChunk[c.chunk - 1]).map((c) => c.chunk),
  }

  const result: AiDataResult = { chunks, pairs, stats }
  if (stats.skipped_chunks.length > 0) {
    result.warning = `${stats.skipped_chunks.length} of ${chunks.length} chunks couldn't be processed, so their training data is missing. ${describeClaudeError(firstError)}`
  }
  return result
}

// Alpaca format, plus source and chunk so every pair can be traced back to its document
export const toAlpaca = (p: TrainingPair) => ({ instruction: p.instruction, input: '', output: p.output, source: p.source, chunk: p.chunk })

// Chat format stays minimal — {"messages": [...]} is the exact shape OpenAI's fine-tuning expects
export const toChat = (p: TrainingPair) => ({
  messages: [
    { role: 'user', content: p.instruction },
    { role: 'assistant', content: p.output },
  ],
})

export const jsonl = (rows: unknown[]) => rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : '')

export function aiDataFiles(result: AiDataResult): Record<string, string> {
  return {
    'alpaca.jsonl': jsonl(result.pairs.map(toAlpaca)),
    'chat.jsonl': jsonl(result.pairs.map(toChat)),
    'chunks.jsonl': jsonl(result.chunks),
    'stats.json': JSON.stringify(result.stats, null, 2),
  }
}
