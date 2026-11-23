import { unzipSync } from 'fflate'
import { Grid, type Pos, type Sampler } from '../shared/grid.js'
import { growRoofs, levelFaces, rasteriseFaces, type LevelFace } from '../shared/lod1.js'
import type { Roofs } from '../shared/anchoring.js'
import { fetchCached } from './tileCache.js'
import { NoData, noteAnswered, sourcesFor, type CityModel, type Source } from './sources.js'
import { report } from './report.js'
import { surfaceAt, type CellReader } from './cellSurface.js'
import { estimateCanopy } from './canopyMap.js'

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

/** Window size in metres. 256 keeps a request near 256 KB per layer and reuses well while dragging. */
export const WINDOW = 256

/**
 * How far around a draggable anchor to fetch beyond what measuring the line reads.
 *
 * Not padding for the line, which asks only for its own corridor. This is for the anchor itself:
 * without ground under it there is no attachment height and so no line at all, and the panel falls
 * back to a spinner over an empty chart. A pointer drag needs that ground a frame before it arrives
 * there, and a fetch is a round trip, so a hand moving faster than the network stutters between a
 * measured line and nothing.
 *
 * Sixty-four metres is about a quarter of a window: enough that ordinary dragging stays inside what
 * is already held, small enough that an anchor costs a window or two rather than the nine a full
 * window's margin used to take. Fling the pointer across the map and it will still catch up a
 * moment later, which is the honest trade -- the alternative is fetching ground for every direction
 * the anchor did not go.
 */
export const DRAG_LOOKAHEAD = 64

type Layer = 'ground' | 'surface'

interface Window {
  ground: Grid
  surface: Grid
  /**
   * Roof height where a building covers the cell, NaN elsewhere. A Grid so it shares the elevation
   * grids' indexing -- getting the two out of step by one cell would put a roof next to the
   * building it belongs to.
   */
  roof: Grid
  /** Where the surface came from. See {@link Canopy}. */
  canopy: Canopy
}

/**
 * How much is known about what stands on the ground: a survey's surface model, the canopy map's
 * estimate on top of the terrain, or nothing -- the surface copied from the terrain, so the canopy
 * figures describe bare earth.
 */
export type Canopy = 'measured' | 'estimated' | 'none'

const loaded = new Map<string, Window>()
const inFlight = new Map<string, Promise<void>>()

const keyOf = (tx: number, ty: number) => `${tx}_${ty}`

/**
 * Which window an easting and a northing are read from -- and northing rounds the other way.
 *
 * A window is named by its south-west corner, so its column is the floor of the easting. But the
 * grid inside it is read from its *north-west* corner: `nearest` indexes rows downwards from `n1`,
 * so row 0 is the first metre below the north edge and the southern edge belongs to the window
 * underneath. Flooring the northing too -- the obvious thing, and what this did -- hands every
 * exact multiple of WINDOW to the window whose grid starts one row past its last, and the answer
 * comes back NaN.
 *
 * On screen that was a one-metre black line across the terrain at every 256 m seam, wherever a
 * sample lattice happened to land exactly on one. Easting has no such case: its cells are indexed
 * from the same edge the window is named after, so the two already agree.
 */
const colAt = (e: number) => Math.floor(e / WINDOW)
const rowAt = (n: number) => Math.ceil(n / WINDOW) - 1

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

/**
 * Whether any elevation window is still on its way.
 *
 * The one place that knows, so nothing else has to keep a parallel count. The panel asks it to
 * decide whether a gap in a profile is ground still arriving or ground the survey does not have --
 * the chart looks identical either way and they are opposite answers.
 */
export const fetchingWindows = () => inFlight.size > 0

/**
 * Level building faces per city-model tile, parsed once and kept for the session.
 *
 * A tile with no buildings has no file at all, so a 404 is the answer rather than a failure -- and
 * it is cached here as an empty list so the same empty tile is not asked for again while dragging
 * across it. Any other failure is cached the same way: buildings are worth having, but not worth
 * blocking the elevation over.
 */
const roofFaces = new Map<string, Promise<LevelFace[]>>()

function facesFor(url: string): Promise<LevelFace[]> {
  let job = roofFaces.get(url)
  if (job) return job
  job = (async () => {
    const zip = await fetchCached(url)
    const entries = unzipSync(new Uint8Array(zip), { filter: (f) => f.name.endsWith('.gml') })
    const name = Object.keys(entries).find((k) => k.endsWith('.gml'))
    return name ? levelFaces(new TextDecoder().decode(entries[name]!)) : []
  })().catch((e: unknown) => {
    // A tile with no buildings in it answers 404, and saying so for every empty field in
    // Brandenburg would drown out the failures worth seeing. The catch is that the service sends
    // its CORS header on a 200 and none at all on a 404, so the browser cannot read the status and
    // the miss arrives as a bare `TypeError: Failed to fetch` -- which is also what a dropped
    // connection looks like. Both are "no roofs here, carry on", and neither is worth a toast on a
    // first visit. Anything that is not a fetch failure -- a corrupt zip, a GML this parser cannot
    // read -- is a real one and still says so.
    if (!(e instanceof TypeError) && !/\b404\b/.test(String(e))) {
      report(`loading the city model tile ${url}`, e)
    } else {
      console.warn(`[highline] no city model tile ${url}:`, e)
    }
    return []
  })
  roofFaces.set(url, job)
  return job
}

/** Draws whatever buildings stand in this window into its roof grid. */
async function loadRoofs(model: CityModel, e0: number, n0: number, into: Grid): Promise<void> {
  const tiles = model.tiles(e0, n0, WINDOW)
  for (const faces of await Promise.all(tiles.map(facesFor))) rasteriseFaces(faces, into)
}

/**
 * One window, from the first source that will answer for it.
 *
 * Sources are tried in order and a `NoData` from one is not a failure -- it is that service saying
 * this ground is not its, which is the ordinary case a few hundred metres outside a state border.
 * Only running out of sources is a failure.
 *
 * A source without a surface model gets the canopy map's estimate on top of its terrain, and the
 * window says so. Where even that fails, rather than carry NaN through every canopy figure, the
 * surface is set to the terrain: that reads as bare ground, which is the assumption the numbers are
 * then making, and `canopy` is what lets the panel say the numbers are making it. The hard constraint -- clearance over terrain -- is measured
 * against ground either way and is exact wherever a line can be drawn at all.
 */
async function loadWindow(tx: number, ty: number): Promise<void> {
  const e0 = tx * WINDOW
  const n0 = ty * WINDOW
  const grid = () => Grid.filled(WINDOW, WINDOW, e0, n0 + WINDOW, 1)
  const roof = grid()
  emit({ tx, ty, state: 'loading' })

  const mid = { e: e0 + WINDOW / 2, n: n0 + WINDOW / 2 }
  let used: Source | null = null
  let ground = grid()
  let surface = grid()
  let last: unknown = new Error('no elevation source covers this ground')
  for (const source of sourcesFor(mid.e, mid.n)) {
    // Fresh grids per attempt, so a source that filled half a window before giving up cannot leave
    // its half behind for the next one to be credited with.
    const into = { ground: grid(), surface: grid() }
    try {
      await source.load(e0, n0, WINDOW, into)
      // A service asked about ground outside its state does not always say so. Brandenburg's
      // answers a window over Leipzig with a polite raster of nothing, and a raster of nothing is
      // indistinguishable from a decline -- so it is treated as one, and the next source is asked.
      if (!into.ground.data.some(Number.isFinite)) throw new NoData(`${source.id} holds nothing here`)
      ground = into.ground
      surface = into.surface
      used = source
      noteAnswered(mid.e, mid.n, source)
      break
    } catch (e) {
      last = e
      if (!(e instanceof NoData)) {
        report(`fetching the elevation window at ${e0},${n0} from ${source.id}`, e)
      }
    }
  }
  if (!used) {
    emit({ tx, ty, state: 'failed' })
    throw last
  }
  let canopy: Canopy = 'measured'
  if (!used.hasSurface) {
    surface.data.set(ground.data)
    canopy = await estimateCanopy(ground, surface).then(
      () => 'estimated' as const,
      (e: unknown) => {
        report(`estimating the canopy in the window at ${e0},${n0}`, e)
        surface.data.set(ground.data)
        return 'none' as const
      },
    )
  }

  // Separately, after, and caught: an outage on the city model must cost the buildings, never the
  // elevation. The roof grid starts all NaN, which is the same answer as open ground. Only asked of
  // a source with a city model -- of any other it would be a 404 per tile.
  if (used.cityModel) {
    await loadRoofs(used.cityModel, e0, n0, roof).then(() => growRoofs(roof, surface, ground)).catch((e: unknown) =>
      report(`rasterising buildings into the window at ${e0},${n0}`, e),
    )
  }
  loaded.set(keyOf(tx, ty), { ground, surface, roof, canopy })
  emit({ tx, ty, state: 'loaded' })
}

/**
 * The least that is known about what stands along a corridor, over all its loaded windows.
 *
 * Nothing else about the line depends on it -- the clearance is measured against the terrain
 * either way -- and saying which it is is the whole of the handling this needs.
 */
export function canopyAlong(a: Pos, b: Pos, margin = WINDOW): Canopy {
  const kinds = new Set(windowsFor(a, b, margin).map(([tx, ty]) => loaded.get(keyOf(tx, ty))?.canopy))
  return kinds.has('none') ? 'none' : kinds.has('estimated') ? 'estimated' : 'measured'
}

/**
 * Windows covering the corridor between two points, fattened by `margin` metres.
 *
 * A band along the line, not its bounding box. The box is the same thing for an axis-aligned line
 * and quadratically worse for a diagonal one -- at the planner's 4 km span cap that is the
 * difference between roughly 60 windows and 320, each of them two requests, for area the line never
 * crosses.
 *
 * The margin is in metres and is used as metres. It used to be rounded up to whole windows and
 * applied as a ring of neighbours, which meant any margin at all -- one metre or two hundred --
 * asked for the full three-by-three block around every step: a corridor 768 m wide for a line that
 * needs 20. Fetching a window is two requests against someone else's server, so the ones over
 * ground the line never approaches are pure waste, and they are also what the loading overlay draws,
 * which made the viewer look like it was reading half the county to measure one span.
 *
 * Steps are spaced no further apart than the margin itself, so consecutive boxes always overlap and
 * their union is the whole corridor rather than a string of beads. Capped at half a window, which is
 * what keeps a diagonal from clipping the corner of a window between two samples.
 */
export function windowsFor(a: Pos, b: Pos, margin = WINDOW): [number, number][] {
  const span = Math.hypot(b.e - a.e, b.n - a.n)
  const steps = Math.ceil(span / Math.max(1, Math.min(margin, WINDOW / 2)))
  const out = new Map<string, [number, number]>()
  for (let i = 0; i <= steps; i++) {
    const t = steps === 0 ? 0 : i / steps
    const e = a.e + (b.e - a.e) * t
    const n = a.n + (b.n - a.n) * t
    const x1 = colAt(e + margin)
    const y1 = rowAt(n + margin)
    for (let cx = colAt(e - margin); cx <= x1; cx++) {
      for (let cy = rowAt(n - margin); cy <= y1; cy++) {
        out.set(`${cx}_${cy}`, [cx, cy])
      }
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
 *
 * The default margin is a whole window, which is the planner's need rather than the measurement's:
 * an anchor being dragged is about to be somewhere it is not yet, and having its surroundings
 * already in hand is the difference between a smooth drag and a request per pixel. A caller that is
 * only measuring a line that will not move should say what it actually reaches.
 */
/**
 * How many windows a call to {@link ensureTerrain} would have to go and get.
 *
 * For telling somebody how long they are waiting. Everywhere else in the app a fetch is a window or
 * two behind a badge on the map; the 3D view asks for a whole square at once, which can be dozens,
 * and a spinner with no denominator for eight seconds reads as broken rather than as busy.
 */
export const missingWindows = (a: Pos, b: Pos, margin = WINDOW): number =>
  windowsFor(a, b, margin).filter(([tx, ty]) => !loaded.has(keyOf(tx, ty))).length

export async function ensureTerrain(a: Pos, b: Pos, margin = WINDOW): Promise<boolean> {
  const missing = windowsFor(a, b, margin).filter(([tx, ty]) => !loaded.has(keyOf(tx, ty)))
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
  const win = loaded.get(keyOf(colAt(e), rowAt(n)))
  if (!win) return NaN
  return layer === 'ground' ? standingGround(win, e, n) : win.surface.nearest(e, n)
}

/**
 * The height something actually stands at: terrain, or the roof where there is a building.
 *
 * The building model only says *where* a roof is. Its height is a single flattened figure per part,
 * metres off the real roof wherever the roof is pitched or a small part is modelled tall, while the
 * surface model measured the roof itself -- and is what the 3D view draws. Taking the height from
 * there keeps the anchor, the chart and the picture on the same roof. The building model's own
 * figure is the fallback only where no surface model has arrived.
 *
 * The max with the terrain, because the two surveys disagree by centimetres and a roof must never
 * read below the ground beside it. Exported for its test; used through `cellOf`, which is what puts
 * it under the bilinear sampler so a roof edge reads as a one-metre ramp instead of a vertical step
 * -- and that is what stops the anchor optimiser chattering across it.
 */
export function standingGround(
  win: { ground: Grid; surface: Grid; roof: Grid },
  e: number,
  n: number,
): number {
  const ground = win.ground.nearest(e, n)
  const roof = win.roof.nearest(e, n)
  if (Number.isNaN(roof)) return ground
  const measured = win.surface.nearest(e, n)
  return Math.max(ground, Number.isNaN(measured) ? roof : measured)
}

/** Whether a point stands on a building. False where the window has not arrived. */
export function onBuilding(e: number, n: number): boolean {
  const win = loaded.get(keyOf(colAt(e), rowAt(n)))
  return !!win && !Number.isNaN(win.roof.nearest(e, n))
}

/**
 * The city model in the form the anchoring rules take, so a line placed here is rigged and
 * classified by exactly the rule the pipeline applied to the found ones.
 */
export const roofs: Roofs = { covers: onBuilding }

/**
 * Bare earth, ignoring anything standing on it. NaN where the window has not arrived.
 *
 * The terrain model is otherwise invisible once a building is involved, because everything above
 * reads the composite. The chart wants it back to draw the building as a column of a known height
 * rather than as one going down forever.
 */
export function bareGround(e: number, n: number): number {
  const win = loaded.get(keyOf(colAt(e), rowAt(n)))
  return win ? win.ground.nearest(e, n) : NaN
}

/**
 * Samples across window boundaries by looking each contributing cell up independently, so a line
 * crossing from one fetched window into the next reads continuously instead of hitting an edge.
 */
function samplerFor(layer: Layer): Sampler {
  return {
    /** The composite cell itself -- roof where there is one, terrain otherwise. */
    nearest(e: number, n: number): number {
      return cellOf(layer, e, n)
    },
    sample(e: number, n: number): number {
      // What things stand on is the cell surface the 3D view draws, so the two cannot disagree.
      if (layer === 'ground') return surfaceAt(standingCell, e, n)
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

/** Standing height of the 1 m cell (ci, cj). */
export const standingCell: CellReader = (ci, cj) => cellOf('ground', ci + 0.5, cj + 0.5)

export const groundSampler = samplerFor('ground')
export const surfaceSampler = samplerFor('surface')
