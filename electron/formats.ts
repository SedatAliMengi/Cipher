export type Message = { role: 'user' | 'assistant'; content: string }

// One question–answer pair with everything Cipher knows about it; pairs.jsonl stores these as-is
export type Pair = {
  id: string
  source: string
  chunk: number
  instruction: string
  output: string
  // The exact sentence(s) from the document the answer is based on
  quote: string
  // Differently worded versions of the instruction
  variants: string[]
  // A plausible but flawed answer, for preference training
  rejected: string
}

export type Chunk = {
  source: string
  chunk: number
  // One or two sentences placing the chunk in its document, for search (contextual retrieval)
  context: string
  text: string
  search_text: string
  approx_tokens: number
}

export type Conversation = { source: string; chunk: number; messages: Message[] }

export type DatasetConfig = { name: string; train: string; validation?: string; rows: number }

// Rough estimate (~4 characters per token in English); real counts vary by model and language
export function approxTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

// Case, punctuation and spacing differences don't make two texts different
export function normalizeText(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
}

export const jsonl = (rows: unknown[]) => rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : '')

// One row per phrasing (the original question plus each reworded variant), so fine-tuning sees each fact several ways
export function alpacaRows(pairs: Pair[]) {
  return pairs.flatMap((p) =>
    [p.instruction, ...p.variants].map((instruction, variant) => ({
      instruction,
      input: '',
      output: p.output,
      source: p.source,
      chunk: p.chunk,
      pair_id: p.id,
      variant,
    }))
  )
}

// Chat format stays minimal — {"messages": [...]} is the exact shape OpenAI's fine-tuning expects
export function chatRows(pairs: Pair[]) {
  return pairs.flatMap((p) =>
    [p.instruction, ...p.variants].map((instruction) => ({
      messages: [
        { role: 'user', content: instruction },
        { role: 'assistant', content: p.output },
      ],
    }))
  )
}

// Prompt / chosen / rejected: the format preference training (DPO) uses
export function preferenceRows(pairs: Pair[]) {
  return pairs.filter((p) => p.rejected).map((p) => ({ prompt: p.instruction, chosen: p.output, rejected: p.rejected }))
}

export function conversationRows(conversations: Conversation[]) {
  return conversations.map((c) => ({ messages: c.messages }))
}

export function datasetTokens(pairs: Pair[]): number {
  return alpacaRows(pairs).reduce((sum, row) => sum + approxTokens(row.instruction + row.output), 0)
}

export const CONFIG_DESCRIPTIONS: Record<string, string> = {
  pairs: 'One row per pair with its supporting quote, reworded questions and rejected answer (the master file)',
  alpaca: '`instruction`, `input`, `output`, plus `source`, `chunk`, `pair_id` and `variant` (reworded questions are extra rows)',
  chat: '`messages` with a user question and the assistant answer, one row per phrasing',
  preferences: '`prompt`, `chosen`, `rejected` for preference training (DPO)',
  conversations: 'Multi-turn `messages` conversations, each based on one chunk',
  chunks: 'The source text in chunks, each with a `context` line and `search_text` for retrieval (RAG)',
}

export type CardInfo = {
  title: string
  summary: string
  languages: string[]
  sources: { source: string; pairs: number }[]
  models: string[]
  createdAt: string
  reviewed: boolean
  configs: DatasetConfig[]
}

// A Hugging Face dataset card: the README.md the Hub shows, with front matter that maps the files to configs and splits
export function datasetCard(info: CardInfo): string {
  const frontMatter = [
    '---',
    ...(info.languages.length ? ['language:', ...info.languages.map((l) => `- ${l}`)] : []),
    `pretty_name: ${JSON.stringify(info.title)}`,
    'task_categories:',
    '- question-answering',
    '- text-generation',
    'size_categories:',
    `- ${sizeCategory(Math.max(0, ...info.configs.map((c) => c.rows)))}`,
    'configs:',
    ...info.configs.flatMap((c) =>
      c.validation
        ? [`- config_name: ${c.name}`, '  data_files:', '  - split: train', `    path: ${c.train}`, '  - split: validation', `    path: ${c.validation}`]
        : [`- config_name: ${c.name}`, `  data_files: ${c.train}`]
    ),
    '---',
  ]

  const documents = info.sources.length === 1 ? '1 document' : `${info.sources.length} documents`
  const body = [
    `# ${info.title}`,
    '',
    ...(info.summary ? [info.summary, ''] : []),
    `Generated with Cipher from ${documents} using ${info.models.map((m) => `\`${m}\``).join(', ')} on ${info.createdAt.slice(0, 10)}.`,
    '',
    '## Files',
    '',
    '| Config | Rows | Contents |',
    '|---|---|---|',
    ...info.configs.map((c) => `| \`${c.name}\` | ${c.rows.toLocaleString('en-US')} | ${CONFIG_DESCRIPTIONS[c.name] ?? ''} |`),
    '',
    '## How it was made',
    '',
    '- Each document was split into chunks of about 2,000 tokens.',
    '- For every chunk, Claude wrote question–answer pairs using only facts from that chunk, each with the exact sentence it is based on.',
    '- Every quote was checked word for word against the source text; pairs whose quote could not be found were dropped.',
    ...(info.reviewed ? ['- A second Claude pass checked every pair for accuracy and removed weak ones.'] : []),
    '- Exact duplicates were removed.',
    '',
    '## Sources',
    '',
    ...info.sources.map((s) => `- ${s.source} (${s.pairs.toLocaleString('en-US')} pairs)`),
    '',
    '## Before you use or publish this',
    '',
    "Machine-generated data can contain mistakes, so spot-check it. You need the right to use the source documents, and the AI provider's terms apply to how its output may be used.",
    '',
  ]

  return [...frontMatter, '', ...body].join('\n')
}

function sizeCategory(rows: number): string {
  if (rows < 1_000) return 'n<1K'
  if (rows < 10_000) return '1K<n<10K'
  if (rows < 100_000) return '10K<n<100K'
  if (rows < 1_000_000) return '100K<n<1M'
  return '1M<n<10M'
}
