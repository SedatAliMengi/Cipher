import path from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import electron from 'vite-plugin-electron'
import renderer from 'vite-plugin-electron-renderer'

// Externalize bare imports ('electron', 'pdf-parse', ...) so node_modules are never bundled.
// Relative and absolute paths — including Windows paths like C:\... — are our own files and get bundled.
const external = (id: string) => !id.startsWith('.') && !path.isAbsolute(id)

export default defineConfig({
  plugins: [
    react(),
    electron([
      {
        entry: 'electron/main.ts',
        onstart(options) {
          options.startup()
        },
        vite: {
          build: {
            outDir: 'dist-electron',
            sourcemap: true,
            rollupOptions: {
              external,
            },
          },
        },
      },
      {
        entry: 'electron/preload.ts',
        onstart(options) {
          options.reload()
        },
        vite: {
          build: {
            outDir: 'dist-electron',
            sourcemap: true,
            rollupOptions: {
              external,
            },
          },
        },
      },
    ]),
    renderer(),
  ],
})
