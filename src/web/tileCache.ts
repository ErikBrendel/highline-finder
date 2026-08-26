import maplibregl from 'maplibre-gl'
import { report } from './report.js'

/**
 * Persistent basemap tile cache.
 *
 * All three basemap servers answer with `Cache-Control: no-cache` and neither an ETag nor a
 * Last-Modified header, so the browser has nothing to revalidate against and refetches every tile
 * on every basemap switch. Orthophoto tiles are ~130 KB each, which is what makes switching feel
 * slow. Nothing can be fixed with request headers from this side; the cache has to be ours.
 *
 * IndexedDB rather than localStorage: localStorage is a 5-10 MB string-only quota, and base64 adds
 * a third again on top of tiles that are already 130 KB, so a single screenful would overflow it.
 * IndexedDB stores ArrayBuffers natively with a quota in the hundreds of megabytes.
 *
 * There is no invalidation beyond the size cap. An aerial survey does not change between page
 * loads, and the data is versioned by survey epoch rather than continuously updated. OSM's tile
 * usage policy actively requires caching, so this is also the better-behaved way to use it.
 *
 * Every operation degrades to a plain fetch on failure -- private browsing, a denied quota or a
 * blocked database must slow the map down, never break it.
 */

const DB_NAME = 'highline-tiles'
const TILES = 'tiles'
const INDEX = 'index'
const SCHEME = 'hlcache'
const MAX_BYTES = 200 * 1024 * 1024
/** Evict down to this fraction of the cap, so eviction is occasional rather than per-tile. */
const EVICT_TO = 0.8
/** Only rewrite a tile's last-used stamp if it is this stale, to avoid a write per cache hit. */
const TOUCH_AFTER_MS = 60 * 60 * 1000

interface Entry {
  size: number
  at: number
}

/**
 * The index is mirrored in memory so size accounting and eviction never have to read tile bytes,
 * and so the badge in the UI can report cache size synchronously.
 */
const memIndex = new Map<string, Entry>()
let memBytes = 0
let dbPromise: Promise<IDBDatabase | null> | null = null

/** A cache read that failed is a cache miss, and the fetch behind it still has to happen. */
function cacheMiss(e: unknown): null {
  report('reading a tile from the cache', e)
  return null
}

function request<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result)
    r.onerror = () => reject(r.error)
  })
}

async function openDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return null
  const open = indexedDB.open(DB_NAME, 1)
  open.onupgradeneeded = () => {
    const db = open.result
    if (!db.objectStoreNames.contains(TILES)) db.createObjectStore(TILES)
    if (!db.objectStoreNames.contains(INDEX)) db.createObjectStore(INDEX)
  }
  const db = await request(open)

  const store = db.transaction(INDEX, 'readonly').objectStore(INDEX)
  const [keys, values] = await Promise.all([
    request(store.getAllKeys()),
    request(store.getAll()),
  ])
  keys.forEach((key, i) => {
    const entry = values[i] as Entry
    memIndex.set(String(key), entry)
    memBytes += entry.size
  })
  return db
}

function db(): Promise<IDBDatabase | null> {
  dbPromise ??= openDb().catch((e: unknown) => {
    // Private browsing, a denied quota, a blocked database: the map still works, it just refetches
    // everything. Worth one line in the console, since it is also why the map feels slow.
    report('opening the tile cache (IndexedDB) -- tiles will not be cached this session', e)
    return null
  })
  return dbPromise
}

async function read(url: string): Promise<ArrayBuffer | null> {
  const d = await db()
  // Awaiting the open before consulting memIndex matters: on a cold start the index is empty until
  // the database has been read, so checking first would report a miss for every cached tile.
  if (!d || !memIndex.has(url)) return null
  const bytes = await request(d.transaction(TILES, 'readonly').objectStore(TILES).get(url))
  if (!bytes) return null

  const entry = memIndex.get(url)!
  if (Date.now() - entry.at > TOUCH_AFTER_MS) {
    entry.at = Date.now()
    d.transaction(INDEX, 'readwrite').objectStore(INDEX).put(entry, url)
  }
  return bytes as ArrayBuffer
}

async function evict(d: IDBDatabase): Promise<void> {
  const byAge = [...memIndex.entries()].sort((a, b) => a[1].at - b[1].at)
  const tx = d.transaction([TILES, INDEX], 'readwrite')
  for (const [url, entry] of byAge) {
    if (memBytes <= MAX_BYTES * EVICT_TO) break
    tx.objectStore(TILES).delete(url)
    tx.objectStore(INDEX).delete(url)
    memIndex.delete(url)
    memBytes -= entry.size
  }
}

async function write(url: string, bytes: ArrayBuffer): Promise<void> {
  const d = await db()
  if (!d) return
  const entry: Entry = { size: bytes.byteLength, at: Date.now() }
  const tx = d.transaction([TILES, INDEX], 'readwrite')
  tx.objectStore(TILES).put(bytes, url)
  tx.objectStore(INDEX).put(entry, url)

  memBytes += entry.size - (memIndex.get(url)?.size ?? 0)
  memIndex.set(url, entry)
  if (memBytes > MAX_BYTES) await evict(d)
}

/** Rewrites an https tile template so MapLibre routes it through the cache. */
export function cachedUrl(url: string): string {
  return url.replace(/^https:\/\//, `${SCHEME}://`)
}

export function installTileCache(): void {
  void db()
  maplibregl.addProtocol(SCHEME, async (params, abortController) => {
    const url = `https://${params.url.slice(SCHEME.length + 3)}`

    const hit = await read(url).catch(cacheMiss)
    if (hit) return { data: hit }

    const res = await fetch(url, { signal: abortController.signal })
    if (!res.ok) throw new Error(`tile ${res.status} for ${url}`)
    const bytes = await res.arrayBuffer()
    void write(url, bytes).catch((e: unknown) => report('writing a tile to the cache', e))
    return { data: bytes }
  })
}

/**
 * Fetches a URL through the same persistent store the basemap tiles use.
 *
 * Exposed because the elevation windows the line planner needs are the same kind of thing: large,
 * immutable, and expensive to re-request while dragging an anchor around.
 */
export async function fetchCached(url: string, signal?: AbortSignal): Promise<ArrayBuffer> {
  const hit = await read(url).catch(cacheMiss)
  if (hit) return hit
  const res = await fetch(url, { signal })
  if (!res.ok) throw new Error(`${res.status} for ${url}`)
  const bytes = await res.arrayBuffer()
  void write(url, bytes).catch((e: unknown) => report('writing a tile to the cache', e))
  return bytes
}

export function cacheStats(): { count: number; bytes: number } {
  return { count: memIndex.size, bytes: memBytes }
}

export async function clearTileCache(): Promise<void> {
  const d = await db()
  if (!d) return
  const tx = d.transaction([TILES, INDEX], 'readwrite')
  tx.objectStore(TILES).clear()
  tx.objectStore(INDEX).clear()
  memIndex.clear()
  memBytes = 0
}
