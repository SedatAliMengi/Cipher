import fs from 'fs'
import path from 'path'
import JSZip from 'jszip'
import { datasetTokens, jsonl, toAlpaca, toChat, type Chunk, type TrainingPair } from './aiData'

export type CombinedStats = {
  files: number
  sources: { source: string; pairs: number }[]
  pairs: number
  duplicates_removed: number
  train: number
  validation: number
  approx_tokens: number
  skipped_files: { file: string; reason: string }[]
}
export type CombinedResult = {
  train: TrainingPair[]
  validation: TrainingPair[]
  chunks: Chunk[]
  stats: CombinedStats
}

const VALIDATION_PERCENT = 10
// Accepts single-document ZIPs from "Convert to AI Data" and ZIPs this function produced earlier
const PAIR_FILES = ['alpaca.jsonl', 'alpaca/train.jsonl', 'alpaca/validation.jsonl']

export async function combineDatasets(filePaths: string[]): Promise<CombinedResult> {
  const pairs: TrainingPair[] = []
  const chunks: Chunk[] = []
  const skipped: CombinedStats['skipped_files'] = []

  for (const filePath of filePaths) {
    try {
      const dataset = await readDataset(filePath)
      pairs.push(...dataset.pairs)
      chunks.push(...dataset.chunks)
    } catch (err) {
      skipped.push({ file: path.basename(filePath), reason: err instanceof Error ? err.message : String(err) })
    }
  }
  if (pairs.length === 0) {
    throw new Error('None of these files contain Cipher training data. Use ZIPs saved from "Convert to AI Data".')
  }

  const unique = dedupe(pairs, pairKey)
  const train = unique.filter((p) => !isValidation(p))
  const validation = unique.filter(isValidation)

  const sources = new Map<string, number>()
  for (const p of unique) sources.set(p.source, (sources.get(p.source) ?? 0) + 1)

  return {
    train,
    validation,
    chunks: dedupe(chunks, (c) => normalize(c.text)),
    stats: {
      files: filePaths.length - skipped.length,
      sources: [...sources].map(([source, count]) => ({ source, pairs: count })),
      pairs: unique.length,
      duplicates_removed: pairs.length - unique.length,
      train: train.length,
      validation: validation.length,
      approx_tokens: datasetTokens(unique),
      skipped_files: skipped,
    },
  }
}

async function readDataset(filePath: string): Promise<{ pairs: TrainingPair[]; chunks: Chunk[] }> {
  const zip = await JSZip.loadAsync(await fs.promises.readFile(filePath)).catch(() => {
    throw new Error('not a valid ZIP file')
  })
  const pairFiles = PAIR_FILES.map((name) => zip.file(name)).filter((f) => f !== null)
  if (pairFiles.length === 0) throw new Error('no training data inside — not a "Convert to AI Data" ZIP')

  // ZIPs made before source tracking have no source field, so fall back to the ZIP's name
  const fallbackSource = path.basename(filePath, path.extname(filePath))
  const pairs: TrainingPair[] = []
  for (const file of pairFiles) {
    for (const row of parseJsonl(await file.async('string'))) {
      pairs.push({
        instruction: String(row.instruction ?? '').trim(),
        output: String(row.output ?? '').trim(),
        source: String(row.source ?? fallbackSource),
        chunk: Number(row.chunk ?? 0),
      })
    }
  }

  const chunkFile = zip.file('chunks.jsonl')
  const chunks: Chunk[] = chunkFile
    ? parseJsonl(await chunkFile.async('string')).map((row) => ({
        source: String(row.source ?? fallbackSource),
        chunk: Number(row.chunk ?? row.id ?? 0),
        text: String(row.text ?? ''),
        approx_tokens: Number(row.approx_tokens ?? 0),
      }))
    : []

  return { pairs: pairs.filter((p) => p.instruction && p.output), chunks }
}

function parseJsonl(content: string): Record<string, unknown>[] {
  return content
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

// Case, punctuation and spacing differences don't make a pair unique
function normalize(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
}

function pairKey(p: TrainingPair): string {
  return `${normalize(p.instruction)}\n${normalize(p.output)}`
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

// Split by a hash of the pair's text (not randomly), so a pair stays in the same split when more datasets are added later
function isValidation(p: TrainingPair): boolean {
  return fnv1a(pairKey(p)) % 100 < VALIDATION_PERCENT
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
  return {
    'alpaca/train.jsonl': jsonl(result.train.map(toAlpaca)),
    'alpaca/validation.jsonl': jsonl(result.validation.map(toAlpaca)),
    'chat/train.jsonl': jsonl(result.train.map(toChat)),
    'chat/validation.jsonl': jsonl(result.validation.map(toChat)),
    'chunks.jsonl': jsonl(result.chunks),
    'stats.json': JSON.stringify(result.stats, null, 2),
  }
}
