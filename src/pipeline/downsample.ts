import { spawn } from 'node:child_process'
import { cpus } from 'node:os'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Grid } from '../shared/grid.js'
import { blitGeoTiff } from '../shared/geotiff.js'
import { tileTiff, type Product } from './cache.js'

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

/** Decodes one tile down to `res` and writes it to the cache. */
export async function buildTile(product: Product, tile: string, res: number): Promise<Grid> {
  const grid = gridForTile(tile, res)
  const buf = await readFile(await tileTiff(product, tile))
  await blitGeoTiff(
    buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer,
    grid,
  )
  await mkdir(CACHE_DIR, { recursive: true })
  await writeFile(cachePath(product, tile, res), Buffer.from(grid.data.buffer))
  return grid
}

/** The reduced tile, from cache if it is there. */
export async function loadTile(product: Product, tile: string, res: number): Promise<Grid> {
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
 * Fills the cache for whatever is missing, several tiles at a time.
 *
 * Concurrency leaves two cores for everything else; each child holds one raster at a time, so the
 * ceiling is memory per tile rather than tile count.
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

  const lanes = Math.max(1, Math.min(missing.length, (cpus().length || 4) - 2))
  const queues: string[][] = Array.from({ length: lanes }, () => [])
  missing.forEach((tile, i) => queues[i % lanes]!.push(tile))

  await Promise.all(
    queues.filter((q) => q.length).map(
      (q) =>
        new Promise<void>((resolve, reject) => {
          const child = spawn(
            process.execPath,
            [...process.execArgv, new URL(import.meta.url).pathname, product, String(res), ...q],
            { stdio: ['ignore', 'ignore', 'inherit'] },
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
  const run = async () => {
    for (const tile of tiles) await buildTile(product as Product, tile, Number(res))
  }
  run().catch((e) => {
    console.error(e)
    process.exit(1)
  })
}
