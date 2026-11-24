import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { RoadIndex } from '../shared/roads.js'
import { blockKeysFor, decodeBlock, splitFeatures, type Water } from '../shared/osmBlocks.js'

/**
 * Loads the roads and railways a region's lines might pass over.
 *
 * Read from the blocks `npm run osm` builds in data/osm/, not fetched. See src/tools/osmRefresh.ts
 * for where they come from and src/shared/osmBlocks.ts for why they are built rather than queried
 * -- the short version being that the browser reads the identical bytes out of R2, so a planned
 * line and a found one cannot disagree about what is underneath them.
 *
 * A block absent from the index is not a failure: it is ground with nothing on it, or outside
 * Germany.
 */

const DIR = new URL('../../data/osm/', import.meta.url).pathname

export interface RoadsLoaded {
  index: RoadIndex
  ways: number
  /** Water outlines in the same blocks, with the islands standing in them. */
  water: Water
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
  let built: { version: string; blocks: string[] }
  try {
    built = JSON.parse(await readFile(join(DIR, 'index.json'), 'utf8')) as typeof built
  } catch {
    throw new Error(
      `no OSM blocks under ${DIR}. Run \`npm run osm\` to build them -- without them the run ` +
        `would report lines over roads that are far too low to rig.`,
    )
  }
  const present = new Set(built.blocks)
  const keys = blockKeysFor(bbox.minE, bbox.minN, bbox.maxE, bbox.maxN)
  const index = new RoadIndex()
  const seen = new Set<number>()
  const water: Water = { rings: [], islands: [] }
  const byTier: Record<string, number> = {}
  let ways = 0
  let blocks = 0

  for (const key of keys) {
    if (!present.has(key)) continue
    const bytes = await readFile(join(DIR, built.version, `${key}.bin`))
    blocks++
    const split = splitFeatures(decodeBlock(key, bytes), seen)
    for (const road of split.roads) {
      index.add(road)
      ways++
      byTier[road.tier] = (byTier[road.tier] ?? 0) + 1
    }
    water.rings.push(...split.water.rings)
    water.islands.push(...split.water.islands)
  }

  return { index, ways, water, blocks, wanted: keys.length, byTier }
}
