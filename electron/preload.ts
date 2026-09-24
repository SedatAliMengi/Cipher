import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron'

type AiDataProgress = { done: number; total: number }

contextBridge.exposeInMainWorld('cipher', {
  getFilePath: (file: File) => webUtils.getPathForFile(file),

  extractText: (filePath: string) =>
    ipcRenderer.invoke('extract-text', filePath),

  callClaude: (text: string, outputType: string) =>
    ipcRenderer.invoke('call-claude', text, outputType),

  generateAiData: (text: string, source: string) =>
    ipcRenderer.invoke('generate-ai-data', text, source),

  onAiDataProgress: (callback: (progress: AiDataProgress) => void) => {
    const listener = (_event: IpcRendererEvent, progress: AiDataProgress) => callback(progress)
    ipcRenderer.on('ai-data-progress', listener)
    return () => {
      ipcRenderer.removeListener('ai-data-progress', listener)
    }
  },

  pickDatasets: () =>
    ipcRenderer.invoke('pick-datasets'),

  combineDatasets: (filePaths: string[]) =>
    ipcRenderer.invoke('combine-datasets', filePaths),

  saveZip: (jsonData: Record<string, unknown>, sourceText: string, outputType: string, filename: string) =>
    ipcRenderer.invoke('save-zip', jsonData, sourceText, outputType, filename),
})
