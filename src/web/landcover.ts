import type { Pos } from '../shared/grid.js'
import { toUtm33, toWgs84 } from '../shared/geo.js'
import { classifyWay, RoadIndex, type Tags } from '../shared/roads.js'
import type { Roads } from '../shared/scene.js'
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
 *   roads and railways -- OpenStreetMap too, in the same request, because they are the same query
 *     against the same bounding box. These are emphatically not decoration: a line over a road owes
 *     it a great deal more air than it owes bare ground, and that is a hard constraint. See
 *     shared/roads.ts.
 *
 * Which is why the failure behaviour is split. Water fails soft -- a dead Overpass means the chart
 * looks as it did before. Roads cannot: silently reporting no roads would let the planner pass a
 * line four metres over a Bundesstraße and call it valid. So a failed fetch is remembered and
 * `roadsFailed` says so, for the planner to put in front of the user.
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
const roadCache = new Map<string, RoadIndex>()
const failed = new Set<string>()
const inFlight = new Map<string, Promise<unknown>>()

interface OverpassElement {
  tags?: Tags
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

/**
 * Water and traffic for one bounding box, in a single request.
 *
 * Retried, because this is now load-bearing rather than cosmetic and one bad response should not
 * cost the user their road check for the rest of the session.
 */
async function loadCover(key: string): Promise<void> {
  const query =
    `[out:json][timeout:60];(` +
    `way["natural"="water"](${key});` +
    `way["waterway"="riverbank"](${key});` +
    `way["landuse"~"reservoir|basin"](${key});` +
    `relation["natural"="water"](${key});` +
    `way["highway"](${key});` +
    `way["railway"](${key});` +
    `);out geom;`
  // GET rather than POST: a string body would go out as text/plain, which Overpass reads as the
  // query itself rather than as a form field, and the encoded `data=` prefix would land in it.
  let last: unknown
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(`${OVERPASS}?${new URLSearchParams({ data: query })}`)
      if (!res.ok) throw new Error(`overpass ${res.status}`)
      const { elements } = (await res.json()) as { elements: OverpassElement[] }
      const rings: Ring[] = []
      const index = new RoadIndex()
      for (const el of elements) {
        const classified = el.tags && el.geometry ? classifyWay(el.tags) : null
        if (classified && el.geometry!.length > 1) {
          const pts: number[] = []
          for (const { lat, lon } of el.geometry!) pts.push(...toUtm33(lat, lon))
          const bridge = !!el.tags!.bridge && el.tags!.bridge !== 'no'
          index.add({ ...classified, bridge, pts })
          continue
        }
        if (el.geometry && el.geometry.length > 2) rings.push(el.geometry)
        for (const m of el.members ?? []) {
          if (m.role !== 'inner' && m.geometry && m.geometry.length > 2) rings.push(m.geometry)
        }
      }
      waterCache.set(key, rings)
      roadCache.set(key, index)
      failed.delete(key)
      return
    } catch (e) {
      last = e
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)))
    }
  }
  failed.add(key)
  throw last
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

/** Fetches the land cover for the corridor, if this box has not been asked for already. */
export async function ensureCover(a: Pos, b: Pos): Promise<boolean> {
  const key = waterKeyFor(a, b)
  if (waterCache.has(key)) return false
  let job = inFlight.get(key)
  if (!job) {
    job = loadCover(key).finally(() => inFlight.delete(key))
    inFlight.set(key, job)
  }
  await job.catch(() => undefined)
  return true
}

/**
 * The roads under a corridor, or null while they are unknown.
 *
 * Null and empty are different answers and the caller has to keep them apart: empty means Overpass
 * said there is nothing there, null means nobody has asked yet or the asking failed. Measuring a
 * line against null roads silently drops the clearance surcharge, so `roadsFailed` exists to say so
 * out loud rather than letting a too-low line read as a valid one.
 */
export function roadsFor(a: Pos, b: Pos): Roads | null {
  return roadCache.get(waterKeyFor(a, b)) ?? null
}

/** Whether the last attempt at this corridor's land cover failed outright. */
export function roadsFailed(a: Pos, b: Pos): boolean {
  return failed.has(waterKeyFor(a, b))
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
