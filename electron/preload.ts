import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron'
import type { ProcessOptions, Progress, SourceRef } from './types'

contextBridge.exposeInMainWorld('cipher', {
  getFilePath: (file: File) => webUtils.getPathForFile(file),

  pickSources: (kind: 'files' | 'folder') =>
    ipcRenderer.invoke('pick-sources', kind),

  expandPaths: (paths: string[]) =>
    ipcRenderer.invoke('expand-paths', paths),

  process: (sources: SourceRef[], outputType: string, options: ProcessOptions) =>
    ipcRenderer.invoke('process', sources, outputType, options),

  stop: () =>
    ipcRenderer.invoke('stop'),

  onProgress: (callback: (progress: Progress) => void) => {
    const listener = (_event: IpcRendererEvent, progress: Progress) => callback(progress)
    ipcRenderer.on('progress', listener)
    return () => {
      ipcRenderer.removeListener('progress', listener)
    }
  },

  pickDatasets: () =>
    ipcRenderer.invoke('pick-datasets'),

  combineDatasets: (filePaths: string[]) =>
    ipcRenderer.invoke('combine-datasets', filePaths),

  saveZip: (jsonData: Record<string, unknown>, sourceText: string, outputType: string, filename: string) =>
    ipcRenderer.invoke('save-zip', jsonData, sourceText, outputType, filename),
})
