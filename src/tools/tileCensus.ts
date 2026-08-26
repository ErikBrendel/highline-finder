import { dropField, loadCoarse, tilesWorthLoading } from '../pipeline/coarse.js'
import { toUtm33 } from '../shared/geo.js'
import { DEFAULT_PARAMS } from '../pipeline/params.js'

/**
 * How many 1 km tiles a statewide run would actually fetch.
 *
 * The number every size estimate in the roadmap rests on. The surface model is ~33 MB per tile, so
 * whether Brandenburg is a 43 GB download or a 287 GB one is decided entirely by what fraction of
 * it the coarse pre-pass throws away before a single full-resolution tile is asked for. Scaling one
 * region linearly is the wrong model precisely because the pre-pass is not linear -- it rejects flat
 * ground, and most of the state is flat.
 *
 * Reads the coarse cache that `coarseProbe.ts` fills; fetches nothing that is already there.
 *
 * Windowed rather than done in one pass: the state at 16 m is a 260-million-cell grid, and a
 * gigabyte of float per layer is not worth holding to answer a counting question. Windows are
 * aligned to the 1 km tile grid rather than to the 8 km coarse chunks, because the two do not
 * divide each other -- 8192 is not a multiple of 1000 -- and a window boundary through the middle
 * of a tile would count that tile's cells twice and qualify it on half its ground.
 *
 * Each window carries a 2 km halo and counts only its core. One kilometre of that is because a
 * passing cell dilates `maxLength` outwards, so a cell just outside the core can pull a core tile
 * in; the second kilometre is so the halo tiles' own drop values are computed on complete ground
 * rather than clamped at the window edge.
 *
 * Usage: npx tsx src/tools/tileCensus.ts [seconds]
 */

/** Matches coarseProbe.ts. The northernmost chunk row has no coverage and answers HTTP 400. */
const STATE = { south: 51.35, west: 11.26, north: 53.57, east: 14.78 }
const NO_COVERAGE_ABOVE = 5939200

/** Window core, in 1 km tiles a side, and the halo around it. */
const CORE = 32
const HALO = 2

/** Tiles to a superchunk side: the 8x8 block of source tiles a recompute would own. */
const CHUNK_TILES = 8

const seconds = Number(process.argv[2] ?? 120)

function stateBounds() {
  const corners = [
    toUtm33(STATE.south, STATE.west),
    toUtm33(STATE.south, STATE.east),
    toUtm33(STATE.north, STATE.west),
    toUtm33(STATE.north, STATE.east),
  ]
  return {
    minE: Math.floor(Math.min(...corners.map((c) => c[0])) / 1000) * 1000,
    maxE: Math.ceil(Math.max(...corners.map((c) => c[0])) / 1000) * 1000,
    minN: Math.floor(Math.min(...corners.map((c) => c[1])) / 1000) * 1000,
    maxN: Math.min(NO_COVERAGE_ABOVE, Math.ceil(Math.max(...corners.map((c) => c[1])) / 1000) * 1000),
  }
}

async function main() {
  const p = DEFAULT_PARAMS
  const b = stateBounds()
  const deadline = Date.now() + seconds * 1000
  const started = Date.now()

  const nx = Math.ceil((b.maxE - b.minE) / (CORE * 1000))
  const ny = Math.ceil((b.maxN - b.minN) / (CORE * 1000))
  console.log(
    `${nx} x ${ny} = ${nx * ny} windows of ${CORE} km over ` +
      `E ${b.minE}..${b.maxE} N ${b.minN}..${b.maxN}, stopping after ${seconds}s\n`,
  )

  /** Tiles with any terrain under them at all, which is the state's real extent. */
  const covered = new Set<string>()
  const kept = new Set<string>()
  let windows = 0
  let skipped = 0

  outer: for (let wy = 0; wy < ny; wy++) {
    for (let wx = 0; wx < nx; wx++) {
      if (Date.now() > deadline) break outer
      const e0 = b.minE + wx * CORE * 1000
      const n0 = b.minN + wy * CORE * 1000
      const core = { minE: e0, minN: n0, maxE: e0 + CORE * 1000, maxN: n0 + CORE * 1000 }
      const grown = {
        minE: core.minE - HALO * 1000,
        minN: core.minN - HALO * 1000,
        maxE: core.maxE + HALO * 1000,
        maxN: Math.min(NO_COVERAGE_ABOVE, core.maxN + HALO * 1000),
      }
      let coarse
      try {
        coarse = await loadCoarse(grown, p.maskRes)
      } catch {
        // A window reaching past the survey's coverage. Counted, not guessed at.
        skipped++
        continue
      }
      windows++

      // Which core tiles have data, before any rule is applied.
      for (let te = core.minE / 1000; te < core.maxE / 1000; te++) {
        for (let tn = core.minN / 1000; tn < core.maxN / 1000; tn++) {
          const v = coarse.nearest(te * 1000 + 500, tn * 1000 + 500)
          if (!Number.isNaN(v)) covered.add(`33${te}-${tn}`)
        }
      }

      const drop = dropField(coarse, p.maskRadius)
      for (const id of tilesWorthLoading(drop, p.maskMinDrop, p.maskMinCoverage, p.maxLength)) {
        const [te, tn] = id.slice(2).split('-').map(Number) as [number, number]
        const inCore =
          te >= core.minE / 1000 && te < core.maxE / 1000 &&
          tn >= core.minN / 1000 && tn < core.maxN / 1000
        if (inCore) kept.add(id)
      }
      process.stdout.write(
        `  window ${windows}/${nx * ny} at ${e0}-${n0}: ` +
          `${covered.size} covered, ${kept.size} kept so far\n`,
      )
    }
  }

  const chunkOf = (id: string) => {
    const [te, tn] = id.slice(2).split('-').map(Number) as [number, number]
    return `${Math.floor(te / CHUNK_TILES)}_${Math.floor(tn / CHUNK_TILES)}`
  }
  const chunksCovered = new Set([...covered].map(chunkOf))
  const chunksKept = new Set([...kept].map(chunkOf))
  // Only the kept tiles need the surface model, and they are what a chunk's work is made of.
  const keptPerChunk = kept.size / Math.max(1, chunksKept.size)
  const pct = (n: number, d: number) => (d ? `${((n / d) * 100).toFixed(1)}%` : 'n/a')

  console.log(
    `\n${windows} of ${nx * ny} windows in ${((Date.now() - started) / 1000).toFixed(0)}s` +
      `${skipped ? `, ${skipped} skipped for want of coverage` : ''}\n` +
      `\n  ${covered.size.toLocaleString()} tiles carry terrain` +
      `\n  ${kept.size.toLocaleString()} worth loading (${pct(kept.size, covered.size)})` +
      `\n\n  ${chunksCovered.size} superchunks of ${CHUNK_TILES}x${CHUNK_TILES} km hold any terrain` +
      `\n  ${chunksKept.size} hold a tile worth loading (${pct(chunksKept.size, chunksCovered.size)})` +
      `\n  ${keptPerChunk.toFixed(1)} of ${CHUNK_TILES * CHUNK_TILES} tiles per working superchunk` +
      `\n\n  surface model: ~${Math.round((kept.size * 33) / 1000)} GB if every kept tile carries a ` +
      `line, against ~${Math.round((covered.size * 33) / 1000)} GB for the lot` +
      `\n  terrain model: ~${Math.round((kept.size * 1.4) / 1000)} GB`,
  )
  if (windows < nx * ny) {
    console.log(
      `\n  PARTIAL: ${nx * ny - windows - skipped} windows unvisited, so every count above is a ` +
        `floor, not a total.`,
    )
  }
}

main().catch((e: unknown) => {
  console.error(e)
  process.exit(1)
})
