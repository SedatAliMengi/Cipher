import { useState } from 'react'
import type { AiDataResult } from '../electron/aiData'
import type { CombinedResult } from '../electron/combine'
import { MAX_FOLDER_FILES } from '../electron/fileTypes'
import type { BatchResult, ExpandedPaths, ProcessOptions, ProcessResult, Progress, SourceRef } from '../electron/types'

type DroppedFile = { name: string; path: string }
type Result = ProcessResult
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

// "3 x, 1 y and 2 z" from the non-zero counts
function countList(parts: [number, string][]): string {
  const items = parts.filter(([n]) => n > 0).map(([n, text]) => `${n.toLocaleString()} ${text}`)
  return items.length > 1 ? `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}` : items.join('')
}

function AiDataView({ data }: { data: AiDataResult }) {
  const { stats } = data
  const preview = data.pairs.slice(0, PREVIEW_PAIRS)
  const removed = countList([
    [stats.dropped.unverified, `pair${stats.dropped.unverified === 1 ? '' : 's'} whose quote wasn't in the document`],
    [stats.dropped.review, `pair${stats.dropped.review === 1 ? '' : 's'} that failed the double-check`],
    [stats.dropped.duplicates, `duplicate${stats.dropped.duplicates === 1 ? '' : 's'}`],
  ])

  return (
    <div className="summary-doc">
      <StatCards
        stats={[
          { label: 'Training pairs', value: stats.pairs },
          { label: 'Training rows', value: stats.rows.training },
          { label: 'Chunks', value: stats.chunks },
          { label: 'Tokens (approx.)', value: stats.approx_dataset_tokens },
        ]}
      />

      {data.warning && <div className="warning-box">{data.warning}</div>}

      <p className="aidata-note">
        Every pair's quote was found word for word in the document{stats.options.review ? ' and the pair passed a second check' : ''}.
        {removed && ` Removed: ${removed}.`}
      </p>
      <p className="aidata-note">
        The ZIP has pairs.jsonl (everything), alpaca.jsonl and chat.jsonl (one row per phrasing)
        {stats.options.extras ? ', preferences.jsonl and conversations.jsonl' : ''}, chunks.jsonl (search-ready text),
        stats.json and a README.md dataset card for Hugging Face.
      </p>

      <section className="summary-section">
        <h3 className="section-heading">Preview</h3>
        <div className="pair-list">
          {preview.map((p) => (
            <div key={p.id} className="pair-item">
              <p className="pair-instruction">{p.instruction}</p>
              <p className="pair-output">{p.output}</p>
              {p.quote && <p className="pair-quote">“{p.quote}”</p>}
              {p.variants.length > 0 && <p className="pair-variants">Also asked as: {p.variants.join(' · ')}</p>}
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
  const notes = [...stats.skipped_files.map((f) => `Skipped ${f.file}: ${f.reason}`), ...stats.partial_files.map((f) => `${f.file}: ${f.reason}`)]
  const extraFolders = [stats.rows.preferences > 0 && 'preferences/', stats.rows.conversations > 0 && 'conversations/'].filter(Boolean)

  return (
    <div className="summary-doc">
      <StatCards
        stats={[
          { label: 'Training pairs', value: stats.pairs },
          { label: 'Training rows', value: stats.rows.training },
          { label: 'Duplicates removed', value: stats.duplicates_removed },
          { label: 'Tokens (approx.)', value: stats.approx_tokens },
        ]}
      />

      {notes.length > 0 && (
        <div className="warning-box">
          {notes.map((note, i) => <p key={i}>{note}</p>)}
        </div>
      )}

      <p className="aidata-note">
        {stats.train.toLocaleString()} pairs for training and {stats.validation.toLocaleString()} set aside for
        validation. The ZIP has alpaca/, chat/{extraFolders.map((f) => `, ${f}`).join('')} folders with train.jsonl and
        validation.jsonl, plus pairs.jsonl, chunks.jsonl, stats.json and a README.md dataset card.
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

function BatchView({ data }: { data: BatchResult }) {
  return (
    <div className="summary-doc">
      <StatCards
        stats={[
          { label: 'Files processed', value: data.items.length },
          { label: 'Files not processed', value: data.failures.length },
        ]}
      />

      {data.failures.length > 0 && (
        <div className="warning-box">
          {data.failures.map((f, i) => <p key={i}>{f.file}: {f.reason}</p>)}
        </div>
      )}

      <p className="aidata-note">
        The ZIP has a folder for each file with its output.json and training.jsonl, plus batch_summary.json.
      </p>

      <section className="summary-section">
        <h3 className="section-heading">Files</h3>
        <ul className="source-list">
          {data.items.map((item, i) => (
            <li key={i} className="source-item">
              <span>{item.name}</span>
              <span className="source-count">{item.method}</span>
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
      {result.note && <p className="result-note">{result.note}</p>}
      {result.type === 'student-summary' ? (
        <StudentSummaryView data={result.data as StudentSummary} />
      ) : result.type === 'ai-data' ? (
        <AiDataView data={result.data as AiDataResult} />
      ) : result.type === 'combined' ? (
        <CombinedView data={result.data as CombinedResult} />
      ) : result.type === 'batch' ? (
        <BatchView data={result.data as BatchResult} />
      ) : (
        <pre className="json-viewer">{JSON.stringify(result.data, null, 2)}</pre>
      )}
    </div>
  )
}

function ProgressBar({ progress }: { progress: Progress }) {
  const percent = progress.total ? (progress.done / progress.total) * 100 : 0
  return (
    <div className="progress">
      <div className="progress-bar">
        <div className="progress-fill" style={{ width: `${percent}%` }} />
      </div>
      <span className="progress-label">{progress.label}</span>
    </div>
  )
}

// Errors from the main process arrive as "Error invoking remote method '…': Error: <message>"
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : 'Something went wrong.'
}

const fileName = (filePath: string) => filePath.split(/[\\/]/).pop() ?? filePath

function DocumentsPanel() {
  const [sources, setSources] = useState<SourceRef[]>([])
  const [link, setLink] = useState('')
  const [isDragOver, setIsDragOver] = useState(false)
  const [outputType, setOutputType] = useState('knowledge-base')
  const [options, setOptions] = useState<ProcessOptions>({ review: true, extras: true, readVisuals: false })
  const [isProcessing, setIsProcessing] = useState(false)
  const [progress, setProgress] = useState<Progress | null>(null)
  const [result, setResult] = useState<Result | null>(null)
  const [error, setError] = useState<string | null>(null)

  const addSources = (fresh: SourceRef[]) => {
    const key = (s: SourceRef) => (s.kind === 'file' ? s.path : s.url)
    setSources((current) => [...current, ...fresh.filter((f) => !current.some((c) => key(c) === key(f)))])
    setResult(null)
    setError(null)
  }

  // Folders are searched for readable files; anything unreadable is named in an error
  const addPaths = ({ files, unsupported, truncated }: ExpandedPaths) => {
    addSources(files.map((p) => ({ kind: 'file', path: p, name: fileName(p) })))
    const problems: string[] = []
    if (truncated.length) {
      problems.push(`Only ${MAX_FOLDER_FILES} files were added from ${truncated.join(', ')}, the most Cipher takes from one folder.`)
    }
    if (unsupported.length && unsupported.every((name) => name.toLowerCase().endsWith('.zip'))) {
      problems.push('ZIP datasets go in the Combine datasets tab.')
    } else if (unsupported.length) {
      problems.push(`Can't read ${unsupported.join(', ')}. Cipher reads PDF, Word, PowerPoint, Excel, EPUB, text, Markdown, CSV, HTML and images.`)
    }
    if (problems.length) setError(problems.join(' '))
  }

  const handleDrop = async (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    setIsDragOver(false)
    const paths = [...e.dataTransfer.files].map((f) => window.cipher.getFilePath(f))
    if (paths.length) addPaths(await window.cipher.expandPaths(paths))
  }

  const handleChoose = async (kind: 'files' | 'folder') => addPaths(await window.cipher.pickSources(kind))

  const addLink = () => {
    const url = link.trim()
    if (!url) return
    if (!/^https?:\/\/\S+$/i.test(url)) {
      setError('Links need to start with http:// or https://')
      return
    }
    addSources([{ kind: 'url', url, name: url }])
    setLink('')
  }

  const removeSource = (source: SourceRef) => {
    setSources((current) => current.filter((s) => s !== source))
    setResult(null)
  }

  const removeAll = () => {
    setSources([])
    setResult(null)
    setError(null)
  }

  const handleProcess = async () => {
    if (!sources.length) return
    setIsProcessing(true)
    setError(null)
    setResult(null)
    const unsubscribe = window.cipher.onProgress(setProgress)
    try {
      setResult(await window.cipher.process(sources, outputType, options))
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      unsubscribe()
      setProgress(null)
      setIsProcessing(false)
    }
  }

  const setOption = (name: keyof ProcessOptions) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setOptions((current) => ({ ...current, [name]: e.target.checked }))

  return (
    <>
      <div
        className={`drop-zone${isDragOver ? ' drag-over' : ''}${sources.length ? ' has-file' : ''}`}
        onDrop={handleDrop}
        onDragOver={(e) => { e.preventDefault(); setIsDragOver(true) }}
        onDragLeave={() => setIsDragOver(false)}
      >
        <div className="combine-hint">
          <p className="drop-hint">Drop files or a folder here</p>
          <p className="drop-types">PDF · Word · PowerPoint · Excel · EPUB · text · HTML · images</p>
          <div className="button-row">
            <button className="btn-ghost" onClick={() => handleChoose('files')}>Choose files</button>
            <button className="btn-ghost" onClick={() => handleChoose('folder')}>Choose folder</button>
          </div>
        </div>
      </div>

      <div className="link-row">
        <input
          className="api-input link-input"
          placeholder="…or paste a web page link"
          value={link}
          onChange={(e) => setLink(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') addLink() }}
        />
        <button className="btn-ghost" onClick={addLink} disabled={!link.trim()}>Add link</button>
      </div>

      {sources.length > 1 && (
        <div className="list-header">
          <span className="combine-count">{sources.length} files</span>
          <button className="btn-ghost" onClick={removeAll} disabled={isProcessing}>Remove all</button>
        </div>
      )}
      {sources.length > 0 && (
        <ul className="dataset-list">
          {sources.map((s) => (
            <li key={s.kind === 'file' ? s.path : s.url} className="dataset-item">
              <span className="file-name">{s.name}</span>
              <button className="btn-clear" onClick={() => removeSource(s)} disabled={isProcessing}>
                &#x2715;
              </button>
            </li>
          ))}
        </ul>
      )}

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
        <div className="process-buttons">
          {isProcessing && (
            <button className="btn-ghost" onClick={() => window.cipher.stop()}>Stop</button>
          )}
          <button className="btn-process" onClick={handleProcess} disabled={!sources.length || isProcessing}>
            {isProcessing ? 'Processing…' : sources.length > 1 ? `Process ${sources.length} files` : 'Process'}
          </button>
        </div>
      </div>

      <div className="options-row">
        {outputType === 'ai-data' && (
          <>
            <label className="option">
              <input type="checkbox" checked={options.review} onChange={setOption('review')} />
              Double-check every pair <span className="option-hint">(≈ +40% cost)</span>
            </label>
            <label className="option">
              <input type="checkbox" checked={options.extras} onChange={setOption('extras')} />
              Extra formats: reworded questions, wrong-answer pairs, conversations <span className="option-hint">(≈ +70% cost)</span>
            </label>
          </>
        )}
        <label className="option">
          <input type="checkbox" checked={options.readVisuals} onChange={setOption('readVisuals')} />
          Read images, charts and tables inside PDFs <span className="option-hint">(≈ $0.005 per page; scanned PDFs are always read this way)</span>
        </label>
      </div>

      {progress && <ProgressBar progress={progress} />}

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
    addDatasets(paths.map((p) => ({ name: fileName(p), path: p })))
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
