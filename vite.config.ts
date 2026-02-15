import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],

  // Prevent vite from obscuring Rust errors
  clearScreen: false,

  // Tauri dev server config
  server: {
    port: 5173,
    strictPort: true,
    watch: {
      // Don't watch src-tauri (Tauri handles Rust rebuilds)
      ignored: ["**/src-tauri/**"],
    },
  },
})
