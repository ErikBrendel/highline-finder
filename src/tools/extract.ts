import { createWriteStream } from 'node:fs'
import { mkdir, stat } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { join } from 'node:path'

/**
 * The OpenStreetMap extract for one German state, downloaded once and kept.
 *
 * Shared by the two tools that read one: `npm run osm`, which builds the roads and water the app
 * ships with, and `npm run boundaries`, which traces the state outlines it draws. Both are run by
 * hand and rarely, and both would otherwise carry their own copy of this.
 *
 * Cached by presence rather than by age. An extract is a few hundred megabytes and a state border
 * moves about never; deleting the file is how you ask for a fresh one.
 */

const CACHE = new URL('../../data/cache/', import.meta.url).pathname
const geofabrik = (state: string) =>
  `https://download.geofabrik.de/europe/germany/${state}-latest.osm.pbf`

export function extractPath(state: string): string {
  return join(CACHE, `${state}-latest.osm.pbf`)
}

export async function ensureExtract(state: string): Promise<string> {
  const path = extractPath(state)
  try {
    const { size, mtime } = await stat(path)
    console.log(
      `${state}: cached, ${(size / 1048576).toFixed(0)} MB from ${mtime.toISOString().slice(0, 10)}` +
        ' (delete it to refresh)',
    )
    return path
  } catch {
    // Not there yet, which is the only reason to go and get it.
  }
  await mkdir(CACHE, { recursive: true })
  const url = geofabrik(state)
  console.log(`${state}: downloading ${url}`)
  const res = await fetch(url, { headers: { 'User-Agent': 'highline-finder/0.1' } })
  if (!res.ok || !res.body) throw new Error(`${state}: extract download failed, HTTP ${res.status}`)
  await pipeline(Readable.fromWeb(res.body as never), createWriteStream(path))
  console.log(`  ${((await stat(path)).size / 1048576).toFixed(0)} MB`)
  return path
}
