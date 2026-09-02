import maplibregl from 'maplibre-gl'
import { fetchCached } from './tileCache.js'
import { applyShading } from './shadeMath.js'
import { STACKED, stackedBitmap } from './stacked.js'

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
 * One input tile, however it is addressed.
 *
 * A basemap here is no longer a URL a server answers: ortho and relief are each assembled from
 * whichever surveys cover the tile, and that assembly has its own scheme. Only MapLibre can resolve
 * a scheme it was given a handler for, and this is not MapLibre -- so a stacked input is composited
 * directly rather than fetched, which is what it would have done anyway.
 */
async function bitmap(url: string, signal: AbortSignal): Promise<ImageBitmap> {
  if (url.startsWith(`${STACKED}://`)) return stackedBitmap(url, signal)
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
