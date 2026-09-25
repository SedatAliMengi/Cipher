import type { CombinedResult } from '../electron/combine'
import type { ExpandedPaths, ProcessOptions, ProcessResult, Progress, SourceRef } from '../electron/types'

declare global {
  interface Window {
    cipher: {
      getFilePath: (file: File) => string
      pickSources: (kind: 'files' | 'folder') => Promise<ExpandedPaths>
      expandPaths: (paths: string[]) => Promise<ExpandedPaths>
      process: (sources: SourceRef[], outputType: string, options: ProcessOptions) => Promise<ProcessResult>
      stop: () => Promise<void>
      onProgress: (callback: (progress: Progress) => void) => () => void
      pickDatasets: () => Promise<string[]>
      combineDatasets: (filePaths: string[]) => Promise<CombinedResult>
      saveZip: (
        jsonData: Record<string, unknown>,
        sourceText: string,
        outputType: string,
        filename: string
      ) => Promise<{ success: boolean; filePath?: string }>
    }
  }
}
