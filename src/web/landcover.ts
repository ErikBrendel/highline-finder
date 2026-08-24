import type { Pos } from '../shared/grid.js'
import { toWgs84 } from '../shared/geo.js'
import { fetchCached } from './tileCache.js'
import { windowsFor, WINDOW } from './terrain.js'

/**
 * What a profile sample is standing on, beyond bare height.
 *
 * The elevation pair the rest of the app runs on cannot answer this. The bDOM is one number per
 * cell -- the top of whatever is there -- so a 22 m pine and a 22 m grain silo are the same
 * measurement, and the app has been calling both "canopy". Separating them needs a second source
 * that says where the built-up footprints are, and neither of the two elevation products carries
 * one.
 *
 * Two sources, because no single one covers both questions:
 *
 *   buildings -- ALKIS (the cadastre) via the LGB WMS, requested as a transparent PNG over the
 *     same 256 m window grid the elevation uses. Any non-transparent pixel is inside a building
 *     footprint. Authoritative and pixel-exact at 1 m, but Brandenburg only: the Mueggelberge AOI
 *     is Berlin and comes back empty, which is a coverage gap and not an absence of buildings.
 *
 *   water -- OpenStreetMap via Overpass. The LGB has no usable source here: `adv_alkis_gewaesser`
 *     renders bank lines and labels, not filled polygons, so the middle of a lake comes back
 *     blank. Checked, not assumed. OSM covers Berlin as well.
 *
 * Nothing here feeds the score. It is drawn on the profile so the picture says what the line
 * crosses, and both halves fail soft: a dead service means the chart looks exactly as it did
 * before.
 */

export const COVER_NONE = 0
export const COVER_BUILDING = 1
export const COVER_WATER = 2

const ALKIS_WMS = 'https://isk.geobasis-bb.de/ows/alkis_wms'
const OVERPASS = 'https://overpass-api.de/api/interpreter'

/**
 * Buildings, as a bitmask per 256 m window at 1 m.
 *
 * EPSG:25833 is an easting/northing axis-order CRS, so WMS 1.3.0 wants BBOX in that order despite
 * 1.3.0's reputation -- the reversed form silently returns a blank tile rather than an error.
 */
const buildings = new Map<string, Uint8Array>()
const inFlight = new Map<string, Promise<unknown>>()

const keyOf = (tx: number, ty: number) => `${tx}_${ty}`

function buildingUrl(e0: number, n0: number): string {
  return (
    `${ALKIS_WMS}?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap&LAYERS=adv_alkis_gebaeude&STYLES=` +
    `&CRS=EPSG:25833&BBOX=${e0},${n0},${e0 + WINDOW},${n0 + WINDOW}` +
    `&WIDTH=${WINDOW}&HEIGHT=${WINDOW}&FORMAT=image/png&TRANSPARENT=TRUE`
  )
}

async function loadBuildings(tx: number, ty: number): Promise<void> {
  const bytes = await fetchCached(buildingUrl(tx * WINDOW, ty * WINDOW))
  const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }))
  const canvas = new OffscreenCanvas(WINDOW, WINDOW)
  const ctx = canvas.getContext('2d')!
  ctx.drawImage(bitmap, 0, 0)
  bitmap.close()
  const { data } = ctx.getImageData(0, 0, WINDOW, WINDOW)
  const mask = new Uint8Array(WINDOW * WINDOW)
  // Alpha alone, not colour: the cadastre draws footprints filled but in several greys, and the
  // only thing that matters here is covered versus not.
  for (let i = 0; i < mask.length; i++) mask[i] = data[i * 4 + 3]! > 64 ? 1 : 0
  buildings.set(keyOf(tx, ty), mask)
}

function buildingAt(e: number, n: number): boolean {
  const tx = Math.floor(e / WINDOW)
  const ty = Math.floor(n / WINDOW)
  const mask = buildings.get(keyOf(tx, ty))
  if (!mask) return false
  const col = Math.floor(e - tx * WINDOW)
  const row = WINDOW - 1 - Math.floor(n - ty * WINDOW)
  return mask[row * WINDOW + col] === 1
}

/**
 * Water, as WGS84 rings.
 *
 * Only outer rings, and only the ones Overpass returns geometry for directly. A lake with a hole
 * in it draws as solid, which is wrong by a few square metres of island and right about the
 * question being asked -- is the line over water.
 */
type Ring = { lat: number; lon: number }[]

const waterCache = new Map<string, Ring[]>()

interface OverpassElement {
  type: string
  geometry?: { lat: number; lon: number }[]
  members?: { role?: string; geometry?: { lat: number; lon: number }[] }[]
}

/**
 * The Overpass bounding box for a corridor, rounded outward to whole hundredths of a degree --
 * roughly a kilometre -- so nudging an anchor keeps asking for the same box.
 *
 * Also the cache key, and the reason `coverAlong` can consult one box's rings instead of every
 * box ever fetched.
 */
function waterKeyFor(a: Pos, b: Pos): string {
  const ends = [toWgs84(a.e, a.n), toWgs84(b.e, b.n)]
  const lats = ends.map((c) => c.lat)
  const lons = ends.map((c) => c.lon)
  const out = (v: number, dir: number) => (Math.round(v * 100 + dir * 0.5) / 100).toFixed(2)
  return [
    out(Math.min(...lats), -1),
    out(Math.min(...lons), -1),
    out(Math.max(...lats), 1),
    out(Math.max(...lons), 1),
  ].join(',')
}

async function loadWater(key: string): Promise<void> {
  const [s, w, n, e] = key.split(',')
  const box = `${s},${w},${n},${e}`
  const query =
    `[out:json][timeout:25];(` +
    `way["natural"="water"](${box});` +
    `way["waterway"="riverbank"](${box});` +
    `way["landuse"~"reservoir|basin"](${box});` +
    `relation["natural"="water"](${box});` +
    `);out geom;`
  // GET rather than POST: a string body would go out as text/plain, which Overpass reads as the
  // query itself rather than as a form field, and the encoded `data=` prefix would land in it.
  const res = await fetch(`${OVERPASS}?${new URLSearchParams({ data: query })}`)
  if (!res.ok) throw new Error(`overpass ${res.status}`)
  const { elements } = (await res.json()) as { elements: OverpassElement[] }
  const rings: Ring[] = []
  for (const el of elements) {
    if (el.geometry && el.geometry.length > 2) rings.push(el.geometry)
    for (const m of el.members ?? []) {
      if (m.role !== 'inner' && m.geometry && m.geometry.length > 2) rings.push(m.geometry)
    }
  }
  waterCache.set(key, rings)
}

/** Standard ray cast. Rings from Overpass are closed, so no wrap-around special case is needed. */
export function inRing(ring: Ring, lat: number, lon: number): boolean {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i]!
    const b = ring[j]!
    if (a.lat > lat !== b.lat > lat) {
      const x = a.lon + ((lat - a.lat) / (b.lat - a.lat)) * (b.lon - a.lon)
      if (lon < x) inside = !inside
    }
  }
  return inside
}

function once(key: string, build: () => Promise<void>): Promise<unknown> {
  let job = inFlight.get(key)
  if (!job) {
    job = build().finally(() => inFlight.delete(key))
    inFlight.set(key, job)
  }
  return job
}

/**
 * Fetches whatever the corridor between two points still needs.
 *
 * Resolves to true only when something new arrived, matching `ensureTerrain`, so a caller can
 * re-measure on a real change rather than on every drag frame. Each half is caught separately:
 * losing water must not cost buildings.
 */
export async function ensureLandcover(a: Pos, b: Pos): Promise<boolean> {
  const tiles = windowsFor(a, b, 0).filter(([tx, ty]) => !buildings.has(keyOf(tx, ty)))
  const key = waterKeyFor(a, b)
  const needWater = !waterCache.has(key)
  if (!tiles.length && !needWater) return false

  await Promise.all([
    ...tiles.map(([tx, ty]) =>
      once(`b${keyOf(tx, ty)}`, () => loadBuildings(tx, ty)).catch(() => undefined),
    ),
    needWater ? once(`w${key}`, () => loadWater(key)).catch(() => undefined) : null,
  ])
  return true
}

/**
 * Cover class at each of `count` evenly spaced points from `a` to `b` inclusive, matching the
 * spacing `buildProfile` uses so the two align index for index.
 *
 * Buildings win over water where the cadastre puts a boathouse on a lake: the built thing is the
 * one with height, and height is what the profile is drawing.
 */
export function coverAlong(a: Pos, b: Pos, count: number): Uint8Array {
  const out = new Uint8Array(count)
  const rings = waterCache.get(waterKeyFor(a, b)) ?? []
  const last = count - 1
  for (let i = 0; i < count; i++) {
    const t = last > 0 ? i / last : 0
    const e = a.e + (b.e - a.e) * t
    const n = a.n + (b.n - a.n) * t
    if (buildingAt(e, n)) {
      out[i] = COVER_BUILDING
      continue
    }
    if (!rings.length) continue
    const { lat, lon } = toWgs84(e, n)
    if (rings.some((r) => inRing(r, lat, lon))) out[i] = COVER_WATER
  }
  return out
}

/** Contiguous stretches of one class, for drawing. Skips {@link COVER_NONE}. */
export function coverRuns(cover: Uint8Array): { from: number; to: number; kind: number }[] {
  const runs: { from: number; to: number; kind: number }[] = []
  for (let i = 0; i < cover.length; i++) {
    const kind = cover[i]!
    if (kind === COVER_NONE) continue
    let j = i
    while (j + 1 < cover.length && cover[j + 1] === kind) j++
    runs.push({ from: i, to: j, kind })
    i = j
  }
  return runs
}
