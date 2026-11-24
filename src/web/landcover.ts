import type { Pos } from '../shared/grid.js'
import { RoadIndex } from '../shared/roads.js'
import { blockKeysFor, decodeBlock, splitFeatures, type Water } from '../shared/osmBlocks.js'
import { osmUrl } from './hosts.js'
import type { Roads } from '../shared/scene.js'
import { WaterMask, type WaterCover } from '../shared/water.js'
import { WINDOW, bareGround, onBuilding } from './terrain.js'
import { fetchCached } from './tileCache.js'
import { report } from './report.js'

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
 *   roads, railways and water -- OpenStreetMap, as blocks this project builds itself for all of
 *     Germany and serves out of R2 through the proxy. Roads are emphatically not decoration: a
 *     line over one owes it a great deal more air than it owes bare ground, and that is a hard
 *     constraint. See shared/roads.ts.
 *
 * They are the same bytes the pipeline reads, so a found line and a planned one cannot disagree
 * about what either passes over, and no third party is asked anything at run time. There used to be
 * a live Overpass fallback for ground outside Brandenburg; it was down often enough to read every
 * lake there as dry ground, and is gone now that the blocks reach everywhere the elevation does.
 */

export const COVER_NONE = 0
export const COVER_BUILDING = 1
export const COVER_WATER = 2

interface Block {
  roads: RoadIndex
  /** Water outlines and the islands standing in them. */
  water: Water
}

/** Decoded blocks, and the ones still arriving. A block is fetched once per session. */
const held = new Map<string, Block>()
const loading = new Map<string, Promise<void>>()
/** Blocks that would not load, until a corridor asks for them again. */
const failed = new Set<string>()

/**
 * Which blocks the build produced, and under which version they are published.
 *
 * Without it a block that is missing because the deployment is broken and a block that is missing
 * because there is nothing in those eight kilometres are the same silence -- and the first of those
 * would quietly stop the planner asking for height over roads. With it, absent from the index means
 * empty and present-but-unfetchable means broken, which is worth saying out loud.
 *
 * Fetched past every cache, unlike the blocks: the index is what moves to a new build, and a block
 * URL carries its version, so a stored block can never be read under another build's index.
 */
interface Built {
  version: string
  blocks: Set<string>
}
let index: Promise<Built> | null = null

function blockIndex(): Promise<Built> {
  index ??= fetch(osmUrl('index.json'), { cache: 'no-cache' })
    .then(async (res) => {
      if (!res.ok) throw new Error(`${res.status} for the OSM block index`)
      const parsed = (await res.json()) as { version: string; blocks: string[] }
      return { version: parsed.version, blocks: new Set(parsed.blocks) }
    })
    .catch((e: unknown) => {
      // Asked again by the next block, rather than every block failing for the rest of the session.
      index = null
      throw e
    })
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
 * Told whenever anything new lands, rather than whoever asked for it being told.
 *
 * `ensureCover` used to report "something arrived" to its own caller, and that is not the same
 * question. Two things ask for land cover -- the panel, for the line, and the 3D view, for the
 * square around it -- and whichever asked second was told nothing arrived, because the first had
 * already fetched it. The panel then never rebuilt its profile, so a lake was drawn blue while the
 * clearance line went on demanding the three metres it asks over dry ground.
 *
 * A change is a fact about the data, not about a request, so it is announced to everyone reading it.
 */
const listeners = new Set<() => void>()

export function onCoverChange(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

const announce = () => {
  for (const fn of listeners) fn()
}

/**
 * The blocks a corridor touches, with a margin.
 *
 * The margin is what stops dragging an anchor near a block edge from fetching and discarding a
 * neighbour repeatedly; at 8 km blocks it costs a block occasionally and saves a request often.
 */
const keysFor = (a: Pos, b: Pos, margin: number = 500) =>
  blockKeysFor(
    Math.min(a.e, b.e) - margin,
    Math.min(a.n, b.n) - margin,
    Math.max(a.e, b.e) + margin,
    Math.max(a.n, b.n) + margin,
  )

const EMPTY: Block = { roads: new RoadIndex(), water: { rings: [], islands: [] } }

/**
 * One block, or an empty one where the build produced none -- ground with nothing on it, or
 * outside Germany. A block the index does list and which will not load is recorded as failed, and
 * asked for again the next time a corridor needs it.
 */
function load(key: string): Promise<void> {
  let job = loading.get(key)
  if (job) return job
  job = blockIndex()
    .then(async ({ version, blocks }) => {
      if (!blocks.has(key)) {
        held.set(key, EMPTY)
        return
      }
      const bytes = await fetchCached(osmUrl(`${version}/${key}.bin`))
      const split = splitFeatures(decodeBlock(key, new Uint8Array(bytes)), seenWays)
      const roads = new RoadIndex()
      for (const road of split.roads) roads.add(road)
      held.set(key, { roads, water: split.water })
      failed.delete(key)
      waterWindows.clear()
    })
    .catch((e: unknown) => {
      report(`loading the OSM block ${key}`, e)
      failed.add(key)
      loading.delete(key)
    })
    .finally(announce)
  loading.set(key, job)
  return job
}

/** Fetches whatever this corridor needs. Resolves true when something new arrived. */
export async function ensureCover(a: Pos, b: Pos, margin?: number): Promise<boolean> {
  const keys = keysFor(a, b, margin)
  const missing = keys.filter((k) => !held.has(k))
  await Promise.all(keys.map(load))
  return missing.length > 0
}

/** Whether anything this corridor needs was asked for and did not arrive. */
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
  const under = keys.map((k) => held.get(k)!)
  return {
    crossings: (from, to, p, elevation) =>
      under
        .flatMap((block) => block.roads.crossings(from, to, p, elevation))
        .sort((x, y) => x.d - y.d),
  }
}

/**
 * Water as a bit per cell, one window at a time.
 *
 * The same shape as the elevation windows next door, and for the same reason: a line is measured
 * across a band at a hundred and twenty stations, which is thousands of "is this water" questions
 * per drag frame, and a point-in-polygon test against every lake outline in an 8 km block is not
 * something to do thousands of times a second. Rasterised once per 256 m window and then read with
 * a shift.
 *
 * A window whose block has not arrived reports no water, which is the strict reading: without the
 * layer every sample is held to the full ground clearance.
 */
const waterWindows = new Map<string, WaterMask>()

function waterAt(tx: number, ty: number): WaterMask {
  const key = `${tx}_${ty}`
  let mask = waterWindows.get(key)
  if (mask) return mask
  const e0 = tx * WINDOW
  const n0 = ty * WINDOW
  mask = new WaterMask({ w: WINDOW, h: WINDOW, e0, n1: n0 + WINDOW, res: 1 })
  for (const k of blockKeysFor(e0, n0, e0 + WINDOW, n0 + WINDOW)) {
    const block = held.get(k)
    // Not loaded yet: leave the window unbuilt so it is rasterised again once the block arrives.
    if (!block) return mask
    mask.add(block.water)
  }
  waterWindows.set(key, mask)
  return mask
}

/**
 * The water layer, in the form the clearance rule takes.
 *
 * Module-level and always available, unlike `roadsFor`, because absence is already the answer it
 * gives: no block, no water, full ground clearance. There is no reading of it that could pass a
 * line the strict rule would reject.
 */
export const water: WaterCover = {
  covers(e: number, n: number): boolean {
    return waterAt(Math.floor(e / WINDOW), Math.floor(n / WINDOW)).covers(e, n)
  },
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
  const under = keysFor(a, b).map((k) => held.get(k))
  const rings = under.flatMap((block) => block?.water.rings ?? [])
  // An island is not a lake to draw a section through, so a sample standing on one is bare ground.
  const islands = under.flatMap((block) => block?.water.islands ?? [])
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
    if (rings.some((r) => inRing(r, e, n)) && !islands.some((r) => inRing(r, e, n))) {
      kind[i] = COVER_WATER
    }
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
