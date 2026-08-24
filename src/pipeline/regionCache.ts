import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Aoi, Params } from '../shared/types.js'

/**
 * Reuses a region's results when nothing that could change them has changed.
 *
 * Regions are independent by construction -- each is rasterised, searched and refined on its own,
 * and only pooled at the end -- so re-running one because another was edited is pure waste. Adding
 * a small area used to cost a full re-run of every other, which for a 141 km2 neighbour is ten
 * minutes.
 *
 * The key covers everything that can change a result: the region's own rectangles, every parameter,
 * and a fingerprint of the pipeline and shared source. Hashing the source is what makes this safe
 * to leave on by default -- editing the scoring rule invalidates every region automatically, where
 * a hand-maintained version number would eventually be forgotten and serve stale results as if they
 * were fresh.
 *
 * Two files are excluded. Tests cannot affect output. And params.ts holds only data -- the
 * parameters and the list of areas -- both of which are already in the key by value, so hashing it
 * as source would mean adding one area invalidated every other, which is exactly what this exists
 * to avoid.
 */

const DATA_ONLY = new Set(['params.ts'])

const CACHE_DIR = new URL('../../data/cache/', import.meta.url).pathname
const SOURCE_DIRS = ['../pipeline/', '../shared/']

let fingerprint: string | null = null

async function sourceFingerprint(): Promise<string> {
  if (fingerprint) return fingerprint
  const hash = createHash('sha1')
  for (const dir of SOURCE_DIRS) {
    const path = new URL(dir, import.meta.url).pathname
    for (const name of (await readdir(path)).sort()) {
      if (!name.endsWith('.ts') || name.endsWith('.test.ts') || DATA_ONLY.has(name)) continue
      hash.update(name)
      hash.update(await readFile(join(path, name)))
    }
  }
  fingerprint = hash.digest('hex').slice(0, 12)
  return fingerprint
}

export async function regionKey(aois: Aoi[], p: Params): Promise<string> {
  const hash = createHash('sha1')
  hash.update(await sourceFingerprint())
  hash.update(JSON.stringify(aois))
  hash.update(JSON.stringify(p))
  return hash.digest('hex').slice(0, 16)
}

const pathFor = (key: string) => join(CACHE_DIR, `region_${key}.json`)

export async function readRegion<T>(key: string): Promise<T | null> {
  try {
    await stat(pathFor(key))
    return JSON.parse(await readFile(pathFor(key), 'utf8')) as T
  } catch {
    return null
  }
}

export async function writeRegion(key: string, value: unknown): Promise<number> {
  await mkdir(CACHE_DIR, { recursive: true })
  const text = JSON.stringify(value)
  await writeFile(pathFor(key), text)
  return text.length
}
