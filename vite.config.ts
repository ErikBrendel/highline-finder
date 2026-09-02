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
  /**
   * One survey, fetched by the dev server on the browser's behalf.
   *
   * Saxony-Anhalt answers a cross-origin request only for an `https://` origin, so on plain
   * localhost the browser blocks every elevation window and every orthophoto tile in that state --
   * while curl and the deployed site get them fine. Nothing else this app talks to cares. Rather
   * than put the whole dev server behind a self-signed certificate for one host, that host is
   * proxied: Node has no CORS, and what reaches the browser is same-origin. See web/hosts.ts.
   */
  server: {
    proxy: {
      '/via/st': {
        target: 'https://geodatenportal.sachsen-anhalt.de',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/via\/st/, ''),
      },
    },
  },
  root: 'src/web',
  publicDir: 'public',
  base: process.env.VITE_BASE ?? '/highline-finder/',
  build: { outDir: '../../dist', emptyOutDir: true },
})
