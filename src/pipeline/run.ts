import { createWriteStream } from 'node:fs'
import { once } from 'node:events'
import { mkdir, writeFile } from 'node:fs/promises'
import { tilesForBounds, toWgs84 } from '../shared/geo.js'
import { corridorTiles, loadProduct } from './raster.js'
import { raiseOntoBuildings, tileBuildings } from './buildings.js'
import { loadRoads } from './roads.js'
import { WaterMask } from '../shared/water.js'
import { readRegion, writeRegion } from './regionCache.js'
import {
  aggregateDrops,
  dropField,
  loadCoarse,
  tilesWithRoofAnchors,
  tilesWorthLoading,
} from './coarse.js'
import { packAnchors, packSectors, scanAnchors } from './openness.js'
import { dedupe, locate, pairsOf, thinCrossings } from './lines.js'
import {
  HOTSPOT_RADIUS,
  SPOT_RES,
  clusterSpots,
  gridSpots,
  isWalkable,
  spotOf,
  type Spot,
} from './hotspots.js'
import type { Grid, Pos } from '../shared/grid.js'
import type { Anchor } from './openness.js'
import { DEFAULT_AOIS, DEFAULT_CHUNKS, DEFAULT_PARAMS, URBAN_AREAS } from './params.js'
import { boxOf, contains, recomputes, workAreas, type WorkArea } from './regions.js'
import { chunkArea, parseChunk } from './chunks.js'
import { record, renderReport, stage } from './report.js'
import { Pool, poolSize } from './pool.js'
import { pairInParallel, refineInParallel, scoreInParallel } from './parallel.js'
import { enablePhases } from '../shared/phases.js'
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
 * Runs with a raised heap; see the `pipeline` script in package.json.
 *
 * Node defaults to about 4.5 GB of old space regardless of the machine, and a region holds every
 * candidate and every line endpoint it found until dedup and the hotspot grid have run -- dedup
 * needs to see them all at once, so that is inherent rather than sloppy. A chunk in the Lausitz
 * mining country, where 8 % of scanned points pass the drop test against the usual 0.3-3 %, ran
 * that out during scoring. Twelve gigabytes of a thirty-four gigabyte machine is a limit chosen
 * rather than inherited. The rasters do not compete for it: they live on SharedArrayBuffers, which
 * are external memory.
 *
 * The narrower fix is to reduce endpoints to their 25 m grid inside each worker instead of pooling
 * them raw -- the aggregate is exactly mergeable, so it would collapse millions of objects at the
 * worker boundary. Worth doing before this bites again.
 */

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
 * Everything one region contributes, in a form that survives a round trip through JSON.
 *
 * Changing this shape means bumping `FORMAT` in regionCache.ts. Nothing checks the code any more,
 * so a field added here without that is a field the next run reads as undefined out of a cache
 * written before it existed.
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
   * The hotspot layer's input, already reduced to a `SPOT_RES` grid -- see hotspots.ts. Split by
   * kind because the three layers are clustered independently, and columnar because even reduced
   * this is the largest thing in the file.
   */
  spots: ByKind<{ e: number[]; n: number[]; count: number[]; score: number[] }>
  /** Feasible line endpoints, and how many of those were clear enough to reach the grid. */
  endpointsFeasible: number
  endpointsWalkable: number
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

/** Rounded to a metre-ish, which is all any coordinate in an exported file needs. */
const r6 = (v: number) => Math.round(v * 1e6) / 1e6

const kmTile = (e: number, n: number) => `${Math.floor(e / 1000)}_${Math.floor(n / 1000)}`

function countPerTile(points: Iterable<Pos>): Map<string, number> {
  const out = new Map<string, number>()
  for (const at of points) {
    const key = kmTile(at.e, at.n)
    out.set(key, (out.get(key) ?? 0) + 1)
  }
  return out
}

/** What each source tile was fetched for and what it yielded, for the coverage overlay. */
function tileUsage(
  allTiles: string[],
  anchors: Anchor[],
  roadKills: Pos[],
  terrainWanted: Set<string> | null,
  surfaceWanted: Set<string>,
  roofCells: Map<string, number>,
): TileUsage {
  const perAnchor = countPerTile(anchors)
  const perKill = countPerTile(roadKills)
  const tiles: TileUsage = {
    size: 1000,
    lat: [], lon: [], terrain: [], surface: [], anchors: [], roofCells: [], roadKills: [],
  }
  for (const id of allTiles) {
    const [e, n] = id.slice(2).split('-').map(Number) as [number, number]
    const { lat, lon } = toWgs84(e * 1000 + 500, n * 1000 + 500)
    tiles.lat.push(r6(lat))
    tiles.lon.push(r6(lon))
    tiles.terrain.push(!terrainWanted || terrainWanted.has(id))
    tiles.surface.push(surfaceWanted.has(id))
    tiles.anchors.push(perAnchor.get(`${e}_${n}`) ?? 0)
    tiles.roofCells.push(roofCells.get(id) ?? 0)
    tiles.roadKills.push(perKill.get(`${e}_${n}`) ?? 0)
  }
  return tiles
}

/** The anchors as the debug layer wants them: parallel arrays, rounded, sectors packed to hex. */
function dumpAnchors(anchors: Anchor[]): AreaResult['anchors'] {
  const dump: AreaResult['anchors'] = { lat: [], lon: [], ground: [], drop: [], open: [] }
  for (const a of anchors) {
    const { lat, lon } = toWgs84(a.e, a.n)
    dump.lat.push(r6(lat))
    dump.lon.push(r6(lon))
    dump.ground.push(Math.round(a.ground * 10) / 10)
    dump.drop.push(Math.round(a.dropDepth * 10) / 10)
    dump.open.push(packSectors(a.open))
  }
  return dump
}

const emptySpots = () => ({ e: [] as number[], n: [] as number[], count: [] as number[], score: [] as number[] })

const packSpots = (spots: Spot[]) => {
  const packed = emptySpots()
  for (const s of spots) {
    packed.e.push(s.e)
    packed.n.push(s.n)
    packed.count.push(s.count)
    packed.score.push(s.score)
  }
  return packed
}

const unpackSpots = (packed: ReturnType<typeof emptySpots>): Spot[] =>
  packed.e.map((e, i) => ({ e, n: packed.n[i]!, count: packed.count[i]!, score: packed.score[i]! }))

function exportMask(drop: Grid, p: Params): MaskCells {
  const cells = aggregateDrops(drop, p.maskExportRes)
  const out: MaskCells = {
    res: p.maskExportRes,
    sourceRes: p.maskRes,
    minDrop: p.maskMinDrop,
    lat: [],
    lon: [],
    drop: [],
  }
  for (const c of cells) {
    const { lat, lon } = toWgs84(c.e, c.n)
    out.lat.push(r6(lat))
    out.lon.push(r6(lon))
    out.drop.push(c.drop)
  }
  return out
}

const pctOf = (n: number, d: number) => (d ? `${((n / d) * 100).toFixed(1)}%` : 'n/a')

/**
 * Writes the anchor dump a column at a time rather than as one enormous string.
 *
 * It is the largest output by a wide margin -- 57 MB for the 1.2 million anchors of a 3,520 km2
 * block, which extrapolates to around 496 MB for Brandenburg. `JSON.stringify` would have to build
 * that as a single JavaScript string, and V8 will not make one much past 537 MB, so the obvious
 * implementation fails at the end of the longest run rather than the start of a short one. Written
 * in pieces there is no such ceiling: nothing larger than a few thousand values exists at once.
 *
 * The shape is columnar, which is what makes this easy -- a header of scalars and five arrays, each
 * of which can be emitted in slices without ever holding the whole file.
 */
async function writeAnchorDump(path: string, dump: AnchorDump): Promise<number> {
  const { lat, lon, ground, drop, open, ...scalars } = dump
  const out = createWriteStream(path)
  let length = 0
  const put = async (text: string) => {
    length += text.length
    // Backpressure matters here and nowhere else in this file: the columns are written far faster
    // than a disk accepts them, and ignoring it buffers the whole file in memory again.
    if (!out.write(text)) await once(out, 'drain')
  }

  await put(`{${Object.entries(scalars).map(([k, v]) => `${JSON.stringify(k)}:${v}`).join(',')}`)
  for (const [name, column] of Object.entries({ lat, lon, ground, drop, open })) {
    await put(`,${JSON.stringify(name)}:[`)
    for (let i = 0; i < column.length; i += 4096) {
      const slice = column.slice(i, i + 4096) as (number | string)[]
      await put(slice.map((v) => JSON.stringify(v)).join(',') + (i + 4096 < column.length ? ',' : ''))
    }
    await put(']')
  }
  await put('}')
  out.end()
  await once(out, 'finish')
  return length
}

/**
 * Stage numbers are deliberately absent from the labels.
 *
 * They were `[4/6]` and there were nine of them, because every split of a stage meant renumbering
 * every label after it and that is the edit nobody makes. The report prints them in order anyway,
 * which is the only thing the numbers were for.
 */
async function searchArea(area: WorkArea, p: Params, label: string): Promise<AreaResult> {
  const { bbox, boxes } = area

  /**
   * Where a roof may be stood on.
   *
   * Never null: an empty URBAN_AREAS means no roof anywhere is anchorable, which is the whole point
   * of the list. Passing null for an empty list would have meant the opposite -- anchor on every
   * roof in the state -- and did, until a chunk that is 100 % rooftop lines came back unchanged.
   */
  const urbanBoxes = URBAN_AREAS.map(boxOf)
  const urban = { covers: (e: number, n: number) => urbanBoxes.some((b) => contains(b, e, n)) }

  const countValid = (g: Grid, atLeast = -Infinity) => {
    let n = 0
    for (const v of g.data) if (!Number.isNaN(v) && v >= atLeast) n++
    return n
  }

  const coarse = await stage(
    `coarse terrain, 10 m (${label})`,
    () => loadCoarse(bbox, p.maskRes),
    (g) => ({ to: [countValid(g), 'cells'] }),
  )
  const allTiles = tilesForBounds(bbox.minE, bbox.minN, bbox.maxE, bbox.maxN)
  const valid = countValid(coarse)
  /**
   * Every tile's buildings, before anything decides which terrain to load.
   *
   * The same requests raising used to make, moved ahead of the decision they turn out to belong in:
   * the terrain rule reads bare earth and is blind to a building on flat ground, which is where
   * every urban line in this dataset lives.
   */
  const faces = await stage(
    `city model, every tile (${label})`,
    () => tileBuildings(allTiles),
    (f) => ({ from: [allTiles.length, 'tiles'], to: [f.size, 'carry a building'] }),
  )
  const drop = await stage(
    'drop field',
    () => dropField(coarse, p.maskRadius),
    (g) => ({
      from: [valid, 'cells'],
      to: [countValid(g, p.maskMinDrop), `cells >=${p.maskMinDrop}m`],
    }),
  )
  const byTerrain =
    p.maskMinDrop > 0
      ? tilesWorthLoading(drop, p.maskMinDrop, p.maskMinCoverage, p.maxLength)
      : null
  const byRoof = byTerrain && tilesWithRoofAnchors(faces, coarse, p, p.maxLength, urban)
  const wantedTiles = byTerrain && byRoof ? new Set([...byTerrain, ...byRoof]) : null
  const groundTiles = wantedTiles ? allTiles.filter((t) => wantedTiles.has(t)) : allTiles
  const roofOnly = byTerrain && byRoof
    ? allTiles.filter((t) => byRoof.has(t) && !byTerrain.has(t)).length
    : 0
  record('terrain tile choice', {
    from: [allTiles.length, 'tiles'],
    to: [groundTiles.length, 'worth loading'],
    steps: [['for their buildings alone', roofOnly]],
  })
  console.log(
    `  ${drop.w}x${drop.h} @${p.maskRes}m, ${groundTiles.length} of ${allTiles.length} terrain ` +
      `tiles worth loading: ${byTerrain ? allTiles.filter((t) => byTerrain.has(t)).length : allTiles.length} ` +
      `for a fall of >=${p.maskMinDrop}m within ${p.maskRadius}m, ${roofOnly} more for a roof alone`,
  )

  const ground = await stage(
    `terrain rasters (${label})`,
    () => loadProduct('dgm', bbox, 1, wantedTiles ?? undefined),
    (g) => ({ from: [groundTiles.length, 'tiles'], to: [g.extent().valid, 'cells'] }),
  )
  const ext = ground.extent()
  console.log(
    `  ground grid ${ground.w}x${ground.h} @1m, ${ext.valid} valid cells, ` +
      `${ext.min.toFixed(2)}..${ext.max.toFixed(2)} m (relief ${(ext.max - ext.min).toFixed(1)} m)`,
  )

  /**
   * Ground here means what an anchor could stand on, which includes roofs -- so the city model is
   * folded into the grid rather than applied as a later correction. It costs 5-50 KB a tile and
   * nothing at all where there are no buildings; see buildings.ts for why it is not derived from
   * the surface model.
   *
   * Every tile is probed, not just the ones the pre-pass kept: what a skipped tile holds is the
   * only way to see what judging tiles on bare earth costs. Only the kept ones are raised.
   */
  const buildings = await stage(
    'buildings raised onto the terrain',
    () => raiseOntoBuildings(ground, faces, new Set(groundTiles)),
    (b) => ({ from: [b.tiles.length, 'built-up tiles'], to: [b.mask.count(), 'roof cells'] }),
  )
  const roofs = buildings.mask
  const skippedWithRoofs = [...buildings.cellsPerTile]
    .filter(([tile, cells]) => cells > 0 && !groundTiles.includes(tile))
  console.log(
    `  ${buildings.tiles.length} of ${allTiles.length} tiles carry a building, ` +
      `ground raised at ${roofs.count()} cells`,
  )
  if (skippedWithRoofs.length) {
    // The coarse pre-pass judges a tile on bare earth, so this is what that costs: ground the
    // search never looked at, that has something standing on it worth anchoring to. See ROADMAP.
    const cells = skippedWithRoofs.reduce((s, [, c]) => s + c, 0)
    console.log(
      `  ${skippedWithRoofs.length} tiles the pre-pass skipped carry ${cells} roof cells anyway`,
    )
  }

  // Ground merged in between two AOIs is read for profiles but never searched.
  const inAoi = (a: { e: number; n: number }) => boxes.some((b) => contains(b, a.e, a.n))
  const scan = await stage(
    'openness scan',
    () => {
      const found = scanAnchors(ground, p, roofs, urban)
      return { ...found, inside: found.anchors.filter(inAoi) }
    },
    (r) => ({
      from: [r.scanned, 'points'],
      to: [r.inside.length, 'anchors'],
      steps: [
        ['on a roof outside an urban area, so not searched', r.skippedRoof],
        [`falls >=${p.minDropDepth}m within ${p.dropSearchRadius}m`, r.passedDropTest],
        ['some direction open', r.anchors.length],
        ['inside an AOI', r.inside.length],
      ],
    }),
  )
  const anchors = scan.inside
  const meanOpen = anchors.length
    ? anchors.reduce((s, a) => s + a.openCount, 0) / anchors.length
    : 0
  console.log(
    `  ${scan.scanned} points @${p.anchorStep}m -> ${scan.passedDropTest} with a drop ` +
      `(${pctOf(scan.passedDropTest, scan.scanned)}) -> ${anchors.length} anchors, ` +
      `mean ${meanOpen.toFixed(1)}/${p.sectorCount} open sectors`,
  )

  /**
   * The road network. Read from the committed blocks rather than fetched, so this costs a few
   * hundred milliseconds and nothing at all from any third party -- see src/pipeline/roads.ts.
   * Loaded for the whole region rather than per corridor, since it is cheap enough not to bother.
   */
  const roads = await stage(
    'road network',
    () => loadRoads(bbox),
    (r) => ({ from: [r.blocks, 'blocks'], to: [r.index.segments, 'segments'] }),
  )
  console.log(
    `  ${roads.ways.toLocaleString()} ways in ${roads.index.segments.toLocaleString()} segments ` +
      `from ${roads.blocks}/${roads.wanted} blocks  ` +
      `(${Object.entries(roads.byTier).map(([t, n]) => `${n} ${t}`).join(', ')})`,
  )
  /**
   * Water, rasterised onto the terrain grid so a sample can ask about it as cheaply as it asks the
   * elevation. Islands are punched back out -- a wooded island in a lake is ground with trees on
   * it, and offering a line one metre of clearance over it would be exactly backwards.
   */
  const water = await stage(
    'water rasterised',
    () => {
      const mask = WaterMask.shared(ground)
      mask.add(roads.water)
      return mask
    },
    (mask) => ({ from: [roads.water.rings.length, 'outlines'], to: [mask.cells, 'water cells'] }),
  )
  console.log(
    `  ${roads.water.rings.length.toLocaleString()} water outlines with ` +
      `${roads.water.islands.length.toLocaleString()} islands, ` +
      `${(water.cells / 1e6).toFixed(1)}M cells of the grid under water`,
  )
  /**
   * The pool, opened once the rasters exist and closed when the region is done.
   *
   * Started here rather than at the top of the run because a worker needs the terrain grid to
   * adopt, and it outlives all three parallel stages so the grids and the road index are paid for
   * once rather than per stage. The surface model is sent later, since which of its tiles are worth
   * fetching is decided by the pair search these workers are about to run.
   */
  const pool = new Pool({
    ground: ground.share(),
    roofs: roofs.share(),
    water: water.share(),
    bbox,
    params: p,
  })
  console.log(`  ${poolSize()} worker threads on the pair search, profiles and refinement`)
  const table = packAnchors(anchors, p.sectorCount)

  try {
    const found = await stage(
      'pairing and terrain gate',
      () => pairInParallel(pool, table, area.owns ?? null),
      (r) => ({
        from: [anchors.length, 'anchors'],
        to: [r.count, 'pairs'],
        steps: [
          ['within length range', r.pairsInRange],
          ['both ends open that way', r.pairsSectorPassed],
          ['level enough to rig', r.pairsLevelEnough],
          ['clears the terrain', r.count],
        ],
      }),
    )

    /**
     * The surface model is fetched here rather than alongside the terrain, and only for the tiles the
     * surviving corridors cross. It is 33 MB per square kilometre against the terrain model's 1.4 MB,
     * and canopy is never a hard constraint -- so paying for it over the whole area of interest buys
     * canopy figures for ground no line ever crosses.
     */
    const wanted = corridorTiles(pairsOf(table, found.pairs), p.refineRadius + p.profileStep)
    const used = allTiles.filter((t) => wanted.has(t))
    record('surface tile choice', {
      from: [allTiles.length, 'tiles'],
      to: [used.length, 'carry a line'],
    })
    console.log(
      `  ${used.length} of ${allTiles.length} tiles carry a line ` +
        `(~${used.length * 33} MB instead of ~${allTiles.length * 33} MB)`,
    )
    const surface = await stage(
      'surface rasters',
      () => loadProduct('bdom', bbox, 1, wanted),
      (g) => ({ from: [used.length, 'tiles'], to: [g.extent().valid, 'cells'] }),
    )
    console.log(`  surface grid ${surface.w}x${surface.h} @1m (bDOM 0.2m, max-downsampled)`)
    await pool.broadcast({ kind: 'surface', grid: surface.share() })

    const r = await stage(
      'profiles and score',
      () => scoreInParallel(pool, table, found, p),
      (out) => ({
        from: [found.count, 'pairs'],
        to: [out.candidatesAfterDedup, 'distinct'],
        steps: [['feasible after profile', out.pairsFeasible]],
      }),
    )
    const rejected = Object.entries(r.rejects).sort((x, y) => y[1] - x[1])
    if (rejected.length) {
      console.log(`  rejected by  ${rejected.map(([why, n]) => `${n} ${why}`).join(', ')}`)
    }

    const ref = await stage(
      'local refinement',
      () => refineInParallel(pool, r.candidates),
      (out) => ({
        from: [r.candidates.length, 'distinct'],
        to: [out.improved, 'improved'],
        steps: [['line evaluations spent', out.evaluations]],
      }),
    )
    const gain = ref.improved ? ref.totalGain / ref.improved : 0
    console.log(
      `  ${ref.improved}/${r.candidates.length} improved from ${ref.evaluations} evaluations, ` +
        `mean +${gain.toFixed(2)} score`,
    )

    const thinned = await stage(
      'thinning crossed-out meshes',
      () => thinCrossings(ref.candidates, p.maxCrossings, p.keepBest),
      (out) => ({ from: [ref.candidates.length, 'distinct'], to: [out.length, 'kept'] }),
    )

    const tiles = tileUsage(
      allTiles, anchors, r.roadKills, wantedTiles, wanted, buildings.cellsPerTile,
    )

    /**
     * The hotspot layer's input, reduced here rather than at the end of the run.
     *
     * Three million endpoints a region is both more than a region file should carry and more than
     * the pooled run should hold, and the grid is exactly mergeable, so nothing is gained by
     * carrying the raw points any further. See hotspots.ts.
     */
    const walkable = r.endpoints.filter(isWalkable)
    const spots = byKind(emptySpots)
    for (const kind of LINE_KINDS) {
      const cells = gridSpots(walkable.filter((e) => e.kind === kind).map(spotOf), SPOT_RES)
      spots[kind] = packSpots(cells)
    }
    record('endpoint grid', {
      from: [r.endpoints.length, 'feasible endpoints'],
      to: [LINE_KINDS.reduce((n, k) => n + spots[k].e.length, 0), `${SPOT_RES}m cells`],
      steps: [['clear enough to count', walkable.length]],
    })

    return {
      region: {
        // Identity, filled in by the caller for the same reason `generatedAt` is: it belongs to the
        // work area rather than to anything the search found, so a record written before these
        // fields existed still gets them.
        id: '',
        aois: area.aois,
        owns25833: null,
        bbox25833: bbox,
        width: Math.round(bbox.maxE - bbox.minE),
        height: Math.round(bbox.maxN - bbox.minN),
        groundMin: Math.round(ext.min * 100) / 100,
        groundMax: Math.round(ext.max * 100) / 100,
        anchorsScanned: scan.scanned,
        anchorsKept: anchors.length,
        // Overwritten by the caller, which is the only place that knows whether this came from a
        // cache and when that cache was written.
        generatedAt: '',
      },
      mask: exportMask(drop, p),
      tiles,
      anchors: dumpAnchors(anchors),
      spots,
      endpointsFeasible: r.endpoints.length,
      endpointsWalkable: walkable.length,
      candidates: thinned,
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
  } finally {
    await pool.close()
  }
}

/**
 * What the command line asked to be recomputed.
 *
 * Rectangles and chunks *select* rather than replace what is searched. Replacing made the obvious
 * move -- "just rebuild Sperenberg" -- quietly destructive: the run wrote a dataset containing
 * Sperenberg and nothing else. Every area always reaches the output, from cache if it is not named.
 *
 * The two selections are separate on purpose. A rectangle names areas of interest and can never
 * touch a chunk; `--chunk` names chunks and can never touch an area of interest. Ground can
 * therefore be moved from one mechanism to the other a piece at a time, with each side rebuilt
 * only when it is asked for.
 *
 * Nothing named means nothing recomputed, because a region that has been computed stays computed.
 * `--all` rebuilds the lot, which is what to reach for after a change to the search itself -- the
 * cache no longer notices those on its own. See regionCache.ts.
 *
 *   npm run pipeline                                    keep everything, search what has no cache
 *   npm run pipeline -- 52.13 13.36 52.14 13.39         that area of interest
 *   npm run pipeline -- --chunk 53_729 --chunk 52_729   those chunks
 *   npm run pipeline -- --all                           everything
 */
interface Asked {
  all: boolean
  rects: Aoi[]
  /** Work-area ids, so the check against a chunk area is an identity test and not a parse. */
  chunks: Set<string>
}

function askedFor(args: string[]): Asked {
  const chunks = new Set<string>()
  const rest: string[] = []
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--all') continue
    if (args[i] === '--chunk') {
      const name = args[++i]
      if (!name) throw new Error('--chunk needs a name, like --chunk 53_729')
      chunks.add(chunkArea(parseChunk(name)).id)
      continue
    }
    rest.push(args[i]!)
  }
  const argv = rest.map(Number)
  const rects: Aoi[] = []
  if (argv.length && argv.length % 4 === 0 && argv.every((v) => Number.isFinite(v))) {
    for (let i = 0; i < argv.length; i += 4) {
      rects.push({ south: argv[i]!, west: argv[i + 1]!, north: argv[i + 2]!, east: argv[i + 3]! })
    }
  } else if (argv.length) {
    throw new Error(`not four numbers per rectangle: ${rest.join(' ')}`)
  }
  return { all: args.includes('--all'), rects, chunks }
}

async function main() {
  const started = Date.now()
  enablePhases()
  const p = DEFAULT_PARAMS
  const aois = DEFAULT_AOIS
  /**
   * Areas of interest first, then chunks, and never merged with each other: an area of interest is
   * rasterised whole while a chunk is one square of a fixed lattice, and unioning the two would
   * dissolve exactly the property the lattice exists for.
   */
  const chunks = DEFAULT_CHUNKS.map((name) => chunkArea(parseChunk(name)))
  const drawn = workAreas(aois, p.maxLength)
  const areas = [...drawn, ...chunks]
  const asked = askedFor(process.argv.slice(2))
  const wanted = (area: WorkArea) =>
    asked.all ||
    (area.kind === 'chunk'
      ? asked.chunks.has(area.id)
      : recomputes(area, asked.rects.length ? asked.rects : null))

  /**
   * Ground claimed by both mechanisms is searched twice. The lines dedup, since the anchor lattice
   * is fixed to the projection and both runs find the same ones -- but the hotspot layer counts
   * endpoints, and counting the same endpoint from two regions doubles it. Worth saying out loud
   * rather than leaving in the data.
   */
  const clashes = chunks.filter((c) =>
    drawn.some((a) =>
      a.boxes.some((b) =>
        b.minE < c.owns!.maxE && c.owns!.minE < b.maxE &&
        b.minN < c.owns!.maxN && c.owns!.minN < b.maxN)))
  if (clashes.length) {
    console.log(
      `\n!! ${clashes.length} chunk(s) overlap an area of interest: ` +
        `${clashes.map((c) => c.id).join(', ')}\n` +
        `   Lines will dedup, hotspot counts will not. Drop one side or the other.`,
    )
  }

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
  const spotCells = byKind<Spot[]>(() => [])
  let endpointsFeasible = 0
  let endpointsWalkable = 0
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

  /**
   * Assembles and writes every output file from what has been searched so far.
   *
   * Called after each region that produced something new, not only at the end, so a chunk is
   * visible in the viewer the moment it finishes rather than after the run it happens to be part
   * of. A statewide pass is hours of downloading; waiting for all of it to see any of it is the
   * difference between watching progress and watching a log.
   *
   * Cheap enough to do repeatedly: the whole set is ~480 ms to serialise and write at present, and
   * dedup and hotspot clustering are both under a tenth of a second. Against a chunk that takes
   * minutes to fetch, it does not register.
   *
   * `final` decides whether the work is charged to the run report. Only the last call is, because
   * `stage` accumulates by label and timing the same dedup fifty times would make it the largest
   * row in the table while telling you nothing. The console lines are the last call's too.
   */
  const emit = async (final: boolean) => {
    const timed: typeof stage = final
      ? stage
      : async (_label, run) => run()
    const say = (line: string) => {
      if (final) console.log(line)
    }
  // One pass over the pooled results: overlapping AOIs find the same line twice, and refinement
    // can walk two neighbours onto the same optimum. Nothing is capped after that -- every distinct
    // line found is stored.
    const deduped = (
      await timed('pooled dedup', () => dedupe(refinedAll, p.dedupRadius), (out) => ({
        from: [refinedAll.length, 'pooled'],
        to: [out.length, 'distinct'],
      }))
    ).map(locate)
    // evaluateLine already drops the profile unless it is wanted, so there is nothing left to strip.
    const finalCandidates = deduped
    const meanGain = totals.refinedCount ? totals.refineGain / totals.refinedCount : 0
    say(
      `\npooled ${refinedAll.length} from ${areas.length} region(s) -> ` +
        `${finalCandidates.length} distinct`,
    )

    // Split rather than labelled: the list a line is in is its kind, so the word does not have to be
    // repeated on every line. `kind` is dropped here for the same reason and put back on load.
    const lines = byKind<Candidate[]>(() => [])
    for (const { kind, ...rest } of finalCandidates) lines[kind].push(rest as Candidate)
    say(
      `  ${LINE_KINDS.map((k) => `${lines[k].length} ${k}`).join(', ')}`,
    )

    const dataset: Dataset = {
      meta: {
        generatedAt: new Date().toISOString(),
        regions,
        params: p,
        urbanAreas: URBAN_AREAS,
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
          {
            name: 'LoD1 city model (3d_gebaeude)',
            url: 'https://data.geobasis-bb.de/geobasis/daten/3d_gebaeude/lod1_gml/',
            attribution: 'GeoBasis-DE/LGB, dl-de/by-2.0',
            note: 'extruded footprints with one roof height each; merged into the ground so a roof is both an anchor and an obstacle. Brandenburg only, so no buildings in Berlin',
          },
          {
            name: 'OpenStreetMap roads, railways and water',
            url: 'https://download.geofabrik.de/europe/germany/brandenburg-latest.osm.pbf',
            attribution: 'OpenStreetMap contributors, ODbL',
            note: 'extracted once by `npm run osm` and shipped as blocks under public/osm; sets the clearance a line owes over traffic. Brandenburg extract, which includes Berlin',
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
    const datasetText = JSON.stringify(dataset)
    await writeFile(OUT, datasetText)

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
    // Written every time like the rest, so a run that dies leaves a set of files that agree with
    // each other rather than a candidate list describing chunks the anchor dump has never heard of.
    const anchorKb = (await writeAnchorDump(ANCHORS_OUT, dump)) / 1024

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
      roofCells: tileUse.flatMap((t) => t.roofCells),
      roadKills: tileUse.flatMap((t) => t.roadKills),
    }
    await writeFile(TILES_OUT, JSON.stringify(tiles))
    const barren = tiles.terrain.filter((t, i) => t && tiles.anchors[i] === 0).length
    say(
      `tiles: ${tiles.terrain.filter(Boolean).length}/${tiles.lat.length} terrain fetched ` +
        `(${barren} yielded no anchor), ${tiles.surface.filter(Boolean).length} surface`,
    )

    const maskText = JSON.stringify(mask)
    await writeFile(MASK_OUT, maskText)
    const skipped = mask.drop.filter((d) => d < p.maskMinDrop).length
    say(
      `mask: ${mask.drop.length} cells @${p.maskExportRes}m, ${skipped} below the ${p.maskMinDrop}m ` +
        `threshold (${((100 * skipped) / Math.max(1, mask.drop.length)).toFixed(0)}% of the area) ` +
        `(${(maskText.length / 1024).toFixed(0)} KB)`,
    )

    /**
     * Clustered across all regions at once, so a spot straddling two of them is one spot -- but once
     * per kind, so the layer splits the same way the lines do.
     *
     * Three independent clusterings rather than one tagged set, because a place where both a natural
     * and an urban line work really is two answers: a spot only appears in a layer if that kind of
     * line can actually be rigged there, which is what makes switching the filter mean something.
     */
    const hotspots: Hotspots = { radius: HOTSPOT_RADIUS, ...byKind<HotspotArrays>(emptyHotspots) }
    const cells = LINE_KINDS.reduce((n, k) => n + spotCells[k].length, 0)
    const spotCounts = await timed('hotspot clustering', () =>
      LINE_KINDS.map((kind) => {
        // Merged through the same grid the regions were reduced on, so two regions that overlap a
        // cell contribute to one cell rather than to two spots on top of each other.
        const spots = clusterSpots(gridSpots(spotCells[kind], SPOT_RES), HOTSPOT_RADIUS)
        spots.sort((a, b) => b.count - a.count)
        for (const s of spots) {
          const { lat, lon } = toWgs84(s.e, s.n)
          hotspots[kind].lat.push(r6(lat))
          hotspots[kind].lon.push(r6(lon))
          hotspots[kind].count.push(s.count)
          hotspots[kind].score.push(Math.round(s.score * 10) / 10)
        }
        return spots.length
      }),
    (out) => ({
      from: [cells, `${SPOT_RES}m cells`],
      to: [out.reduce((n, spots) => n + spots, 0), 'spots'],
    }))
    const hotspotsText = JSON.stringify(hotspots)
    await writeFile(HOTSPOTS_OUT, hotspotsText)
    const hotKb = (hotspotsText.length / 1024).toFixed(0)
    say(
      `hotspots: ${endpointsFeasible} feasible endpoints, ${endpointsWalkable} clear of canopy ` +
        `-> ${cells} cells @${SPOT_RES}m ` +
        `-> ${LINE_KINDS.map((k, i) => `${spotCounts[i]} ${k}`).join(', ')} spots ` +
        `@${HOTSPOT_RADIUS}m (${hotKb} KB)`,
    )
    say(
      `\ndone in ${((Date.now() - started) / 1000).toFixed(1)}s -> ` +
        `candidates.json (${(datasetText.length / 1024).toFixed(0)} KB), ` +
        `anchors.json (${anchorKb.toFixed(0)} KB, ${dumpAnchors.lat.length} points)`,
    )
    return finalCandidates
  }


  /**
   * Everything that needs no work first, everything that does after it.
   *
   * Because the output files are now written after each region that produced something, the order
   * decides what a half-finished run is serving. Left in list order, a run whose new chunks happen
   * to come first publishes a dataset holding only those -- the caches are all still on disk, but
   * the map shows a fraction of them until the loop reaches the rest, which on a statewide pass is
   * hours of looking at a hole. Folding the cached regions in first means the first write is
   * already complete and every later one only adds to it.
   *
   * The classification reads each cache and drops it again rather than holding them all: the loop
   * below reads them properly, and a statewide run's worth of parsed regions at once is not
   * something to keep in memory for the sake of one boolean.
   *
   * Safe to reorder. Pooled dedup sorts by score with a canonical tie-break, and the hotspot grid
   * merges by cell, so neither depends on the order regions arrive in.
   */
  const cached = new Set<string>()
  for (const area of areas) if (await readRegion(area.id)) cached.add(area.id)
  const needsWork = (a: WorkArea) => !cached.has(a.id) || wanted(a)
  const ordered = [...areas].sort((a, b) => Number(needsWork(a)) - Number(needsWork(b)))

  let reused = 0
  for (const [index, area] of ordered.entries()) {
    const label = `region ${index + 1}/${areas.length}`
    const hit = await readRegion<AreaResult>(area.id)
    // Kept unless this run was told to rebuild it. A region with no cache is searched whatever the
    // selection says, since a dataset with a hole in it is worse than one that took longer.
    const serve = hit && !wanted(area)
    let found: AreaResult
    let vintage = new Date().toISOString()
    if (serve) {
      reused++
      vintage = hit.generatedAt
      console.log(
        `\n=== ${label} (kept from ${hit.generatedAt.slice(0, 10)}) ===\n` +
          `  ${hit.value.region.anchorsKept} anchors, ${hit.value.find.pairsFeasible} feasible, ` +
          `${hit.value.candidates.length} distinct`,
      )
      found = hit.value
    } else {
      console.log(`\n=== ${label} ===`)
      found = await searchArea(area, p, label)
      const bytes = await writeRegion(area.id, p, found)
      console.log(`  cached as ${area.id}.json (${(bytes / 1e6).toFixed(1)} MB)`)
    }
    found.region.generatedAt = vintage
    found.region.id = area.id
    found.region.owns25833 = area.owns ?? null

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
    for (const kind of LINE_KINDS) spotCells[kind].push(...unpackSpots(found.spots[kind]))
    endpointsFeasible += found.endpointsFeasible
    endpointsWalkable += found.endpointsWalkable
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

    // Written now rather than only at the end, so this region is on the map as soon as it is done.
    // Only when something was actually searched: a run over cached regions would otherwise rewrite
    // the same files once per region for no change at all.
    if (!serve) await emit(false)
  }
  if (reused) {
    // Said plainly every time, because nothing else will say it: results are kept until asked to
    // go, so a run that changed the search and forgot `--all` gets yesterday's answer in silence.
    const oldest = regions.reduce((a, r) => (r.generatedAt < a ? r.generatedAt : a), 'z')
    console.log(
      `\n${reused} of ${areas.length} region(s) kept as they were, oldest ${oldest.slice(0, 10)}. ` +
        `Re-run with --all to rebuild them.`,
    )
  }

  const finalCandidates = await emit(true)
  renderReport((Date.now() - started) / 1000)

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
