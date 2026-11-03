import { toWgs84 } from '../shared/geo.js'
import type { Pos } from '../shared/grid.js'
import { stackedBitmap, stackedUrl, type StackLayer } from './stacked.js'
import { stateBox } from './coverage.js'
import { ORTHO_SURVEYS, SENTINEL, type SurveyLayer } from './surveys.js'

/**
 * The orthophoto basemap, and the same imagery as a texture for the 3D view.
 *
 * One definition for both, in its own file rather than in MapView, because the two must be the
 * same picture. A view that textured the ground from some second source would disagree with the map
 * it was opened from about what is standing where -- and the stack is where the agreement lives:
 * Sentinel-2 everywhere, each state's own survey over the ground it answers for.
 *
 * It also means the 3D view costs nothing the map has not already paid. The stack composites per
 * Web Mercator tile and every tile goes through the same IndexedDB cache, so a square someone has
 * already looked at on the map is textured from disk.
 */

/**
 * Where each survey has imagery, read off the outlines rather than typed in. See `stateBox`.
 *
 * A survey that answers for more than one state gets the box around all of them: Brandenburg's
 * covers Berlin too, and Berlin is a hole in Brandenburg's outline, so taking only Brandenburg's
 * box would leave the city as a square of Sentinel-2 in the middle of its own survey.
 */
export function boxFor(states: string[]): [number, number, number, number] {
  const boxes = states.map(stateBox)
  return [
    Math.min(...boxes.map((b) => b[0])),
    Math.min(...boxes.map((b) => b[1])),
    Math.max(...boxes.map((b) => b[2])),
    Math.max(...boxes.map((b) => b[3])),
  ]
}

/** One survey's layer, clipped to the ground it answers for. See surveys.ts. */
export const clipped = (l: SurveyLayer): StackLayer => ({ ...l, bbox: boxFor(l.states) })

/**
 * Bottom to top, broadest first: what covers the whole country, then every state survey over it.
 *
 * Which surveys those are is surveys.ts, so that the coverage map in the guide can colour a state
 * from the same list this stack is built from.
 */
export const ORTHO = stackedUrl('ortho', {
  layers: [SENTINEL, ...ORTHO_SURVEYS.map(clipped)],
})

/** Web Mercator, as every tile service means it. */
const EDGE = 20037508.342789244
const toMercator = (lat: number, lon: number): [number, number] => [
  (lon * Math.PI * EDGE) / 180 / Math.PI,
  Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360)) * (EDGE / Math.PI),
]

/** How much of one tile a metre of ground is, at this zoom and this far from the equator. */
const metresPerTile = (z: number, lat: number) =>
  ((2 * EDGE) / 2 ** z) * Math.cos((lat * Math.PI) / 180)

/**
 * The sharpest zoom whose tiles the patch can be covered by without a flood of requests.
 *
 * Sharpness here is free up to a point and then suddenly is not: each level doubles the tiles
 * across and so quadruples the requests, and this runs again every time an anchor is dragged out of
 * its square. Capping the tiles across rather than the zoom is what makes a small patch -- a 60 m
 * line in a quarry, where the detail is the whole point -- come out sharp while a 500 m one still
 * costs the same handful of fetches.
 *
 * The ceiling is the state surveys' own twenty centimetres; below it there is nothing more to see,
 * only more pixels of the same photograph.
 */
export const ACROSS = 5
const MAX_ZOOM = 19
export function zoomFor(halfSide: number, lat: number): number {
  const wanted = Math.log2(((2 * EDGE) / (2 * halfSide)) * Math.cos((lat * Math.PI) / 180) * ACROSS)
  return Math.max(10, Math.min(MAX_ZOOM, Math.floor(wanted)))
}

/** The tiles a box of Web Mercator metres falls in, as inclusive ranges. */
export function tileRange(
  box: { minX: number; minY: number; maxX: number; maxY: number },
  z: number,
): { x0: number; y0: number; x1: number; y1: number } {
  const n = 2 ** z
  const px = (x: number) => Math.floor(((x + EDGE) / (2 * EDGE)) * n)
  const py = (y: number) => Math.floor(((EDGE - y) / (2 * EDGE)) * n)
  const clamp = (v: number) => Math.max(0, Math.min(n - 1, v))
  return {
    x0: clamp(px(box.minX)),
    x1: clamp(px(box.maxX)),
    y0: clamp(py(box.maxY)),
    y1: clamp(py(box.minY)),
  }
}

/**
 * The patch's own axes, in the mosaic's pixels.
 *
 * Not a bounding box pasted into place. UTM and Web Mercator disagree about which way north is by
 * up to three degrees -- grid convergence, worst at the edges of a zone -- and over a square a few
 * hundred metres across that is tens of metres of slip at the corners: every roof in the texture
 * offset from the roof in the model, which is exactly the comparison this view exists for. So the
 * patch's east and north are measured in the mosaic and the image is drawn through that transform.
 *
 * First order is enough. The curvature either projection adds over half a kilometre is centimetres,
 * far under one pixel of the sharpest tile this ever asks for.
 */
export function patchAxes(
  centre: Pos,
  halfSide: number,
  origin: { x: number; y: number; res: number },
): { ox: number; oy: number; ex: number; ey: number; nx: number; ny: number } {
  const pixel = (e: number, n: number) => {
    const { lat, lon } = toWgs84(e, n)
    const [mx, my] = toMercator(lat, lon)
    return { x: (mx - origin.x) / origin.res, y: (origin.y - my) / origin.res }
  }
  const o = pixel(centre.e, centre.n)
  const east = pixel(centre.e + halfSide, centre.n)
  const north = pixel(centre.e, centre.n + halfSide)
  return {
    ox: o.x,
    oy: o.y,
    ex: (east.x - o.x) / halfSide,
    ey: (east.y - o.y) / halfSide,
    nx: (north.x - o.x) / halfSide,
    ny: (north.y - o.y) / halfSide,
  }
}

/** How wide the texture is drawn, in pixels. Bounded both ways: a phone holds this in memory. */
const texSize = (halfSide: number, groundPerPixel: number) =>
  Math.max(512, Math.min(2048, 2 ** Math.round(Math.log2((2 * halfSide) / groundPerPixel))))

/**
 * The imagery over one square of ground, north up and square to the patch's own axes.
 *
 * Returns null where the stack came back empty, which it can: every layer in it is somebody else's
 * server. The view then stays on its measured colours, which is what it has always looked like.
 */
export async function orthoPatch(
  centre: Pos,
  halfSide: number,
  signal: AbortSignal,
): Promise<ImageBitmap | null> {
  const { lat } = toWgs84(centre.e, centre.n)
  const z = zoomFor(halfSide, lat)
  const corners = [
    [-1, -1],
    [1, -1],
    [-1, 1],
    [1, 1],
  ].map(([se, sn]) => {
    const p = toWgs84(centre.e + se! * halfSide, centre.n + sn! * halfSide)
    return toMercator(p.lat, p.lon)
  })
  const box = {
    minX: Math.min(...corners.map((c) => c[0]!)),
    maxX: Math.max(...corners.map((c) => c[0]!)),
    minY: Math.min(...corners.map((c) => c[1]!)),
    maxY: Math.max(...corners.map((c) => c[1]!)),
  }
  const { x0, y0, x1, y1 } = tileRange(box, z)

  const span = (2 * EDGE) / 2 ** z
  const tiles = await Promise.all(
    Array.from({ length: (x1 - x0 + 1) * (y1 - y0 + 1) }, (_, i) => {
      const x = x0 + (i % (x1 - x0 + 1))
      const y = y0 + Math.floor(i / (x1 - x0 + 1))
      const west = -EDGE + x * span
      const north = EDGE - y * span
      const bbox = [west, north - span, west + span, north].join(',')
      return stackedBitmap(`stacked://ortho/${z}/${x}/${y}/${bbox}`, signal).then(
        (b) => ({ x, y, b }),
        () => null,
      )
    }),
  )
  const drawn = tiles.filter((t) => t !== null)
  if (!drawn.length) return null

  const size = drawn[0]!.b.width
  const mosaic = new OffscreenCanvas((x1 - x0 + 1) * size, (y1 - y0 + 1) * size)
  const mctx = mosaic.getContext('2d')
  if (!mctx) return null
  for (const { x, y, b } of drawn) mctx.drawImage(b, (x - x0) * size, (y - y0) * size)
  drawn.forEach(({ b }) => b.close())

  const res = span / size
  const axes = patchAxes(centre, halfSide, {
    x: -EDGE + x0 * span,
    y: EDGE - y0 * span,
    res,
  })
  const side = texSize(halfSide, metresPerTile(z, lat) / size)
  const canvas = new OffscreenCanvas(side, side)
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  ctx.imageSmoothingQuality = 'high'

  /**
   * The mosaic drawn through the inverse of the patch's axes, so the texture comes out square to
   * the model rather than square to the world.
   *
   * `k` is pixels of texture per metre of ground; the flipped north term is the texture's v running
   * south, which is the order the mesh's rows are built in.
   */
  const k = side / (2 * halfSide)
  const det = axes.ex * axes.ny - axes.ey * axes.nx
  if (!det) return null
  const a = (k * axes.ny) / det
  const b = (k * axes.ey) / det
  const c = (-k * axes.nx) / det
  const d = (-k * axes.ex) / det
  ctx.setTransform(
    a, b, c, d,
    side / 2 - (a * axes.ox + c * axes.oy),
    side / 2 - (b * axes.ox + d * axes.oy),
  )
  ctx.drawImage(mosaic, 0, 0)

  return createImageBitmap(canvas)
}
