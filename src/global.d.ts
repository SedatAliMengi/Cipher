import type { AiDataResult } from '../electron/aiData'
import type { CombinedResult } from '../electron/combine'

declare global {
  interface Window {
    cipher: {
      getFilePath: (file: File) => string
      extractText: (filePath: string) => Promise<string>
      callClaude: (text: string, outputType: string) => Promise<Record<string, unknown>>
      generateAiData: (text: string, source: string) => Promise<AiDataResult>
      onAiDataProgress: (callback: (progress: { done: number; total: number }) => void) => () => void
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
