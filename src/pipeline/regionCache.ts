import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Aoi, Params } from '../shared/types.js'

/**
 * Keeps each region's results until someone asks for them to be recomputed.
 *
 * Regions are independent by construction -- each is rasterised, searched and refined on its own,
 * and only pooled at the end -- so re-running one because another was edited is pure waste. A cache
 * file is named for the region's *identity*, the rectangles it covers, and holds what it was
 * generated with and when.
 *
 * Nothing here decides whether a cached region is worth reusing. It used to: the envelope carried a
 * SHA of every .ts file under pipeline/ and shared/, and a region whose fingerprint no longer
 * matched was recomputed automatically. That was too eager to be useful. The hash could not tell a
 * changed constant from a reworded comment, so renaming a variable threw away twenty minutes of
 * compute across seven regions, and the exclusion list it needed -- params.ts, report.ts, phases.ts
 * -- kept growing as each new "this cannot possibly change the output" file was discovered the
 * expensive way. Worse, it made ordinary refactoring something to schedule around.
 *
 * So the rule is now the blunt one: a region that has been computed stays computed until the run is
 * told otherwise, by naming its ground on the command line or by `--all`. Nothing else is consulted
 * -- not the source, not the parameters. Comparing the parameters was tried and removed on the way
 * here: flagging one kind of drift while silently ignoring the larger one is worse than flagging
 * neither, because it implies a guarantee about two regions being comparable that it cannot make.
 *
 * The cost is that a dataset can hold lines scored under rules the code no longer follows and
 * nothing will notice. What is left to notice it with is the vintage on every region, reported in
 * the run log and drawn in the map's region view.
 *
 * `FORMAT` is the one thing the fingerprint did that still has to be done, because it was doing two
 * jobs and only one of them was unwanted. It also guaranteed that a stored value was shaped the way
 * the code reading it expected -- change the record and the hash changed, so the old file was never
 * read. Nothing enforces that now, and a file missing a field the reader walks is not a stale
 * answer but a crash halfway through a long run. So the shape carries a number, bumped by hand when
 * it changes: deliberate, unlike a hash, and unmoved by renaming a variable.
 */

/**
 * The shape of the stored value. Bump when `AreaResult` in run.ts gains, loses or repurposes a
 * field; every region is then recomputed once, which is the point.
 */
const FORMAT = 2

/** Which region this is, by the ground it covers. Stable across every change to code or tuning. */
export function regionId(aois: Aoi[]): string {
  return createHash('sha1').update(JSON.stringify(aois)).digest('hex').slice(0, 16)
}

interface Envelope<T> {
  format: number
  /** Provenance: what produced this file. Written and never read back. */
  params: string
  generatedAt: string
  value: T
}

export interface CacheHit<T> {
  value: T
  generatedAt: string
}

const CACHE_DIR = new URL('../../data/cache/', import.meta.url).pathname
const pathFor = (id: string) => join(CACHE_DIR, `region_${id}.json`)

export async function readRegion<T>(aois: Aoi[]): Promise<CacheHit<T> | null> {
  let held: Envelope<T>
  try {
    held = JSON.parse(await readFile(pathFor(regionId(aois)), 'utf8')) as Envelope<T>
  } catch {
    return null
  }
  // A truncated file, one from before the envelope existed, or one holding a record this code no
  // longer knows how to read. Nothing to serve in any of those cases.
  if (!held || typeof held.generatedAt !== 'string' || held.format !== FORMAT) return null
  return { value: held.value, generatedAt: held.generatedAt }
}

export async function writeRegion<T>(aois: Aoi[], p: Params, value: T): Promise<number> {
  await mkdir(CACHE_DIR, { recursive: true })
  const held: Envelope<T> = {
    format: FORMAT,
    params: JSON.stringify(p),
    generatedAt: new Date().toISOString(),
    value,
  }
  const text = JSON.stringify(held)
  await writeFile(pathFor(regionId(aois)), text)
  return text.length
}
