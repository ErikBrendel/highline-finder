import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { toUtm33, toWgs84 } from '../shared/geo.js'
import { classifyWay, RoadIndex, type RoadWay, type Tags } from '../shared/roads.js'

/**
 * Fetches the road and rail network and indexes it for the clearance check.
 *
 * OpenStreetMap rather than the survey. The Brandenburg portal publishes roads only as ALKIS
 * `tatsaechliche_nutzung`, which renders as lines and labels rather than as anything with a
 * classification attached, and it has nothing at all for Berlin. OSM has the classification, the
 * lane counts and the bridge and tunnel tags, which is exactly what the clearance ladder keys on.
 *
 * Cached per 1 km tile, on the same grid as everything else, so a re-run costs nothing and growing
 * an area only fetches what it added. But *fetched* per block of tiles, which is not the same
 * thing: one request per square kilometre got the machine refused by Overpass after twelve of the
 * hundred and twelve a single region needed. Overpass is a shared community service and a hundred
 * small queries is worse for it than a handful of large ones, so missing tiles are grouped into
 * blocks and each block asked for once. The per-tile files are still written, so the cache stays
 * as incremental as it was.
 *
 * Unlike the city model, a failure here is fatal. A missing LoD1 tile costs roof anchors and the
 * run is still correct about everything else; a missing road tile means the run silently stops
 * asking for height over traffic and reports lines four metres over a Bundesstraße as candidates.
 * There is no safe way to continue past that, so it throws -- and every tile that did arrive is
 * already on disk, so restarting resumes rather than starting again.
 */

/**
 * Endpoints, tried in order. The second is a mirror that explicitly invites heavy use; it exists so
 * a run does not die because the main instance is busy, not so both can be hammered at once.
 */
const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
]

/**
 * Overpass refuses a request with no User-Agent outright -- 406, with an HTML error page for a body
 * -- and asks callers to identify themselves so it can talk to whoever is overloading it. The
 * browser half of this project never hits that because a browser sends its own.
 */
const HEADERS = {
  'User-Agent': 'highline-finder/0.1 (+https://github.com/ErikBrendel/highline-finder)',
}

/** Tiles per side of one request. 5 km squared is a few megabytes of roads, even over a town. */
const BLOCK = 5

/** Pause between requests, so a run is a polite trickle rather than a burst. */
const BETWEEN_REQUESTS = 2000

/** Seconds to wait after a rate-limit refusal, when the server does not say. */
const RATE_LIMIT_WAIT = 30_000

const CACHE_DIR = new URL('../../data/cache/', import.meta.url).pathname

/**
 * What is kept per tile: enough to classify and to intersect, and nothing else.
 *
 * Geometry is stored already projected, flat as `[e, n, e, n, ...]`. Overpass answers in WGS84, so
 * something has to convert; doing it once at fetch time rather than on every load keeps proj4 off
 * the path a re-run takes, and drops the `{lat, lon}` key names from the file.
 */
interface CachedWay {
  id: number
  tags: Tags
  pts: number[]
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

const pathFor = (tile: string) => join(CACHE_DIR, `roads_${tile}.json`)

/** The UTM square a 1 km tile covers. */
function tileBox(tile: string): { minE: number; minN: number; maxE: number; maxN: number } {
  const [e, n] = tile.slice(2).split('-').map(Number) as [number, number]
  return { minE: e * 1000, minN: n * 1000, maxE: (e + 1) * 1000, maxN: (n + 1) * 1000 }
}

/**
 * The WGS84 bounding box covering a set of tiles, as Overpass wants it: south, west, north, east.
 *
 * All four corners of the UTM extent, because the square is a slightly skewed quadrilateral in
 * latitude and longitude and the box around it is the only one that covers the whole of it. Over-
 * covering costs a little duplication, which the id deduplication on load eats.
 */
function bboxOf(tiles: string[]): string {
  const boxes = tiles.map(tileBox)
  const minE = Math.min(...boxes.map((b) => b.minE))
  const minN = Math.min(...boxes.map((b) => b.minN))
  const maxE = Math.max(...boxes.map((b) => b.maxE))
  const maxN = Math.max(...boxes.map((b) => b.maxN))
  const corners = [
    toWgs84(minE, minN),
    toWgs84(maxE, minN),
    toWgs84(minE, maxN),
    toWgs84(maxE, maxN),
  ]
  const lats = corners.map((c) => c.lat)
  const lons = corners.map((c) => c.lon)
  return [Math.min(...lats), Math.min(...lons), Math.max(...lats), Math.max(...lons)].join(',')
}

interface OverpassWay {
  id: number
  tags?: Tags
  geometry?: { lat: number; lon: number }[]
}

/**
 * One block's worth of ways, retried across both endpoints.
 *
 * 429 and 504 are the rate limiter and a query that ran out of slots -- the server asking to be
 * left alone rather than anything wrong with the request -- so they get a flat wait. A dropped
 * socket gets an escalating one and the next endpoint.
 */
async function fetchBlock(tiles: string[], label: string): Promise<CachedWay[]> {
  const bbox = bboxOf(tiles)
  const query =
    `[out:json][timeout:300];(way["highway"](${bbox});way["railway"](${bbox}););out geom;`
  let last: unknown
  for (let attempt = 0; attempt < 6; attempt++) {
    const endpoint = ENDPOINTS[attempt % ENDPOINTS.length]!
    try {
      const res = await fetch(`${endpoint}?${new URLSearchParams({ data: query })}`, {
        headers: HEADERS,
      })
      if (res.status === 429 || res.status === 504) {
        const after = Number(res.headers.get('retry-after')) * 1000
        await new Promise((r) => setTimeout(r, after > 0 ? after : RATE_LIMIT_WAIT))
        continue
      }
      if (!res.ok) throw new Error(`overpass ${res.status}`)
      const { elements } = (await res.json()) as { elements: OverpassWay[] }
      return elements
        .filter((el) => (el.geometry?.length ?? 0) > 1)
        .map((el) => ({
          id: el.id,
          tags: el.tags ?? {},
          pts: el.geometry!.flatMap(({ lat, lon }) => toUtm33(lat, lon)),
        }))
    } catch (e) {
      last = e
      await new Promise((r) => setTimeout(r, 5000 * (attempt + 1)))
    }
  }
  throw new Error(
    `road data for ${label} failed after 6 attempts: ${last ?? 'rate limited throughout'}. ` +
      `Refusing to continue -- without it the run would report lines over roads that are far too ` +
      `low to rig. Everything already fetched is cached, so re-running resumes here.`,
  )
}

/** Whether a way's own extent reaches into a tile's square. Cheap and deliberately generous. */
function touches(pts: number[], box: ReturnType<typeof tileBox>): boolean {
  let minE = Infinity
  let minN = Infinity
  let maxE = -Infinity
  let maxN = -Infinity
  for (let i = 0; i + 1 < pts.length; i += 2) {
    if (pts[i]! < minE) minE = pts[i]!
    if (pts[i]! > maxE) maxE = pts[i]!
    if (pts[i + 1]! < minN) minN = pts[i + 1]!
    if (pts[i + 1]! > maxN) maxN = pts[i + 1]!
  }
  return minE <= box.maxE && maxE >= box.minE && minN <= box.maxN && maxN >= box.minN
}

/** Groups tiles into square blocks, so one request covers a compact area rather than a scatter. */
function blocksOf(tiles: string[]): string[][] {
  const groups = new Map<string, string[]>()
  for (const tile of tiles) {
    const [e, n] = tile.slice(2).split('-').map(Number) as [number, number]
    const key = `${Math.floor(e / BLOCK)}_${Math.floor(n / BLOCK)}`
    const group = groups.get(key)
    if (group) group.push(tile)
    else groups.set(key, [tile])
  }
  return [...groups.values()]
}

export interface RoadsLoaded {
  index: RoadIndex
  ways: number
  /** Ways per tier, so the log says what kind of network the area actually has. */
  byTier: Record<string, number>
  /** Blocks that had to be fetched, so a re-run's zero is visible. */
  fetched: number
}

/**
 * Every road and railway under the given tiles, as one index.
 *
 * One request at a time with a pause between, which is what Overpass asks of anyone running a
 * batch. The work is bounded by how much *new* area a run covers, not by its size, so this is only
 * slow the first time an area is searched.
 */
export async function loadRoads(tiles: string[]): Promise<RoadsLoaded> {
  await mkdir(CACHE_DIR, { recursive: true })
  const missing: string[] = []
  for (const tile of tiles) if (!(await exists(pathFor(tile)))) missing.push(tile)

  const blocks = blocksOf(missing)
  for (const [i, block] of blocks.entries()) {
    const label = `${block.length} tile(s) around ${block[0]}`
    process.stdout.write(`  roads: block ${i + 1}/${blocks.length}, ${label}\r`)
    const ways = await fetchBlock(block, label)
    // Every tile of the block gets its own file, including the empty ones -- an empty file is the
    // answer "no roads here" and is what stops the tile being asked for again.
    await Promise.all(
      block.map((tile) => {
        const box = tileBox(tile)
        return writeFile(pathFor(tile), JSON.stringify(ways.filter((w) => touches(w.pts, box))))
      }),
    )
    if (i + 1 < blocks.length) await new Promise((r) => setTimeout(r, BETWEEN_REQUESTS))
  }
  if (blocks.length) process.stdout.write(`${' '.repeat(60)}\r`)

  const index = new RoadIndex()
  const seen = new Set<number>()
  const byTier: Record<string, number> = {}
  let ways = 0
  for (const tile of tiles) {
    for (const way of JSON.parse(await readFile(pathFor(tile), 'utf8')) as CachedWay[]) {
      // A way reaching into two tiles is written to both, so the id is what makes it one way.
      if (seen.has(way.id)) continue
      seen.add(way.id)
      const classified = classifyWay(way.tags)
      if (!classified) continue
      const bridge = !!way.tags.bridge && way.tags.bridge !== 'no'
      const road: RoadWay = { ...classified, bridge, pts: way.pts }
      index.add(road)
      ways++
      byTier[classified.tier] = (byTier[classified.tier] ?? 0) + 1
    }
  }
  return { index, ways, byTier, fetched: blocks.length }
}
