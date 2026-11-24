import { upstream } from '../src/shared/proxied.js'

/**
 * The CORS header two open-data hosts will not send, added on the way through -- and the
 * OpenStreetMap blocks, served out of R2 under /osm/ with the same header.
 *
 * GET and HEAD only, and only the paths src/shared/proxied.ts names. Range requests pass through,
 * because the canopy map is a cloud-optimised GeoTIFF read a few tiles at a time out of 190 MB.
 * Saxony's tiles are fetched whole, so those are cached at the edge as well: a survey epoch does not
 * change for months, and a second planner in the same valley should not cost GeoSN another 30 MB.
 */

/** Just the part of Cloudflare's R2 binding this uses. */
interface Bucket {
  get(key: string): Promise<{ body: ReadableStream; httpEtag: string; writeHttpMetadata(h: Headers): void } | null>
}

interface Env {
  /** The OpenStreetMap blocks, published by `npm run osm:upload`. */
  OSM: Bucket
}

const ALLOWED = /^(https:\/\/erikbrendel\.github\.io|http:\/\/localhost(:\d+)?)$/
const MONTH = 30 * 24 * 3600

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const origin = request.headers.get('Origin') ?? ''
    const cors: Record<string, string> = ALLOWED.test(origin)
      ? {
          'Access-Control-Allow-Origin': origin,
          'Access-Control-Allow-Headers': 'Range',
          'Access-Control-Expose-Headers': 'Content-Range, Content-Length, Accept-Ranges, ETag',
          Vary: 'Origin',
        }
      : {}
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors })
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('method not allowed', { status: 405, headers: cors })
    }
    const path = new URL(request.url).pathname
    if (path.startsWith('/osm/')) {
      const object = await env.OSM.get(path.slice(1))
      if (!object) return new Response('no such block', { status: 404, headers: cors })
      const headers = new Headers(cors)
      object.writeHttpMetadata(headers)
      headers.set('ETag', object.httpEtag)
      return new Response(request.method === 'HEAD' ? null : object.body, { headers })
    }
    const target = upstream(path)
    if (!target) return new Response('not proxied', { status: 404, headers: cors })

    const range = request.headers.get('Range')
    const reply = await fetch(target, {
      method: request.method,
      headers: range ? { Range: range } : {},
      cf: range ? undefined : { cacheEverything: true, cacheTtl: MONTH },
    } as RequestInit)
    const headers = new Headers(cors)
    for (const name of ['Content-Type', 'Content-Length', 'Content-Range', 'Accept-Ranges', 'ETag', 'Last-Modified']) {
      const value = reply.headers.get(name)
      if (value) headers.set(name, value)
    }
    if (reply.ok) headers.set('Cache-Control', `public, max-age=${MONTH}`)
    return new Response(reply.body, { status: reply.status, headers })
  },
}
