import { Grid } from './grid.js'

const NODATA = -9999

/**
 * Decodes a GeoTIFF and blits it into `dest`, aggregating with max when the tile is finer than the
 * destination. Max (not mean) is deliberate for the surface model: for clearance testing the
 * tallest obstacle inside a cell is the one that matters, and averaging a treetop with the gap
 * beside it invents clearance that is not there.
 *
 * Read happens in horizontal strips so a 5000x5000 float32 tile never materialises whole
 * (100 MB each); this is also what makes a whole-Brandenburg run conceivable later.
 *
 * Shared because the pipeline and the browser differ only in where the bytes come from -- a cached
 * 1 km tile download on one side, a WCS window fetch on the other -- and not at all in what is
 * done with them.
 */
export async function blitGeoTiff(bytes: ArrayBuffer, dest: Grid): Promise<void> {
  // Imported here rather than at the top so the decoder is not in the entry bundle. Nothing on
  // first paint reads a raster -- the map, the borders and the lines are all vector -- and this is
  // the only door to geotiff, so deferring it defers the whole library and its decoders with it.
  const { fromArrayBuffer } = await import('geotiff')
  const tiff = await fromArrayBuffer(bytes)
  const img = await tiff.getImage()
  const [ox, oy] = img.getOrigin()
  const [rx] = img.getResolution()
  const srcRes = Math.abs(rx)
  const w = img.getWidth()
  const h = img.getHeight()

  const stripRows = Math.max(1, Math.floor(2e6 / w))
  for (let top = 0; top < h; top += stripRows) {
    const bottom = Math.min(h, top + stripRows)
    const [band] = (await img.readRasters({ window: [0, top, w, bottom] })) as unknown as Float32Array[]
    for (let sy = top; sy < bottom; sy++) {
      const n = oy - (sy + 0.5) * srcRes
      const drow = Math.floor((dest.n1 - n) / dest.res)
      if (drow < 0 || drow >= dest.h) continue
      const rowOff = (sy - top) * w
      for (let sx = 0; sx < w; sx++) {
        const v = band![rowOff + sx]!
        if (v <= NODATA + 1) continue
        const e = ox + (sx + 0.5) * srcRes
        const dcol = Math.floor((e - dest.e0) / dest.res)
        if (dcol < 0 || dcol >= dest.w) continue
        const i = drow * dest.w + dcol
        const cur = dest.data[i]!
        if (Number.isNaN(cur) || v > cur) dest.data[i] = v
      }
    }
  }
}
