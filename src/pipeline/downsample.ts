import { spawn } from 'node:child_process'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Grid } from '../shared/grid.js'
import { blitGeoTiff } from '../shared/geotiff.js'
import { MissingTile, tileTiff, type Product } from './cache.js'

/**
 * Reduces a source tile to the working resolution once, and keeps the result.
 *
 * The surface model is published at 0.2 m and reduced to 1 m by taking the maximum of each block,
 * because for clearance the tallest obstacle in a cell is the one that matters. That is 25 million
 * source pixels per square kilometre, and it was 43% of a full run -- decoded from scratch every
 * time, always producing exactly the same answer.
 *
 * So the reduced grid is cached: 4 MB per tile against 32 MB for the source, and every later run
 * reads it instead of decoding. Geometry is not stored, because a tile id and a resolution fix it
 * completely, which leaves the file a bare Float32Array.
 *
 * Decoding is spread across processes rather than threads. The work is pure CPU in a decoder we do
 * not control, and separate processes need no shared memory, no loader tricks to run TypeScript off
 * the main thread, and give each tile its own heap for a raster that briefly wants a lot of it.
 * This file is both the coordinator and the worker: run it directly to fill the cache for named
 * tiles, or call ensureDownsampled to have it fill itself.
 */

const CACHE_DIR = new URL('../../data/cache/', import.meta.url).pathname

const cachePath = (product: Product, tile: string, res: number) =>
  join(CACHE_DIR, `dn${res}_${product}_${tile}.bin`)

/** The 1 km square a tile id names, as a grid at `res`. */
export function gridForTile(tile: string, res: number): Grid {
  const [e, n] = tile.slice(2).split('-').map(Number) as [number, number]
  const side = Math.round(1000 / res)
  return Grid.filled(side, side, e * 1000, (n + 1) * 1000, res)
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/**
 * Decodes one tile down to `res` and writes it to the cache.
 *
 * The source .tif is deleted once the reduced grid is on disk. It is a decode intermediate that
 * nothing reads again -- this is its only caller, and only when the reduced grid is missing -- and
 * it is the larger half of the cache by a wide margin: a surface tile is ~30 MB of .tif against
 * 4 MB of reduced grid. Statewide that is the difference between 244 GB of cache and 122 GB.
 *
 * The cost is that a second working resolution would have to redownload rather than re-decode.
 * There is one resolution and no reason to expect a second, and disk is the constraint that
 * actually binds.
 */
export async function buildTile(product: Product, tile: string, res: number): Promise<Grid | null> {
  const grid = gridForTile(tile, res)
  let tif: string
  try {
    tif = await tileTiff(product, tile)
  } catch (e) {
    // Ground the survey does not cover. Nothing is written, so a later run asks once more and gets
    // the same answer cheaply; the caller leaves those cells unfilled, which reads as no data.
    if (e instanceof MissingTile) return null
    throw e
  }
  const buf = await readFile(tif)
  await blitGeoTiff(
    buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer,
    grid,
  )
  await mkdir(CACHE_DIR, { recursive: true })
  await writeFile(cachePath(product, tile, res), Buffer.from(grid.data.buffer))
  await rm(tif, { force: true })
  return grid
}

/** The reduced tile, from cache if it is there, or null where the survey publishes none. */
export async function loadTile(product: Product, tile: string, res: number): Promise<Grid | null> {
  const path = cachePath(product, tile, res)
  if (!(await exists(path))) return buildTile(product, tile, res)
  const buf = await readFile(path)
  const data = new Float32Array(
    buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
  )
  const empty = gridForTile(tile, res)
  return new Grid(data, empty.w, empty.h, empty.e0, empty.n1, res)
}

/**
 * How many tiles are worked on at once.
 *
 * Sized for the download, not the decode, because the download is what the time goes on: on the run
 * that added the roof rule the surface stage was 1023s of clock against 10s of processor. Measured
 * against the survey's server, a single connection gets between 0.08 and 0.72 MB/s -- a nine-fold
 * spread on identical requests -- while eight at once aggregate 2.08 MB/s and four aggregate 0.69.
 * So the cap is per-connection and the way past it is more connections.
 *
 * Sixteen rather than more because there is no published rate limit to lean on, and this is a public
 * survey office rather than a CDN. It does oversubscribe the decode by about 1.6x on ten cores, and
 * that is the right way round: a decode that runs slightly slower while sixteen downloads are in
 * flight still finishes long before the downloads do.
 *
 * Measured end to end, on the same 24 surface tiles ten minutes apart: 778s the old way, 628s this
 * way, so 1.24x. Less than the connection test promises, and the reason is the static split below --
 * 24 tiles over 16 lanes gives eight lanes two tiles and eight lanes one, so the batch waits on a
 * lane running two tiles in series and the prefetch gets one chance to help. On a batch big enough
 * for several tiles a lane it should do better, which is untested.
 */
const LANES = 16

/**
 * Fills the cache for whatever is missing, several tiles at a time.
 *
 * Each lane runs one tile ahead of itself, so a tile is downloading while the previous one decodes.
 * Without that the network sits idle through every decode and the processor through every download,
 * which on a batch of surface tiles is most of both.
 */
export async function ensureDownsampled(
  product: Product,
  tiles: string[],
  res: number,
): Promise<number> {
  const missing: string[] = []
  for (const tile of tiles) {
    if (!(await exists(cachePath(product, tile, res)))) missing.push(tile)
  }
  if (!missing.length) return 0

  const lanes = Math.max(1, Math.min(missing.length, LANES))
  // Round-robin, which is even in tile count and not in time: one lane drawing two slow tiles sets
  // the pace for the batch. Handing tiles out as lanes free up would need the parent to talk to its
  // children, and is the next thing worth doing here.
  const queues: string[][] = Array.from({ length: lanes }, () => [])
  missing.forEach((tile, i) => queues[i % lanes]!.push(tile))

  await Promise.all(
    queues.filter((q) => q.length).map(
      (q) =>
        new Promise<void>((resolve, reject) => {
          const child = spawn(
            process.execPath,
            [...process.execArgv, new URL(import.meta.url).pathname, product, String(res), ...q],
            // A lane's own progress reaches the log: `tileTiff` writes a line per tile, and with
            // stdout ignored a stage that spends seventeen minutes downloading looked like a hang.
            { stdio: ['ignore', 'inherit', 'inherit'] },
          )
          child.on('error', reject)
          child.on('exit', (code) =>
            code === 0 ? resolve() : reject(new Error(`downsample worker exited ${code}`)),
          )
        }),
    ),
  )
  return missing.length
}

// Worker mode: `downsample.ts <product> <res> <tile> [<tile> ...]`.
if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) {
  const [product, res, ...tiles] = process.argv.slice(2)
  /**
   * One tile ahead: the next download starts before the current tile is decoded.
   *
   * The two use different resources, so running them in series inside a lane wastes whichever one
   * is idle. Only one ahead, because a lane holding several downloaded tiles would hold their
   * rasters too -- a surface tile is 100 MB decoded.
   */
  const run = async () => {
    // Settled rather than left to reject on its own: a download that fails while the previous tile
    // is decoding has nothing awaiting it yet, and Node treats an unhandled rejection as fatal --
    // so the run would die somewhere in the middle of a decode instead of at the tile that failed.
    const start = (tile: string) =>
      tileTiff(product as Product, tile).then(
        () => null,
        // A tile the survey does not publish is not a failure to hand on: the build below asks
        // again, gets the same answer, and reports it as ground with no data. Everything else is.
        (error: unknown) =>
          error instanceof MissingTile ? null : (error ?? new Error(`fetching ${tile} failed`)),
      )
    const raise = async (settled: Promise<unknown> | null) => {
      const failure = await settled
      if (failure) throw failure
    }

    let ahead = tiles.length ? start(tiles[0]!) : null
    for (let i = 0; i < tiles.length; i++) {
      await raise(ahead)
      ahead = i + 1 < tiles.length ? start(tiles[i + 1]!) : null
      if (!(await buildTile(product as Product, tiles[i]!, Number(res)))) {
        process.stdout.write(`  ${product}_${tiles[i]!} is not published, skipping\n`)
      }
    }
  }
  run().catch((e) => {
    console.error(e)
    process.exit(1)
  })
}
