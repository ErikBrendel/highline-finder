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

export const reachable = (url: string): string =>
  import.meta.env.DEV && url.startsWith(FUSSY) ? VIA_DEV + url.slice(FUSSY.length) : url
