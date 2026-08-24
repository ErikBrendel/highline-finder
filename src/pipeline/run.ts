import { mkdir, writeFile } from 'node:fs/promises'
import { tilesForBounds, toWgs84 } from '../shared/geo.js'
import { corridorTiles, loadProduct } from './raster.js'
import { aggregateDrops, dropField, loadCoarse, tilesWorthLoading } from './coarse.js'
import { packSectors, scanAnchors, type Anchor } from './openness.js'
import { dedupe, evaluatePairs, refine, terrainPairs } from './lines.js'
import { clusterEndpoints, isWalkable, type Endpoint } from './hotspots.js'
import { DEFAULT_AOIS, DEFAULT_PARAMS } from './params.js'
import { contains, workAreas, type WorkArea } from './regions.js'
import type {
  Aoi,
  AnchorDump,
  Candidate,
  Dataset,
  Hotspots,
  MaskCells,
  Params,
  Region,
} from '../shared/types.js'

/**
 * CLI entry point. Writes src/web/public/candidates.json, which is the only artefact the web app
 * needs -- the app is a static viewer over precomputed results and never talks to the pipeline.
 *
 * Each work area is rasterised, searched and refined on its own, and the results are pooled and
 * deduped once at the end. Grids are the expensive thing here -- an 18 km2 area is ~75 MB per
 * layer -- so they are scoped to one iteration and dropped before the next area loads.
 *
 * Override the AOIs with: npm run pipeline -- <south> <west> <north> <east> [<south> ... ]
 */

const OUT = new URL('../web/public/candidates.json', import.meta.url).pathname
const ANCHORS_OUT = new URL('../web/public/anchors.json', import.meta.url).pathname
const HOTSPOTS_OUT = new URL('../web/public/hotspots.json', import.meta.url).pathname
const MASK_OUT = new URL('../web/public/mask.json', import.meta.url).pathname

/**
 * Radius the hotspot layer collapses line endpoints over. Ten times the candidate `dedupRadius`:
 * this answers "is this valley worth a trip", where two spots 60 m apart are the same answer.
 */
const HOTSPOT_RADIUS = 50

interface AreaResult {
  region: Region
  /** Anchors inside the AOIs, for the debug dump. */
  anchors: Anchor[]
  /** The coarse pre-pass, aggregated for the map overlay. */
  mask: MaskCells
  /** Anchors of every feasible line in this area, for the hotspot layer. */
  endpoints: Endpoint[]
  refined: {
    candidates: Candidate[]
    improved: number
    totalGain: number
    find: {
      pairsInRange: number
      pairsSectorPassed: number
      pairsLevelEnough: number
      pairsFeasible: number
      candidatesAfterDedup: number
    }
  }
}

function exportMask(drop: import('../shared/grid.js').Grid, p: Params): MaskCells {
  const cells = aggregateDrops(drop, p.maskExportRes)
  const out: MaskCells = {
    res: p.maskExportRes,
    sourceRes: p.maskRes,
    minDrop: p.maskMinDrop,
    lat: [],
    lon: [],
    drop: [],
  }
  const r6 = (v: number) => Math.round(v * 1e6) / 1e6
  for (const c of cells) {
    const { lat, lon } = toWgs84(c.e, c.n)
    out.lat.push(r6(lat))
    out.lon.push(r6(lon))
    out.drop.push(c.drop)
  }
  return out
}

const pctOf = (n: number, d: number) => (d ? `${((n / d) * 100).toFixed(1)}%` : 'n/a')
const pct2 = (n: number, d: number) => (d ? `${((n / d) * 100).toFixed(2)}%` : 'n/a')

async function searchArea(area: WorkArea, p: Params, label: string): Promise<AreaResult> {
  const { bbox, boxes } = area

  console.log(`[1/6] coarse pre-pass (${label})`)
  const coarse = await loadCoarse(bbox, p.maskRes)
  const drop = dropField(coarse, p.maskRadius)
  const allTiles = tilesForBounds(bbox.minE, bbox.minN, bbox.maxE, bbox.maxN)
  const wantedTiles = p.maskMinDrop > 0 ? tilesWorthLoading(drop, p.maskMinDrop) : null
  const groundTiles = wantedTiles ? allTiles.filter((t) => wantedTiles.has(t)) : allTiles
  const passing = [...drop.data].filter((v) => !Number.isNaN(v) && v >= p.maskMinDrop).length
  const valid = [...drop.data].filter((v) => !Number.isNaN(v)).length
  console.log(
    `  ${drop.w}x${drop.h} @${p.maskRes}m, ${((100 * passing) / Math.max(1, valid)).toFixed(1)}% of ` +
      `cells fall >=${p.maskMinDrop}m within ${p.maskRadius}m`,
  )
  console.log(`  ${groundTiles.length} of ${allTiles.length} terrain tiles worth loading`)

  console.log(`[2/6] terrain (${label})`)
  const ground = await loadProduct('dgm', bbox, 1, wantedTiles ?? undefined)
  const ext = ground.extent()
  console.log(
    `  ground grid ${ground.w}x${ground.h} @1m, ${ext.valid} valid cells, ` +
      `${ext.min.toFixed(2)}..${ext.max.toFixed(2)} m (relief ${(ext.max - ext.min).toFixed(1)} m)`,
  )

  console.log('[3/6] openness scan')
  const scan = scanAnchors(ground, p)
  // Ground merged in between two AOIs is read for profiles but never searched.
  const anchors = scan.anchors.filter((a) => boxes.some((b) => contains(b, a.e, a.n)))
  const meanOpen = anchors.length
    ? anchors.reduce((s, a) => s + a.openCount, 0) / anchors.length
    : 0
  console.log(`  ${scan.scanned} points scanned @${p.anchorStep}m`)
  console.log(
    `  drop within ${p.dropSearchRadius}m       ${scan.passedDropTest}  ` +
      `(${pctOf(scan.passedDropTest, scan.scanned)})`,
  )
  console.log(
    `  any direction falls away  ${scan.anchors.length}  ` +
      `(${pctOf(scan.anchors.length, scan.passedDropTest)} of those), ` +
      `mean ${meanOpen.toFixed(1)}/${p.sectorCount} open sectors`,
  )
  if (anchors.length !== scan.anchors.length) {
    console.log(`  inside an AOI             ${anchors.length}`)
  }

  console.log('[4/6] pairing and terrain test')
  const found = terrainPairs(anchors, ground, p)

  /**
   * The surface model is fetched here rather than alongside the terrain, and only for the tiles the
   * surviving corridors cross. It is 33 MB per square kilometre against the terrain model's 1.4 MB,
   * and canopy is never a hard constraint -- so paying for it over the whole area of interest buys
   * canopy figures for ground no line ever crosses.
   */
  console.log('[5/6] surface, for the corridors that survived')
  const wanted = corridorTiles(found.pairs, p.refineRadius + p.profileStep)
  const all = tilesForBounds(bbox.minE, bbox.minN, bbox.maxE, bbox.maxN)
  const used = all.filter((t) => wanted.has(t))
  console.log(
    `  ${used.length} of ${all.length} tiles carry a line ` +
      `(~${used.length * 33} MB instead of ~${all.length * 33} MB)`,
  )
  const surface = await loadProduct('bdom', bbox, 1, wanted)
  console.log(`  surface grid ${surface.w}x${surface.h} @1m (bDOM 0.2m, max-downsampled)`)

  console.log('[6/6] profiles, score and refinement')
  const r = evaluatePairs(found, ground, surface, p)
  console.log(`  pairs in length range      ${r.pairsInRange}`)
  console.log(
    `  survived sector test       ${r.pairsSectorPassed}  ` +
      `(${pct2(r.pairsSectorPassed, r.pairsInRange)} -- work the prefilter saved)`,
  )
  console.log(
    `  level enough to rig        ${r.pairsLevelEnough}  ` +
      `(${pct2(r.pairsLevelEnough, r.pairsSectorPassed)} of those)`,
  )
  console.log(
    `  feasible after profile     ${r.pairsFeasible}  ` +
      `(${pct2(r.pairsFeasible, r.pairsLevelEnough)} of those tested)`,
  )
  console.log(`  distinct after dedup       ${r.candidatesAfterDedup}`)

  const ref = refine(r.candidates, ground, surface, p)
  const gain = ref.improved ? ref.totalGain / ref.improved : 0
  console.log(
    `  ${ref.improved}/${r.candidates.length} improved from ${ref.evaluations} evaluations, ` +
      `mean +${gain.toFixed(2)} score`,
  )

  return {
    region: {
      aois: area.aois,
      bbox25833: bbox,
      width: Math.round(bbox.maxE - bbox.minE),
      height: Math.round(bbox.maxN - bbox.minN),
      groundMin: Math.round(ext.min * 100) / 100,
      groundMax: Math.round(ext.max * 100) / 100,
      anchorsScanned: scan.scanned,
      anchorsKept: anchors.length,
    },
    anchors,
    mask: exportMask(drop, p),
    endpoints: r.endpoints,
    refined: {
      candidates: ref.candidates,
      improved: ref.improved,
      totalGain: ref.totalGain,
      find: {
        pairsInRange: r.pairsInRange,
        pairsSectorPassed: r.pairsSectorPassed,
        pairsLevelEnough: r.pairsLevelEnough,
        pairsFeasible: r.pairsFeasible,
        candidatesAfterDedup: r.candidatesAfterDedup,
      },
    },
  }
}

function aoisFromArgv(argv: number[]): Aoi[] | null {
  if (!argv.length || argv.length % 4 !== 0 || !argv.every((v) => Number.isFinite(v))) return null
  const out: Aoi[] = []
  for (let i = 0; i < argv.length; i += 4) {
    out.push({ south: argv[i]!, west: argv[i + 1]!, north: argv[i + 2]!, east: argv[i + 3]! })
  }
  return out
}

async function main() {
  const started = Date.now()
  const p = DEFAULT_PARAMS
  const aois = aoisFromArgv(process.argv.slice(2).map(Number)) ?? DEFAULT_AOIS
  const areas = workAreas(aois, p.maxLength)

  console.log(`${aois.length} AOI(s) in ${areas.length} region(s):`)
  for (const area of areas) {
    const { bbox } = area
    console.log(
      `  ${area.aois.map((a) => `${a.south},${a.west}..${a.north},${a.east}`).join(' + ')}\n` +
        `    EPSG:25833 E ${bbox.minE.toFixed(0)}..${bbox.maxE.toFixed(0)} ` +
        `N ${bbox.minN.toFixed(0)}..${bbox.maxN.toFixed(0)} ` +
        `(${(bbox.maxE - bbox.minE).toFixed(0)} x ${(bbox.maxN - bbox.minN).toFixed(0)} m, ` +
        `${(((bbox.maxE - bbox.minE) * (bbox.maxN - bbox.minN)) / 1e6).toFixed(1)} km2)`,
    )
  }

  const regions: Region[] = []
  const dumpAnchors: Anchor[] = []
  const refinedAll: Candidate[] = []
  const endpoints: Endpoint[] = []
  const maskCells: MaskCells[] = []
  const totals = {
    anchorsScanned: 0,
    anchorsKept: 0,
    pairsInRange: 0,
    pairsSectorPassed: 0,
    pairsLevelEnough: 0,
    pairsFeasible: 0,
    candidatesAfterDedup: 0,
    refinedCount: 0,
    refineGain: 0,
  }

  for (const [index, area] of areas.entries()) {
    const label = `region ${index + 1}/${areas.length}`
    console.log(`\n=== ${label} ===`)
    const found = await searchArea(area, p, label)
    const { anchors, region, refined } = found
    regions.push(region)
    // Appended one at a time rather than spread: a 141 km2 area produces 3.2 million endpoints,
    // and passing those as arguments exceeds the call stack.
    for (const a of anchors) dumpAnchors.push(a)
    for (const e of found.endpoints) endpoints.push(e)
    for (const c of refined.candidates) refinedAll.push(c)
    maskCells.push(found.mask)
    totals.anchorsScanned += region.anchorsScanned
    totals.anchorsKept += region.anchorsKept
    totals.pairsInRange += refined.find.pairsInRange
    totals.pairsSectorPassed += refined.find.pairsSectorPassed
    totals.pairsLevelEnough += refined.find.pairsLevelEnough
    totals.pairsFeasible += refined.find.pairsFeasible
    totals.candidatesAfterDedup += refined.find.candidatesAfterDedup
    totals.refinedCount += refined.improved
    totals.refineGain += refined.totalGain
  }

  // One pass over the pooled results: overlapping AOIs find the same line twice, and refinement
  // can walk two neighbours onto the same optimum. Nothing is capped after that -- every distinct
  // line found is stored.
  const deduped = dedupe(refinedAll, p.dedupRadius)
  const finalCandidates = p.storeProfiles
    ? deduped
    : deduped.map(({ profile: _profile, ...rest }) => rest)
  const meanGain = totals.refinedCount ? totals.refineGain / totals.refinedCount : 0
  console.log(
    `\npooled ${refinedAll.length} from ${areas.length} region(s) -> ` +
      `${finalCandidates.length} distinct` +
      (p.storeProfiles ? ' (with profiles)' : ' (profiles fetched on demand)'),
  )

  const dataset: Dataset = {
    meta: {
      generatedAt: new Date().toISOString(),
      regions,
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
        anchorsScanned: totals.anchorsScanned,
        anchorsKept: totals.anchorsKept,
        pairsInRange: totals.pairsInRange,
        pairsSectorPassed: totals.pairsSectorPassed,
        pairsLevelEnough: totals.pairsLevelEnough,
        pairsFeasible: totals.pairsFeasible,
        candidatesAfterDedup: totals.candidatesAfterDedup,
        refinedCount: totals.refinedCount,
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
    nearProbeLength: p.nearProbeLength,
    minDropDepth: p.minDropDepth,
    dropSearchRadius: p.dropSearchRadius,
    lat: [],
    lon: [],
    ground: [],
    drop: [],
    open: [],
  }
  for (const a of dumpAnchors) {
    const { lat, lon } = toWgs84(a.e, a.n)
    dump.lat.push(r6(lat))
    dump.lon.push(r6(lon))
    dump.ground.push(Math.round(a.ground * 10) / 10)
    dump.drop.push(Math.round(a.dropDepth * 10) / 10)
    dump.open.push(packSectors(a.open))
  }
  await writeFile(ANCHORS_OUT, JSON.stringify(dump))

  const mask: MaskCells = {
    res: p.maskExportRes,
    sourceRes: p.maskRes,
    minDrop: p.maskMinDrop,
    lat: maskCells.flatMap((m) => m.lat),
    lon: maskCells.flatMap((m) => m.lon),
    drop: maskCells.flatMap((m) => m.drop),
  }
  await writeFile(MASK_OUT, JSON.stringify(mask))
  const skipped = mask.drop.filter((d) => d < p.maskMinDrop).length
  console.log(
    `mask: ${mask.drop.length} cells @${p.maskExportRes}m, ${skipped} below the ${p.maskMinDrop}m ` +
      `threshold (${((100 * skipped) / Math.max(1, mask.drop.length)).toFixed(0)}% of the area) ` +
      `(${(JSON.stringify(mask).length / 1024).toFixed(0)} KB)`,
  )

  // Clustered across all regions at once, so a spot straddling two of them is one spot.
  const walkable = endpoints.filter(isWalkable)
  const spots = clusterEndpoints(walkable, HOTSPOT_RADIUS)
  spots.sort((a, b) => b.count - a.count)
  const hotspots: Hotspots = {
    radius: HOTSPOT_RADIUS,
    lat: [],
    lon: [],
    count: [],
    score: [],
  }
  for (const s of spots) {
    const { lat, lon } = toWgs84(s.e, s.n)
    hotspots.lat.push(r6(lat))
    hotspots.lon.push(r6(lon))
    hotspots.count.push(s.count)
    hotspots.score.push(Math.round(s.score * 10) / 10)
  }
  await writeFile(HOTSPOTS_OUT, JSON.stringify(hotspots))
  const hotKb = (JSON.stringify(hotspots).length / 1024).toFixed(0)
  console.log(
    `hotspots: ${endpoints.length} feasible endpoints, ${walkable.length} clear of canopy ` +
      `-> ${spots.length} spots @${HOTSPOT_RADIUS}m (${hotKb} KB), ` +
      `busiest ${spots[0]?.count ?? 0} endpoints`,
  )
  const anchorKb = (JSON.stringify(dump).length / 1024).toFixed(0)
  const kb = (JSON.stringify(dataset).length / 1024).toFixed(0)
  console.log(
    `\ndone in ${((Date.now() - started) / 1000).toFixed(1)}s -> candidates.json (${kb} KB), ` +
      `anchors.json (${anchorKb} KB, ${dumpAnchors.length} points)`,
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
