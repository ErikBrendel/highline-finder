import maplibregl from 'maplibre-gl'
import { fetchCached } from './tileCache.js'

/**
 * Relief shading applied to a map instead of laid over it.
 *
 * Cross-fading a hillshade onto an orthophoto drags every colour toward grey: at the halfway point
 * an autumn beech wood and a ploughed field are the same washed-out brown, and the relief that was
 * supposed to be the point is only half there. What a cartographer does instead is *shade* the map
 * -- keep its colour and vary its brightness with the terrain -- which is a multiply, not a blend.
 *
 * The survey's shaded-relief product renders flat ground at a mid grey, so the shading a pixel
 * carries is its distance from that baseline: `base * shade / baseline`. Above the baseline the map
 * brightens, below it darkens, and because all three channels are scaled by the same factor the hue
 * and saturation come through untouched. That is the whole idea, and it is four lines of arithmetic.
 *
 * It has to happen before MapLibre sees the tile, because raster layers only alpha-composite --
 * there is no multiply blend to ask for. So this is a protocol handler that fetches the two tiles,
 * multiplies them and returns one image. The inputs come through the same persistent cache as every
 * other tile; the composite itself is not stored, since it is a few milliseconds of arithmetic over
 * bytes we already have and MapLibre keeps its own decoded tiles in memory anyway.
 */

const SCHEME = 'shaded'

/**
 * Grey the shaded-relief product renders flat ground at, as a channel value.
 *
 * #c4c4c4. Fixed rather than measured per tile: a per-tile baseline would make the same hillside
 * lighter or darker depending on what else happened to be in frame, which is exactly the artefact
 * this is meant to remove.
 */
export const SHADE_BASELINE = 196

/** Raw tile templates for one composite, before MapLibre substitutes anything into them. */
interface Pair {
  base: string
  shade: string
}

const pairs = new Map<string, Pair>()

/**
 * A tile template for the composite of `base` under `shade`.
 *
 * Carries every placeholder either side might want -- the WMS layers are addressed by bounding box
 * and OSM by tile index -- so MapLibre fills all of them in and the handler substitutes whichever
 * the real templates actually use.
 */
export function shadedUrl(id: string, pair: Pair): string {
  pairs.set(id, pair)
  return `${SCHEME}://${id}/{z}/{x}/{y}/{bbox-epsg-3857}`
}

const fill = (template: string, z: string, x: string, y: string, bbox: string) =>
  template
    .replace('{bbox-epsg-3857}', bbox)
    .replace('{z}', z)
    .replace('{x}', x)
    .replace('{y}', y)

/**
 * Multiplies `shade` into `base` in place, relative to the flat-ground grey.
 *
 * Exported for its test, which is the only way to check the arithmetic: everything else here is
 * fetching and encoding.
 */
export function applyShading(base: Uint8ClampedArray, shade: Uint8ClampedArray): void {
  for (let i = 0; i < base.length; i += 4) {
    const factor = shade[i]! / SHADE_BASELINE
    base[i] = base[i]! * factor
    base[i + 1] = base[i + 1]! * factor
    base[i + 2] = base[i + 2]! * factor
  }
}

async function bitmap(url: string, signal: AbortSignal): Promise<ImageBitmap> {
  return createImageBitmap(new Blob([await fetchCached(url, signal)]))
}

export function installShadedTiles(): void {
  maplibregl.addProtocol(SCHEME, async (params, abortController) => {
    const [id, z, x, y, ...rest] = params.url.slice(SCHEME.length + 3).split('/')
    const pair = pairs.get(id ?? '')
    if (!pair) throw new Error(`no shaded basemap called ${id}`)
    // The bounding box is the last segment and carries commas of its own, so it is rejoined rather
    // than assumed to be one piece.
    const bbox = rest.join('/')
    const at = (t: string) => fill(t, z!, x!, y!, bbox)

    const [base, shade] = await Promise.all([
      bitmap(at(pair.base), abortController.signal),
      bitmap(at(pair.shade), abortController.signal),
    ])
    const canvas = new OffscreenCanvas(base.width, base.height)
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('no 2d context for shading')
    ctx.drawImage(base, 0, 0)
    const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height)
    ctx.drawImage(shade, 0, 0, canvas.width, canvas.height)
    applyShading(pixels.data, ctx.getImageData(0, 0, canvas.width, canvas.height).data)
    ctx.putImageData(pixels, 0, 0)
    return { data: await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer() }
  })
}
