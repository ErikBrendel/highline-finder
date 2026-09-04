import maplibregl from 'maplibre-gl'
import { fetchCached } from './tileCache.js'
import { makeOpaque, normaliseShade, SHADE_BASELINE } from './shadeMath.js'
import { report } from './report.js'

/**
 * One basemap out of several surveys, composited per tile.
 *
 * There is no orthophoto of Germany anybody may use, and no shaded relief of it either: each state
 * publishes its own, over its own ground, on its own server. So a basemap that works outside
 * Brandenburg is a stack -- the broadest thing at the bottom, each survey's own imagery over it --
 * and the seam between two of them is wherever the upper one stops having data.
 *
 * That is the good seam, and the reason this is a composite rather than a set of MapLibre layers
 * with rectangular bounds. A state's WMS answers a tile outside its territory with transparency, so
 * what shows through is the shape of the survey rather than the shape of a bounding box. Nobody
 * draws a straight line down the map where two states meet.
 *
 * What it is not is a cross-fade. Two orthophotos of the same wood, flown in different years at
 * different sun angles, do not blend into a better picture of the wood -- they blend into a double
 * exposure. Where they overlap the more local one simply wins.
 *
 * Each layer carries the ground it covers, so a tile over Saxony asks Saxony and nobody else. That
 * is what keeps a stack of four from costing four requests a tile.
 */

export const STACKED = 'stacked'

export interface StackLayer {
  /** Raw tile template, with whichever placeholders the service uses. */
  url: string
  /** Where it has anything, in WGS84 degrees: west, south, east, north. Omit for everywhere. */
  bbox?: [number, number, number, number]
  /**
   * The channel value this survey renders flat ground at, for a shaded-relief layer.
   *
   * Given, it is rebased onto {@link SHADE_BASELINE} before it is drawn, so surveys that disagree
   * about what flat looks like still stack into one map. See `normaliseShade`.
   */
  baseline?: number
  /**
   * How much of its own relief this survey draws, against Brandenburg's.
   *
   * The factor its deviations from flat are multiplied by, so under 1 flattens a survey that
   * overdraws and over 1 lifts one that underdraws. See `normaliseShade`, and the SHADE stack for
   * where the numbers were measured.
   */
  contrast?: number
  /**
   * Whether this survey draws itself semi-transparent, and should not.
   *
   * Saxony-Anhalt's relief arrives at 80 % alpha everywhere it has ground. See `makeOpaque`.
   */
  opaque?: boolean
}

export interface Stack {
  /** Bottom to top: the last one that has data for a tile is the one seen. */
  layers: StackLayer[]
  /**
   * A colour painted under everything, for a stack that must never be transparent.
   *
   * The shade stack uses it: unshaded ground has to come out at the flat-ground grey, because the
   * composite that consumes it divides by that grey. Left transparent, a state with no relief
   * product would multiply its neighbours' maps to black.
   */
  under?: string
}

const stacks = new Map<string, Stack>()

/** A tile template for a stack. Carries every placeholder either kind of service might want. */
export function stackedUrl(id: string, stack: Stack): string {
  stacks.set(id, stack)
  return `${STACKED}://${id}/{z}/{x}/{y}/{bbox-epsg-3857}`
}

const fill = (template: string, z: string, x: string, y: string, bbox: string) =>
  template.replace('{bbox-epsg-3857}', bbox).replace('{z}', z).replace('{x}', x).replace('{y}', y)

/** Web Mercator metres to degrees, to test a tile's box against a survey's. */
function degrees(x: number, y: number): [number, number] {
  const R = 6378137
  return [(x / R) * (180 / Math.PI), (Math.atan(Math.exp(y / R)) * 2 - Math.PI / 2) * (180 / Math.PI)]
}

/**
 * Whether a layer has any business being asked about this tile.
 *
 * The tile's own bounding box arrives in the URL, in the projection MapLibre asked for, so this
 * costs two conversions and saves a request to a server on the other side of the country.
 */
export function touches(layer: StackLayer, bbox: string): boolean {
  if (!layer.bbox) return true
  const [x0, y0, x1, y1] = bbox.split(',').map(Number)
  if ([x0, y0, x1, y1].some((v) => v === undefined || Number.isNaN(v))) return true
  const [west, south] = degrees(x0!, y0!)
  const [east, north] = degrees(x1!, y1!)
  const [lw, ls, le, ln] = layer.bbox
  return west <= le && east >= lw && south <= ln && north >= ls
}

async function bitmap(url: string, signal: AbortSignal): Promise<ImageBitmap | null> {
  try {
    return await createImageBitmap(new Blob([await fetchCached(url, signal)]))
  } catch (e) {
    // A survey that is down, or that answered with something that is not an image, costs its own
    // layer and nothing else: what is underneath it still draws.
    if (!signal.aborted) report('fetching a basemap tile', e)
    return null
  }
}

/**
 * Draws one tile of a stack, from a `stacked://` address.
 *
 * Called two ways. MapLibre asks through the protocol handler below, for a stack that is itself a
 * basemap; and the shaded composite asks directly, because it needs the relief and the imagery as
 * images to multiply together and only MapLibre can resolve a scheme it holds a handler for.
 */
async function paint(url: string, signal: AbortSignal): Promise<OffscreenCanvas> {
  const [id, z, x, y, ...rest] = url.slice(STACKED.length + 3).split('/')
  const stack = stacks.get(id ?? '')
  if (!stack) throw new Error(`no stacked basemap called ${id}`)
  // The bounding box is the last segment and carries commas of its own, so it is rejoined.
  const bbox = rest.join('/')
  const wanted = stack.layers.filter((l) => touches(l, bbox))

  const tiles = await Promise.all(
    wanted.map((l) => bitmap(fill(l.url, z!, x!, y!, bbox), signal)),
  )
  const size = tiles.find(Boolean)?.width ?? 256
  const canvas = new OffscreenCanvas(size, size)
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('no 2d context for stacking')
  if (stack.under) {
    ctx.fillStyle = stack.under
    ctx.fillRect(0, 0, size, size)
  }
  tiles.forEach((tile, i) => {
    if (!tile) return
    const layer = wanted[i]!
    const rebase =
      (layer.baseline !== undefined && layer.baseline !== SHADE_BASELINE) ||
      (layer.contrast !== undefined && layer.contrast !== 1)
    if (!rebase && !layer.opaque) {
      ctx.drawImage(tile, 0, 0, size, size)
      return
    }
    // Fixed up in its own scratch canvas, so reading its pixels back does not pick up whatever this
    // tile already has underneath it.
    const own = new OffscreenCanvas(size, size)
    const octx = own.getContext('2d')
    if (!octx) return
    octx.drawImage(tile, 0, 0, size, size)
    const pixels = octx.getImageData(0, 0, size, size)
    if (rebase) normaliseShade(pixels.data, layer.baseline ?? SHADE_BASELINE, SHADE_BASELINE, layer.contrast)
    if (layer.opaque) makeOpaque(pixels.data)
    octx.putImageData(pixels, 0, 0)
    ctx.drawImage(own, 0, 0)
  })
  return canvas
}

/** A stack as an image, for a composite that has to multiply it into something else. */
export async function stackedBitmap(url: string, signal: AbortSignal): Promise<ImageBitmap> {
  return createImageBitmap(await paint(url, signal))
}

export function installStackedTiles(): void {
  maplibregl.addProtocol(STACKED, async (params, abortController) => {
    const canvas = await paint(params.url, abortController.signal)
    return { data: await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer() }
  })
}
