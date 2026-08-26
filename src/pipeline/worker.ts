import { parentPort, workerData } from 'node:worker_threads'
import { Grid } from '../shared/grid.js'
import { RoofMask } from '../shared/anchoring.js'
import { WaterMask } from '../shared/water.js'
import { enablePhases, takeCounts, takePhases } from '../shared/phases.js'
import { loadRoads } from './roads.js'
import { bucketAnchors, pairsOf, refine, scorePairs, terrainPairs, type AnchorIndex } from './lines.js'
import { readAnchors, type AnchorTable, type Done, type Job, type Scene } from './pool.js'
import type { Anchor } from './openness.js'
import type { Scene as SceneRefs } from '../shared/scene.js'

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

const scene = workerData as Scene
const port = parentPort!

const ground = Grid.adopt(scene.ground)
/**
 * The surface model arrives after the pool is running, because which tiles of it are worth fetching
 * is decided by the pair search the pool has yet to do. Until then it stands in as the terrain,
 * which is what the pair search reads anyway.
 */
let surfaceRef = ground
const refs: SceneRefs = {
  roofs: scene.roofs ? RoofMask.adopt(scene.roofs) : undefined,
  water: scene.water ? WaterMask.adopt(scene.water) : undefined,
}

enablePhases()

/** Phase and tally totals accrued while running one job, so the run report still sees inside. */
function withMeasurements(value: unknown): Done {
  return { value, phases: [...takePhases()], counts: [...takeCounts()] }
}

/**
 * The anchor table, unpacked once per region rather than once per job.
 *
 * A worker takes several chunks of the same region, and rebuilding three hundred thousand anchor
 * objects for each of them is most of what the pair search would otherwise spend its time
 * allocating. Keyed on the buffer, so a new region replaces it rather than being served the old one.
 */
let unpacked: { from: SharedArrayBuffer; anchors: Anchor[]; index: AnchorIndex } | null = null

function anchorsOf(table: AnchorTable): { anchors: Anchor[]; index: AnchorIndex } {
  if (unpacked?.from !== table.fields) {
    const anchors = readAnchors(table)
    unpacked = { from: table.fields, anchors, index: bucketAnchors(anchors, scene.params.maxLength) }
  }
  return unpacked
}

function handle(job: Job): unknown {
  if (job.kind === 'pairs') {
    const { anchors, index } = anchorsOf(job.anchors)
    const found = terrainPairs(anchors, ground, scene.params, refs, job.from, job.to, index)
    // Copied out of the growable buffer so the message carries the pairs and nothing else.
    return { ...found, pairs: Int32Array.from(found.pairs) }
  }
  if (job.kind === 'score') {
    const { anchors } = anchorsOf(job.anchors)
    const pairs = new Int32Array(job.pairs, 0, job.total * 2)
    return scorePairs(pairsOf(anchors, pairs, job.from, job.to), ground, surfaceRef, scene.params, refs)
  }
  if (job.kind === 'refine') return refine(job.candidates, ground, surfaceRef, scene.params, refs)
  surfaceRef = Grid.adopt(job.grid)
  return { attached: true }
}

loadRoads(scene.bbox)
  .then((roads) => {
    refs.roads = roads.index
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
