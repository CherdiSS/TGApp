import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    // Нужно для туннелей cloudflared/ngrok: они приходят с чужим Host.
    allowedHosts: true,
    proxy: {
      '/api': 'http://localhost:8000',
    },
  },
})
