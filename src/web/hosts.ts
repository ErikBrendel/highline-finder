import type { ProxiedHost } from '../shared/proxied.js'

/**
 * The one survey that will not answer a development machine.
 *
 * Saxony-Anhalt's services echo any `https://` origin and send no CORS header at all to an
 * `http://` one, so every request to them succeeds from the deployed site and is blocked by the
 * browser on `http://localhost` -- as a bare `TypeError: NetworkError`, which says nothing about
 * why. Every other service this app talks to answers a plain localhost origin happily.
 *
 * In development those requests go to the dev server instead, which fetches them from Node where
 * there is no such thing as CORS and hands them back same-origin. See `server.proxy` in
 * vite.config.ts. In a build the URL is untouched, because the deployed origin is https and the
 * service is content with that.
 */

const FUSSY = 'https://geodatenportal.sachsen-anhalt.de'
export const VIA_DEV = '/via/st'

/**
 * Optional, because Node has no `import.meta.env` at all and the tools import this transitively:
 * `npm run slackmap` measures lines through the same source registry the browser uses, and there
 * neither the dev server nor CORS exists, so the untouched URL is the right one.
 */
export const reachable = (url: string): string =>
  import.meta.env?.DEV && url.startsWith(FUSSY) ? VIA_DEV + url.slice(FUSSY.length) : url

/**
 * The hosts that send no CORS header at all, through the Cloudflare worker in proxy/.
 *
 * In development the dev server stands in for it on the same paths (see vite.config.ts), so a
 * change to the routes can be tried before the worker is redeployed.
 */
const PROXY = 'https://highline-finder-proxy.erik-brendel.workers.dev'

/** The OpenStreetMap blocks, which the same worker serves out of R2 -- in development too. */
export const osmUrl = (path: string): string => `${PROXY}/osm/${path}`

export const proxied = (host: ProxiedHost, path: string): string =>
  import.meta.env?.DEV ? `/via/${host}${path}` : `${PROXY}/${host}${path}`
