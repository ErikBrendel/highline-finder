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
 * How long to keep trying one tile, and how patiently.
 *
 * Eight attempts backing off to a minute is a little over four minutes of tolerance. It was five
 * attempts over thirty seconds, which is not proportionate to the job: a run fetches hundreds of
 * tiles over an hour or more, and it lost forty minutes of successful downloading because one tile
 * failed for half a minute. The survey's server is reachable and slow rather than reliable, and a
 * blip shorter than a coffee break should not be able to discard the work either side of it.
 */
export const ATTEMPTS = 8
export const backoffMs = (attempt: number) => Math.min(60_000, 5_000 * 2 ** attempt)

/**
 * Returns the local path of the GeoTIFF for one product/tile, downloading and unzipping it
 * on first use. Neither the .zip nor the .tif is retained: the caller reduces the tile to the
 * working resolution and deletes the source, so what survives on disk is the reduced grid alone.
 *
 * Only transport failures are retried -- a reset socket, a truncated body, a refused connection.
 * A status code is the server answering the question, and it will answer the same way in a minute:
 * a tile outside the survey's coverage is not there, and eight minutes of backoff spent confirming
 * that is eight minutes not spent on the tiles that exist.
 *
 * A 404 is that answer and not an error. Brandenburg's border is ragged and the survey publishes a
 * tile only where it has data, so a run that reaches the edge -- which every statewide run does --
 * asks for squares that do not exist. `MissingTile` says so in a way callers can act on, because
 * the alternative is what happened: nine chunks of work thrown away on the eighth for one square
 * of Poland.
 */
export class MissingTile extends Error {}
export async function tileTiff(product: Product, tile: string): Promise<string> {
  await mkdir(CACHE_DIR, { recursive: true })
  const tifPath = join(CACHE_DIR, `${product}_${tile}.tif`)
  if (await exists(tifPath)) return tifPath

  const url = `${BASE}/${product}/tif/${product}_${tile}.zip`
  process.stdout.write(`  fetching ${product}_${tile} ... `)
  let last: unknown
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    if (attempt) {
      process.stdout.write(`retry ${attempt} `)
      await new Promise((r) => setTimeout(r, backoffMs(attempt - 1)))
    }
    let res: Response
    try {
      res = await fetch(url)
    } catch (e) {
      last = e
      continue
    }
    if (res.status === 404) throw new MissingTile(`${product}_${tile} is not published`)
    if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`)
    try {
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
      // A body that stopped arriving part way, or a zip that will not open because of it.
      last = e
    }
  }
  throw new Error(`${url} failed after ${ATTEMPTS} attempts: ${last}`)
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
