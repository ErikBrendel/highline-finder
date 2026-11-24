import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { PROXIED } from './src/shared/proxied.js'
import { HTTPS_ONLY } from './src/web/hosts.js'

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
   * The surveys that answer a cross-origin request only for an `https://` origin, fetched by the dev
   * server on the browser's behalf. Rather than put the whole dev server behind a self-signed
   * certificate, those hosts are proxied: Node has no CORS, and what reaches the browser is
   * same-origin. See web/hosts.ts.
   */
  server: {
    proxy: {
      ...Object.fromEntries(
        Object.entries(HTTPS_ONLY).map(([host, origin]) => [
          `/via/${host}/`,
          { target: origin, changeOrigin: true, rewrite: (path: string) => path.slice(`/via/${host}`.length) },
        ]),
      ),
      // The hosts with no CORS header for anyone, which the deployed site reads through its proxy.
      ...Object.fromEntries(
        Object.entries(PROXIED).map(([host, { origin }]) => [
          `/via/${host}/`,
          { target: origin, changeOrigin: true, rewrite: (path: string) => path.slice(`/via/${host}`.length) },
        ]),
      ),
    },
  },
  root: 'src/web',
  publicDir: 'public',
  base: process.env.VITE_BASE ?? '/highline-finder/',
  build: { outDir: '../../dist', emptyOutDir: true },
})
