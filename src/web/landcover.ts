import type { Pos } from '../shared/grid.js'
import { RoadIndex } from '../shared/roads.js'
import { blockKeysFor, decodeBlock, splitFeatures } from '../shared/osmBlocks.js'
import type { Roads } from '../shared/scene.js'
import { bareGround, onBuilding } from './terrain.js'
import { fetchCached } from './tileCache.js'

/**
 * What a profile sample is standing on: for the chart to draw, and for the planner to measure.
 *
 * The bDOM is one number per cell -- the top of whatever is there -- so a 22 m pine and a 22 m
 * grain silo are the same measurement, and without a second source the app has to call both
 * "canopy". Two sources fix that, and they live in different places for a reason:
 *
 *   buildings -- the LoD1 city model. Loaded with the elevation in terrain.ts, because a roof is
 *     not decoration: it is what an anchor stands on and what a line has to clear. This module only
 *     reads the result back for drawing.
 *
 *   roads, railways and water -- OpenStreetMap, from the blocks this project ships with itself
 *     under public/osm/. Roads are emphatically not decoration: a line over one owes it a great
 *     deal more air than it owes bare ground, and that is a hard constraint. See shared/roads.ts.
 *
 * These used to come from the public Overpass API, per corridor, at run time. That was wrong twice
 * over. It is a shared community service, and this project's own pipeline got the machine refused
 * outright asking it for a state's road network; and the pipeline and the browser asked it
 * separately, so the two could disagree about what a line passes over -- the exact thing the
 * project refuses to allow for terrain and roofs. Now both read the same bytes, and there is no
 * run-time dependency and no failure mode left to handle.
 */

export const COVER_NONE = 0
export const COVER_BUILDING = 1
export const COVER_WATER = 2

interface Block {
  roads: RoadIndex
  /** Water outlines, as flat `[e, n, ...]` rings in EPSG:25833. */
  water: number[][]
}

/** Decoded blocks, and the ones still arriving. A block is fetched once per session. */
const held = new Map<string, Block>()
const loading = new Map<string, Promise<void>>()
/** Blocks the index says exist but which would not load, which is a broken deployment. */
const failed = new Set<string>()

/**
 * Which blocks the build actually produced.
 *
 * Without it a block that is missing because the deployment is broken and a block that is missing
 * because there is nothing in that square kilometre are the same silence -- and the first of those
 * would quietly stop the planner asking for height over roads. With it, absent from the index means
 * empty and present-but-unfetchable means broken, which is worth saying out loud.
 */
let index: Promise<Set<string>> | null = null

function blockIndex(): Promise<Set<string>> {
  index ??= fetchCached(`${import.meta.env.BASE_URL}osm/index.json`)
    .then((bytes) => {
      const parsed = JSON.parse(new TextDecoder().decode(bytes)) as { blocks: string[] }
      return new Set(parsed.blocks)
    })
    // An unreadable index is itself a broken deployment, and reporting every block as missing is
    // how that surfaces rather than as silently unchecked lines.
    .catch(() => new Set<string>())
  return index
}

/**
 * Ways already taken from some block, so one lying across a boundary is indexed once.
 *
 * Module-level and never cleared. It is a few hundred thousand numbers over a whole session, and
 * deduplicating per corridor instead would let the same road into two neighbouring blocks' indexes
 * and report its crossing twice on any line that spans both.
 */
const seenWays = new Set<number>()

/**
 * The blocks a corridor touches, with a margin.
 *
 * The margin is what stops dragging an anchor near a block edge from fetching and discarding a
 * neighbour repeatedly; at 8 km blocks it costs a block occasionally and saves a request often.
 */
const keysFor = (a: Pos, b: Pos, margin = 500) =>
  blockKeysFor(
    Math.min(a.e, b.e) - margin,
    Math.min(a.n, b.n) - margin,
    Math.max(a.e, b.e) + margin,
    Math.max(a.n, b.n) + margin,
  )

const EMPTY: Block = { roads: new RoadIndex(), water: [] }

/**
 * One block, or an empty one where the build produced none.
 *
 * The extract covers Brandenburg and Berlin, and a corridor near the edge of it reaches squares
 * that hold nothing at all -- so "not in the index" is an answer and costs no request. A block the
 * index does list and which will not load is a different matter, and is recorded as failed.
 */
function load(key: string): Promise<void> {
  let job = loading.get(key)
  if (job) return job
  job = blockIndex()
    .then(async (known) => {
      if (!known.has(key)) {
        held.set(key, EMPTY)
        return
      }
      const bytes = await fetchCached(`${import.meta.env.BASE_URL}osm/${key}.bin`)
      const split = splitFeatures(decodeBlock(key, new Uint8Array(bytes)), seenWays)
      const roads = new RoadIndex()
      for (const road of split.roads) roads.add(road)
      held.set(key, { roads, water: split.water })
    })
    .catch(() => {
      failed.add(key)
    })
  loading.set(key, job)
  return job
}

/** Fetches whatever this corridor needs. Resolves true when something new arrived. */
export async function ensureCover(a: Pos, b: Pos): Promise<boolean> {
  const keys = keysFor(a, b)
  const missing = keys.filter((k) => !held.has(k))
  await Promise.all(keys.map(load))
  return missing.length > 0
}

/** Whether a block this corridor needs is listed in the index but could not be loaded. */
export const coverFailed = (a: Pos, b: Pos) => keysFor(a, b).some((k) => failed.has(k))

/**
 * The roads under a corridor, or null until every block it needs has arrived.
 *
 * Null and empty are different answers and callers must keep them apart: empty means there is
 * nothing there, null means nobody has looked yet. Measuring a line against null roads would
 * silently drop the clearance surcharge and present an unchecked line as a valid one.
 */
export function roadsFor(a: Pos, b: Pos): Roads | null {
  const keys = keysFor(a, b)
  if (!keys.every((k) => held.has(k))) return null
  return {
    crossings: (from, to, p, elevation) =>
      keys
        .flatMap((k) => held.get(k)!.roads.crossings(from, to, p, elevation))
        .sort((x, y) => x.d - y.d),
  }
}

/**
 * Standard ray cast over a flat `[e, n, ...]` ring, in projected metres.
 *
 * Projected rather than in latitude and longitude, which is what this used to take: the samples are
 * already in metres, so the test costs no coordinate transform and there is no longer a place where
 * the ring geometry and the profile disagree about which space they are in.
 */
export function inRing(ring: number[], e: number, n: number): boolean {
  let inside = false
  const count = ring.length / 2
  for (let i = 0, j = count - 1; i < count; j = i++) {
    const an = ring[i * 2 + 1]!
    const bn = ring[j * 2 + 1]!
    if (an > n !== bn > n) {
      const ae = ring[i * 2]!
      const be = ring[j * 2]!
      if (e < ae + ((n - an) / (bn - an)) * (be - ae)) inside = !inside
    }
  }
  return inside
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
  const rings = keysFor(a, b).flatMap((k) => held.get(k)?.water ?? [])
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
    if (rings.some((r) => inRing(r, e, n))) kind[i] = COVER_WATER
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
