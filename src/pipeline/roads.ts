import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { toUtm33, toWgs84 } from '../shared/geo.js'
import { classifyWay, RoadIndex, type RoadWay, type Tags } from '../shared/roads.js'

/**
 * Fetches the road and rail network per 1 km tile and indexes it for the clearance check.
 *
 * OpenStreetMap rather than the survey. The Brandenburg portal publishes roads only as ALKIS
 * `tatsaechliche_nutzung`, which renders as lines and labels rather than as anything with a
 * classification attached, and it has nothing at all for Berlin. OSM has the classification, the
 * lane counts and the bridge and tunnel tags, which is exactly what the clearance ladder keys on.
 *
 * Tiled on the same 1 km grid as everything else, and cached per tile, so a re-run costs nothing
 * and growing an area of interest only fetches the tiles it added. A way whose nodes straddle a
 * tile boundary comes back whole in both tiles, so ways are deduplicated by OSM id on load.
 *
 * Unlike the city model, a failure here is fatal. A missing LoD1 tile costs roof anchors and the
 * run is still correct about everything else; a missing road tile means the run silently stops
 * asking for height over traffic and reports lines four metres over a Bundesstraße as candidates.
 * There is no safe way to continue past that, so it throws.
 */

const OVERPASS = 'https://overpass-api.de/api/interpreter'

/**
 * Overpass refuses a request with no User-Agent outright -- 406, with an HTML error page for a body
 * -- and asks callers to identify themselves so it can talk to whoever is overloading it. The
 * browser half of this project never hits it because a browser sends its own.
 */
const HEADERS = {
  'User-Agent': 'highline-finder/0.1 (+https://github.com/ErikBrendel/highline-finder)',
}

/** Seconds to wait after a rate-limit refusal, when the server does not say. */
const RATE_LIMIT_WAIT = 30_000
const CACHE_DIR = new URL('../../data/cache/', import.meta.url).pathname

/** What is kept from a response: enough to classify and to intersect, and nothing else. */
interface CachedWay {
  id: number
  tags: Tags
  geometry: { lat: number; lon: number }[]
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/** The WGS84 bounding box of a 1 km tile, as Overpass wants it: south, west, north, east. */
function tileBbox(tile: string): string {
  const [e, n] = tile.slice(2).split('-').map(Number) as [number, number]
  const corners = [
    toWgs84(e * 1000, n * 1000),
    toWgs84((e + 1) * 1000, n * 1000),
    toWgs84(e * 1000, (n + 1) * 1000),
    toWgs84((e + 1) * 1000, (n + 1) * 1000),
  ]
  const lats = corners.map((c) => c.lat)
  const lons = corners.map((c) => c.lon)
  // The UTM square is a slightly skewed quadrilateral in lat/lon, so the box around it is the one
  // that covers the whole tile. Over-covering costs a little duplication, which the id dedup eats.
  return [Math.min(...lats), Math.min(...lons), Math.max(...lats), Math.max(...lons)].join(',')
}

async function tileWays(tile: string): Promise<CachedWay[]> {
  await mkdir(CACHE_DIR, { recursive: true })
  const path = join(CACHE_DIR, `roads_${tile}.json`)
  if (await exists(path)) return JSON.parse(await readFile(path, 'utf8')) as CachedWay[]

  const bbox = tileBbox(tile)
  const query =
    `[out:json][timeout:180];(way["highway"](${bbox});way["railway"](${bbox}););out geom;`
  let last: unknown
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      const res = await fetch(`${OVERPASS}?${new URLSearchParams({ data: query })}`, {
        headers: HEADERS,
      })
      // 429 is the rate limiter and 504 is a query that ran out of slots. Both are the server
      // asking to be left alone for a moment rather than anything wrong with the request, so they
      // get a flat wait instead of the escalating one -- there is no point backing off to minutes
      // over a limit that clears in seconds.
      if (res.status === 429 || res.status === 504) {
        const after = Number(res.headers.get('retry-after')) * 1000
        await new Promise((r) => setTimeout(r, after > 0 ? after : RATE_LIMIT_WAIT))
        continue
      }
      if (!res.ok) throw new Error(`overpass ${res.status} for ${tile}`)
      const { elements } = (await res.json()) as { elements: CachedWay[] }
      const kept = elements
        .filter((el) => el.geometry?.length > 1)
        .map((el) => ({ id: el.id, tags: el.tags ?? {}, geometry: el.geometry }))
      await writeFile(path, JSON.stringify(kept))
      return kept
    } catch (e) {
      last = e
      // Longer than the raster backoff: this is a shared community service and hammering it is
      // both rude and counterproductive.
      await new Promise((r) => setTimeout(r, 5000 * (attempt + 1)))
    }
  }
  throw new Error(
    `road data for tile ${tile} failed after 8 attempts: ${last ?? 'rate limited throughout'}. ` +
      `Refusing to continue -- without it the run would report lines over roads that are far too ` +
      `low to rig.`,
  )
}

export interface RoadsLoaded {
  index: RoadIndex
  ways: number
  /** Ways per tier, so the log says what kind of network the area actually has. */
  byTier: Record<string, number>
}

/**
 * Every road and railway under the given tiles, as one index.
 *
 * Two requests at a time. Overpass asks callers to stay light, and the whole point of the tile
 * cache is that this cost is paid once per area rather than once per run.
 */
export async function loadRoads(tiles: string[]): Promise<RoadsLoaded> {
  const queue = [...tiles]
  const perTile: CachedWay[][] = []
  await Promise.all(
    Array.from({ length: Math.min(2, queue.length) }, async () => {
      for (let tile = queue.pop(); tile; tile = queue.pop()) perTile.push(await tileWays(tile))
    }),
  )

  const index = new RoadIndex()
  const seen = new Set<number>()
  const byTier: Record<string, number> = {}
  let ways = 0
  for (const batch of perTile) {
    for (const way of batch) {
      if (seen.has(way.id)) continue
      seen.add(way.id)
      const classified = classifyWay(way.tags)
      if (!classified) continue
      const pts: number[] = []
      for (const { lat, lon } of way.geometry) pts.push(...toUtm33(lat, lon))
      const bridge = !!way.tags.bridge && way.tags.bridge !== 'no'
      const road: RoadWay = { ...classified, bridge, pts }
      index.add(road)
      ways++
      byTier[classified.tier] = (byTier[classified.tier] ?? 0) + 1
    }
  }
  return { index, ways, byTier }
}
