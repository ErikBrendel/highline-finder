import { mkdir, writeFile } from 'node:fs/promises'
import { toUtm33, toWgs84 } from '../shared/geo.js'
import { loadProduct } from './raster.js'
import { packSectors, scanAnchors } from './openness.js'
import { dedupe, findLines, refine } from './lines.js'
import { DEFAULT_AOI, DEFAULT_PARAMS } from './params.js'
import type { AnchorDump, Dataset } from '../shared/types.js'

/**
 * CLI entry point. Writes src/web/public/candidates.json, which is the only artefact the web app
 * needs -- the app is a static viewer over precomputed results and never talks to the pipeline.
 *
 * Override the AOI with: npm run pipeline -- <south> <west> <north> <east>
 */

const OUT = new URL('../web/public/candidates.json', import.meta.url).pathname
const ANCHORS_OUT = new URL('../web/public/anchors.json', import.meta.url).pathname

async function main() {
  const started = Date.now()
  const argv = process.argv.slice(2).map(Number)
  const aoi =
    argv.length === 4 && argv.every((v) => Number.isFinite(v))
      ? { south: argv[0]!, west: argv[1]!, north: argv[2]!, east: argv[3]! }
      : DEFAULT_AOI
  const p = DEFAULT_PARAMS

  const corners = [
    toUtm33(aoi.south, aoi.west),
    toUtm33(aoi.south, aoi.east),
    toUtm33(aoi.north, aoi.west),
    toUtm33(aoi.north, aoi.east),
  ]
  const bbox = {
    minE: Math.min(...corners.map((c) => c[0])),
    maxE: Math.max(...corners.map((c) => c[0])),
    minN: Math.min(...corners.map((c) => c[1])),
    maxN: Math.max(...corners.map((c) => c[1])),
  }
  console.log(
    `AOI ${aoi.south},${aoi.west} .. ${aoi.north},${aoi.east}\n` +
      `    EPSG:25833 E ${bbox.minE.toFixed(0)}..${bbox.maxE.toFixed(0)} ` +
      `N ${bbox.minN.toFixed(0)}..${bbox.maxN.toFixed(0)} ` +
      `(${(bbox.maxE - bbox.minE).toFixed(0)} x ${(bbox.maxN - bbox.minN).toFixed(0)} m)`,
  )

  console.log('\n[1/5] ingest')
  const ground = await loadProduct('dgm', bbox, 1)
  const surface = await loadProduct('bdom', bbox, 1)
  const ext = ground.extent()
  console.log(
    `  ground grid ${ground.w}x${ground.h} @1m, ${ext.valid} valid cells, ` +
      `${ext.min.toFixed(2)}..${ext.max.toFixed(2)} m (relief ${(ext.max - ext.min).toFixed(1)} m)`,
  )
  console.log(`  surface grid ${surface.w}x${surface.h} @1m (bDOM 0.2m, max-downsampled)`)

  console.log('\n[2/5] openness scan')
  const { anchors, scanned } = scanAnchors(ground, p)
  const meanOpen = anchors.length
    ? anchors.reduce((s, a) => s + a.openCount, 0) / anchors.length
    : 0
  console.log(
    `  ${scanned} points scanned @${p.anchorStep}m -> ${anchors.length} anchors kept ` +
      `(${((anchors.length / Math.max(scanned, 1)) * 100).toFixed(1)}%), ` +
      `mean ${meanOpen.toFixed(1)}/${p.sectorCount} open sectors`,
  )

  console.log('\n[3/6] pairing  [4/6] profiles  [5/6] score')
  const r = findLines(anchors, ground, surface, p)
  const pct = (n: number, d: number) => (d ? `${((n / d) * 100).toFixed(2)}%` : 'n/a')
  console.log(`  pairs in length range      ${r.pairsInRange}`)
  console.log(
    `  survived sector test       ${r.pairsSectorPassed}  (${pct(r.pairsSectorPassed, r.pairsInRange)} -- work the prefilter saved)`,
  )
  console.log(
    `  level enough to rig        ${r.pairsLevelEnough}  (${pct(r.pairsLevelEnough, r.pairsSectorPassed)} of those)`,
  )
  console.log(
    `  feasible after profile     ${r.pairsFeasible}  (${pct(r.pairsFeasible, r.pairsLevelEnough)} of those tested)`,
  )
  console.log(`  distinct after dedup       ${r.candidatesAfterDedup}`)

  console.log('\n[6/6] local refinement')
  const ref = refine(r.candidates, ground, surface, p)
  const meanGain = ref.improved ? ref.totalGain / ref.improved : 0
  console.log(
    `  ${ref.improved}/${r.candidates.length} improved from ${ref.evaluations} evaluations, ` +
      `mean +${meanGain.toFixed(2)} score`,
  )
  // Refined anchors can converge on the same optimum, so collapse again before capping.
  const finalCandidates = dedupe(ref.candidates, p.dedupRadius).slice(0, p.maxCandidates)
  console.log(`  ${finalCandidates.length} after re-dedup and cap`)

  const dataset: Dataset = {
    meta: {
      generatedAt: new Date().toISOString(),
      aoi,
      bbox25833: bbox,
      params: p,
      sources: [
        {
          name: 'DGM 1 m (LiDAR terrain model)',
          url: 'https://data.geobasis-bb.de/geobasis/daten/dgm/tif/',
          attribution: 'GeoBasis-DE/LGB, dl-de/by-2.0',
          note: '1 m grid, DHHN2016 heights, bare earth',
        },
        {
          name: 'bDOM 0.2 m (photogrammetric surface model)',
          url: 'https://data.geobasis-bb.de/geobasis/daten/bdom/tif/',
          attribution: 'GeoBasis-DE/LGB, dl-de/by-2.0',
          note: 'includes vegetation and structures; different survey epoch than the DGM',
        },
      ],
      stats: {
        aoiWidth: Math.round(bbox.maxE - bbox.minE),
        aoiHeight: Math.round(bbox.maxN - bbox.minN),
        groundMin: Math.round(ext.min * 100) / 100,
        groundMax: Math.round(ext.max * 100) / 100,
        anchorsScanned: scanned,
        anchorsKept: anchors.length,
        pairsInRange: r.pairsInRange,
        pairsSectorPassed: r.pairsSectorPassed,
        pairsLevelEnough: r.pairsLevelEnough,
        pairsFeasible: r.pairsFeasible,
        candidatesAfterDedup: r.candidatesAfterDedup,
        refinedCount: ref.improved,
        refineMeanGain: Math.round(meanGain * 100) / 100,
        runtimeMs: Date.now() - started,
      },
    },
    candidates: finalCandidates,
  }

  await mkdir(new URL('../web/public/', import.meta.url).pathname, { recursive: true })
  await writeFile(OUT, JSON.stringify(dataset))

  const r6 = (v: number) => Math.round(v * 1e6) / 1e6
  const dump: AnchorDump = {
    sectorCount: p.sectorCount,
    aFrameMin: p.aFrameMin,
    aFrameMax: p.aFrameMax,
    anchorStep: p.anchorStep,
    lat: [],
    lon: [],
    ground: [],
    open: [],
  }
  for (const a of anchors) {
    const { lat, lon } = toWgs84(a.e, a.n)
    dump.lat.push(r6(lat))
    dump.lon.push(r6(lon))
    dump.ground.push(Math.round(a.ground * 10) / 10)
    dump.open.push(packSectors(a.open))
  }
  await writeFile(ANCHORS_OUT, JSON.stringify(dump))
  const anchorKb = (JSON.stringify(dump).length / 1024).toFixed(0)
  const kb = (JSON.stringify(dataset).length / 1024).toFixed(0)
  console.log(
    `\ndone in ${((Date.now() - started) / 1000).toFixed(1)}s -> candidates.json (${kb} KB), ` +
      `anchors.json (${anchorKb} KB, ${anchors.length} points)`,
  )

  if (finalCandidates.length) {
    console.log('\ntop 10:')
    console.log('  score  len    exposure  clear  offlevel  canopyMin  blocked')
    for (const c of finalCandidates.slice(0, 10)) {
      console.log(
        `  ${c.score.toFixed(1).padStart(5)}  ${c.length.toFixed(0).padStart(4)}m  ` +
          `${c.exposure.toFixed(1).padStart(7)}m  ${c.clearanceMin.toFixed(1).padStart(5)}m  ` +
          `${c.offLevel.toFixed(1).padStart(7)}m  ${c.canopyClearanceMin.toFixed(1).padStart(8)}m  ` +
          `${(c.canopyBlockedFraction * 100).toFixed(0).padStart(6)}%`,
      )
    }
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
