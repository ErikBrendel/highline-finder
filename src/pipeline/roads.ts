import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { RoadIndex } from '../shared/roads.js'
import { blockKeysFor, decodeBlock, splitFeatures } from '../shared/osmBlocks.js'

/**
 * Loads the roads and railways a region's lines might pass over.
 *
 * Read from the blocks committed under src/web/public/osm/, not fetched. See src/tools/osmRefresh.ts
 * for where they come from and src/shared/osmBlocks.ts for why they are shipped rather than queried
 * -- the short version being that asking the public Overpass API for a state's road network got
 * this machine refused, and that the browser now reads the identical bytes, so a planned line and a
 * found one cannot disagree about what is underneath them.
 *
 * A missing block is not a failure: the extract covers Brandenburg and Berlin, and a region on the
 * edge of it has blocks with nothing in them at all.
 */

const DIR = new URL('../web/public/osm/', import.meta.url).pathname

export interface RoadsLoaded {
  index: RoadIndex
  ways: number
  /** Water outlines in the same blocks, as flat `[e, n, ...]` rings. */
  water: number[][]
  /** Blocks that held something, against the number looked for. */
  blocks: number
  wanted: number
  byTier: Record<string, number>
}

export async function loadRoads(bbox: {
  minE: number
  minN: number
  maxE: number
  maxN: number
}): Promise<RoadsLoaded> {
  const keys = blockKeysFor(bbox.minE, bbox.minN, bbox.maxE, bbox.maxN)
  const index = new RoadIndex()
  const seen = new Set<number>()
  const water: number[][] = []
  const byTier: Record<string, number> = {}
  let ways = 0
  let blocks = 0

  for (const key of keys) {
    let bytes: Buffer
    try {
      bytes = await readFile(join(DIR, `${key}.bin`))
    } catch {
      continue
    }
    blocks++
    const split = splitFeatures(decodeBlock(key, bytes), seen)
    for (const road of split.roads) {
      index.add(road)
      ways++
      byTier[road.tier] = (byTier[road.tier] ?? 0) + 1
    }
    water.push(...split.water)
  }

  if (!blocks) {
    throw new Error(
      `no OSM blocks under ${DIR} for this region. Run \`npm run osm\` to build them -- without ` +
        `them the run would report lines over roads that are far too low to rig.`,
    )
  }
  return { index, ways, water, blocks, wanted: keys.length, byTier }
}
