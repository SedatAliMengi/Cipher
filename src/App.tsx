import { useState, useCallback } from 'react'
import type { AiDataResult } from '../electron/aiData'
import type { CombinedResult } from '../electron/combine'

type DroppedFile = { name: string; path: string }
type Result = { type: string; data: Record<string, unknown>; filename: string; sourceText: string }
type Progress = { done: number; total: number }
type View = 'documents' | 'combine'

const OUTPUT_TYPES = [
  { id: 'knowledge-base', label: 'Knowledge Base' },
  { id: 'student-summary', label: 'Student Summary' },
  { id: 'academic-research', label: 'Academic Research' },
  { id: 'analytics', label: 'Analytics' },
  { id: 'ai-data', label: 'Convert to AI Data' },
]

const PREVIEW_PAIRS = 50

type StudentSummary = {
  title?: string
  difficulty_level?: string
  one_liner?: string
  summary?: string
  key_points?: string[]
  definitions?: { term: string; definition: string }[]
}

function StudentSummaryView({ data }: { data: StudentSummary }) {
  return (
    <div className="summary-doc">
      <div className="summary-top">
        <h2 className="summary-title">{data.title}</h2>
        {data.difficulty_level && (
          <span className={`difficulty difficulty-${data.difficulty_level.toLowerCase()}`}>
            {data.difficulty_level}
          </span>
        )}
      </div>

      {data.one_liner && <p className="summary-oneliner">{data.one_liner}</p>}

      {data.summary && (
        <section className="summary-section">
          <h3 className="section-heading">Summary</h3>
          {data.summary.split('\n\n').map((para, i) => (
            <p key={i} className="summary-para">{para}</p>
          ))}
        </section>
      )}

      {data.key_points && data.key_points.length > 0 && (
        <section className="summary-section">
          <h3 className="section-heading">Key Points</h3>
          <ul className="summary-list">
            {data.key_points.map((pt, i) => <li key={i}>{pt}</li>)}
          </ul>
        </section>
      )}

      {data.definitions && data.definitions.length > 0 && (
        <section className="summary-section">
          <h3 className="section-heading">Definitions</h3>
          <dl className="definition-list">
            {data.definitions.map((d, i) => (
              <div key={i} className="definition-item">
                <dt>{d.term}</dt>
                <dd>{d.definition}</dd>
              </div>
            ))}
          </dl>
        </section>
      )}
    </div>
  )
}

function StatCards({ stats }: { stats: { label: string; value: number }[] }) {
  return (
    <div className="aidata-stats">
      {stats.map((s) => (
        <div key={s.label} className="aidata-stat">
          <span className="aidata-stat-value">{s.value.toLocaleString()}</span>
          <span className="aidata-stat-label">{s.label}</span>
        </div>
      ))}
    </div>
  )
}

function AiDataView({ data }: { data: AiDataResult }) {
  const preview = data.pairs.slice(0, PREVIEW_PAIRS)

  return (
    <div className="summary-doc">
      <StatCards
        stats={[
          { label: 'Chunks', value: data.stats.chunks },
          { label: 'Training pairs', value: data.stats.pairs },
          { label: 'Tokens (approx.)', value: data.stats.approx_dataset_tokens },
        ]}
      />

      {data.warning && <div className="warning-box">{data.warning}</div>}

      <p className="aidata-note">
        The ZIP contains alpaca.jsonl and chat.jsonl (the same pairs in two training formats),
        chunks.jsonl (the raw text chunks) and stats.json.
      </p>

      <section className="summary-section">
        <h3 className="section-heading">Preview</h3>
        <div className="pair-list">
          {preview.map((p, i) => (
            <div key={i} className="pair-item">
              <p className="pair-instruction">{p.instruction}</p>
              <p className="pair-output">{p.output}</p>
            </div>
          ))}
        </div>
        {data.pairs.length > preview.length && (
          <p className="pair-more">+ {data.pairs.length - preview.length} more in the download</p>
        )}
      </section>
    </div>
  )
}

function CombinedView({ data }: { data: CombinedResult }) {
  const { stats } = data

  return (
    <div className="summary-doc">
      <StatCards
        stats={[
          { label: 'Training pairs', value: stats.pairs },
          { label: 'Duplicates removed', value: stats.duplicates_removed },
          { label: 'Tokens (approx.)', value: stats.approx_tokens },
        ]}
      />

      {stats.skipped_files.length > 0 && (
        <div className="warning-box">
          Skipped {stats.skipped_files.length === 1 ? '1 file' : `${stats.skipped_files.length} files`}:{' '}
          {stats.skipped_files.map((f) => `${f.file} (${f.reason})`).join('; ')}
        </div>
      )}

      <p className="aidata-note">
        {stats.train.toLocaleString()} pairs for training and {stats.validation.toLocaleString()} set aside for
        validation. The ZIP has alpaca/ and chat/ folders, each with train.jsonl and validation.jsonl, plus
        chunks.jsonl and stats.json.
      </p>

      <section className="summary-section">
        <h3 className="section-heading">Sources</h3>
        <ul className="source-list">
          {stats.sources.map((s) => (
            <li key={s.source} className="source-item">
              <span>{s.source}</span>
              <span className="source-count">{s.pairs.toLocaleString()} pairs</span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  )
}

function ResultSection({ result }: { result: Result }) {
  const handleDownload = () => window.cipher.saveZip(result.data, result.sourceText, result.type, result.filename)

  return (
    <div className="result-section">
      <div className="result-header">
        <span className="result-label">Output</span>
        <button className="btn-download" onClick={handleDownload}>
          &#8595; Download ZIP
        </button>
      </div>
      {result.type === 'student-summary' ? (
        <StudentSummaryView data={result.data as StudentSummary} />
      ) : result.type === 'ai-data' ? (
        <AiDataView data={result.data as AiDataResult} />
      ) : result.type === 'combined' ? (
        <CombinedView data={result.data as CombinedResult} />
      ) : (
        <pre className="json-viewer">{JSON.stringify(result.data, null, 2)}</pre>
      )}
    </div>
  )
}

// Errors from the main process arrive as "Error invoking remote method '…': Error: <message>"
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : 'Something went wrong.'
}

function DocumentsPanel() {
  const [file, setFile] = useState<DroppedFile | null>(null)
  const [isDragOver, setIsDragOver] = useState(false)
  const [outputType, setOutputType] = useState('knowledge-base')
  const [isProcessing, setIsProcessing] = useState(false)
  const [result, setResult] = useState<Result | null>(null)
  const [progress, setProgress] = useState<Progress | null>(null)
  const [error, setError] = useState<string | null>(null)

  const handleDrop = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    setIsDragOver(false)

    const dropped = e.dataTransfer.files[0]
    if (!dropped) return

    const ext = dropped.name.split('.').pop()?.toLowerCase()
    if (ext === 'zip') {
      setError('ZIP datasets go in the Combine datasets tab.')
      return
    }
    if (ext !== 'pdf' && ext !== 'docx') {
      setError('Only PDF and DOCX files are supported.')
      return
    }

    const filePath = window.cipher.getFilePath(dropped)
    setFile({ name: dropped.name, path: filePath })
    setResult(null)
    setError(null)
  }, [])

  const generateAiData = async (text: string, source: string) => {
    const unsubscribe = window.cipher.onAiDataProgress(setProgress)
    try {
      return await window.cipher.generateAiData(text, source)
    } finally {
      unsubscribe()
      setProgress(null)
    }
  }

  const handleProcess = async () => {
    if (!file) return
    setIsProcessing(true)
    setError(null)
    setResult(null)

    try {
      const text = await window.cipher.extractText(file.path)
      if (!text || text.trim().length === 0) {
        throw new Error('No text could be extracted from the file.')
      }
      const data = outputType === 'ai-data'
        ? await generateAiData(text, file.name)
        : await window.cipher.callClaude(text, outputType)
      const base = file.name.replace(/\.(pdf|docx)$/i, '')
      setResult({ type: outputType, data, filename: `${base}_${outputType}.zip`, sourceText: text })
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setIsProcessing(false)
    }
  }

  const canProcess = !!file && !isProcessing

  return (
    <>
      <div
        className={`drop-zone${isDragOver ? ' drag-over' : ''}${file ? ' has-file' : ''}`}
        onDrop={handleDrop}
        onDragOver={(e) => { e.preventDefault(); setIsDragOver(true) }}
        onDragLeave={() => setIsDragOver(false)}
      >
        {file ? (
          <div className="file-info">
            <span className="file-icon">&#128196;</span>
            <span className="file-name">{file.name}</span>
            <button
              className="btn-clear"
              onClick={() => { setFile(null); setResult(null); setError(null) }}
            >
              &#x2715;
            </button>
          </div>
        ) : (
          <p className="drop-hint">Drop a PDF or DOCX file here</p>
        )}
      </div>

      <div className="controls">
        <div className="output-type-row">
          {OUTPUT_TYPES.map((ot) => (
            <span
              key={ot.id}
              className={`output-badge${outputType === ot.id ? ' active' : ''}`}
              onClick={() => setOutputType(ot.id)}
            >
              {ot.label}
            </span>
          ))}
        </div>
        <button className="btn-process" onClick={handleProcess} disabled={!canProcess}>
          {isProcessing ? 'Processing…' : 'Process'}
        </button>
      </div>

      {progress && (
        <div className="progress">
          <div className="progress-bar">
            <div className="progress-fill" style={{ width: `${(progress.done / progress.total) * 100}%` }} />
          </div>
          <span className="progress-label">
            Generating training data… {progress.done} of {progress.total} chunks done
          </span>
        </div>
      )}

      {error && <div className="error-box">{error}</div>}

      {result && <ResultSection result={result} />}
    </>
  )
}

function CombinePanel() {
  const [datasets, setDatasets] = useState<DroppedFile[]>([])
  const [isDragOver, setIsDragOver] = useState(false)
  const [isCombining, setIsCombining] = useState(false)
  const [result, setResult] = useState<Result | null>(null)
  const [error, setError] = useState<string | null>(null)

  const addDatasets = (files: DroppedFile[]) => {
    setDatasets((current) => [...current, ...files.filter((f) => !current.some((c) => c.path === f.path))])
    setResult(null)
    setError(null)
  }

  const removeDataset = (path: string) => {
    setDatasets((current) => current.filter((d) => d.path !== path))
    setResult(null)
  }

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    setIsDragOver(false)

    const dropped = [...e.dataTransfer.files]
    const zips = dropped.filter((f) => f.name.toLowerCase().endsWith('.zip'))
    addDatasets(zips.map((f) => ({ name: f.name, path: window.cipher.getFilePath(f) })))
    if (zips.length < dropped.length) setError('Only ZIP files saved from "Convert to AI Data" can be combined.')
  }

  const handleChoose = async () => {
    const paths = await window.cipher.pickDatasets()
    addDatasets(paths.map((p) => ({ name: p.split(/[\\/]/).pop() ?? p, path: p })))
  }

  const handleCombine = async () => {
    setIsCombining(true)
    setError(null)
    setResult(null)

    try {
      const data = await window.cipher.combineDatasets(datasets.map((d) => d.path))
      setResult({ type: 'combined', data, filename: 'combined_dataset.zip', sourceText: '' })
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setIsCombining(false)
    }
  }

  return (
    <>
      <div
        className={`drop-zone${isDragOver ? ' drag-over' : ''}`}
        onDrop={handleDrop}
        onDragOver={(e) => { e.preventDefault(); setIsDragOver(true) }}
        onDragLeave={() => setIsDragOver(false)}
      >
        <div className="combine-hint">
          <p className="drop-hint">Drop ZIPs saved from "Convert to AI Data" here</p>
          <button className="btn-ghost" onClick={handleChoose}>or choose files</button>
        </div>
      </div>

      {datasets.length > 0 && (
        <ul className="dataset-list">
          {datasets.map((d) => (
            <li key={d.path} className="dataset-item">
              <span className="file-name">{d.name}</span>
              <button className="btn-clear" onClick={() => removeDataset(d.path)}>
                &#x2715;
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="controls">
        <span className="combine-count">
          {datasets.length === 1 ? '1 dataset' : `${datasets.length} datasets`} selected
        </span>
        <button className="btn-process" onClick={handleCombine} disabled={datasets.length === 0 || isCombining}>
          {isCombining ? 'Combining…' : 'Combine'}
        </button>
      </div>

      {error && <div className="error-box">{error}</div>}

      {result && <ResultSection result={result} />}
    </>
  )
}

export default function App() {
  const [view, setView] = useState<View>('documents')

  return (
    <div className="app">
      <header className="header">
        <h1 className="logo">CIPHER</h1>
        <nav className="tabs">
          <button className={`tab${view === 'documents' ? ' active' : ''}`} onClick={() => setView('documents')}>
            Documents
          </button>
          <button className={`tab${view === 'combine' ? ' active' : ''}`} onClick={() => setView('combine')}>
            Combine datasets
          </button>
        </nav>
      </header>

      {/* Both panels stay mounted so switching tabs keeps their files and results */}
      <main className="main" hidden={view !== 'documents'}>
        <DocumentsPanel />
      </main>
      <main className="main" hidden={view !== 'combine'}>
        <CombinePanel />
      </main>
    </div>
  )
}
