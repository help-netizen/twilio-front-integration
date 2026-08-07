import { defineConfig, type Plugin } from 'vite'
import path from 'path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'

const frontendPort = process.env.FRONTEND_PORT ? Number(process.env.FRONTEND_PORT) : undefined
const backendTarget = process.env.VITE_PROXY_TARGET

// PWA-UPDATE-001 — a per-build stamp the running app compares against /version.json to detect a
// deploy. VITE_BUILD_ID if the pipeline sets one, else the build time (unique per build).
const appVersion = process.env.VITE_BUILD_ID || String(Date.now())

// Emit dist/version.json = { version } so the running app can poll it (no-store) and, when the
// deployed build differs from the one it is running, offer a reload — installed PWAs otherwise keep
// a stale bundle for days after a deploy.
function emitVersionJson(version: string): Plugin {
  return {
    name: 'albusto-emit-version-json',
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'version.json', source: JSON.stringify({ version }) })
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(appVersion),
  },
  plugins: [react(), tailwindcss(), emitVersionJson(appVersion)],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  build: {
    rollupOptions: {
      input: {
        main: path.resolve(__dirname, 'index.html'),
        'card-entry': path.resolve(__dirname, 'card-entry.html'),
      },
    },
  },
  server: {
    ...(frontendPort ? { port: frontendPort } : {}),
    ...(backendTarget ? {
      proxy: {
        '/api': {
          target: backendTarget,
          changeOrigin: true
        },
        '/events': {
          target: backendTarget,
          changeOrigin: true
        }
      }
    } : {})
  }
})
