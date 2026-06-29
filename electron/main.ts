import { app, BrowserWindow, ipcMain, dialog } from 'electron'
import path from 'path'
import fs from 'fs'
import pdfParse from 'pdf-parse'
import mammoth from 'mammoth'
import { GoogleGenerativeAI } from '@google/generative-ai'
import JSZip from 'jszip'

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

ipcMain.handle('extract-text', async (_event, filePath: string) => {
  const ext = path.extname(filePath).toLowerCase()

  if (ext === '.pdf') {
    const buffer = fs.readFileSync(filePath)
    const data = await pdfParse(buffer)
    return data.text as string
  } else if (ext === '.docx') {
    const result = await mammoth.extractRawText({ path: filePath })
    return result.value as string
  } else {
    throw new Error(`Unsupported file type: ${ext}`)
  }
})

ipcMain.handle(
  'call-gemini',
  async (_event, text: string, outputType: string) => {
    const apiKey = process.env.VITE_GEMINI_API_KEY
    if (!apiKey) throw new Error('Gemini API key not set — add VITE_GEMINI_API_KEY to .env')
    const genAI = new GoogleGenerativeAI(apiKey)
    const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' })

    const prompt = buildPrompt(outputType, text)
    const result = await model.generateContent(prompt)
    const responseText: string = result.response.text()

    const cleaned = responseText
      .replace(/^```json\s*/m, '')
      .replace(/^```\s*/m, '')
      .replace(/\s*```$/m, '')
      .trim()

    return JSON.parse(cleaned) as Record<string, unknown>
  }
)

ipcMain.handle(
  'save-zip',
  async (_event, jsonData: Record<string, unknown>, sourceText: string, outputType: string, filename: string) => {
    const { canceled, filePath } = await dialog.showSaveDialog({
      defaultPath: filename,
      filters: [{ name: 'ZIP Files', extensions: ['zip'] }],
    })

    if (canceled || !filePath) return { success: false }

    const trainingEntry = {
      instruction: trainingInstruction(outputType),
      input: sourceText,
      output: JSON.stringify(jsonData),
    }

    const zip = new JSZip()
    zip.file('output.json', JSON.stringify(jsonData, null, 2))
    zip.file('training.jsonl', JSON.stringify(trainingEntry))
    const buffer = await zip.generateAsync({ type: 'nodebuffer' })
    fs.writeFileSync(filePath, buffer)

    return { success: true, filePath }
  }
)

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
