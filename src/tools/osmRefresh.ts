import { mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { toUtm33 } from '../shared/geo.js'
import { classifyWay } from '../shared/roads.js'
import { waterKind } from '../shared/water-tags.js'
import { BLOCK, blockKeysFor, encodeBlock, type OsmFeature, type OsmKind } from '../shared/osmBlocks.js'
import { MEMBER_WAY, readNodes, readWaysAndRelations, type PbfWay } from './osmPbf.js'
import { ensureExtract, extractPath } from './extract.js'

/**
 * Rebuilds the roads and water this project ships with itself, from an OpenStreetMap extract.
 *
 * Run it by hand, rarely: `npm run osm`. It is deliberately not part of the search pipeline. The
 * pipeline is about one area of interest and is re-run whenever a parameter changes; this is about
 * the whole state, changes only when OpenStreetMap does, and its output is committed. Coupling them
 * would mean every parameter tweak re-read three hundred megabytes to produce identical bytes.
 *
 * What it costs: one 4.4 GB download, cached, and a quarter of an hour of work. What it buys: the
 * deployed site asks nothing of any third party at run time, and the pipeline and the browser read
 * the same bytes rather than querying the same service separately and disagreeing.
 *
 * `npm run osm -- --fresh` downloads a new extract first; `npm run osm:upload` then publishes the
 * result. The blocks are not committed: they live in data/osm/ here and in R2 for the site.
 *
 * Three passes over the extract, which is cheaper than it sounds -- inflating the whole file takes
 * a minute and the alternative is holding four hundred million node positions.
 *
 *   1. ways and relations, keeping only what classifies as something a line must clear
 *   2. nodes, keeping only the positions those ways referred to
 *   3. assemble, project, block and write
 */

const OUT = new URL('../../data/osm/', import.meta.url).pathname
/**
 * All of Germany, because a line can be planned anywhere the elevation reaches, which is all of it.
 * Anything less leaves a live fallback in the browser for the rest, and that fallback was a shared
 * public service that is down often enough to read every lake outside the extract as dry ground.
 */
const STATE = 'germany'
const PBF = extractPath(STATE)

/**
 * Node ids, gathered with repeats and then sorted and made unique.
 *
 * Typed rather than a Set: V8 caps a Set at 2^24 entries and Germany's roads and water refer to
 * well over a hundred million nodes.
 */
class IdList {
  private ids = new Float64Array(1 << 20)
  private n = 0

  push(id: number): void {
    if (this.n === this.ids.length) {
      const grown = new Float64Array(this.n * 2)
      grown.set(this.ids)
      this.ids = grown
    }
    this.ids[this.n++] = id
  }

  sortedUnique(): Float64Array {
    const s = this.ids.subarray(0, this.n).sort()
    let w = 0
    for (let i = 0; i < s.length; i++) if (w === 0 || s[i] !== s[w - 1]) s[w++] = s[i]!
    this.ids = new Float64Array(0)
    return s.slice(0, w)
  }
}

function indexOf(sorted: Float64Array, id: number): number {
  let lo = 0
  let hi = sorted.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1
    const v = sorted[mid]!
    if (v === id) return mid
    if (v < id) lo = mid + 1
    else hi = mid - 1
  }
  return -1
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
  await ensureExtract(STATE, process.argv.includes('--fresh'))

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

  const kept: (Kept & { id: number })[] = []
  /** Geometry of relation members, which are outlines rather than features in their own right. */
  const memberRefs = new Map<number, number[]>()
  let ways = 0
  readWaysAndRelations(
    PBF,
    (w) => {
      ways++
      const k = keep(w)
      if (k) kept.push({ ...k, id: w.id })
      if (memberOf.has(w.id)) memberRefs.set(w.id, w.refs)
    },
    () => {},
  )
  console.log(
    `  ${ways.toLocaleString()} ways read, ${kept.length.toLocaleString()} kept, ` +
      `${memberRefs.size.toLocaleString()} outline members`,
  )

  const gathered = new IdList()
  for (const k of kept) for (const ref of k.refs) gathered.push(ref)
  for (const refs of memberRefs.values()) for (const ref of refs) gathered.push(ref)
  const wanted = gathered.sortedUnique()
  console.log(`  ${wanted.length.toLocaleString()} node positions needed`)

  console.log('[2/3] nodes')
  // Projected on the way in: proj4 over every point is the expensive part of this script, and
  // doing it here means it happens once per node rather than once per way that shares it.
  // Nodes arrive sorted by id, so one cursor walks `wanted` alongside them; that is checked rather
  // than assumed, because an unsorted file would silently lose positions.
  const pos = new Float64Array(wanted.length * 2).fill(NaN)
  let cursor = 0
  let last = -Infinity
  let found = 0
  let outside = 0
  const seen = readNodes(PBF, (id, lat, lon) => {
    if (id <= last) throw new Error(`nodes not sorted by id at ${id}`)
    last = id
    while (cursor < wanted.length && wanted[cursor]! < id) cursor++
    if (wanted[cursor] !== id) return
    if (lat < 45 || lat > 60 || lon < 5 || lon > 25) {
      outside++
      return
    }
    const [e, n] = toUtm33(lat, lon)
    pos[cursor * 2] = e
    pos[cursor * 2 + 1] = n
    found++
  })
  if (seen.plain) throw new Error(`${seen.plain} plain node groups: geometry would be incomplete`)
  console.log(`  ${seen.dense.toLocaleString()} scanned, ${found.toLocaleString()} kept`)
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
      const i = indexOf(wanted, ref)
      if (i < 0 || Number.isNaN(pos[i * 2]!)) return null
      pts.push(pos[i * 2]!, pos[i * 2 + 1]!)
    }
    return pts.length >= 4 ? pts : null
  }

  let incomplete = 0
  for (const k of kept) {
    const pts = geometryOf(k.refs)
    if (!pts) {
      incomplete++
      continue
    }
    add({ id: k.id, kind: k.kind, name: k.name, half: k.half, bridge: k.bridge, pts })
  }
  kept.length = 0

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

  // The version names the directory the blocks are published under, so a browser holding blocks of
  // one build in its cache can never mix them with another's index.
  const generated = new Date().toISOString()
  const version = generated.slice(0, 16).replace(/[-:]/g, '').replace('T', '-')
  await rm(OUT, { recursive: true, force: true })
  await mkdir(join(OUT, version), { recursive: true })
  let bytes = 0
  for (const [key, features] of blocks) {
    const packed = encodeBlock(key, features)
    bytes += packed.length
    await writeFile(join(OUT, version, `${key}.bin`), packed)
  }
  await writeFile(
    join(OUT, 'index.json'),
    JSON.stringify({
      block: BLOCK,
      source: `geofabrik ${STATE}`,
      generated,
      version,
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

  const listing = await readdir(join(OUT, version))
  console.log(`${listing.length} blocks in data/osm/${version}/`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
