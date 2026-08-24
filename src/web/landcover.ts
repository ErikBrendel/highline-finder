import type { Pos } from '../shared/grid.js'
import { toWgs84 } from '../shared/geo.js'
import { bareGround, onBuilding } from './terrain.js'

/**
 * What a profile sample is standing on, for the chart to draw.
 *
 * The bDOM is one number per cell -- the top of whatever is there -- so a 22 m pine and a 22 m
 * grain silo are the same measurement, and without a second source the app has to call both
 * "canopy". Two sources fix that, and they live in different places for a reason:
 *
 *   buildings -- the LoD1 city model. Loaded with the elevation in terrain.ts, because a roof is
 *     not decoration: it is what an anchor stands on and what a line has to clear. This module
 *     only reads the result back for drawing.
 *
 *   water -- OpenStreetMap via Overpass, here. It genuinely is decoration: a lake changes nothing
 *     about a line over it, it just makes the picture legible. The survey has no usable source --
 *     `adv_alkis_gewaesser` renders bank lines and labels, not filled polygons, so the middle of
 *     a lake comes back blank. Checked, not assumed. OSM also covers Berlin, where the
 *     Brandenburg city model does not.
 *
 * The water half fails soft: a dead Overpass means the chart looks exactly as it did before.
 */

export const COVER_NONE = 0
export const COVER_BUILDING = 1
export const COVER_WATER = 2

const OVERPASS = 'https://overpass-api.de/api/interpreter'

/**
 * Water, as WGS84 rings.
 *
 * Only outer rings. A lake with an island draws as solid, which is wrong by a few square metres
 * and right about the question being asked -- is the line over water.
 */
type Ring = { lat: number; lon: number }[]

const waterCache = new Map<string, Ring[]>()
const inFlight = new Map<string, Promise<unknown>>()

interface OverpassElement {
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
  const query =
    `[out:json][timeout:25];(` +
    `way["natural"="water"](${key});` +
    `way["waterway"="riverbank"](${key});` +
    `way["landuse"~"reservoir|basin"](${key});` +
    `relation["natural"="water"](${key});` +
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

/** Fetches the water in the corridor, if this box has not been asked for already. */
export async function ensureWater(a: Pos, b: Pos): Promise<boolean> {
  const key = waterKeyFor(a, b)
  if (waterCache.has(key)) return false
  let job = inFlight.get(key)
  if (!job) {
    job = loadWater(key).finally(() => inFlight.delete(key))
    inFlight.set(key, job)
  }
  await job.catch(() => undefined)
  return true
}

export interface Cover {
  /** One of the COVER_* constants per sample. */
  kind: Uint8Array
  /**
   * Bare earth per sample, which the profile itself no longer carries: its ground series is the
   * roof wherever there is a building. This is the foot of that column.
   */
  bare: Float32Array
}

/**
 * Cover at each of `count` evenly spaced points from `a` to `b` inclusive, matching the spacing
 * `buildProfile` uses so the two align index for index.
 *
 * Buildings win over water where the cadastre puts a boathouse on a lake: the built thing is the
 * one with height, and height is what the profile is drawing.
 */
export function coverAlong(a: Pos, b: Pos, count: number): Cover {
  const kind = new Uint8Array(count)
  const bare = new Float32Array(count)
  const rings = waterCache.get(waterKeyFor(a, b)) ?? []
  const last = count - 1
  for (let i = 0; i < count; i++) {
    const t = last > 0 ? i / last : 0
    const e = a.e + (b.e - a.e) * t
    const n = a.n + (b.n - a.n) * t
    bare[i] = bareGround(e, n)
    if (onBuilding(e, n)) {
      kind[i] = COVER_BUILDING
      continue
    }
    if (!rings.length) continue
    const { lat, lon } = toWgs84(e, n)
    if (rings.some((r) => inRing(r, lat, lon))) kind[i] = COVER_WATER
  }
  return { kind, bare }
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
