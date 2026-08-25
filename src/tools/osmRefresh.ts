import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { createWriteStream } from 'node:fs'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { join } from 'node:path'
import { toUtm33 } from '../shared/geo.js'
import { classifyWay } from '../shared/roads.js'
import { BLOCK, blockKeysFor, encodeBlock, type OsmFeature, type OsmKind } from '../shared/osmBlocks.js'
import { MEMBER_WAY, readNodes, readWaysAndRelations, type PbfWay } from './osmPbf.js'

/**
 * Rebuilds the roads and water this project ships with itself, from an OpenStreetMap extract.
 *
 * Run it by hand, rarely: `npm run osm`. It is deliberately not part of the search pipeline. The
 * pipeline is about one area of interest and is re-run whenever a parameter changes; this is about
 * the whole state, changes only when OpenStreetMap does, and its output is committed. Coupling them
 * would mean every parameter tweak re-read three hundred megabytes to produce identical bytes.
 *
 * What it costs: one 285 MB download, cached, and about a minute of work. What it buys: the
 * deployed site asks nothing of any third party at run time, and the pipeline and the browser read
 * the same bytes rather than querying the same service separately and disagreeing.
 *
 * Three passes over the extract, which is cheaper than it sounds -- inflating the whole file takes
 * six seconds and the alternative is holding thirty million node positions.
 *
 *   1. ways and relations, keeping only what classifies as something a line must clear
 *   2. nodes, keeping only the positions those ways referred to
 *   3. assemble, project, block and write
 */

const SOURCE = 'https://download.geofabrik.de/europe/germany/brandenburg-latest.osm.pbf'
const CACHE = new URL('../../data/cache/', import.meta.url).pathname
const OUT = new URL('../web/public/osm/', import.meta.url).pathname
const PBF = join(CACHE, 'brandenburg-latest.osm.pbf')

/** Water tags worth drawing. Same set the Overpass query used, so nothing changes visually. */
function waterKind(tags: Record<string, string>): OsmKind | null {
  if (tags.natural === 'water') return 'water'
  if (tags.waterway === 'riverbank') return 'water'
  if (tags.landuse === 'reservoir' || tags.landuse === 'basin') return 'water'
  // Rivers and streams as lines, for the chart to draw where there is no polygon.
  if (tags.waterway === 'river' || tags.waterway === 'canal') return 'waterway'
  return null
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

async function download(): Promise<void> {
  if (await exists(PBF)) {
    const { size, mtime } = await stat(PBF)
    console.log(
      `extract cached: ${(size / 1048576).toFixed(0)} MB, downloaded ${mtime.toISOString().slice(0, 10)}` +
        ` (delete it to refresh)`,
    )
    return
  }
  await mkdir(CACHE, { recursive: true })
  console.log(`downloading ${SOURCE}`)
  const res = await fetch(SOURCE, { headers: { 'User-Agent': 'highline-finder/0.1' } })
  if (!res.ok || !res.body) throw new Error(`extract download failed: HTTP ${res.status}`)
  await pipeline(Readable.fromWeb(res.body as never), createWriteStream(PBF))
  console.log(`  ${((await stat(PBF)).size / 1048576).toFixed(0)} MB`)
}

/** A way we intend to keep, with its classification already decided. */
interface Kept {
  kind: OsmKind
  name: string
  half: number
  bridge: boolean
  refs: number[]
}

function keep(w: PbfWay): Kept | null {
  const road = classifyWay(w.tags)
  if (road) {
    return {
      kind: road.tier,
      name: road.kind,
      half: road.half,
      bridge: !!w.tags.bridge && w.tags.bridge !== 'no',
      refs: w.refs,
    }
  }
  if (w.tags.tunnel && w.tags.tunnel !== 'no') return null
  const water = waterKind(w.tags)
  return water ? { kind: water, name: water, half: 0, bridge: false, refs: w.refs } : null
}

/**
 * Stitches a multipolygon's outer member ways into closed rings.
 *
 * A big lake or a river is a relation whose outline is split across several ways that only form a
 * ring once joined end to end, and in no particular order or direction. Emitting them separately --
 * which is what the Overpass code did -- gives open polylines, and a point-in-polygon test on an
 * open polyline answers nonsense. Anything that will not close is dropped and counted.
 */
function stitch(parts: number[][]): { rings: number[][]; dropped: number } {
  const open = parts.filter((p) => p.length >= 4)
  const rings: number[][] = []
  let dropped = 0
  const endsMatch = (a: number[], b: number[]) =>
    Math.abs(a[a.length - 2]! - b[0]!) < 0.5 && Math.abs(a[a.length - 1]! - b[1]!) < 0.5

  /** Attaches whichever remaining part continues this chain, in either direction. */
  const extend = (ring: number[]): number[] | null => {
    for (let i = 0; i < open.length; i++) {
      const forward = endsMatch(ring, open[i]!)
      if (!forward && !endsMatch(ring, reverse(open[i]!))) continue
      const next = forward ? open[i]! : reverse(open[i]!)
      open.splice(i, 1)
      return ring.concat(next.slice(2))
    }
    return null
  }

  while (open.length) {
    let ring = open.pop()!
    while (!endsMatch(ring, ring)) {
      const grown = extend(ring)
      if (grown) {
        ring = grown
        continue
      }
      // Nothing continues this end. The seed was in the middle of the ring as often as not, so the
      // rest of it attaches at the *front* -- turn the chain around and keep going from there.
      // Only when neither end takes anything is the ring genuinely unfinishable.
      const flipped = extend(reverse(ring))
      if (!flipped) break
      ring = flipped
    }
    if (endsMatch(ring, ring)) rings.push(ring)
    else dropped++
  }
  return { rings, dropped }
}

const reverse = (pts: number[]): number[] => {
  const out: number[] = []
  for (let i = pts.length - 2; i >= 0; i -= 2) out.push(pts[i]!, pts[i + 1]!)
  return out
}

async function main(): Promise<void> {
  const started = Date.now()
  await download()

  /**
   * Relations first, on their own pass.
   *
   * A multipolygon's member ways carry no tags -- the tags are on the relation -- so nothing about
   * a member way says it is part of a lake. Ways come before relations in the file, so by the time
   * the relation is read the ways are gone. Hence two passes: learn which way ids matter, then
   * read the ways knowing it.
   */
  console.log('[1/3] relations, then ways')
  const waterRelations: { outer: number[]; inner: number[] }[] = []
  const memberOf = new Set<number>()
  readWaysAndRelations(PBF, () => {}, (rel) => {
    if (!waterKind(rel.tags)) return
    const ways = rel.members.filter((m) => m.type === MEMBER_WAY)
    const outer = ways.filter((m) => m.role !== 'inner')
    if (!outer.length) return
    // Inner rings are islands, and they used to be dropped here. A lake with a wooded island in it
    // then read as water all the way across -- invisible while water was only ever drawn, and wrong
    // the moment a line is allowed less clearance over water than over ground.
    const inner = ways.filter((m) => m.role === 'inner')
    waterRelations.push({ outer: outer.map((m) => m.ref), inner: inner.map((m) => m.ref) })
    for (const m of ways) memberOf.add(m.ref)
  })
  console.log(
    `  ${waterRelations.length.toLocaleString()} water multipolygons ` +
      `(${waterRelations.filter((r) => r.inner.length).length.toLocaleString()} with islands)`,
  )

  const kept = new Map<number, Kept>()
  /** Geometry of relation members, which are outlines rather than features in their own right. */
  const memberRefs = new Map<number, number[]>()
  let ways = 0
  readWaysAndRelations(
    PBF,
    (w) => {
      ways++
      const k = keep(w)
      if (k) kept.set(w.id, k)
      if (memberOf.has(w.id)) memberRefs.set(w.id, w.refs)
    },
    () => {},
  )
  console.log(
    `  ${ways.toLocaleString()} ways read, ${kept.size.toLocaleString()} kept, ` +
      `${memberRefs.size.toLocaleString()} outline members`,
  )

  const wanted = new Set<number>()
  for (const k of kept.values()) for (const ref of k.refs) wanted.add(ref)
  for (const refs of memberRefs.values()) for (const ref of refs) wanted.add(ref)
  console.log(`  ${wanted.size.toLocaleString()} node positions needed`)

  console.log('[2/3] nodes')
  // Projected on the way in: proj4 over ten million points is the expensive part of this script,
  // and doing it here means it happens once per node rather than once per way that shares it.
  const at = new Map<number, [number, number]>()
  let outside = 0
  const seen = readNodes(PBF, (id, lat, lon) => {
    if (!wanted.has(id)) return
    if (lat < 45 || lat > 60 || lon < 5 || lon > 25) {
      outside++
      return
    }
    at.set(id, toUtm33(lat, lon))
  })
  if (seen.plain) throw new Error(`${seen.plain} plain node groups: geometry would be incomplete`)
  console.log(`  ${seen.dense.toLocaleString()} scanned, ${at.size.toLocaleString()} kept`)
  if (outside) throw new Error(`${outside} nodes outside plausible bounds: the decode is wrong`)

  console.log('[3/3] blocks')
  const blocks = new Map<string, OsmFeature[]>()
  const add = (f: OsmFeature) => {
    let minE = Infinity
    let minN = Infinity
    let maxE = -Infinity
    let maxN = -Infinity
    for (let i = 0; i < f.pts.length; i += 2) {
      if (f.pts[i]! < minE) minE = f.pts[i]!
      if (f.pts[i]! > maxE) maxE = f.pts[i]!
      if (f.pts[i + 1]! < minN) minN = f.pts[i + 1]!
      if (f.pts[i + 1]! > maxN) maxN = f.pts[i + 1]!
    }
    // Whole ways into every block they touch, deduplicated on load. Clipping them at the boundary
    // would be tidier and is not worth the arithmetic: most ways are far shorter than a block.
    for (const key of blockKeysFor(minE, minN, maxE, maxN)) {
      const list = blocks.get(key)
      if (list) list.push(f)
      else blocks.set(key, [f])
    }
  }

  const geometryOf = (refs: number[]): number[] | null => {
    const pts: number[] = []
    for (const ref of refs) {
      const p = at.get(ref)
      if (!p) return null
      pts.push(p[0], p[1])
    }
    return pts.length >= 4 ? pts : null
  }

  let incomplete = 0
  for (const [id, k] of kept) {
    const pts = geometryOf(k.refs)
    if (!pts) {
      incomplete++
      continue
    }
    add({ id, kind: k.kind, name: k.name, half: k.half, bridge: k.bridge, pts })
  }

  let stitched = 0
  let islands = 0
  let unstitched = 0
  /**
   * Stitched rings get their own ids, counting down from -1.
   *
   * Way ids are positive, so nothing here can collide with one. They used to carry the relation id
   * negated, which meant every ring of one relation shared an id -- and since blocks deduplicate by
   * id, only the first ring of a multi-ring lake survived being read back. One id per ring fixes
   * that as well as making room for the islands.
   */
  let ringId = 0
  const ringsOf = (members: number[]) => {
    const geoms = members
      .map((id) => memberRefs.get(id))
      .filter((refs): refs is number[] => !!refs)
      .map(geometryOf)
      .filter((g): g is number[] => !!g)
    return geoms.length ? stitch(geoms) : { rings: [], dropped: 0 }
  }

  for (const { outer, inner } of waterRelations) {
    const shell = ringsOf(outer)
    unstitched += shell.dropped
    for (const ring of shell.rings) {
      stitched++
      add({ id: --ringId, kind: 'water', name: 'water', half: 0, bridge: false, pts: ring })
    }
    // No shell means no lake to put an island in: the outline did not survive the extract's edge.
    if (!shell.rings.length) continue
    const holes = ringsOf(inner)
    unstitched += holes.dropped
    for (const ring of holes.rings) {
      islands++
      add({ id: --ringId, kind: 'island', name: 'island', half: 0, bridge: false, pts: ring })
    }
  }

  await rm(OUT, { recursive: true, force: true })
  await mkdir(OUT, { recursive: true })
  let bytes = 0
  for (const [key, features] of blocks) {
    const packed = encodeBlock(key, features)
    bytes += packed.length
    await writeFile(join(OUT, `${key}.bin`), packed)
  }
  await writeFile(
    join(OUT, 'index.json'),
    JSON.stringify({
      block: BLOCK,
      source: SOURCE,
      generated: new Date().toISOString(),
      blocks: [...blocks.keys()].sort(),
    }),
  )

  const byKind = new Map<string, number>()
  for (const list of blocks.values()) {
    for (const f of list) byKind.set(f.kind, (byKind.get(f.kind) ?? 0) + 1)
  }
  console.log(
    `  ${blocks.size} blocks, ${(bytes / 1048576).toFixed(1)} MB, ` +
      `largest ${(Math.max(...[...blocks.values()].map((l) => l.length))).toLocaleString()} features`,
  )
  console.log(`  ${[...byKind].map(([k, n]) => `${n.toLocaleString()} ${k}`).join(', ')} (with duplicates across blocks)`)
  if (incomplete) console.log(`  ${incomplete.toLocaleString()} ways dropped for missing nodes (clipped at the extract's edge)`)
  console.log(
    `  ${stitched.toLocaleString()} multipolygon rings stitched, ` +
      `${islands.toLocaleString()} islands inside them, ${unstitched} would not close`,
  )
  console.log(`done in ${((Date.now() - started) / 1000).toFixed(1)}s`)

  const listing = await readdir(OUT)
  console.log(`${listing.length} files in src/web/public/osm/`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
