import { readdir, stat } from 'node:fs/promises'
import { loadCoarse } from '../pipeline/coarse.js'
import { toUtm33 } from '../shared/geo.js'
import { DEFAULT_PARAMS } from '../pipeline/params.js'

/**
 * How long a statewide coarse pass would take, measured rather than guessed.
 *
 * The coarse pre-pass decides which 1 km tiles are worth fetching at full resolution, and running
 * it over all of Brandenburg is the one measurement the whole superchunk plan waits on: whether the
 * surface download is 43 GB or 287 GB turns on what fraction of the state it rejects. It needs no
 * new pipeline code -- `loadCoarse` already fetches and caches 8 km chunks -- but it is a few
 * hundred requests to a public survey office, so this runs it under a deadline and extrapolates.
 *
 * Every chunk it does fetch is cached exactly as a real run would cache it, so this is not a
 * throwaway: running it repeatedly fills the cache, and a later full pass reads what is already
 * there. Chunks are visited in a strided order rather than in rows, so a partial run samples the
 * whole state instead of one corner -- the bbox is a rectangle around a state that is not one, and
 * a corner-first pass would measure mostly empty coverage and report a flattering number.
 *
 * Usage: npx tsx src/tools/coarseProbe.ts [seconds] [lanes]
 */

/** Brandenburg and Berlin, generously boxed. The WCS answers with NaN outside its coverage. */
const STATE = { south: 51.35, west: 11.26, north: 53.57, east: 14.78 }

/**
 * Mirrors `CHUNK` in coarse.ts, which does not export it.
 *
 * Duplicated rather than exported because coarse.ts is one of the files the region cache
 * fingerprints, and touching it would invalidate all seven regions for a measurement that changes
 * no output. If a statewide pass becomes a real pipeline stage the enumeration belongs there.
 */
const CHUNK = 8192
const CACHE_DIR = new URL('../../data/cache/', import.meta.url).pathname

const [seconds, lanes] = [Number(process.argv[2] ?? 60), Number(process.argv[3] ?? 4)]

function stateBounds() {
  const corners = [
    toUtm33(STATE.south, STATE.west),
    toUtm33(STATE.south, STATE.east),
    toUtm33(STATE.north, STATE.west),
    toUtm33(STATE.north, STATE.east),
  ]
  return {
    minE: Math.min(...corners.map((c) => c[0])),
    maxE: Math.max(...corners.map((c) => c[0])),
    minN: Math.min(...corners.map((c) => c[1])),
    maxN: Math.max(...corners.map((c) => c[1])),
  }
}

/**
 * The chunk boxes, in an order that samples the whole state early.
 *
 * A stride coprime with the count walks every chunk exactly once while jumping across the grid, so
 * the first fifty are spread out. Deterministic, so a second run resumes into the gaps rather than
 * re-drawing a different sample.
 */
function chunkBoxes(): { minE: number; minN: number; maxE: number; maxN: number }[] {
  const b = stateBounds()
  const e0 = Math.floor(b.minE / CHUNK) * CHUNK
  const n0 = Math.floor(b.minN / CHUNK) * CHUNK
  const nx = Math.ceil((b.maxE - e0) / CHUNK)
  const ny = Math.ceil((b.maxN - n0) / CHUNK)

  // Any stride coprime with the count visits every chunk exactly once; primes that happen to
  // divide it would revisit a few and miss the rest.
  const total = nx * ny
  const stride = [97, 89, 83, 79].find((s) => total % s !== 0)!
  const all = []
  for (let i = 0; i < total; i++) {
    const at = (i * stride) % total
    const e = e0 + (at % nx) * CHUNK
    const n = n0 + Math.floor(at / nx) * CHUNK
    all.push({ minE: e, minN: n, maxE: e + CHUNK, maxN: n + CHUNK })
  }
  return all
}

/** What the coarse cache holds now, so the probe can report what it added rather than what exists. */
async function cacheState(res: number) {
  const names = (await readdir(CACHE_DIR)).filter((f) => f.startsWith(`coarse${res}_`))
  const sizes = await Promise.all(names.map((f) => stat(CACHE_DIR + f).then((s) => s.size)))
  return { count: names.length, bytes: sizes.reduce((s, n) => s + n, 0) }
}

async function main() {
  const res = DEFAULT_PARAMS.maskRes
  const boxes = chunkBoxes()
  const before = await cacheState(res)
  const deadline = Date.now() + seconds * 1000
  const started = Date.now()

  console.log(
    `${boxes.length} chunks of ${CHUNK} m at ${res} m over Brandenburg + Berlin ` +
      `(${((boxes.length * CHUNK * CHUNK) / 1e6).toLocaleString()} km2 of bbox)\n` +
      `  ${before.count} already cached, ${(before.bytes / 1e6).toFixed(0)} MB\n` +
      `  ${lanes} lanes, stopping after ${seconds}s\n`,
  )

  let next = 0
  let done = 0
  let withData = 0
  let failed = 0
  const take = async () => {
    while (next < boxes.length && Date.now() < deadline) {
      const box = boxes[next++]!
      try {
        const grid = await loadCoarse(box, res)
        done++
        if (grid.data.some((v) => !Number.isNaN(v))) withData++
      } catch (e) {
        failed++
        console.log(`  FAILED ${box.minE}-${box.minN}: ${e instanceof Error ? e.message : e}`)
      }
    }
  }
  await Promise.all(Array.from({ length: lanes }, take))

  const elapsed = (Date.now() - started) / 1000
  const after = await cacheState(res)
  const fetched = after.count - before.count
  const perChunk = fetched ? elapsed / fetched : 0
  const left = boxes.length - after.count

  console.log(
    `\n${done} chunks in ${elapsed.toFixed(0)}s: ${fetched} fetched, ` +
      `${done - fetched} already cached, ${failed} failed\n` +
      `  ${withData}/${done} carry any coverage at all\n` +
      `  ${((after.bytes - before.bytes) / 1e6).toFixed(1)} MB added, ` +
      `${(after.bytes / 1e6).toFixed(0)} MB total, ` +
      `${after.count}/${boxes.length} chunks cached`,
  )
  if (fetched) {
    console.log(
      `  ${perChunk.toFixed(1)}s per chunk at ${lanes} lanes -> ` +
        `${((left * perChunk) / 60).toFixed(0)} min for the remaining ${left}, ` +
        `~${((boxes.length * (after.bytes - before.bytes)) / fetched / 1e6).toFixed(0)} MB in total`,
    )
  }
}

main().catch((e: unknown) => {
  console.error(e)
  process.exit(1)
})
