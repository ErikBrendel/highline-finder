import { classifyWay } from '../shared/roads.js'
import { waterKind } from '../shared/water-tags.js'
import { decodeBlock, encodeBlock, type OsmFeature } from '../shared/osmBlocks.js'
import { toUtm33, toWgs84 } from '../shared/geo.js'
import { readCached, writeCached } from './tileCache.js'

/**
 * Roads and water for ground this app does not carry, asked for a square kilometre at a time.
 *
 * The blocks under public/osm are Brandenburg and Berlin, because they are what the search covers
 * and they are thirty megabytes. Elevation now reaches most of Germany, so a line planned near
 * Leipzig or in the Harz was measured with the roads under it unknown and every lake read as dry
 * ground -- stated in the panel, and still a worse answer than one nobody had to qualify.
 *
 * This is deliberately the fallback and deliberately small. The shipped blocks are consulted first
 * and this is never asked about ground they cover; a public Overpass instance is a shared service,
 * and the project moved off it for bulk work for exactly that reason. One kilometre square is the
 * unit because eight -- the shipped block size -- is thirty megabytes over a city and times out.
 *
 * Everything fetched is packed into the same block format the shipped ones use and kept in the same
 * browser database, so the second visit to a place costs nothing and the two kinds of data cannot
 * drift apart in how they are read.
 */

/** Instances tried in order. The public one is busy often enough to be worth a second. */
const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
]

/** Side of a fetched square, in metres. See the note above on why this is not the block size. */
export const PATCH = 1000

/** Version in the key, so a change to what is asked for does not read stale answers. */
const CACHE_PREFIX = 'overpass:v1:'

/** Longest a request may take before the next endpoint, or the banner, gets its turn. */
const TIMEOUT_MS = 25_000

export const patchKeyFor = (e: number, n: number) =>
  `${Math.floor(e / PATCH)}-${Math.floor(n / PATCH)}`

/**
 * Every patch a corridor touches, with a small margin.
 *
 * Much smaller than the shipped blocks use. Theirs is drag hysteresis over an eight-kilometre grid,
 * where an extra square is occasionally fetched and often saved. Here a square is a kilometre and a
 * request to a shared service, so a 500 m margin turned a two-hundred-metre line into six requests
 * -- which is both wasteful and, tried at once, enough to be rate-limited.
 */
export function patchKeysFor(
  a: { e: number; n: number },
  b: { e: number; n: number },
  margin: number = 150,
) {
  const out: string[] = []
  const [e0, e1] = [Math.min(a.e, b.e) - margin, Math.max(a.e, b.e) + margin]
  const [n0, n1] = [Math.min(a.n, b.n) - margin, Math.max(a.n, b.n) + margin]
  for (let x = Math.floor(e0 / PATCH); x <= Math.floor(e1 / PATCH); x++) {
    for (let y = Math.floor(n0 / PATCH); y <= Math.floor(n1 / PATCH); y++) out.push(`${x}-${y}`)
  }
  return out
}

/**
 * The query, in latitude and longitude because that is what Overpass takes.
 *
 * The corners are projected and the box is the one that holds all four, padded: a square in UTM is
 * not a square in degrees, and asking for slightly too much costs a few kilobytes where asking for
 * too little leaves a strip of the line unchecked.
 */
function queryFor(key: string): string {
  const [x, y] = key.split('-').map(Number) as [number, number]
  const lats: number[] = []
  const lons: number[] = []
  for (const e of [x * PATCH, (x + 1) * PATCH]) {
    for (const n of [y * PATCH, (y + 1) * PATCH]) {
      const { lat, lon } = toWgs84(e, n)
      lats.push(lat)
      lons.push(lon)
    }
  }
  const pad = 0.001
  const bbox = [
    Math.min(...lats) - pad,
    Math.min(...lons) - pad,
    Math.max(...lats) + pad,
    Math.max(...lons) + pad,
  ]
    .map((v) => v.toFixed(6))
    .join(',')
  // The same tags the shipped extract keeps, so the two agree about what a road is. `out geom`
  // returns the geometry inline, which saves resolving node ids in the browser.
  return (
    `[out:json][timeout:25];(` +
    `way["highway"](${bbox});` +
    `way["railway"](${bbox});` +
    `way["natural"="water"](${bbox});` +
    `way["waterway"](${bbox});` +
    `way["landuse"~"reservoir|basin"](${bbox});` +
    `relation["natural"="water"](${bbox});` +
    `);out geom;`
  )
}

interface OverpassGeom {
  lat: number
  lon: number
}

interface OverpassElement {
  type: 'way' | 'relation' | 'node'
  id: number
  tags?: Record<string, string>
  geometry?: OverpassGeom[]
  members?: { role?: string; geometry?: OverpassGeom[] }[]
}

const projected = (geom: OverpassGeom[]): number[] => {
  const pts: number[] = []
  for (const g of geom) {
    const [e, n] = toUtm33(g.lat, g.lon)
    pts.push(e, n)
  }
  return pts
}

/**
 * Overpass's answer as the features the rest of the app reads.
 *
 * A multipolygon lake arrives as a relation whose members carry their own geometry, so its outer
 * rings become water and its inner ones islands -- an island is not a lake to draw a section
 * through, and the water test already knows the difference. Ring ids are negative and counted down,
 * the same convention the shipped blocks use, so a ring can never collide with a way.
 */
export function featuresFrom(elements: OverpassElement[]): OsmFeature[] {
  const out: OsmFeature[] = []
  let ringId = -1
  for (const el of elements) {
    const tags = el.tags ?? {}
    if (el.type === 'way' && el.geometry) {
      const road = classifyWay(tags)
      if (road) {
        out.push({
          id: el.id,
          kind: road.tier,
          name: road.kind,
          half: road.half,
          bridge: !!tags.bridge && tags.bridge !== 'no',
          pts: projected(el.geometry),
        })
        continue
      }
      const water = waterKind(tags)
      if (water) {
        out.push({ id: el.id, kind: water, name: water, half: 0, bridge: false, pts: projected(el.geometry) })
      }
      continue
    }
    if (el.type === 'relation' && waterKind(tags)) {
      for (const m of el.members ?? []) {
        if (!m.geometry?.length) continue
        const kind = m.role === 'inner' ? 'island' : 'water'
        out.push({ id: ringId--, kind, name: kind, half: 0, bridge: false, pts: projected(m.geometry) })
      }
    }
  }
  return out
}

/**
 * One request at a time, across the whole app.
 *
 * A corridor can want two or three patches and a public instance answers a burst from one address
 * with 429. They are wanted in sequence anyway -- nothing is drawn until all of them are in -- so
 * queueing costs nothing but the wait it was going to cost regardless.
 */
let queue: Promise<unknown> = Promise.resolve()

function inTurn<T>(work: () => Promise<T>): Promise<T> {
  const next = queue.then(work, work)
  // The queue must not inherit a rejection, or one refusal would poison every request after it.
  queue = next.catch(() => undefined)
  return next
}

async function ask(query: string): Promise<OverpassElement[]> {
  let last: unknown = new Error('no Overpass endpoint answered')
  for (const endpoint of ENDPOINTS) {
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        body: query,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
      if (!res.ok) throw new Error(`${res.status} from ${new URL(endpoint).host}`)
      return ((await res.json()) as { elements?: OverpassElement[] }).elements ?? []
    } catch (e) {
      last = e
    }
  }
  throw last
}

/**
 * One patch of land cover, from the cache if it has been here before.
 *
 * Packed into the block format on the way in rather than kept as objects: it is the format the
 * shipped blocks are in, it is a tenth of the size of the JSON it came from, and storing it means
 * the next visit to this square costs nothing at all.
 */
export async function fetchPatch(key: string): Promise<OsmFeature[]> {
  const cached = await readCached(CACHE_PREFIX + key)
  if (cached) return decodeBlock(key, new Uint8Array(cached))
  const features = featuresFrom(await inTurn(() => ask(queryFor(key))))
  const packed = encodeBlock(key, features)
  writeCached(CACHE_PREFIX + key, packed.buffer.slice(packed.byteOffset, packed.byteOffset + packed.byteLength) as ArrayBuffer)
  return features
}
