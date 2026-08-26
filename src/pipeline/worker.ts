import { parentPort, workerData } from 'node:worker_threads'
import { Grid } from '../shared/grid.js'
import { RoofMask } from '../shared/anchoring.js'
import { WaterMask } from '../shared/water.js'
import { enablePhases, takeCounts, takePhases } from '../shared/phases.js'
import { loadRoads } from './roads.js'
import {
  bucketAnchors,
  pairsOf,
  refine,
  scorePairs,
  terrainPairs,
  type AnchorIndex,
} from './lines.js'
import type { Done, Job, SharedRegion } from './pool.js'
import type { AnchorTable } from './openness.js'
import type { Scene } from '../shared/scene.js'

/**
 * One worker's share of a region.
 *
 * Everything sized by the raster arrives by reference on a SharedArrayBuffer and is wrapped here
 * without copying. The road index is rebuilt from the same on-disk blocks the main thread reads,
 * because it is a map of objects and could not be shared without being rewritten as typed arrays --
 * half a second, once, against the minutes the pool saves.
 *
 * A worker holds no state between jobs beyond the scene, so which chunk lands on which worker
 * cannot affect the answer.
 */

const region = workerData as SharedRegion
const port = parentPort!

const ground = Grid.adopt(region.ground)
const scene: Scene = {
  roofs: region.roofs ? RoofMask.adopt(region.roofs) : undefined,
  water: region.water ? WaterMask.adopt(region.water) : undefined,
}

/**
 * The surface model arrives after the pool is running, because which of its tiles are worth
 * fetching is decided by the pair search the pool has yet to do. Until then it stands in as the
 * terrain, which is what the pair search reads anyway.
 */
let surface = ground

enablePhases()

/** Phase and tally totals accrued while running one job, so the run report still sees inside. */
function withMeasurements(value: unknown): Done {
  return { value, phases: [...takePhases()], counts: [...takeCounts()] }
}

/**
 * The bucket index, built once per region rather than once per job.
 *
 * A worker takes several chunks of the same region and every chunk needs the whole index -- a
 * partner can be any anchor -- so building it per chunk is building it once per chunk instead of
 * once per region. Keyed on the buffer, so a new region replaces it rather than being served the
 * old one.
 */
let indexed: { from: SharedArrayBuffer; index: AnchorIndex } | null = null

function indexOf(table: AnchorTable): AnchorIndex {
  if (indexed?.from !== table.fields) {
    indexed = { from: table.fields, index: bucketAnchors(table, region.params.maxLength) }
  }
  return indexed.index
}

function handle(job: Job): unknown {
  if (job.kind === 'pairs') {
    const found = terrainPairs(job.anchors, ground, region.params, scene, {
      from: job.from,
      to: job.to,
      index: indexOf(job.anchors),
    })
    // Copied out of the growable buffer so the message carries the pairs and nothing else.
    return { ...found, pairs: Int32Array.from(found.pairs) }
  }
  if (job.kind === 'score') {
    const pairs = new Int32Array(job.pairs, 0, job.total * 2)
    return scorePairs(
      pairsOf(job.anchors, pairs, job.from, job.to), ground, surface, region.params, scene,
    )
  }
  if (job.kind === 'refine') return refine(job.candidates, ground, surface, region.params, scene)
  surface = Grid.adopt(job.grid)
  return { attached: true }
}

loadRoads(region.bbox)
  .then((roads) => {
    scene.roads = roads.index
    port.postMessage({ ready: true })
    port.on('message', (job: Job) => {
      try {
        port.postMessage(withMeasurements(handle(job)))
      } catch (e) {
        port.postMessage({ error: e instanceof Error ? e.stack ?? e.message : String(e) })
      }
    })
  })
  .catch((e: unknown) => {
    port.postMessage({ error: e instanceof Error ? e.stack ?? e.message : String(e) })
  })
