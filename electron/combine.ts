import fs from 'fs'
import path from 'path'
import JSZip from 'jszip'
import type { AiDataResult } from './aiData'
import {
  alpacaRows,
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

type FileNote = { file: string; reason: string }

export type CombinedStats = {
  files: number
  sources: { source: string; pairs: number }[]
  pairs: number
  duplicates_removed: number
  train: number
  validation: number
  rows: { training: number; preferences: number; conversations: number }
  approx_tokens: number
  languages: string[]
  models: string[]
  // True when every source was double-checked by a second Claude pass
  reviewed: boolean
  created_at: string
  skipped_files: FileNote[]
  // Files that were processed but have gaps (e.g. some chunks failed)
  partial_files: FileNote[]
}
export type CombinedResult = {
  train: Pair[]
  validation: Pair[]
  conversations: { train: Conversation[]; validation: Conversation[] }
  chunks: Chunk[]
  stats: CombinedStats
}

type DatasetParts = { pairs: Pair[]; chunks: Chunk[]; conversations: Conversation[]; languages: string[]; models: string[]; reviewed: boolean }

const VALIDATION_PERCENT = 10

export async function combineDatasets(filePaths: string[]): Promise<CombinedResult> {
  const parts: DatasetParts[] = []
  const skipped: FileNote[] = []

  for (const filePath of filePaths) {
    try {
      parts.push(await readDataset(filePath))
    } catch (err) {
      skipped.push({ file: path.basename(filePath), reason: err instanceof Error ? err.message : String(err) })
    }
  }
  if (!parts.some((p) => p.pairs.length)) {
    throw new Error('None of these files contain Cipher training data. Use ZIPs saved from "Convert to AI Data".')
  }
  return merge(parts, skipped, [])
}

// Merges datasets made in this run (a batch of documents) without saving them first
export function combineResults(results: AiDataResult[], skipped: FileNote[]): CombinedResult {
  const parts = results.map((r) => ({
    pairs: r.pairs,
    chunks: r.chunks,
    conversations: r.conversations,
    languages: r.overview.language ? [r.overview.language] : [],
    models: [r.stats.model],
    reviewed: r.stats.options.review,
  }))
  const partial = results.filter((r) => r.warning).map((r) => ({ file: r.stats.source, reason: r.warning ?? '' }))
  return merge(parts, skipped, partial)
}

function merge(parts: DatasetParts[], skipped: FileNote[], partial: FileNote[]): CombinedResult {
  const allPairs = parts.flatMap((p) => p.pairs)
  const unique = dedupe(allPairs, pairKey)
  // Split whole pairs (never single phrasings), so a reworded question can't leak from training into validation
  const train = unique.filter((p) => !isValidation(pairKey(p)))
  const validation = unique.filter((p) => isValidation(pairKey(p)))

  const conversations = dedupe(
    parts.flatMap((p) => p.conversations),
    (c) => normalizeText(c.messages.map((m) => m.content).join(' '))
  )
  const conversationSplit = {
    train: conversations.filter((c) => !isValidation(normalizeText(c.messages.map((m) => m.content).join(' ')))),
    validation: conversations.filter((c) => isValidation(normalizeText(c.messages.map((m) => m.content).join(' ')))),
  }

  const sources = new Map<string, number>()
  for (const p of unique) sources.set(p.source, (sources.get(p.source) ?? 0) + 1)

  return {
    train,
    validation,
    conversations: conversationSplit,
    chunks: dedupe(parts.flatMap((p) => p.chunks), (c) => normalizeText(c.text)),
    stats: {
      files: parts.length,
      sources: [...sources].map(([source, count]) => ({ source, pairs: count })),
      pairs: unique.length,
      duplicates_removed: allPairs.length - unique.length,
      train: train.length,
      validation: validation.length,
      rows: {
        training: alpacaRows(unique).length,
        preferences: preferenceRows(unique).length,
        conversations: conversations.length,
      },
      approx_tokens: datasetTokens(unique),
      languages: [...new Set(parts.flatMap((p) => p.languages))],
      models: [...new Set(parts.flatMap((p) => p.models))],
      reviewed: parts.every((p) => p.reviewed),
      created_at: new Date().toISOString(),
      skipped_files: skipped,
      partial_files: partial,
    },
  }
}

async function readDataset(filePath: string): Promise<DatasetParts> {
  const zip = await JSZip.loadAsync(await fs.promises.readFile(filePath)).catch(() => {
    throw new Error('not a valid ZIP file')
  })
  // ZIPs made before source tracking have no source field, so fall back to the ZIP's name
  const fallbackSource = path.basename(filePath, path.extname(filePath))
  const read = async (...names: string[]) => {
    const rows: Record<string, unknown>[] = []
    for (const name of names) {
      const file = zip.file(name)
      if (file) rows.push(...parseJsonl(await file.async('string')))
    }
    return rows
  }
  const has = (...names: string[]) => names.some((name) => zip.file(name))

  // pairs.jsonl holds the full records; older ZIPs only have Alpaca rows, where extra phrasings are skipped
  let pairs: Pair[]
  if (has('pairs.jsonl')) pairs = (await read('pairs.jsonl')).map((row, i) => toPair(row, fallbackSource, i))
  else if (has('alpaca.jsonl', 'alpaca/train.jsonl', 'alpaca/validation.jsonl')) {
    const rows = await read('alpaca.jsonl', 'alpaca/train.jsonl', 'alpaca/validation.jsonl')
    pairs = rows.filter((row) => !Number(row.variant)).map((row, i) => toPair(row, fallbackSource, i))
  } else throw new Error('no training data inside — not a "Convert to AI Data" ZIP')

  const conversations = (await read('conversations.jsonl', 'conversations/train.jsonl', 'conversations/validation.jsonl'))
    .map((row) => toConversation(row, fallbackSource))
    .filter((c): c is Conversation => c !== null)

  const chunks = (await read('chunks.jsonl')).map((row): Chunk => {
    const text = str(row.text)
    return {
      source: str(row.source) || fallbackSource,
      chunk: Number(row.chunk ?? row.id ?? 0),
      context: str(row.context),
      text,
      search_text: str(row.search_text) || text,
      approx_tokens: Number(row.approx_tokens ?? 0),
    }
  })

  const statsFile = zip.file('stats.json')
  const stats = statsFile ? (JSON.parse(await statsFile.async('string')) as Record<string, unknown>) : {}
  const list = (single: unknown, many: unknown) => [...(Array.isArray(many) ? many : []), single].filter((v): v is string => typeof v === 'string' && v !== '')

  return {
    pairs: pairs.filter((p) => p.instruction && p.output),
    chunks,
    conversations,
    languages: list(stats.language, stats.languages),
    models: list(stats.model, stats.models),
    reviewed: (stats.options as { review?: boolean } | undefined)?.review === true || stats.reviewed === true,
  }
}

function toPair(row: Record<string, unknown>, fallbackSource: string, index: number): Pair {
  const source = str(row.source) || fallbackSource
  const chunk = Number(row.chunk ?? 0)
  return {
    id: str(row.id) || str(row.pair_id) || `${source}#${chunk}.${index + 1}`,
    source,
    chunk,
    instruction: str(row.instruction).trim(),
    output: str(row.output).trim(),
    quote: str(row.quote),
    variants: Array.isArray(row.variants) ? row.variants.filter((v): v is string => typeof v === 'string' && v.trim() !== '') : [],
    rejected: str(row.rejected),
  }
}

function toConversation(row: Record<string, unknown>, fallbackSource: string): Conversation | null {
  if (!Array.isArray(row.messages)) return null
  const messages = row.messages.filter(
    (m): m is Message => !!m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string'
  )
  return messages.length >= 2 ? { source: str(row.source) || fallbackSource, chunk: Number(row.chunk ?? 0), messages } : null
}

const str = (value: unknown) => (typeof value === 'string' ? value : '')

function parseJsonl(content: string): Record<string, unknown>[] {
  return content
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

function pairKey(p: Pair): string {
  return `${normalizeText(p.instruction)}\n${normalizeText(p.output)}`
}

function dedupe<T>(items: T[], key: (item: T) => string): T[] {
  const seen = new Set<string>()
  return items.filter((item) => {
    const k = key(item)
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}

// Split by a hash of the text (not randomly), so an item stays in the same split when more datasets are added later
function isValidation(key: string): boolean {
  return fnv1a(key) % 100 < VALIDATION_PERCENT
}

function fnv1a(text: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

export function combinedFiles(result: CombinedResult): Record<string, string> {
  const { train, validation, conversations, chunks, stats } = result
  const files: Record<string, string> = { 'pairs.jsonl': jsonl([...train, ...validation]) }
  const configs: DatasetConfig[] = []

  // Writes <name>/train.jsonl and <name>/validation.jsonl; the card only lists the validation split when it has rows
  const addSplit = (name: string, trainRows: unknown[], validationRows: unknown[]) => {
    files[`${name}/train.jsonl`] = jsonl(trainRows)
    files[`${name}/validation.jsonl`] = jsonl(validationRows)
    configs.push({
      name,
      train: `${name}/train.jsonl`,
      ...(validationRows.length ? { validation: `${name}/validation.jsonl` } : {}),
      rows: trainRows.length + validationRows.length,
    })
  }

  addSplit('alpaca', alpacaRows(train), alpacaRows(validation))
  addSplit('chat', chatRows(train), chatRows(validation))
  const preferences = { train: preferenceRows(train), validation: preferenceRows(validation) }
  if (preferences.train.length + preferences.validation.length) addSplit('preferences', preferences.train, preferences.validation)
  if (conversations.train.length + conversations.validation.length) {
    addSplit('conversations', conversationRows(conversations.train), conversationRows(conversations.validation))
  }

  files['chunks.jsonl'] = jsonl(chunks)
  configs.push({ name: 'chunks', train: 'chunks.jsonl', rows: chunks.length })
  configs.push({ name: 'pairs', train: 'pairs.jsonl', rows: stats.pairs })
  files['stats.json'] = JSON.stringify(stats, null, 2)

  const names = stats.sources.map((s) => s.source)
  files['README.md'] = datasetCard({
    title: stats.sources.length === 1 ? `${names[0]} dataset` : `Combined dataset from ${stats.sources.length} documents`,
    summary: `Question–answer training data generated from ${names.join(', ')}.`,
    languages: stats.languages,
    sources: stats.sources,
    models: stats.models.length ? stats.models : ['unknown model'],
    createdAt: stats.created_at,
    reviewed: stats.reviewed,
    configs,
  })
  return files
}
