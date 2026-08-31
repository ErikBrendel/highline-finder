import { readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'

/**
 * Converts a cache written in the old formats to the ones the pipeline reads now.
 *
 * `npm run shrink`, once. Without it every reduced grid and every CityGML tile on disk is simply
 * invisible to the pipeline, which would fetch all of them again -- and the whole point of the new
 * formats is that they are the same data, so re-downloading tens of gigabytes to get identical
 * heights back would be an odd way to save space.
 *
 * Two conversions, each described where the format is defined:
 *
 *   dn{res}_{product}_{tile}.bin  -> .i16.gz   float32 metres to gzipped int16 decimetres
 *   lod1_{tile}.gml               -> .gml.gz   CityGML gzipped, empties left empty
 *
 * Safe to interrupt and safe to re-run. Each file is converted to a temporary name, moved into
 * place, and only then is the original removed, so a kill leaves either the old file or the new one
 * and never half of either.
 */

const CACHE_DIR = new URL('../../data/cache/', import.meta.url).pathname
const NO_DATA = -32768

const mb = (n: number) => `${(n / 1048576).toFixed(0)} MB`

/** Same packing as downsample.ts, which is the only other place that writes this format. */
function packGrid(data: Float32Array): Buffer {
  const out = new Int16Array(data.length)
  for (let i = 0; i < data.length; i++) {
    const v = data[i]!
    out[i] = Number.isFinite(v)
      ? Math.max(NO_DATA + 1, Math.min(32767, Math.round(v * 10)))
      : NO_DATA
  }
  return gzipSync(Buffer.from(out.buffer, out.byteOffset, out.byteLength))
}

async function convert(
  name: string,
  to: string,
  make: (buf: Buffer) => Buffer,
): Promise<[number, number]> {
  const from = join(CACHE_DIR, name)
  const dest = join(CACHE_DIR, to)
  const before = (await stat(from)).size
  const out = before ? make(await readFile(from)) : Buffer.alloc(0)
  const tmp = `${dest}.partial`
  await writeFile(tmp, out)
  await rename(tmp, dest)
  await rm(from, { force: true })
  return [before, out.byteLength]
}

async function main() {
  const files = await readdir(CACHE_DIR)
  const grids = files.filter((f) => /^dn\d+_\w+_[\d-]+\.bin$/.test(f))
  const gml = files.filter((f) => f.startsWith('lod1_') && f.endsWith('.gml'))
  if (!grids.length && !gml.length) {
    console.log('nothing to convert -- the cache is already in the current formats')
    return
  }

  let was = 0
  let now = 0
  let done = 0
  const tick = (a: number, b: number, of: number, what: string) => {
    was += a
    now += b
    if (++done % 250 === 0) console.log(`  ${done}/${of} ${what}, ${mb(was)} -> ${mb(now)}`)
  }

  console.log(`${grids.length} reduced grids`)
  for (const f of grids) {
    const [a, b] = await convert(f, f.replace(/\.bin$/, '.i16.gz'), (buf) =>
      packGrid(new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength))),
    )
    tick(a, b, grids.length, 'grids')
  }

  done = 0
  console.log(`${gml.length} CityGML tiles`)
  for (const f of gml) {
    // An empty file means the survey publishes no buildings there, and convert() keeps it empty:
    // gzipping nothing into twenty bytes, half a million times over, is not a saving.
    const [a, b] = await convert(f, `${f}.gz`, (buf) => gzipSync(buf))
    tick(a, b, gml.length, 'tiles')
  }

  console.log(
    `\n${grids.length + gml.length} files: ${mb(was)} -> ${mb(now)}` +
      ` (${was ? (was / Math.max(1, now)).toFixed(1) : '0'}x smaller)`,
  )
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
