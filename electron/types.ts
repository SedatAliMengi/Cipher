// Data passed between the window and the main process. Types only, so the interface can import it too.

export type SourceRef = { kind: 'file'; path: string; name: string } | { kind: 'url'; url: string; name: string }

export type ProcessOptions = {
  // Convert to AI Data: a second Claude pass checks every pair
  review: boolean
  // Convert to AI Data: reworded questions, wrong-answer (preference) pairs and conversations
  extras: boolean
  // Read PDFs with Claude so images, charts and tables are included (scanned PDFs always are)
  readVisuals: boolean
}

// Dropped or chosen paths, sorted out: readable files, names Cipher can't read, and folders with too many files to take them all
export type ExpandedPaths = { files: string[]; unsupported: string[]; truncated: string[] }

export type Progress = { label: string; done: number; total: number }

export type ProcessResult = {
  type: string
  data: Record<string, unknown>
  filename: string
  sourceText: string
  note?: string
}

export type BatchItem = { name: string; method: string; text: string; data: Record<string, unknown> }
export type BatchResult = { mode: string; items: BatchItem[]; failures: { file: string; reason: string }[] }
