import { unzipSync } from 'fflate'
import { Grid, type Pos, type Sampler } from '../shared/grid.js'
import { blitGeoTiff } from '../shared/geotiff.js'
import { levelFaces, rasteriseFaces, type LevelFace } from '../shared/lod1.js'
import { tilesForBounds } from '../shared/geo.js'
import { fetchCached } from './tileCache.js'

/**
 * Elevation on demand, for measuring user-placed lines.
 *
 * Nothing is bundled. The Brandenburg survey publishes both the terrain and the surface model as
 * WCS coverages over the whole state with open CORS, so a window is fetched for wherever the user
 * is actually working and cached in the same IndexedDB store as the basemap tiles. That is what
 * makes this survive the AOI growing: the payload depends on where you look, not on how large the
 * region is. Bundling the raster instead would have cost ~939 KB per square kilometre, or roughly
 * 28 GB for Brandenburg.
 *
 * A roof counts as ground. The third layer is the LoD1 city model, rasterised into each window
 * alongside the two elevation ones, and where a roof covers a cell the ground sampler returns it --
 * so an anchor dropped on a building stands on the building, and a line passing over one has to
 * clear it. That is the physical truth the two elevation products cannot express on their own: the
 * terrain model is bare earth and goes straight through a house, and the surface model knows the
 * roof is there but not that it is a roof rather than a tree. Same source and same rule as the
 * pipeline, so a planned line and a found one stand on the same buildings.
 *
 * The city model is published per 1 km tile rather than per window, which is why it is cached a
 * level up from everything else here. A tile is 5-50 KB, so a window costs at most four small
 * requests the first time it touches new tiles and none after that.
 *
 * One honest difference from the pipeline remains. The pipeline reads the 0.2 m surface model and
 * reduces it to 1 m by taking the *maximum* of each block, so the tallest obstacle in a cell wins.
 * The WCS resamples server side instead, and measured against the pipeline's rule it under-reports
 * canopy by more than a metre on 16 % of cells, occasionally by much more at canopy edges. So a
 * planned line's canopy figures are slightly optimistic compared with a found candidate's. Terrain
 * and roofs, which are the hard constraints, match exactly.
 */

const WCS = 'https://isk.geobasis-bb.de/ows'
const LAYERS = {
  ground: { service: 'dgm_wcs', coverage: 'bb_dgm' },
  surface: { service: 'bdom_wcs', coverage: 'bb_bdom' },
} as const
const LOD1 = 'https://data.geobasis-bb.de/geobasis/daten/3d_gebaeude/lod1_gml'

/** Window size in metres. 256 keeps a request near 256 KB per layer and reuses well while dragging. */
export const WINDOW = 256

type Layer = keyof typeof LAYERS

interface Window {
  ground: Grid
  surface: Grid
  /**
   * Roof height where a building covers the cell, NaN elsewhere. A Grid so it shares the elevation
   * grids' indexing -- getting the two out of step by one cell would put a roof next to the
   * building it belongs to.
   */
  roof: Grid
}

const loaded = new Map<string, Window>()
const inFlight = new Map<string, Promise<void>>()

const keyOf = (tx: number, ty: number) => `${tx}_${ty}`

/** The UTM 33N square one window covers, for drawing it on the map. */
export function windowBounds(tx: number, ty: number): { e0: number; n0: number; size: number } {
  return { e0: tx * WINDOW, n0: ty * WINDOW, size: WINDOW }
}

export interface WindowEvent {
  tx: number
  ty: number
  state: 'loading' | 'loaded' | 'failed'
}

/**
 * Reports which elevation windows are being fetched, so the map can show it in place.
 *
 * A callback rather than React state: a drag can touch a dozen windows a second, and the overlay
 * animates per frame anyway, so routing this through a re-render would buy nothing.
 */
const listeners = new Set<(e: WindowEvent) => void>()

export function onWindowActivity(fn: (e: WindowEvent) => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

const emit = (e: WindowEvent) => listeners.forEach((fn) => fn(e))

function url(layer: Layer, e0: number, n0: number): string {
  const { service, coverage } = LAYERS[layer]
  return (
    `${WCS}/${service}?SERVICE=WCS&VERSION=2.0.1&REQUEST=GetCoverage` +
    `&COVERAGEID=${coverage}&FORMAT=image/tiff` +
    `&SUBSET=x(${e0},${e0 + WINDOW})&SUBSET=y(${n0},${n0 + WINDOW})`
  )
}

/**
 * Level building faces per 1 km tile, parsed once and kept for the session.
 *
 * A tile with no buildings has no file at all, so a 404 is the answer rather than a failure -- and
 * it is cached here as an empty list so the same empty tile is not asked for again while dragging
 * across it. Any other failure is cached the same way: buildings are worth having, but not worth
 * blocking the elevation over.
 */
const roofFaces = new Map<string, Promise<LevelFace[]>>()

function facesFor(tile: string): Promise<LevelFace[]> {
  let job = roofFaces.get(tile)
  if (job) return job
  job = (async () => {
    const zip = await fetchCached(`${LOD1}/lod1_${tile}.zip`)
    const entries = unzipSync(new Uint8Array(zip))
    const name = Object.keys(entries).find((k) => k.endsWith('.gml'))
    return name ? levelFaces(new TextDecoder().decode(entries[name]!)) : []
  })().catch(() => [])
  roofFaces.set(tile, job)
  return job
}

/** Draws whatever buildings stand in this window into its roof grid. */
async function loadRoofs(e0: number, n0: number, into: Grid): Promise<void> {
  const tiles = tilesForBounds(e0, n0, e0 + WINDOW, n0 + WINDOW)
  for (const faces of await Promise.all(tiles.map(facesFor))) rasteriseFaces(faces, into)
}

async function loadWindow(tx: number, ty: number): Promise<void> {
  const e0 = tx * WINDOW
  const n0 = ty * WINDOW
  const ground = Grid.filled(WINDOW, WINDOW, e0, n0 + WINDOW, 1)
  const surface = Grid.filled(WINDOW, WINDOW, e0, n0 + WINDOW, 1)
  const roof = Grid.filled(WINDOW, WINDOW, e0, n0 + WINDOW, 1)
  emit({ tx, ty, state: 'loading' })
  try {
    await Promise.all(
      (['ground', 'surface'] as Layer[]).map(async (layer) => {
        const bytes = await fetchCached(url(layer, e0, n0))
        await blitGeoTiff(bytes, layer === 'ground' ? ground : surface)
      }),
    )
  } catch (e) {
    emit({ tx, ty, state: 'failed' })
    throw e
  }
  // Separately, and after: an outage on the city model must cost the buildings, never the
  // elevation. The roof grid starts all NaN, which is the same answer as open ground.
  await loadRoofs(e0, n0, roof)
  loaded.set(keyOf(tx, ty), { ground, surface, roof })
  emit({ tx, ty, state: 'loaded' })
}

/**
 * Windows covering the corridor between two points, plus a margin for dragging.
 *
 * A band along the line, not its bounding box. The box is the same thing for an axis-aligned line
 * and quadratically worse for a diagonal one -- at the planner's 4 km span cap that is the
 * difference between roughly 60 windows and 320, each of them two requests, for area the line never
 * crosses. Walking the segment in half-window steps and taking the neighbours of each step covers
 * the same line with no gap: consecutive steps land at most half a window apart, so their
 * neighbourhoods always overlap.
 */
export function windowsFor(a: Pos, b: Pos, margin = WINDOW): [number, number][] {
  const steps = Math.ceil(Math.hypot(b.e - a.e, b.n - a.n) / (WINDOW / 2))
  const reach = Math.ceil(margin / WINDOW)
  const out = new Map<string, [number, number]>()
  for (let i = 0; i <= steps; i++) {
    const t = steps === 0 ? 0 : i / steps
    const cx = Math.floor((a.e + (b.e - a.e) * t) / WINDOW)
    const cy = Math.floor((a.n + (b.n - a.n) * t) / WINDOW)
    for (let dx = -reach; dx <= reach; dx++) {
      for (let dy = -reach; dy <= reach; dy++) out.set(`${cx + dx}_${cy + dy}`, [cx + dx, cy + dy])
    }
  }
  return [...out.values()]
}

/**
 * Fetches whatever is still missing around these points.
 *
 * Resolves to true only if something new arrived, so callers can re-measure on a real change
 * instead of on every call. Dragging an anchor asks for terrain many times a second and almost
 * always already has it; without this the answer would be indistinguishable from a fresh load.
 */
export async function ensureTerrain(a: Pos, b: Pos): Promise<boolean> {
  const missing = windowsFor(a, b).filter(([tx, ty]) => !loaded.has(keyOf(tx, ty)))
  if (!missing.length) return false
  await Promise.all(
    missing.map(([tx, ty]) => {
      const key = keyOf(tx, ty)
      let job = inFlight.get(key)
      if (!job) {
        job = loadWindow(tx, ty).finally(() => inFlight.delete(key))
        inFlight.set(key, job)
      }
      return job
    }),
  )
  return true
}

/**
 * One cell of one layer, or NaN where the window has not arrived.
 *
 * This is the single place a roof becomes ground. Doing it here rather than in the sampler means
 * the bilinear interpolation above runs over the composite, so a roof edge reads as a one-metre
 * ramp instead of a vertical step -- which is what stops the anchor optimiser from chattering
 * across it, and matches the smoothing the terrain already gets.
 */
function cellOf(layer: Layer, e: number, n: number): number {
  const win = loaded.get(keyOf(Math.floor(e / WINDOW), Math.floor(n / WINDOW)))
  if (!win) return NaN
  return layer === 'ground' ? standingGround(win, e, n) : win.surface.nearest(e, n)
}

/**
 * The height something actually stands at: terrain, or the roof where there is a building.
 *
 * The max rather than the roof outright, because a LoD1 roof is a single flattened height and the
 * terrain under a building on a slope can sit above it at one corner. Exported for its test; used
 * through `cellOf`, which is what puts it under the bilinear sampler so a roof edge reads as a
 * one-metre ramp instead of a vertical step -- and that is what stops the anchor optimiser
 * chattering across it.
 */
export function standingGround(
  win: { ground: Grid; roof: Grid },
  e: number,
  n: number,
): number {
  const roof = win.roof.nearest(e, n)
  const ground = win.ground.nearest(e, n)
  return Number.isNaN(roof) ? ground : Math.max(ground, roof)
}

/** Whether a point stands on a building. False where the window has not arrived. */
export function onBuilding(e: number, n: number): boolean {
  const win = loaded.get(keyOf(Math.floor(e / WINDOW), Math.floor(n / WINDOW)))
  return !!win && !Number.isNaN(win.roof.nearest(e, n))
}

/**
 * Bare earth, ignoring anything standing on it. NaN where the window has not arrived.
 *
 * The terrain model is otherwise invisible once a building is involved, because everything above
 * reads the composite. The chart wants it back to draw the building as a column of a known height
 * rather than as one going down forever.
 */
export function bareGround(e: number, n: number): number {
  const win = loaded.get(keyOf(Math.floor(e / WINDOW), Math.floor(n / WINDOW)))
  return win ? win.ground.nearest(e, n) : NaN
}

/**
 * Samples across window boundaries by looking each contributing cell up independently, so a line
 * crossing from one fetched window into the next reads continuously instead of hitting an edge.
 */
function samplerFor(layer: Layer): Sampler {
  return {
    sample(e: number, n: number): number {
      const fx = e - 0.5
      const fy = n + 0.5
      const x0 = Math.floor(fx)
      const y0 = Math.floor(fy)
      const tx = fx - x0
      const ty = y0 - fy + 1
      const v00 = cellOf(layer, x0, y0)
      const v10 = cellOf(layer, x0 + 1, y0)
      const v01 = cellOf(layer, x0, y0 - 1)
      const v11 = cellOf(layer, x0 + 1, y0 - 1)
      if (Number.isNaN(v00 + v10 + v01 + v11)) return cellOf(layer, e, n)
      return v00 * (1 - tx) * (1 - ty) + v10 * tx * (1 - ty) + v01 * (1 - tx) * ty + v11 * tx * ty
    },
  }
}

export const groundSampler = samplerFor('ground')
export const surfaceSampler = samplerFor('surface')

export function terrainStats(): { windows: number } {
  return { windows: loaded.size }
}
