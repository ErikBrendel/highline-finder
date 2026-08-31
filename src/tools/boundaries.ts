import { mkdir, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { toUtm33, toWgs84 } from '../shared/geo.js'
import { MEMBER_WAY, readNodes, readWaysAndRelations } from './osmPbf.js'

/**
 * Extracts the Berlin and Brandenburg state borders from the OpenStreetMap extract.
 *
 * Run it by hand, about never: `npm run boundaries`. A state border moves less often than anything
 * else this project draws, and the output is committed, so the deployed site asks nothing of anyone
 * to know where Brandenburg ends.
 *
 * The same extract `osmRefresh` already downloads and the same three passes, for the same reason:
 * a relation names its member ways, the ways come first in the file, and nothing about a member way
 * says which relation wants it. So the relations are read to learn the ids, the ways are read again
 * to get their node references, and the nodes are read to get positions.
 *
 * Only outer members are kept. Brandenburg's relation carries Berlin as an inner ring -- the state
 * genuinely has a hole in it -- and drawing that would put a second line under Berlin's own.
 */

const CACHE = new URL('../../data/cache/', import.meta.url).pathname
const PBF = join(CACHE, 'brandenburg-latest.osm.pbf')
const OUT = new URL('../web/public/boundaries.json', import.meta.url).pathname

/** The two relations wanted, by the tags that identify a German federal state. */
const WANTED = ['Berlin', 'Brandenburg']
const isState = (tags: Record<string, string>) =>
  tags.boundary === 'administrative' &&
  tags.admin_level === '4' &&
  tags.type === 'boundary' &&
  WANTED.includes(tags.name ?? '')

/**
 * Douglas-Peucker, on projected metres so the tolerance means what it says.
 *
 * A state border in OpenStreetMap is surveyed to the field boundary and Brandenburg's runs to a
 * hundred thousand points, which is more than the whole line dataset. At the zoom this is drawn --
 * a border seen against a whole state -- a hundred metres of detour is a fraction of a pixel, so
 * what survives is the shape and none of the surveying.
 */
function simplify(pts: number[][], tolerance: number): number[][] {
  if (pts.length < 3) return pts
  const keep = new Uint8Array(pts.length)
  keep[0] = 1
  keep[pts.length - 1] = 1
  const stack: [number, number][] = [[0, pts.length - 1]]
  while (stack.length) {
    const [from, to] = stack.pop()!
    const [ax, ay] = pts[from] as [number, number]
    const [bx, by] = pts[to] as [number, number]
    const dx = bx - ax
    const dy = by - ay
    const span = Math.hypot(dx, dy)
    let worst = -1
    let at = -1
    for (let i = from + 1; i < to; i++) {
      const [px, py] = pts[i] as [number, number]
      // Distance to the segment, or to the point itself where the segment has no length.
      const d = span
        ? Math.abs(dy * px - dx * py + bx * ay - by * ax) / span
        : Math.hypot(px - ax, py - ay)
      if (d > worst) {
        worst = d
        at = i
      }
    }
    if (worst <= tolerance || at < 0) continue
    keep[at] = 1
    stack.push([from, at], [at, to])
  }
  return pts.filter((_, i) => keep[i])
}

/**
 * Joins member ways end to end into the longest chains they will make.
 *
 * A border is split across hundreds of ways in no particular order or direction, so they have to be
 * walked from either end until nothing else attaches. What comes out is usually one chain per ring.
 *
 * Closure is not required, and that is deliberate. Brandenburg's relation names 539 outer ways and
 * the extract holds 538 of them -- one way short, because Geofabrik clips at the state boundary and
 * the border is exactly where clipping is decided. Demanding a closed ring threw away the other 538
 * for it. This is drawn as a line rather than filled as a polygon, so a chain missing a few metres
 * of itself draws correctly and the gap is reported rather than being fatal.
 */
function stitch(parts: number[][][]): { chains: number[][][]; gaps: number[]; stubs: number } {
  const open = parts.filter((p) => p.length >= 2)
  const chains: number[][][] = []
  const gaps: number[] = []
  let stubs = 0
  const same = (a: number[], b: number[]) =>
    Math.abs(a[0]! - b[0]!) < 0.5 && Math.abs(a[1]! - b[1]!) < 0.5

  const extend = (chain: number[][]): number[][] | null => {
    const tail = chain[chain.length - 1]!
    for (let i = 0; i < open.length; i++) {
      const part = open[i]!
      const forward = same(tail, part[0]!)
      if (!forward && !same(tail, part[part.length - 1]!)) continue
      open.splice(i, 1)
      return chain.concat((forward ? part : [...part].reverse()).slice(1))
    }
    return null
  }

  const lengthOf = (c: number[][]) => {
    let m = 0
    for (let i = 1; i < c.length; i++) m += Math.hypot(c[i]![0]! - c[i - 1]![0]!, c[i]![1]! - c[i - 1]![1]!)
    return m
  }

  while (open.length) {
    let chain = open.pop()!
    // Grow from the tail until nothing attaches, then turn round and grow from what was the head.
    // The seed is as often in the middle of a border as at one end of it.
    for (const _ of [0, 1]) {
      for (let grown = extend(chain); grown; grown = extend(chain)) chain = grown
      chain = [...chain].reverse()
    }
    // Stubs, not borders. A handful of two- and three-point fragments a metre long come out of
    // both relations -- duplicated or zero-length ways, which every large OSM relation collects --
    // and drawn at 3 px each is a dot sitting on the border for no reason.
    if (lengthOf(chain) < MIN_CHAIN_M) {
      stubs++
      continue
    }
    chains.push(chain)
    const [head, tail] = [chain[0]!, chain[chain.length - 1]!]
    if (!same(head, tail)) gaps.push(Math.hypot(head[0]! - tail[0]!, head[1]! - tail[1]!))
  }
  return { chains, gaps, stubs }
}

async function main() {
  try {
    await stat(PBF)
  } catch {
    throw new Error(`${PBF} is missing -- run \`npm run osm\` first, which downloads it`)
  }

  console.log('[1/3] relations')
  const wantWays = new Map<number, string>()
  const found = new Map<string, number>()
  readWaysAndRelations(
    PBF,
    () => {},
    (rel) => {
      if (!isState(rel.tags)) return
      const name = rel.tags.name!
      found.set(name, (found.get(name) ?? 0) + 1)
      for (const m of rel.members) {
        // Outer only: Brandenburg's inner ring is Berlin, which is drawn as itself.
        if (m.type !== MEMBER_WAY || (m.role !== 'outer' && m.role !== '')) continue
        wantWays.set(m.ref, name)
      }
    },
  )
  for (const name of WANTED) {
    if (!found.get(name)) throw new Error(`no admin_level=4 boundary relation named ${name}`)
  }
  console.log(`  ${[...found].map(([n, c]) => `${n} x${c}`).join(', ')}, ${wantWays.size} member ways`)

  console.log('[2/3] ways')
  const wayRefs = new Map<number, number[]>()
  const wantNodes = new Set<number>()
  readWaysAndRelations(
    PBF,
    (w) => {
      if (!wantWays.has(w.id)) return
      wayRefs.set(w.id, w.refs)
      for (const r of w.refs) wantNodes.add(r)
    },
    () => {},
  )
  console.log(`  ${wayRefs.size} ways, ${wantNodes.size.toLocaleString()} nodes to place`)

  console.log('[3/3] nodes')
  const at = new Map<number, [number, number]>()
  const { plain } = readNodes(PBF, (id, lat, lon) => {
    if (wantNodes.has(id)) at.set(id, toUtm33(lat, lon) as [number, number])
  })
  if (plain) throw new Error(`${plain} plain nodes -- this reader only handles DenseNodes`)
  console.log(`  placed ${at.size.toLocaleString()} of ${wantNodes.size.toLocaleString()}`)

  const features = WANTED.map((name) => {
    const parts: number[][][] = []
    for (const [id, owner] of wantWays) {
      if (owner !== name) continue
      const refs = wayRefs.get(id)
      if (!refs) continue
      const pts = refs.map((r) => at.get(r)).filter(Boolean) as [number, number][]
      if (pts.length >= 2) parts.push(pts)
    }
    const { chains, gaps, stubs } = stitch(parts)
    const before = chains.reduce((n, r) => n + r.length, 0)
    const kept = chains.map((r) => simplify(r, TOLERANCE))
    const after = kept.reduce((n, r) => n + r.length, 0)
    console.log(
      `  ${name}: ${chains.length} chain(s), ${before.toLocaleString()} -> ` +
        `${after.toLocaleString()} points at ${TOLERANCE} m` +
        (gaps.length
          ? `, ${gaps.length} not closed (largest gap ${Math.max(...gaps).toFixed(0)} m)`
          : ', all closed') +
        (stubs ? `, ${stubs} stub(s) dropped` : ''),
    )
    return {
      type: 'Feature' as const,
      properties: { name },
      geometry: {
        type: 'MultiLineString' as const,
        coordinates: kept.map((ring) =>
          ring.map(([e, n]) => {
            const { lat, lon } = toWgs84(e, n)
            return [Math.round(lon * 1e5) / 1e5, Math.round(lat * 1e5) / 1e5]
          }),
        ),
      },
    }
  })

  await mkdir(new URL('../web/public/', import.meta.url).pathname, { recursive: true })
  const text = JSON.stringify({ type: 'FeatureCollection', features })
  await writeFile(OUT, text)
  console.log(`\nwrote boundaries.json (${(text.length / 1024).toFixed(0)} KB)`)
}

/**
 * Simplification tolerance in metres.
 *
 * A hundred metres is about a pixel at the zoom a whole state fits on screen, and a fifth of one at
 * the zoom where the lines themselves become legible -- past which the border is scenery rather
 * than something anyone is reading off.
 */
const TOLERANCE = 100

/** Shortest chain worth drawing. Below this it is an artefact of the relation, not a border. */
const MIN_CHAIN_M = 1000

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
