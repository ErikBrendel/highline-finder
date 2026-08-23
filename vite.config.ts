import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  root: 'src/web',
  publicDir: 'public',
  base: process.env.VITE_BASE ?? '/highline-finder/',
  build: { outDir: '../../dist', emptyOutDir: true },
})
