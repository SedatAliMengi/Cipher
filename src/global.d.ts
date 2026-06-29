export {}

declare global {
  interface Window {
    cipher: {
      getFilePath: (file: File) => string
      extractText: (filePath: string) => Promise<string>
      callGemini: (text: string, outputType: string) => Promise<Record<string, unknown>>
      saveZip: (
        jsonData: Record<string, unknown>,
        sourceText: string,
        outputType: string,
        filename: string
      ) => Promise<{ success: boolean; filePath?: string }>
    }
  }
}
