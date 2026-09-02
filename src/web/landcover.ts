import type { Pos } from '../shared/grid.js'
import { RoadIndex } from '../shared/roads.js'
import {
  blockKeysFor, decodeBlock, splitFeatures, type OsmFeature, type Water,
} from '../shared/osmBlocks.js'
import { PATCH, fetchPatch, patchKeysFor } from './overpass.js'
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
 *   roads, railways and water -- OpenStreetMap, from the blocks this project ships with itself
 *     under public/osm/. Roads are emphatically not decoration: a line over one owes it a great
 *     deal more air than it owes bare ground, and that is a hard constraint. See shared/roads.ts.
 *
 * The shipped blocks used to be the only source, and everything the pipeline searches still comes
 * from them: they are the same bytes the pipeline read, so a found line and a planned one cannot
 * disagree about what either passes over, and Brandenburg needs no third party at run time.
 *
 * They cover Brandenburg and Berlin, because that is what the search covers and because they are
 * thirty megabytes. Elevation now reaches most of Germany, so outside them a planned line was
 * measured with every road unknown and every lake read as dry ground. For that ground only -- never
 * where a block exists -- the browser asks Overpass for a square kilometre at a time and caches
 * what comes back. See overpass.ts, which is careful about why that is the fallback and not the
 * rule: a public instance is a shared service, and asking it for a state's road network is what
 * drove this project onto shipped extracts in the first place.
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
/**
 * The same set once it has arrived, for the questions that cannot wait.
 *
 * `roadsFor` has to answer synchronously whether this corridor's roads are known, and knowing that
 * means knowing which squares the shipped blocks do not cover. Null means the index has not been
 * read yet, which is itself an answer: nothing is known about anything.
 */
let knownBlocks: Set<string> | null = null

function blockIndex(): Promise<Set<string>> {
  index ??= fetchCached(`${import.meta.env.BASE_URL}osm/index.json`)
    .then((bytes) => {
      const parsed = JSON.parse(new TextDecoder().decode(bytes)) as { blocks: string[] }
      knownBlocks = new Set(parsed.blocks)
      return knownBlocks
    })
    // An unreadable index is itself a broken deployment, and reporting every block as missing is
    // how that surfaces rather than as silently unchecked lines -- but it is said out loud, since
    // "no roads anywhere" and "the road data did not load" look identical on the map.
    .catch((e: unknown) => {
      report('loading the OSM block index (public/osm/index.json)', e)
      knownBlocks = new Set<string>()
      return knownBlocks
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
 * Land cover for ground the shipped blocks do not cover, a square kilometre at a time.
 *
 * A second, finer index beside the shipped one rather than a replacement for it. The blocks are
 * eight kilometres because that is a good size for a file in a repository; an Overpass query for
 * eight kilometres of a city is thirty megabytes and times out, so what is fetched is fetched
 * smaller. Both are read through the same functions below, and a patch is only ever asked for where
 * no block exists, so the two never describe the same ground.
 */
const patches = new Map<string, Block>()
const patching = new Map<string, Promise<void>>()
const patchFailed = new Set<string>()

/** Turns a bag of features into the two things that read them, exactly as a shipped block does. */
function blockFrom(features: OsmFeature[]): Block {
  const split = splitFeatures(features, seenWays)
  const roads = new RoadIndex()
  for (const road of split.roads) roads.add(road)
  return { roads, water: split.water }
}

function loadPatch(key: string): Promise<void> {
  let job = patching.get(key)
  if (job) return job
  job = fetchPatch(key)
    .then((features) => {
      patches.set(key, blockFrom(features))
      // The water raster is built per window and cached; a window over this patch may already have
      // been built from nothing, and would go on reporting dry ground for ever.
      waterWindows.clear()
    })
    .catch((e: unknown) => {
      report(`asking Overpass for the land cover around ${key}`, e)
      patchFailed.add(key)
    })
    // Both ways: a refusal changes what `roadsFor` may answer just as much as an arrival does.
    .finally(announce)
  patching.set(key, job)
  return job
}

const blockUnder = (patch: string) => {
  const [x, y] = patch.split('-').map(Number) as [number, number]
  return blockKeysFor(x * PATCH, y * PATCH, x * PATCH, y * PATCH)[0]!
}

/**
 * The patches a corridor needs, or null before the shipped index has been read.
 *
 * None of them wherever a block covers the ground: "this square is not in the index" is the whole
 * test, and until the index is here that question has no answer rather than the answer "none".
 */
function patchesWanted(a: Pos, b: Pos, margin?: number): string[] | null {
  if (!knownBlocks) return null
  const known = knownBlocks
  return patchKeysFor(a, b, margin).filter((key) => !known.has(blockUnder(key)))
}

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
      waterWindows.clear()
    })
    .catch((e: unknown) => {
      report(`loading the OSM block ${key}`, e)
      failed.add(key)
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
  await blockIndex()
  const wanted = patchesWanted(a, b, margin) ?? []
  const fetching = wanted.filter((k) => !patches.has(k))
  await Promise.all(wanted.map(loadPatch))
  return missing.length > 0 || fetching.length > 0
}

/** Whether anything this corridor needs was asked for and did not arrive. */
export const coverFailed = (a: Pos, b: Pos) =>
  keysFor(a, b).some((k) => failed.has(k)) || patchKeysFor(a, b).some((k) => patchFailed.has(k))

/** The fetched squares under a corridor. A patch over shipped ground is never fetched. */
const patchesUnder = (a: Pos, b: Pos) =>
  patchKeysFor(a, b)
    .map((k) => patches.get(k))
    .filter(Boolean) as Block[]

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
  /**
   * Outside the shipped blocks, an absent block is not an absent road.
   *
   * `load` records a square the index does not list as empty, which is right for a corner of the
   * extract and exactly wrong for Saxony: the block is empty because nothing was ever built for it,
   * not because the ground is bare. Answering with those alone reported every road in Germany as
   * checked and not there -- no banner, no crossing, no waiting for the patch that would have said
   * otherwise. So a corridor is known only once every patch it wants has arrived.
   */
  const wanted = patchesWanted(a, b)
  if (!wanted || !wanted.every((k) => patches.has(k))) return null
  const under = [...keys.map((k) => held.get(k)!), ...patchesUnder(a, b)]
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
  // And whatever was fetched for ground no block covers. A window is 256 m and a patch a kilometre,
  // so this is one or two of them; both are added because a window can straddle the join.
  for (const k of patchKeysFor({ e: e0, n: n0 }, { e: e0 + WINDOW, n: n0 + WINDOW }, 0)) {
    const patch = patches.get(k)
    if (patch) mask.add(patch.water)
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
  // Both sources, or a lake outside the shipped blocks is drawn as dry ground even after it has
  // been fetched -- the sampler behind `water.covers` reads both and this has to agree with it.
  const under = [...keysFor(a, b).map((k) => held.get(k)), ...patchesUnder(a, b)]
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
