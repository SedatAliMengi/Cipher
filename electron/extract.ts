import fs from 'fs'
import path from 'path'
import type Anthropic from '@anthropic-ai/sdk'
import { convert } from 'html-to-text'
import JSZip from 'jszip'
import mammoth from 'mammoth'
import { PDFParse } from 'pdf-parse'
import { PDFDocument } from 'pdf-lib'
import { askForText } from './claude'
import { IMAGE_EXTENSIONS, isSupported, MAX_FOLDER_FILES } from './fileTypes'
import { runPool, StoppedError, type Hooks } from './jobs'
import type { SourceRef } from './types'

export type Extracted = { text: string; method: string }
export type ExtractContext = Hooks & { client: Anthropic; model: string; readVisuals: boolean }

// Pages sent to Claude per request, and how many requests run at once
const PAGES_PER_READ = 10
const READ_CONCURRENCY = 3
// Below this many characters per page, a PDF is mostly scanned images with little or no text layer
const MIN_CHARS_PER_PAGE = 100
// Claude takes at most 5 MB of base64 per image, which is 3.75 MB of file
const MAX_IMAGE_BASE64 = 5 * 1024 * 1024
const MAX_SHEET_ROWS = 5000

export async function extractSource(source: SourceRef, ctx: ExtractContext): Promise<Extracted> {
  if (source.kind === 'url') return extractUrl(source.url, ctx)

  const ext = path.extname(source.path).toLowerCase()
  if (IMAGE_EXTENSIONS.includes(ext)) return extractImage(await fs.promises.readFile(source.path), ctx)
  switch (ext) {
    case '.pdf':
      return extractPdf(await fs.promises.readFile(source.path), ctx)
    case '.docx':
      return { text: (await mammoth.extractRawText({ path: source.path })).value, method: 'Word document' }
    case '.pptx':
      return { text: await extractPptx(source.path), method: 'PowerPoint slides and notes' }
    case '.xlsx':
      return extractXlsx(source.path)
    case '.epub':
      return { text: await extractEpub(source.path), method: 'EPUB book' }
    case '.html':
    case '.htm':
      return { text: htmlToText(await readText(source.path)), method: 'HTML file' }
    case '.txt':
    case '.md':
    case '.csv':
      return { text: await readText(source.path), method: 'text file' }
    default:
      throw new Error(`Unsupported file type: ${ext || 'no extension'}`)
  }
}

// Every readable file in a folder and its subfolders (hidden ones skipped), up to MAX_FOLDER_FILES.
// truncated says there were more, so the window can tell the user instead of leaving files out silently.
export async function listSupportedFiles(dir: string): Promise<{ files: string[]; truncated: boolean }> {
  const found: string[] = []
  const walk = async (current: string) => {
    for (const entry of await fs.promises.readdir(current, { withFileTypes: true })) {
      if (found.length > MAX_FOLDER_FILES) return
      if (entry.name.startsWith('.')) continue
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) await walk(full)
      else if (entry.isFile() && isSupported(entry.name)) found.push(full)
    }
  }
  await walk(dir)
  found.sort((a, b) => a.localeCompare(b))
  return { files: found.slice(0, MAX_FOLDER_FILES), truncated: found.length > MAX_FOLDER_FILES }
}

async function readText(filePath: string): Promise<string> {
  return (await fs.promises.readFile(filePath, 'utf8')).replace(/^﻿/, '')
}

// --- PDFs and images -------------------------------------------------------------

async function extractPdf(buffer: Buffer, ctx: ExtractContext): Promise<Extracted> {
  const parsed = await readPdfText(buffer).catch(() => null)
  if (!parsed) {
    return { text: await readPdfWithClaude(buffer, ctx), method: "PDF read by Claude (its text couldn't be extracted locally)" }
  }
  const scanned = parsed.text.trim().length < MIN_CHARS_PER_PAGE * Math.max(parsed.pages, 1)
  if (!scanned && !ctx.readVisuals) return { text: parsed.text, method: 'PDF text' }

  const text = await readPdfWithClaude(buffer, ctx)
  return { text, method: scanned ? 'scanned PDF, read by Claude' : 'PDF read by Claude, including images and tables' }
}

// The PDF's own text layer, read locally for free, with a blank line between pages
async function readPdfText(buffer: Buffer): Promise<{ text: string; pages: number }> {
  // A copy, because the PDF engine may take over (and empty) the memory it is given
  const parser = new PDFParse({ data: new Uint8Array(buffer) })
  try {
    const result = await parser.getText({ pageJoiner: '\n\n' })
    return { text: result.text, pages: result.total }
  } finally {
    await parser.destroy()
  }
}

// Sends the PDF in parts of PAGES_PER_READ pages, so each request only pays for the pages it reads
async function readPdfWithClaude(buffer: Buffer, ctx: ExtractContext): Promise<string> {
  const { pdf, pageCount } = await openPdf(buffer)
  // pdf-lib can't decrypt, so pages copied out of an encrypted PDF would be unreadable
  if (pdf.isEncrypted) {
    throw new Error('This PDF is encrypted, so its pages can\'t be sent to Claude. Save an unprotected copy (for example with "Print to PDF") and try again.')
  }
  const starts = Array.from({ length: Math.ceil(pageCount / PAGES_PER_READ) }, (_, i) => i * PAGES_PER_READ)
  let read = 0
  ctx.onProgress(`Reading pages with Claude… 0 of ${pageCount}`, 0, pageCount)

  const parts = await runPool(starts, READ_CONCURRENCY, async (start) => {
    if (ctx.shouldStop()) throw new StoppedError()
    const end = Math.min(start + PAGES_PER_READ, pageCount)
    const part = await PDFDocument.create()
    const pages = await part.copyPages(pdf, Array.from({ length: end - start }, (_, i) => start + i))
    for (const page of pages) part.addPage(page)
    const data = Buffer.from(await part.save()).toString('base64')

    const text = await askForText(ctx.client, ctx.model, [
      { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } },
      { type: 'text', text: transcribePrompt('these PDF pages', start + 1) },
    ])
    read += end - start
    ctx.onProgress(`Reading pages with Claude… ${read} of ${pageCount}`, read, pageCount)
    return text
  })
  return parts.join('\n\n')
}

// pdf-lib accepts some broken files and only fails once their pages are read, so both steps share one check
async function openPdf(buffer: Buffer): Promise<{ pdf: PDFDocument; pageCount: number }> {
  try {
    const pdf = await PDFDocument.load(buffer, { ignoreEncryption: true })
    const pageCount = pdf.getPageCount()
    if (pageCount > 0) return { pdf, pageCount }
  } catch {
    // reported below
  }
  throw new Error("This PDF couldn't be opened. It may be damaged.")
}

async function extractImage(buffer: Buffer, ctx: ExtractContext): Promise<Extracted> {
  const mediaType = imageType(buffer)
  if (!mediaType) throw new Error("This isn't a PNG, JPEG, WebP or GIF image. Open it in an image editor, save it as JPEG or PNG, and try again.")
  if (Math.ceil(buffer.length / 3) * 4 > MAX_IMAGE_BASE64) {
    throw new Error('Images must be smaller than 3.75 MB. Save it as a JPEG or scale it down, then try again.')
  }
  ctx.onProgress('Reading the image with Claude…', 0, 1)
  const text = await askForText(ctx.client, ctx.model, [
    { type: 'image', source: { type: 'base64', media_type: mediaType, data: buffer.toString('base64') } },
    { type: 'text', text: transcribePrompt('this image') },
  ])
  ctx.onProgress('Reading the image with Claude…', 1, 1)
  return { text, method: 'image, read by Claude' }
}

// The real format, from the file's first bytes: a photo named .png is often a JPEG, and Claude rejects a mismatched type
export function imageType(buffer: Buffer): 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp' | null {
  const startsWith = (...bytes: number[]) => bytes.every((b, i) => buffer[i] === b)
  const text = (from: number, to: number) => buffer.toString('latin1', from, to)
  if (startsWith(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png'
  if (startsWith(0xff, 0xd8, 0xff)) return 'image/jpeg'
  if (text(0, 6) === 'GIF87a' || text(0, 6) === 'GIF89a') return 'image/gif'
  if (text(0, 4) === 'RIFF' && text(8, 12) === 'WEBP') return 'image/webp'
  return null
}

function transcribePrompt(what: string, firstPage?: number): string {
  const pages = firstPage ? `\n- Start each page with a line like "--- Page ${firstPage} ---", numbering the pages from ${firstPage}.` : ''
  return `Transcribe ${what} into clean Markdown.
- Keep all of the text, in reading order. Do not summarize, shorten or translate it.
- Write tables as Markdown tables.
- For every chart, diagram, figure or photo, add a short description in square brackets, like [Figure: ...], including any numbers, labels or trends it shows.${pages}
- Output only the transcription, with no introduction or closing remarks.`
}

// --- Web pages and HTML ----------------------------------------------------------

async function extractUrl(url: string, ctx: ExtractContext): Promise<Extracted> {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error(`"${url}" isn't a valid web address.`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('Only http:// and https:// links are supported.')

  ctx.onProgress('Downloading the page…', 0, 1)
  const response = await fetch(parsed, {
    signal: AbortSignal.timeout(30_000),
    headers: { 'user-agent': 'Mozilla/5.0 (compatible; Cipher document reader)' },
  }).catch(() => {
    throw new Error(`Couldn't download ${url}. Check the link and your internet connection.`)
  })
  if (!response.ok) throw new Error(`${url} returned an error (HTTP ${response.status}).`)

  const type = response.headers.get('content-type') ?? ''
  if (type.includes('application/pdf')) return extractPdf(Buffer.from(await response.arrayBuffer()), ctx)
  if (type.startsWith('image/')) return extractImage(Buffer.from(await response.arrayBuffer()), ctx)
  if (!/html|text\/plain/.test(type)) throw new Error(`${url} isn't a web page (${type.split(';')[0] || 'unknown type'}).`)
  const body = await response.text()
  return { text: type.includes('html') ? htmlToText(body) : body, method: 'web page' }
}

// The page's main content: the first of <article>, <main> or <body> with real text, without menus, footers or images
function htmlToText(html: string): string {
  for (const base of ['article', 'main', 'body']) {
    const text = convert(html, {
      wordwrap: false,
      baseElements: { selectors: [base] },
      selectors: [
        ...['nav', 'footer', 'aside', 'form', 'script', 'style', 'noscript', 'svg', 'img'].map((selector) => ({ selector, format: 'skip' })),
        { selector: 'a', options: { ignoreHref: true } },
        ...['h1', 'h2', 'h3', 'h4', 'h5', 'h6'].map((selector) => ({ selector, options: { uppercase: false } })),
      ],
    }).trim()
    if (text.length > 200 || base === 'body') return text
  }
  return ''
}

// --- Office files and EPUB (ZIP archives of XML) ----------------------------------

async function loadZip(filePath: string): Promise<JSZip> {
  return JSZip.loadAsync(await fs.promises.readFile(filePath)).catch(() => {
    throw new Error(`${path.basename(filePath)} couldn't be opened. It may be damaged or password-protected.`)
  })
}

async function extractPptx(filePath: string): Promise<string> {
  const zip = await loadZip(filePath)
  const slides: string[] = []
  for (const [i, slidePath] of (await slideOrder(zip)).entries()) {
    const xml = await zip.file(slidePath)?.async('string')
    if (!xml) continue
    const notesPath = [...(await readRels(zip, slidePath)).values()].find((r) => r.type.endsWith('/notesSlide'))?.target
    const notesXml = notesPath ? await zip.file(notesPath)?.async('string') : undefined
    // Notes pages also contain the slide number as a paragraph of its own
    const notes = notesXml ? paragraphs(notesXml).filter((line) => !/^\d+$/.test(line)) : []
    slides.push([`## Slide ${i + 1}`, ...paragraphs(xml), ...(notes.length ? ['', `Notes: ${notes.join(' ')}`] : [])].join('\n'))
  }
  return slides.join('\n\n')
}

// Slides in presentation order; the file names (slide1.xml, …) keep their original numbers after slides are moved
async function slideOrder(zip: JSZip): Promise<string[]> {
  const presentation = (await zip.file('ppt/presentation.xml')?.async('string')) ?? ''
  const rels = await readRels(zip, 'ppt/presentation.xml')
  const ordered = [...presentation.matchAll(/<p:sldId\b[^>]*>/g)]
    .map((m) => rels.get(attr(m[0], 'r:id'))?.target)
    .filter((target): target is string => !!target)
  if (ordered.length) return ordered
  const number = (name: string) => Number(/(\d+)\.xml$/.exec(name)?.[1] ?? 0)
  return Object.keys(zip.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((a, b) => number(a) - number(b))
}

// Text of every <a:p> paragraph, joining its <a:t> runs
function paragraphs(xml: string): string[] {
  return xml
    .split(/<\/a:p>/)
    .map((p) => [...p.matchAll(/<a:t(?:\s[^>]*)?>([^<]*)<\/a:t>/g)].map((m) => decodeXml(m[1])).join('').trim())
    .filter(Boolean)
}

async function extractXlsx(filePath: string): Promise<Extracted> {
  const zip = await loadZip(filePath)
  const shared = sharedStrings((await zip.file('xl/sharedStrings.xml')?.async('string')) ?? '')
  const workbook = (await zip.file('xl/workbook.xml')?.async('string')) ?? ''
  const rels = await readRels(zip, 'xl/workbook.xml')

  const sheets: string[] = []
  let rowsLeft = MAX_SHEET_ROWS
  let truncated = false
  for (const [tag] of workbook.matchAll(/<sheet\b[^>]*>/g)) {
    const target = rels.get(attr(tag, 'r:id'))?.target
    const xml = target ? await zip.file(target)?.async('string') : undefined
    if (!xml) continue
    const rows = sheetRows(xml, shared)
    if (rows.length > rowsLeft) truncated = true
    sheets.push(`## Sheet: ${decodeXml(attr(tag, 'name'))}\n\n${markdownTable(rows.slice(0, rowsLeft))}`)
    rowsLeft -= Math.min(rows.length, rowsLeft)
    if (rowsLeft <= 0) break
  }
  const limit = MAX_SHEET_ROWS.toLocaleString('en-US')
  return { text: sheets.join('\n\n'), method: truncated ? `Excel workbook (only the first ${limit} rows)` : 'Excel workbook' }
}

function sharedStrings(xml: string): string[] {
  return (xml.match(/<si\b[^>]*>[\s\S]*?<\/si>/g) ?? []).map((si) => [...si.matchAll(/<t(?:\s[^>]*)?>([^<]*)<\/t>/g)].map((m) => decodeXml(m[1])).join(''))
}

function sheetRows(xml: string, shared: string[]): string[][] {
  const rows: string[][] = []
  // Empty self-closing rows come first in the pattern so they can't swallow the next row
  for (const [, inner] of xml.matchAll(/<row\b[^>]*\/>|<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    if (!inner) continue
    const cells: string[] = []
    for (const [, attrs, content = ''] of inner.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const column = columnIndex(/\br="([A-Z]+)\d+"/.exec(attrs)?.[1] ?? '')
      const type = /\bt="(\w+)"/.exec(attrs)?.[1]
      const raw = /<v>([^<]*)<\/v>/.exec(content)?.[1] ?? ''
      const value =
        type === 's' ? shared[Number(raw)] ?? ''
        : type === 'inlineStr' ? [...content.matchAll(/<t(?:\s[^>]*)?>([^<]*)<\/t>/g)].map((m) => decodeXml(m[1])).join('')
        : type === 'b' ? (raw === '1' ? 'TRUE' : 'FALSE')
        : decodeXml(raw)
      cells[column >= 0 ? column : cells.length] = value
    }
    if (cells.some((cell) => cell?.trim())) rows.push(Array.from(cells, (cell) => cell ?? ''))
  }
  return rows
}

// "A" -> 0, "Z" -> 25, "AA" -> 26
function columnIndex(letters: string): number {
  return [...letters].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1
}

function markdownTable(rows: string[][]): string {
  if (!rows.length) return '(empty sheet)'
  const width = Math.max(...rows.map((r) => r.length))
  const cell = (value: string) => value.replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ')
  const line = (row: string[]) => `| ${Array.from({ length: width }, (_, i) => cell(row[i] ?? '')).join(' | ')} |`
  return [line(rows[0]), `|${' --- |'.repeat(width)}`, ...rows.slice(1).map(line)].join('\n')
}

async function extractEpub(filePath: string): Promise<string> {
  const zip = await loadZip(filePath)
  const container = (await zip.file('META-INF/container.xml')?.async('string')) ?? ''
  const opfPath = attr(/<rootfile\b[^>]*>/.exec(container)?.[0] ?? '', 'full-path')
  const opf = opfPath ? await zip.file(opfPath)?.async('string') : undefined
  if (!opf) throw new Error(`The chapter list inside ${path.basename(filePath)} couldn't be read.`)

  const baseDir = path.posix.dirname(opfPath)
  const manifest = new Map((opf.match(/<item\b[^>]*>/g) ?? []).map((tag) => [attr(tag, 'id'), attr(tag, 'href')]))
  const chapters: string[] = []
  for (const tag of opf.match(/<itemref\b[^>]*>/g) ?? []) {
    const href = manifest.get(attr(tag, 'idref'))
    if (!href) continue
    const html = await zip.file(path.posix.join(baseDir, decodeURIComponent(href)))?.async('string')
    const text = html ? htmlToText(html) : ''
    if (text) chapters.push(text)
  }
  return chapters.join('\n\n')
}

// A part's relationships (from its _rels file): id -> absolute target path inside the ZIP, and relationship type
async function readRels(zip: JSZip, partPath: string): Promise<Map<string, { target: string; type: string }>> {
  const dir = path.posix.dirname(partPath)
  const xml = (await zip.file(`${dir}/_rels/${path.posix.basename(partPath)}.rels`)?.async('string')) ?? ''
  const rels = new Map<string, { target: string; type: string }>()
  for (const tag of xml.match(/<Relationship\b[^>]*>/g) ?? []) {
    // Targets are usually relative to the part's folder, but some files use absolute paths ("/xl/worksheets/…")
    const target = attr(tag, 'Target')
    rels.set(attr(tag, 'Id'), { target: target.startsWith('/') ? target.slice(1) : path.posix.normalize(path.posix.join(dir, target)), type: attr(tag, 'Type') })
  }
  return rels
}

function attr(tag: string, name: string): string {
  return new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1] ?? ''
}

function decodeXml(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, code: string) => {
    const lower = code.toLowerCase()
    if (lower.startsWith('#x')) return String.fromCodePoint(parseInt(lower.slice(2), 16))
    if (lower.startsWith('#')) return String.fromCodePoint(parseInt(lower.slice(1), 10))
    return ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" } as Record<string, string>)[lower] ?? ''
  })
}
