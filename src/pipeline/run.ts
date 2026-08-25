import { mkdir, writeFile } from 'node:fs/promises'
import { tilesForBounds, toWgs84 } from '../shared/geo.js'
import { corridorTiles, loadProduct } from './raster.js'
import { raiseOntoBuildings } from './buildings.js'
import { loadRoads } from './roads.js'
import { readRegion, regionKey, writeRegion } from './regionCache.js'
import { aggregateDrops, dropField, loadCoarse, tilesWorthLoading } from './coarse.js'
import { packSectors, scanAnchors } from './openness.js'
import { dedupe, evaluatePairs, locate, refine, terrainPairs } from './lines.js'
import { clusterEndpoints, isWalkable, type Endpoint } from './hotspots.js'
import { DEFAULT_AOIS, DEFAULT_PARAMS } from './params.js'
import { contains, workAreas, type WorkArea } from './regions.js'
import { LINE_KINDS } from '../shared/types.js'
import type {
  Aoi,
  AnchorDump,
  ByKind,
  Candidate,
  Dataset,
  HotspotArrays,
  Hotspots,
  MaskCells,
  Params,
  Region,
  TileUsage,
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
const TILES_OUT = new URL('../web/public/tiles.json', import.meta.url).pathname

/**
 * Radius the hotspot layer collapses line endpoints over. Ten times the candidate `dedupRadius`:
 * this answers "is this valley worth a trip", where two spots 60 m apart are the same answer.
 */
const HOTSPOT_RADIUS = 50

/**
 * Everything one region contributes, in a form that survives a round trip through JSON.
 *
 * Serialisable on purpose: regions are independent, so a region whose inputs have not changed is
 * read back from disk instead of recomputed. Endpoints are parallel arrays rather than objects
 * because there are millions of them and the key names would otherwise be most of the file.
 */
interface AreaResult {
  region: Region
  /** The coarse pre-pass, aggregated for the map overlay. */
  mask: MaskCells
  /** What was actually fetched per source tile, and what it yielded. */
  tiles: TileUsage
  /** Anchors inside the AOIs, already in the shape the debug dump wants. */
  anchors: { lat: number[]; lon: number[]; ground: number[]; drop: number[]; open: string[] }
  /**
   * Anchors of every feasible line, for the hotspot layer. `kind` is an index into LINE_KINDS
   * rather than the word: there are millions of these, and the word is most of the record.
   */
  endpoints: { e: number[]; n: number[]; kind: number[]; score: number[]; blocked: number[] }
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

/** One entry per kind, built fresh so the three never share an array. */
function byKind<T>(make: () => T): ByKind<T> {
  return Object.fromEntries(LINE_KINDS.map((k) => [k, make()])) as ByKind<T>
}

const emptyHotspots = (): HotspotArrays => ({ lat: [], lon: [], count: [], score: [] })

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

/**
 * Times a stage and prints how long it took.
 *
 * Every stage of this pipeline has been the bottleneck at some point -- dedup once took most of an
 * hour while looking like a footnote in the log -- so where the time goes is worth stating rather
 * than guessing at.
 */
async function stage<T>(label: string, run: () => T | Promise<T>): Promise<T> {
  const started = Date.now()
  const out = await run()
  const seconds = (Date.now() - started) / 1000
  // Summed across regions: which stage is expensive matters more than which region was.
  const key = label.replace(/ \(region[^)]*\)/, '')
  timings.set(key, (timings.get(key) ?? 0) + seconds)
  console.log(`${label}  [${seconds.toFixed(1)}s]`)
  return out
}

const timings = new Map<string, number>()

const pctOf = (n: number, d: number) => (d ? `${((n / d) * 100).toFixed(1)}%` : 'n/a')
const pct2 = (n: number, d: number) => (d ? `${((n / d) * 100).toFixed(2)}%` : 'n/a')

async function searchArea(area: WorkArea, p: Params, label: string): Promise<AreaResult> {
  const { bbox, boxes } = area

  const drop = await stage(`[1/6] coarse pre-pass (${label})`, async () =>
    dropField(await loadCoarse(bbox, p.maskRes), p.maskRadius),
  )
  const allTiles = tilesForBounds(bbox.minE, bbox.minN, bbox.maxE, bbox.maxN)
  const wantedTiles =
    p.maskMinDrop > 0
      ? tilesWorthLoading(drop, p.maskMinDrop, p.maskMinCoverage, p.maxLength)
      : null
  const groundTiles = wantedTiles ? allTiles.filter((t) => wantedTiles.has(t)) : allTiles
  const passing = [...drop.data].filter((v) => !Number.isNaN(v) && v >= p.maskMinDrop).length
  const valid = [...drop.data].filter((v) => !Number.isNaN(v)).length
  console.log(
    `  ${drop.w}x${drop.h} @${p.maskRes}m, ${((100 * passing) / Math.max(1, valid)).toFixed(1)}% of ` +
      `cells fall >=${p.maskMinDrop}m within ${p.maskRadius}m`,
  )
  console.log(`  ${groundTiles.length} of ${allTiles.length} terrain tiles worth loading`)

  /**
   * Ground here means what an anchor could stand on, which includes roofs -- so the city model is
   * folded in as part of building the grid rather than as a later correction. It costs 5-50 KB a
   * tile and nothing at all where there are no buildings; see buildings.ts for why it is not
   * derived from the surface model.
   */
  const built = await stage(`[2/6] terrain and buildings (${label})`, async () => {
    const ground = await loadProduct('dgm', bbox, 1, wantedTiles ?? undefined)
    return { ground, buildings: await raiseOntoBuildings(ground, groundTiles) }
  })
  const ground = built.ground
  const roofs = built.buildings.mask
  const ext = ground.extent()
  console.log(
    `  ground grid ${ground.w}x${ground.h} @1m, ${ext.valid} valid cells, ` +
      `${ext.min.toFixed(2)}..${ext.max.toFixed(2)} m (relief ${(ext.max - ext.min).toFixed(1)} m)`,
  )
  console.log(
    `  ${built.buildings.tiles.length} of ${groundTiles.length} tiles carry a building, ` +
      `ground raised at ${roofs.count()} cells`,
  )

  const scan = await stage('[3/6] openness scan', () => scanAnchors(ground, p, roofs))
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

  const found = await stage('[4/6] pairing and terrain test', () =>
    terrainPairs(anchors, ground, p),
  )

  /**
   * The surface model is fetched here rather than alongside the terrain, and only for the tiles the
   * surviving corridors cross. It is 33 MB per square kilometre against the terrain model's 1.4 MB,
   * and canopy is never a hard constraint -- so paying for it over the whole area of interest buys
   * canopy figures for ground no line ever crosses.
   */
  const wanted = corridorTiles(found.pairs, p.refineRadius + p.profileStep)
  const all = tilesForBounds(bbox.minE, bbox.minN, bbox.maxE, bbox.maxN)
  const used = all.filter((t) => wanted.has(t))
  console.log(
    `  ${used.length} of ${all.length} tiles carry a line ` +
      `(~${used.length * 33} MB instead of ~${all.length * 33} MB)`,
  )
  const surface = await stage('[5/6] surface, for the corridors that survived', () =>
    loadProduct('bdom', bbox, 1, wanted),
  )
  console.log(`  surface grid ${surface.w}x${surface.h} @1m (bDOM 0.2m, max-downsampled)`)

  /**
   * The road network, for the same corridors and for the same reason: only ground a line actually
   * crosses can put traffic under it. Fetched here rather than with the terrain because the
   * corridor set is not known until the pair search has run.
   */
  const roads = await stage('[5/6] roads under those corridors', () => loadRoads(used))
  console.log(
    `  ${roads.ways} ways in ${roads.index.segments} segments  ` +
      `(${Object.entries(roads.byTier).map(([t, n]) => `${n} ${t}`).join(', ')})`,
  )
  const scene = { roofs, roads: roads.index }

  const r = await stage('[6/6] profiles and score', () =>
    evaluatePairs(found, ground, surface, p, scene),
  )
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

  const ref = await stage('[6/6] local refinement', () =>
    refine(r.candidates, ground, surface, p, scene),
  )
  const gain = ref.improved ? ref.totalGain / ref.improved : 0
  console.log(
    `  ${ref.improved}/${r.candidates.length} improved from ${ref.evaluations} evaluations, ` +
      `mean +${gain.toFixed(2)} score`,
  )

  const anchorsPerTile = new Map<string, number>()
  for (const a of anchors) {
    const key = `${Math.floor(a.e / 1000)}_${Math.floor(a.n / 1000)}`
    anchorsPerTile.set(key, (anchorsPerTile.get(key) ?? 0) + 1)
  }
  const tiles: TileUsage = { size: 1000, lat: [], lon: [], terrain: [], surface: [], anchors: [] }
  for (const id of allTiles) {
    const [e, n] = id.slice(2).split('-').map(Number) as [number, number]
    const { lat, lon } = toWgs84(e * 1000 + 500, n * 1000 + 500)
    tiles.lat.push(Math.round(lat * 1e6) / 1e6)
    tiles.lon.push(Math.round(lon * 1e6) / 1e6)
    tiles.terrain.push(!wantedTiles || wantedTiles.has(id))
    tiles.surface.push(wanted.has(id))
    tiles.anchors.push(anchorsPerTile.get(`${e}_${n}`) ?? 0)
  }

  const r6 = (v: number) => Math.round(v * 1e6) / 1e6
  const dump = { lat: [], lon: [], ground: [], drop: [], open: [] } as AreaResult['anchors']
  for (const a of anchors) {
    const { lat, lon } = toWgs84(a.e, a.n)
    dump.lat.push(r6(lat))
    dump.lon.push(r6(lon))
    dump.ground.push(Math.round(a.ground * 10) / 10)
    dump.drop.push(Math.round(a.dropDepth * 10) / 10)
    dump.open.push(packSectors(a.open))
  }
  const packed = { e: [], n: [], kind: [], score: [], blocked: [] } as AreaResult['endpoints']
  for (const e of r.endpoints) {
    packed.e.push(e.e)
    packed.n.push(e.n)
    packed.kind.push(LINE_KINDS.indexOf(e.kind))
    packed.score.push(e.score)
    packed.blocked.push(e.blocked)
  }

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
    mask: exportMask(drop, p),
    tiles,
    anchors: dump,
    endpoints: packed,
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
  const dumpAnchors: AreaResult['anchors'] = { lat: [], lon: [], ground: [], drop: [], open: [] }
  const refinedAll: Candidate[] = []
  const endpoints: Endpoint[] = []
  const maskCells: MaskCells[] = []
  const tileUse: TileUsage[] = []
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

  let reused = 0
  for (const [index, area] of areas.entries()) {
    const label = `region ${index + 1}/${areas.length}`
    const key = await regionKey(area.aois, p)
    const cached = await readRegion<AreaResult>(key)
    let found: AreaResult
    if (cached) {
      reused++
      console.log(
        `\n=== ${label} (unchanged, reused) ===\n` +
          `  ${cached.region.anchorsKept} anchors, ${cached.find.pairsFeasible} feasible, ` +
          `${cached.candidates.length} distinct`,
      )
      found = cached
    } else {
      console.log(`\n=== ${label} ===`)
      found = await searchArea(area, p, label)
      const bytes = await writeRegion(key, found)
      console.log(`  cached as region_${key}.json (${(bytes / 1e6).toFixed(1)} MB)`)
    }

    const { region } = found
    regions.push(region)
    // Appended one at a time rather than spread: a 141 km2 area produces 3.2 million endpoints,
    // and passing those as arguments exceeds the call stack.
    for (let i = 0; i < found.anchors.lat.length; i++) {
      dumpAnchors.lat.push(found.anchors.lat[i]!)
      dumpAnchors.lon.push(found.anchors.lon[i]!)
      dumpAnchors.ground.push(found.anchors.ground[i]!)
      dumpAnchors.drop.push(found.anchors.drop[i]!)
      dumpAnchors.open.push(found.anchors.open[i]!)
    }
    for (let i = 0; i < found.endpoints.e.length; i++) {
      endpoints.push({
        e: found.endpoints.e[i]!,
        n: found.endpoints.n[i]!,
        kind: LINE_KINDS[found.endpoints.kind[i]!]!,
        score: found.endpoints.score[i]!,
        blocked: found.endpoints.blocked[i]!,
      })
    }
    for (const c of found.candidates) refinedAll.push(c)
    maskCells.push(found.mask)
    tileUse.push(found.tiles)
    totals.anchorsScanned += region.anchorsScanned
    totals.anchorsKept += region.anchorsKept
    totals.pairsInRange += found.find.pairsInRange
    totals.pairsSectorPassed += found.find.pairsSectorPassed
    totals.pairsLevelEnough += found.find.pairsLevelEnough
    totals.pairsFeasible += found.find.pairsFeasible
    totals.candidatesAfterDedup += found.find.candidatesAfterDedup
    totals.refinedCount += found.improved
    totals.refineGain += found.totalGain
  }
  if (reused) console.log(`\n${reused} of ${areas.length} region(s) reused unchanged`)

  // One pass over the pooled results: overlapping AOIs find the same line twice, and refinement
  // can walk two neighbours onto the same optimum. Nothing is capped after that -- every distinct
  // line found is stored.
  const deduped = (await stage('pooled dedup', () => dedupe(refinedAll, p.dedupRadius))).map(locate)
  const finalCandidates = p.storeProfiles
    ? deduped
    : deduped.map(({ profile: _profile, ...rest }) => rest)
  const meanGain = totals.refinedCount ? totals.refineGain / totals.refinedCount : 0
  console.log(
    `\npooled ${refinedAll.length} from ${areas.length} region(s) -> ` +
      `${finalCandidates.length} distinct` +
      (p.storeProfiles ? ' (with profiles)' : ' (profiles fetched on demand)'),
  )

  // Split rather than labelled: the list a line is in is its kind, so the word does not have to be
  // repeated on every line. `kind` is dropped here for the same reason and put back on load.
  const lines = byKind<Candidate[]>(() => [])
  for (const { kind, ...rest } of finalCandidates) lines[kind].push(rest as Candidate)
  console.log(
    `  ${LINE_KINDS.map((k) => `${lines[k].length} ${k}`).join(', ')}`,
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
    lines,
  }

  await mkdir(new URL('../web/public/', import.meta.url).pathname, { recursive: true })
  await writeFile(OUT, JSON.stringify(dataset))

  const dump: AnchorDump = {
    sectorCount: p.sectorCount,
    aFrameMin: p.aFrameMin,
    aFrameMax: p.aFrameMax,
    anchorStep: p.anchorStep,
    nearProbeLength: p.nearProbeLength,
    minDropDepth: p.minDropDepth,
    dropSearchRadius: p.dropSearchRadius,
    ...dumpAnchors,
  }
  await writeFile(ANCHORS_OUT, JSON.stringify(dump))

  const r6 = (v: number) => Math.round(v * 1e6) / 1e6
  const mask: MaskCells = {
    res: p.maskExportRes,
    sourceRes: p.maskRes,
    minDrop: p.maskMinDrop,
    lat: maskCells.flatMap((m) => m.lat),
    lon: maskCells.flatMap((m) => m.lon),
    drop: maskCells.flatMap((m) => m.drop),
  }
  const tiles: TileUsage = {
    size: 1000,
    lat: tileUse.flatMap((t) => t.lat),
    lon: tileUse.flatMap((t) => t.lon),
    terrain: tileUse.flatMap((t) => t.terrain),
    surface: tileUse.flatMap((t) => t.surface),
    anchors: tileUse.flatMap((t) => t.anchors),
  }
  await writeFile(TILES_OUT, JSON.stringify(tiles))
  const barren = tiles.terrain.filter((t, i) => t && tiles.anchors[i] === 0).length
  console.log(
    `tiles: ${tiles.terrain.filter(Boolean).length}/${tiles.lat.length} terrain fetched ` +
      `(${barren} yielded no anchor), ${tiles.surface.filter(Boolean).length} surface`,
  )

  await writeFile(MASK_OUT, JSON.stringify(mask))
  const skipped = mask.drop.filter((d) => d < p.maskMinDrop).length
  console.log(
    `mask: ${mask.drop.length} cells @${p.maskExportRes}m, ${skipped} below the ${p.maskMinDrop}m ` +
      `threshold (${((100 * skipped) / Math.max(1, mask.drop.length)).toFixed(0)}% of the area) ` +
      `(${(JSON.stringify(mask).length / 1024).toFixed(0)} KB)`,
  )

  /**
   * Clustered across all regions at once, so a spot straddling two of them is one spot -- but once
   * per kind, so the layer splits the same way the lines do.
   *
   * Three independent clusterings rather than one tagged set, because a place where both a natural
   * and an urban line work really is two answers: a spot only appears in a layer if that kind of
   * line can actually be rigged there, which is what makes switching the filter mean something.
   */
  const walkable = endpoints.filter(isWalkable)
  const hotspots: Hotspots = { radius: HOTSPOT_RADIUS, ...byKind<HotspotArrays>(emptyHotspots) }
  const spotCounts = await stage('hotspot clustering', () =>
    LINE_KINDS.map((kind) => {
      const spots = clusterEndpoints(walkable.filter((e) => e.kind === kind), HOTSPOT_RADIUS)
      spots.sort((a, b) => b.count - a.count)
      for (const s of spots) {
        const { lat, lon } = toWgs84(s.e, s.n)
        hotspots[kind].lat.push(r6(lat))
        hotspots[kind].lon.push(r6(lon))
        hotspots[kind].count.push(s.count)
        hotspots[kind].score.push(Math.round(s.score * 10) / 10)
      }
      return `${spots.length} ${kind}`
    }),
  )
  await writeFile(HOTSPOTS_OUT, JSON.stringify(hotspots))
  const hotKb = (JSON.stringify(hotspots).length / 1024).toFixed(0)
  console.log(
    `hotspots: ${endpoints.length} feasible endpoints, ${walkable.length} clear of canopy ` +
      `-> ${spotCounts.join(', ')} spots @${HOTSPOT_RADIUS}m (${hotKb} KB)`,
  )
  const anchorKb = (JSON.stringify(dump).length / 1024).toFixed(0)
  const kb = (JSON.stringify(dataset).length / 1024).toFixed(0)
  console.log(
    `\ndone in ${((Date.now() - started) / 1000).toFixed(1)}s -> candidates.json (${kb} KB), ` +
      `anchors.json (${anchorKb} KB, ${dumpAnchors.lat.length} points)`,
  )

  const total = (Date.now() - started) / 1000
  console.log('\nwhere the time went:')
  for (const [label, seconds] of [...timings].sort((a, b) => b[1] - a[1])) {
    const share = (100 * seconds) / total
    if (share < 1) continue
    console.log(
      `  ${label.padEnd(44)} ${seconds.toFixed(1).padStart(7)}s  ` +
        `${share.toFixed(0).padStart(3)}%`,
    )
  }

  if (finalCandidates.length) {
    console.log('\ntop 10:')
    console.log('  score  len    exposure  clear  offlevel  canopyMin  blocked  kind')
    for (const c of finalCandidates.slice(0, 10)) {
      console.log(
        `  ${c.score.toFixed(1).padStart(5)}  ${c.length.toFixed(0).padStart(4)}m  ` +
          `${c.exposure.toFixed(1).padStart(7)}m  ${c.clearanceMin.toFixed(1).padStart(5)}m  ` +
          `${c.offLevel.toFixed(1).padStart(7)}m  ${c.canopyClearanceMin.toFixed(1).padStart(8)}m  ` +
          `${(c.canopyBlockedFraction * 100).toFixed(0).padStart(6)}%  ${c.kind}`,
      )
    }
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
