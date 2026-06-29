import { contextBridge, ipcRenderer, webUtils } from 'electron'

contextBridge.exposeInMainWorld('cipher', {
  getFilePath: (file: File) => webUtils.getPathForFile(file),

  extractText: (filePath: string) =>
    ipcRenderer.invoke('extract-text', filePath),

  callGemini: (text: string, outputType: string) =>
    ipcRenderer.invoke('call-gemini', text, outputType),

  saveZip: (jsonData: Record<string, unknown>, sourceText: string, outputType: string, filename: string) =>
    ipcRenderer.invoke('save-zip', jsonData, sourceText, outputType, filename),
})
