import { mkdir, readFile, writeFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { unzipSync } from 'fflate'

/**
 * Fetches and caches raw Brandenburg geobasis tiles.
 *
 * Source: Landesvermessung und Geobasisinformation Brandenburg (LGB), served as flat directory
 * listings over plain HTTPS. No API key, no registration, no documented rate limit.
 * Licence: Datenlizenz Deutschland Namensnennung 2.0 (dl-de/by-2.0). Attribution
 * "GeoBasis-DE/LGB" must be displayed wherever the data is shown -- see the map attribution
 * in the web app.
 *
 * Products used here:
 *   dgm  -- LiDAR digital *terrain* model. 1 m grid, float32 LZW GeoTIFF, ~1.3 MB per tile
 *           zipped. Bare earth. Vertical agreement with bdom on open ground measured at
 *           +/-0.2 m, which is the practical accuracy ceiling of this whole project.
 *   bdom -- photogrammetric digital *surface* model. 0.2 m grid, ~32 MB per tile zipped.
 *           Includes vegetation and structures.
 *
 * Two caveats that matter and are invisible in the data itself:
 *
 *   1. The products are from different epochs. For tile 33407-5784 the dgm is 2025-10-22 and
 *      the bdom is 2024-01-31, 21 months apart. Anything felled, planted or grown in between
 *      shows up as spurious object height when the two are differenced.
 *   2. bdom is derived from aerial imagery, not LiDAR. It is noisy at canopy edges and tends
 *      to bridge small gaps rather than see through them, so narrow clearings can read as
 *      closed canopy.
 *
 * Also available from the same host, unused in v1 but see ROADMAP: `als` (classified LAZ point
 * clouds), `3d_gebaeude` (LoD1/LoD2 CityGML building models), `dop` (20 cm orthophotos).
 */

const BASE = 'https://data.geobasis-bb.de/geobasis/daten'
const CACHE_DIR = new URL('../../data/cache/', import.meta.url).pathname

export type Product = 'dgm' | 'bdom'

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/**
 * Returns the local path of the GeoTIFF for one product/tile, downloading and unzipping it
 * on first use. Neither the .zip nor the .tif is retained: the caller reduces the tile to the
 * working resolution and deletes the source, so what survives on disk is the reduced grid alone.
 *
 * Retried, because a run now fetches hundreds of tiles of tens of megabytes each and a single
 * dropped connection two hundred tiles in should not cost the whole run. Failures are transport
 * ones -- a reset socket, a truncated body -- so a short backoff clears them; an HTTP error is a
 * missing tile and is not worth retrying, but it is also not worth distinguishing here.
 */
export async function tileTiff(product: Product, tile: string): Promise<string> {
  await mkdir(CACHE_DIR, { recursive: true })
  const tifPath = join(CACHE_DIR, `${product}_${tile}.tif`)
  if (await exists(tifPath)) return tifPath

  const url = `${BASE}/${product}/tif/${product}_${tile}.zip`
  process.stdout.write(`  fetching ${product}_${tile} ... `)
  let last: unknown
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const res = await fetch(url)
      if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`)
      const zip = new Uint8Array(await res.arrayBuffer())
      const entries = unzipSync(zip)
      const name = Object.keys(entries).find((k) => k.endsWith('.tif'))
      if (!name) throw new Error(`no .tif inside ${url}`)
      await writeFile(tifPath, entries[name]!)
      process.stdout.write(
        `${(zip.length / 1e6).toFixed(1)} MB zip -> ${(entries[name]!.length / 1e6).toFixed(1)} MB tif\n`,
      )
      return tifPath
    } catch (e) {
      last = e
      process.stdout.write(`retry ${attempt + 1} `)
      await new Promise((r) => setTimeout(r, 3000 * (attempt + 1)))
    }
  }
  throw new Error(`${url} failed after 5 attempts: ${last}`)
}

/** Cached derived artefacts (assembled AOI grids), keyed by caller-supplied name. */
export async function cachedBuffer(
  key: string,
  build: () => Promise<Buffer>,
): Promise<Buffer> {
  await mkdir(CACHE_DIR, { recursive: true })
  const path = join(CACHE_DIR, key)
  if (await exists(path)) return readFile(path)
  const buf = await build()
  await writeFile(path, buf)
  return buf
}
