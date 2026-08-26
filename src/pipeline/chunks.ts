import { toWgs84 } from '../shared/geo.js'
import type { Box, WorkArea } from './regions.js'

/**
 * The fixed grid a statewide search is cut into.
 *
 * An area of interest says "look here". A superchunk says "this square is somebody's
 * responsibility", which is a different and more useful thing once the ground stops fitting in
 * memory. The two run side by side: an area of interest is rasterised as one grid and searched
 * whole, a chunk is one square of a lattice that tiles the state, and the run pools both.
 *
 * They cannot be spelled with each other, which is why this exists rather than a list of
 * chunk-shaped areas of interest. `workAreas` merges anything within `maxLength`, so four adjacent
 * chunk-shaped rectangles become one region of four times the area -- and a swathe of them becomes
 * one region of the whole swathe, which is the opposite of the point. Chunks never merge.
 *
 * Pinned to EPSG:25833 in multiples of 8 km, so a chunk is exactly 8x8 of the 1 km source tiles the
 * survey publishes. Tile edges are already the download, cache and downsample boundaries, so chunk
 * edges land on them for free, and the grid does not move when the area searched changes.
 *
 * A chunk *loads* one tile more in every direction than it owns:
 *
 *   - North, east and west for the 500 m a partner anchor can sit away. The pair search enumerates
 *     each pair from its southern anchor, so a partner is always north or due east -- but a partner
 *     to the north may be anywhere in easting, so west is needed too.
 *   - South because the chunk's own southernmost anchors probe 40 m out (`nearProbeLength`) and
 *     test their drop 25 m out (`dropSearchRadius`).
 *
 * One kilometre covers all of those with room to spare, including the 3 m refinement can move an
 * anchor after the ground is fixed. That is 100 tiles loaded for 64 owned, 1.56x, and it is the
 * price of not having to talk to the neighbours.
 *
 * Ownership is `owns` on the WorkArea and is enforced in `terrainPairs`: every pair belongs to the
 * chunk holding its first anchor, so neighbours agree about a line crossing between them without
 * either knowing the other exists. See PairSearchRange.
 */

/** Source tiles to a chunk side. */
export const CHUNK_TILES = 8
export const CHUNK_M = CHUNK_TILES * 1000
/** Tiles loaded beyond the owned square, in every direction. */
export const HALO_TILES = 1

export interface ChunkId {
  /** Lattice indices, so the chunk covers E [e*CHUNK_M, (e+1)*CHUNK_M). */
  e: number
  n: number
}

export const chunkName = (c: ChunkId): string => `${c.e}_${c.n}`

export function chunkAt(e: number, n: number): ChunkId {
  return { e: Math.floor(e / CHUNK_M), n: Math.floor(n / CHUNK_M) }
}

/** Parses `52_729`, or throws -- a mistyped chunk should stop the run, not search nowhere. */
export function parseChunk(name: string): ChunkId {
  const m = /^(-?\d+)_(-?\d+)$/.exec(name.trim())
  if (!m) throw new Error(`not a chunk name: "${name}" (expected something like 52_729)`)
  return { e: Number(m[1]), n: Number(m[2]) }
}

/** The ground this chunk is answerable for. */
export function chunkBounds(c: ChunkId): Box {
  return {
    minE: c.e * CHUNK_M,
    minN: c.n * CHUNK_M,
    maxE: (c.e + 1) * CHUNK_M,
    maxN: (c.n + 1) * CHUNK_M,
  }
}

/** Every chunk whose owned square meets `box`. */
export function chunksOver(box: Box): ChunkId[] {
  const out: ChunkId[] = []
  for (let e = Math.floor(box.minE / CHUNK_M); e <= Math.floor(box.maxE / CHUNK_M); e++) {
    for (let n = Math.floor(box.minN / CHUNK_M); n <= Math.floor(box.maxN / CHUNK_M); n++) {
      out.push({ e, n })
    }
  }
  return out
}

const grow = (b: Box, by: number): Box => ({
  minE: b.minE - by,
  minN: b.minN - by,
  maxE: b.maxE + by,
  maxN: b.maxN + by,
})

/**
 * One chunk as a unit of work.
 *
 * `boxes` is the loaded square rather than the owned one: an anchor in the halo is not a place this
 * chunk reports a line from, but it is a place a line can reach *to*, so it has to be scanned. What
 * keeps the halo from producing duplicate lines is `owns`, not the anchor filter.
 *
 * The `aois` are cosmetic -- the owned square in latitude and longitude, so the viewer can draw and
 * fit to a chunk the same way it does an area of interest. Nothing in the search reads them.
 */
export function chunkArea(c: ChunkId): WorkArea {
  const owns = chunkBounds(c)
  const sw = toWgs84(owns.minE, owns.minN)
  const ne = toWgs84(owns.maxE, owns.maxN)
  const bbox = grow(owns, HALO_TILES * 1000)
  return {
    id: `chunk_${chunkName(c)}`,
    kind: 'chunk',
    aois: [{ south: sw.lat, west: sw.lon, north: ne.lat, east: ne.lon }],
    boxes: [bbox],
    bbox,
    owns,
  }
}
