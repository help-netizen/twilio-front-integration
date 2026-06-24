import { defineConfig } from 'vite'
import path from 'path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'

const frontendPort = process.env.FRONTEND_PORT ? Number(process.env.FRONTEND_PORT) : undefined
const backendTarget = process.env.VITE_PROXY_TARGET

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
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
