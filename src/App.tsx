import { useState, useCallback } from 'react'

type DroppedFile = { name: string; path: string }

const OUTPUT_TYPES = [
  { id: 'knowledge-base', label: 'Knowledge Base' },
  { id: 'student-summary', label: 'Student Summary' },
  { id: 'academic-research', label: 'Academic Research' },
  { id: 'analytics', label: 'Analytics' },
]

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

export default function App() {
  const [file, setFile] = useState<DroppedFile | null>(null)
  const [isDragOver, setIsDragOver] = useState(false)
  const [outputType, setOutputType] = useState('knowledge-base')
  const [isProcessing, setIsProcessing] = useState(false)
  const [result, setResult] = useState<Record<string, unknown> | null>(null)
  const [extractedText, setExtractedText] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const handleDrop = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    setIsDragOver(false)

    const dropped = e.dataTransfer.files[0]
    if (!dropped) return

    const ext = dropped.name.split('.').pop()?.toLowerCase()
    if (ext !== 'pdf' && ext !== 'docx') {
      setError('Only PDF and DOCX files are supported.')
      return
    }

    const filePath = window.cipher.getFilePath(dropped)
    setFile({ name: dropped.name, path: filePath })
    setResult(null)
    setError(null)
  }, [])

  const handleProcess = async () => {
    if (!file) return
    setIsProcessing(true)
    setError(null)
    setResult(null)
    setExtractedText(null)

    try {
      const text = await window.cipher.extractText(file.path)
      if (!text || text.trim().length === 0) {
        throw new Error('No text could be extracted from the file.')
      }
      setExtractedText(text)
      const json = await window.cipher.callGemini(text, outputType)
      setResult(json)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.')
    } finally {
      setIsProcessing(false)
    }
  }

  const handleDownload = async () => {
    if (!result || !file || !extractedText) return
    const base = file.name.replace(/\.(pdf|docx)$/i, '')
    const filename = `${base}_${outputType}.zip`
    await window.cipher.saveZip(result, extractedText, outputType, filename)
  }

  const canProcess = !!file && !isProcessing

  return (
    <div className="app">
      <header className="header">
        <h1 className="logo">CIPHER</h1>
      </header>

      <main className="main">
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

        {error && <div className="error-box">{error}</div>}

        {result && (
          <div className="result-section">
            <div className="result-header">
              <span className="result-label">Output</span>
              <button className="btn-download" onClick={handleDownload}>
                &#8595; Download ZIP
              </button>
            </div>
            {outputType === 'student-summary' ? (
              <StudentSummaryView data={result as StudentSummary} />
            ) : (
              <pre className="json-viewer">{JSON.stringify(result, null, 2)}</pre>
            )}
          </div>
        )}
      </main>
    </div>
  )
}
