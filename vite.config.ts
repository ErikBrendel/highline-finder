import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

/**
 * Marks the dev server's tab with a "D", so a localhost tab is never mistaken for the deployed one.
 */
const devFavicon: Plugin = {
  name: 'dev-favicon',
  apply: 'serve',
  transformIndexHtml: (html) => html.replace('favicon.svg', 'favicon-dev.svg'),
}

export default defineConfig({
  plugins: [devFavicon],
  root: 'src/web',
  publicDir: 'public',
  base: process.env.VITE_BASE ?? '/highline-finder/',
  build: { outDir: '../../dist', emptyOutDir: true },
})
