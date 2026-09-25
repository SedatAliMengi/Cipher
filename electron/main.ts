import { app, BrowserWindow, ipcMain, dialog } from 'electron'
import path from 'path'
import fs from 'fs'
import type Anthropic from '@anthropic-ai/sdk'
import JSZip from 'jszip'
import { aiDataFiles, generateAiData, type AiDataResult } from './aiData'
import { askForJson, createClient, describeClaudeError, isAccountLevelError } from './claude'
import { combineDatasets, combinedFiles, combineResults, type CombinedResult } from './combine'
import { extractSource, listSupportedFiles, type Extracted } from './extract'
import { isSupported, SUPPORTED_EXTENSIONS } from './fileTypes'
import { StoppedError, type Hooks } from './jobs'
import type { BatchItem, BatchResult, ExpandedPaths, ProcessOptions, ProcessResult, SourceRef } from './types'

// Electron doesn't read .env by itself. A packaged app has no .env, so a missing file is fine.
try {
  process.loadEnvFile(path.join(app.getAppPath(), '.env'))
} catch {
  // no .env file
}

// Used by every output mode. Claude Haiku 4.5 is the cheapest Claude model; set CLAUDE_MODEL in .env to use another.
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || 'claude-haiku-4-5'

function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  if (process.env.VITE_DEV_SERVER_URL) {
    win.loadURL(process.env.VITE_DEV_SERVER_URL)
  } else {
    win.loadFile(path.join(__dirname, '../dist/index.html'))
  }
}

app.whenReady().then(createWindow)

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

let stopRequested = false

ipcMain.handle('pick-sources', async (_event, kind: 'files' | 'folder') => {
  const { canceled, filePaths } = await dialog.showOpenDialog(
    kind === 'folder'
      ? { properties: ['openDirectory'] }
      : { properties: ['openFile', 'multiSelections'], filters: [{ name: 'Documents and images', extensions: SUPPORTED_EXTENSIONS.map((e) => e.slice(1)) }] }
  )
  return canceled ? { files: [], unsupported: [], truncated: [] } : expandPaths(filePaths)
})

// Dropped or chosen paths -> readable files; folders are searched, anything else unreadable is reported by name
ipcMain.handle('expand-paths', (_event, paths: string[]) => expandPaths(paths))

async function expandPaths(paths: string[]): Promise<ExpandedPaths> {
  const files: string[] = []
  const unsupported: string[] = []
  const truncated: string[] = []
  for (const p of paths) {
    const stat = await fs.promises.stat(p).catch(() => null)
    if (stat?.isDirectory()) {
      const listed = await listSupportedFiles(p)
      files.push(...listed.files)
      if (listed.truncated) truncated.push(path.basename(p))
    } else if (stat?.isFile() && isSupported(p)) files.push(p)
    else unsupported.push(path.basename(p))
  }
  return { files, unsupported, truncated }
}

ipcMain.handle('stop', () => {
  stopRequested = true
})

ipcMain.handle('process', async (event, sources: SourceRef[], outputType: string, options: ProcessOptions): Promise<ProcessResult> => {
  stopRequested = false
  const hooks: Hooks = {
    onProgress: (label, done, total) => {
      if (!event.sender.isDestroyed()) event.sender.send('progress', { label, done, total })
    },
    shouldStop: () => stopRequested,
  }
  try {
    const client = createClient(getApiKey())
    return sources.length === 1
      ? await processOne(client, sources[0], outputType, options, hooks)
      : await processMany(client, sources, outputType, options, hooks)
  } catch (err) {
    throw new Error(describeClaudeError(err))
  }
})

async function processOne(client: Anthropic, source: SourceRef, outputType: string, options: ProcessOptions, hooks: Hooks): Promise<ProcessResult> {
  const { text, method } = await readSource(client, source, options, hooks)
  const data =
    outputType === 'ai-data'
      ? await generateAiData({ client, model: CLAUDE_MODEL, source: source.name, text, options }, hooks)
      : await runMode(client, outputType, text, hooks)
  return { type: outputType, data, filename: `${baseName(source.name)}_${outputType}.zip`, sourceText: text, note: `Read as: ${method}` }
}

async function processMany(client: Anthropic, sources: SourceRef[], outputType: string, options: ProcessOptions, hooks: Hooks): Promise<ProcessResult> {
  const results: AiDataResult[] = []
  const items: BatchItem[] = []
  const failures: { file: string; reason: string }[] = []

  for (const [i, source] of sources.entries()) {
    if (stopRequested) break
    const fileHooks: Hooks = {
      ...hooks,
      onProgress: (label, done, total) => hooks.onProgress(`File ${i + 1} of ${sources.length} · ${source.name} — ${label}`, done, total),
    }
    try {
      const { text, method } = await readSource(client, source, options, fileHooks)
      if (outputType === 'ai-data') {
        results.push(await generateAiData({ client, model: CLAUDE_MODEL, source: source.name, text, options }, fileHooks))
      } else {
        items.push({ name: source.name, method, text, data: await runMode(client, outputType, text, fileHooks) })
      }
    } catch (err) {
      if (err instanceof StoppedError) break
      failures.push({ file: source.name, reason: describeClaudeError(err) })
      // A bad key or an empty balance would fail every remaining file the same way
      if (isAccountLevelError(err)) break
    }
  }

  const done = results.length + items.length
  const notReached = sources.slice(done + failures.length)
  const why = stopRequested ? 'not processed: stopped early' : 'not processed: skipped after an account or connection error'
  failures.push(...notReached.map((s) => ({ file: s.name, reason: why })))
  if (done === 0) throw new Error(failures[0] ? `No file could be processed. ${failures[0].file}: ${failures[0].reason}` : 'Nothing was processed.')

  if (outputType === 'ai-data') {
    return { type: 'combined', data: combineResults(results, failures), filename: 'batch_ai-data.zip', sourceText: '' }
  }
  const batch: BatchResult = { mode: outputType, items, failures }
  return { type: 'batch', data: batch, filename: `batch_${outputType}.zip`, sourceText: '' }
}

async function readSource(client: Anthropic, source: SourceRef, options: ProcessOptions, hooks: Hooks): Promise<Extracted> {
  const extracted = await extractSource(source, { ...hooks, client, model: CLAUDE_MODEL, readVisuals: options.readVisuals })
  if (!extracted.text.trim()) throw new Error(`No text could be found in ${source.name}.`)
  return extracted
}

async function runMode(client: Anthropic, outputType: string, text: string, hooks: Hooks): Promise<Record<string, unknown>> {
  hooks.onProgress('Asking Claude…', 0, 1)
  const data = (await askForJson(client, CLAUDE_MODEL, buildPrompt(outputType, text))) as Record<string, unknown>
  hooks.onProgress('Asking Claude…', 1, 1)
  return data
}

ipcMain.handle('pick-datasets', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog({
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Cipher datasets', extensions: ['zip'] }],
  })
  return canceled ? [] : filePaths
})

ipcMain.handle('combine-datasets', (_event, filePaths: string[]) => combineDatasets(filePaths))

ipcMain.handle(
  'save-zip',
  async (_event, jsonData: Record<string, unknown>, sourceText: string, outputType: string, filename: string) => {
    const { canceled, filePath } = await dialog.showSaveDialog({
      defaultPath: filename,
      filters: [{ name: 'ZIP Files', extensions: ['zip'] }],
    })

    if (canceled || !filePath) return { success: false }

    const files =
      outputType === 'ai-data' ? aiDataFiles(jsonData as AiDataResult)
      : outputType === 'combined' ? combinedFiles(jsonData as CombinedResult)
      : outputType === 'batch' ? batchFiles(jsonData as BatchResult)
      : documentFiles(jsonData, sourceText, outputType)

    const zip = new JSZip()
    for (const [name, content] of Object.entries(files)) zip.file(name, content)
    const buffer = await zip.generateAsync({ type: 'nodebuffer' })
    fs.writeFileSync(filePath, buffer)

    return { success: true, filePath }
  }
)

function documentFiles(jsonData: Record<string, unknown>, sourceText: string, outputType: string): Record<string, string> {
  const trainingEntry = {
    instruction: trainingInstruction(outputType),
    input: sourceText,
    output: JSON.stringify(jsonData),
  }
  return {
    'output.json': JSON.stringify(jsonData, null, 2),
    'training.jsonl': JSON.stringify(trainingEntry),
  }
}

// A folder per processed file with its output.json and training.jsonl, plus a summary of what was processed
function batchFiles({ mode, items, failures }: BatchResult): Record<string, string> {
  const files: Record<string, string> = {}
  const used = new Set<string>()
  for (const item of items) {
    // Files with the same name (from different folders) each get their own folder
    let folder = baseName(item.name)
    for (let n = 2; used.has(folder); n++) folder = `${baseName(item.name)} (${n})`
    used.add(folder)
    for (const [name, content] of Object.entries(documentFiles(item.data, item.text, mode))) files[`${folder}/${name}`] = content
  }
  files['batch_summary.json'] = JSON.stringify(
    { mode, processed: items.map((i) => ({ file: i.name, read_as: i.method })), failed: failures },
    null,
    2
  )
  return files
}

// A short, file-system-safe name for output files: "report.pdf" -> "report", "https://site.com/a/b" -> "site.com_a_b"
function baseName(name: string): string {
  const readable = /^https?:\/\//i.test(name) ? name.replace(/^https?:\/\//i, '').replace(/\/+$/, '') : name.replace(/\.[a-z0-9]{2,5}$/i, '')
  return readable.replace(/[^\p{L}\p{N}._-]+/gu, '_').replace(/^_+|_+$/g, '').slice(0, 60) || 'document'
}

function getApiKey(): string {
  const apiKey = process.env.CLAUDE_API_KEY
  if (!apiKey) throw new Error('Claude API key not set — add CLAUDE_API_KEY to .env')
  return apiKey
}

function trainingInstruction(outputType: string): string {
  if (outputType === 'knowledge-base')
    return 'Extract structured knowledge from the following document and return it as a JSON object.'
  if (outputType === 'academic-research')
    return 'Analyze the following academic paper and extract structured research data, returning it as a JSON object.'
  if (outputType === 'student-summary')
    return 'Summarize the following document for a student audience and return it as a JSON object.'
  if (outputType === 'analytics')
    return 'Extract all significant data, metrics, trends, anomalies, and insights from the following document and return them as a JSON object.'
  return 'Process the following document and return the result as a JSON object.'
}

function buildPrompt(outputType: string, text: string): string {
  const truncated = text.substring(0, 200000)

  if (outputType === 'knowledge-base') {
    return `You are an expert knowledge extraction system. Analyze the following document and extract structured knowledge.

Return ONLY a valid JSON object with this exact structure. No markdown, no code blocks, no explanation — just raw JSON:
{
  "main_topic": "the primary subject of the document",
  "summary": "comprehensive 2-3 paragraph summary of the document",
  "key_facts": ["specific fact 1", "specific fact 2", "..."],
  "key_concepts": [{"term": "concept name", "definition": "clear definition"}],
  "connections_to_other_topics": ["related field or topic 1", "related field or topic 2"],
  "questions_raised": ["interesting question the document raises", "another question"]
}

Document text:
${truncated}`
  }

  if (outputType === 'academic-research') {
    return `You are an expert academic research analyst. Your job is to extract structured data from academic papers.

First, check if this document is an actual academic paper or study. If it is NOT (e.g. it is a news article, blog post, book chapter, or general document), return ONLY this JSON and nothing else:
{"error": "This document does not appear to be an academic paper. Academic Research output is designed for peer-reviewed studies, theses, and research articles."}

If it IS an academic paper, return ONLY a valid JSON object with EXACTLY these 9 fields in EXACTLY this order. No extra fields. No omitted fields. No markdown, no code blocks, no explanation — just raw JSON:
{
  "hypothesis": "the specific claim or question the researcher was trying to prove or answer",
  "research_type": "qualitative | quantitative | mixed methods",
  "methodology": "the specific method used — e.g. randomized controlled trial, survey, case study, meta-analysis, ethnography, literature review, experiment",
  "sample_and_data": "who or what was studied, how many subjects, where data came from, time period covered",
  "findings": "what the results actually showed — be specific, not vague",
  "key_figures": ["every number, percentage, p-value, effect size, sample size, or measurement mentioned in the paper"],
  "citations": ["each reference from the bibliography in its original formatted form"],
  "limitations": "weaknesses the authors themselves admitted — methodology gaps, small sample, bias, missing variables",
  "future_research": "what the authors suggested should be studied next"
}

The schema above is fixed. Return exactly these 9 fields every time. Never add fields. Never remove fields. Never rename fields.

Document text:
${truncated}`
  }

  if (outputType === 'student-summary') {
    return `You are a tutor explaining this document to a 16-year-old student who has never heard of this topic before. Use short sentences. Use everyday words. Cut all academic jargon. If you must use a technical term, immediately explain it in brackets in plain words.

Return ONLY a valid JSON object with this exact structure. No markdown, no code blocks, no explanation — just raw JSON:
{
  "title": "topic in plain words, max 10 words",
  "difficulty_level": "Beginner | Intermediate | Advanced",
  "one_liner": "explain the whole document in one simple sentence a 16-year-old would understand",
  "summary": "3-5 short paragraphs. Each paragraph max 3 sentences. Write like you are texting a smart friend. No academic tone. No long words.",
  "key_points": ["short punchy point, one sentence each, max 6 points"],
  "definitions": [{"term": "only truly necessary terms", "definition": "explain it like the student has never heard it — one sentence, plain words only"}]
}

Document text:
${truncated}`
  }

  if (outputType === 'analytics') {
    return `You are a data analyst. Your job is to extract the most significant numbers, measurements, and metrics from this document and explain what they mean.

First, check if this document contains meaningful data, statistics, or measurable metrics. If it does NOT (e.g. it is a novel, poem, or purely narrative text with no data), return ONLY this JSON and nothing else:
{"error": "This document does not contain significant data or metrics. Analytics output is designed for financial reports, business reports, survey results, market analysis, and research statistics."}

If it DOES contain data, return ONLY a valid JSON object with EXACTLY these 8 fields in EXACTLY this order. No extra fields. No omitted fields. No markdown, no code blocks, no explanation — just raw JSON.

CRITICAL INSTRUCTIONS — follow these exactly or the output will be unusable:
1. key_metrics: include at most 20 entries. Pick only the most important metrics. Do NOT list every number in the document.
2. trends, patterns, anomalies, data_sources, insights: keep each array to at most 8 entries. Be concise — one sentence per entry.
3. visualizable_data: include at most 5 datasets, only if clear time-series or categorical data exists. Use an empty array [] if none apply.
4. You MUST complete every field in the schema. Do not stop early. If you are running long, shorten individual entries rather than omitting fields.
5. The schema is fixed — never add fields, never remove fields, never rename fields.

{
  "document_type": "what kind of data document this is — e.g. financial report, market analysis, survey results",
  "key_metrics": [
    {
      "metric": "name of the metric",
      "value": "the actual number, percentage, or measurement — be exact",
      "context": "one sentence explaining what this number means and why it matters"
    }
  ],
  "trends": ["what is increasing, decreasing, or shifting over time — include specific numbers where available"],
  "patterns": ["recurring behaviors, cycles, or consistent themes found across the data"],
  "anomalies": ["anything that stands out as unusual, unexpected, or inconsistent with the rest of the data — include the specific value"],
  "data_sources": ["where the numbers came from — surveys, databases, filings, instruments, platforms, etc."],
  "insights": ["what the data actually means in plain language — implications, conclusions, so-what statements"],
  "visualizable_data": [
    {
      "label": "name of the data set — e.g. Monthly Revenue 2023, Survey Responses by Age Group",
      "values": ["each data point as a string — e.g. Jan: $4.2M, Feb: $3.8M"]
    }
  ]
}

Document text:
${truncated}`
  }

  throw new Error(`Unknown output type: ${outputType}`)
}
