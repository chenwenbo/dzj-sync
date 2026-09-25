import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { crx } from '@crxjs/vite-plugin'
import { resolve } from 'path'
import manifest from './manifest.json'

export default defineConfig(({ mode }) => {
  const isDev = mode === 'development'
  return {
    plugins: [react(), crx({ manifest })],
    define: {
      // 开发模式下让 logger 输出 debug 日志
      'import.meta.env.PROD': JSON.stringify(!isDev),
      'import.meta.env.DEV': JSON.stringify(isDev),
    },
    resolve: {
      alias: {
        '@': resolve(__dirname, 'src'),
        '@wechatsync/core': resolve(__dirname, '../core/src'),
      },
    },
    build: {
      minify: isDev ? false : 'esbuild',
      sourcemap: isDev ? 'inline' : false,
      rollupOptions: {
        input: {
          app: resolve(__dirname, 'src/app/index.html'),
          offscreen: resolve(__dirname, 'src/offscreen/index.html'),
        },
      },
    },
  }
})
