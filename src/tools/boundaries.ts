import { mkdir, writeFile } from 'node:fs/promises'
import { toUtm33, toWgs84 } from '../shared/geo.js'
import { MEMBER_WAY, readNodes, readWaysAndRelations } from './osmPbf.js'
import { ensureExtract } from './extract.js'
import { simplify } from './simplify.js'
import states from '../web/states.json'

/**
 * Extracts the state borders of everywhere this app can measure, from OpenStreetMap extracts.
 *
 * Run it by hand, about never: `npm run boundaries`. A state border moves less often than anything
 * else this project draws, and the output is committed, so the deployed site asks nothing of anyone
 * to know where a survey ends.
 *
 * One extract per state, because Geofabrik cuts them that way and a state's own extract is the
 * cheapest place to find its own relation. Each is read in the same three passes, for the same
 * reason: a relation names its member ways, the ways come first in the file, and nothing about a
 * member way says which relation wants it. So the relations are read to learn the ids, the ways are
 * read again to get their node references, and the nodes are read to get positions.
 *
 * Only outer members are kept. Brandenburg's relation carries Berlin as an inner ring -- the state
 * genuinely has a hole in it -- and drawing that would put a second line under Berlin's own.
 */

const OUT = new URL('../web/public/boundaries.json', import.meta.url).pathname
/**
 * Metres per degree of latitude, and the same for longitude at the latitude in question.
 *
 * A local flat-earth metric, which is all the trimming below needs: it compares distances of a few
 * kilometres between points a few kilometres apart, and the question it answers is only whether two
 * lines are the same line. Reusing the UTM projection would be worse, not better -- the national
 * outline reaches to Aachen, five zones west of the one this project works in.
 */
const M_PER_DEGREE = 111_320

const flat = (lon: number, lat: number, cosLat: number): [number, number] => [
  lon * cosLat * M_PER_DEGREE,
  lat * M_PER_DEGREE,
]

/** Distance from `p` to segment `a`-`b`, and the point on it that is nearest. */
function toSegment(
  p: [number, number],
  a: [number, number],
  b: [number, number],
): { at: number; t: number } {
  const vx = b[0] - a[0]
  const vy = b[1] - a[1]
  const len = vx * vx + vy * vy
  const t = len ? Math.max(0, Math.min(1, ((p[0] - a[0]) * vx + (p[1] - a[1]) * vy) / len)) : 0
  return { at: Math.hypot(p[0] - a[0] - t * vx, p[1] - a[1] - t * vy), t }
}

/**
 * The national outline with every stretch a state border already draws taken out.
 *
 * Brandenburg runs along the Oder and Saxony along the Neisse and the Erzgebirge, so a fifth of the
 * country's edge is a line this map is drawing twice -- once solid as a survey boundary and once
 * dashed underneath it, which reads as a rendering fault rather than as two facts.
 *
 * The threshold is the tolerance the ring was simplified at, which is the honest one: a point can
 * sit that far from where the border truly runs purely because of the simplification, so anything
 * inside it is not a second border but the same one drawn worse.
 *
 * Each surviving chain is carried one point past the last one it keeps and then onto the state
 * border itself, so the dash ends where the solid line begins instead of stopping short of it. That
 * final vertex is the only thing here that is not a point of the ring -- the join is drawn, not
 * measured, and everything the source registry tests against stays exactly as it was.
 */
function trimToStates(ring: number[][], borders: number[][][], within: number): number[][][] {
  const cosLat = Math.cos(
    ((ring.reduce((sum, [, lat]) => sum + lat!, 0) / ring.length) * Math.PI) / 180,
  )
  const segments: [[number, number], [number, number], number[], number[]][] = []
  for (const border of borders) {
    for (let i = 1; i < border.length; i++) {
      const [a, b] = [border[i - 1]!, border[i]!]
      segments.push([flat(a[0]!, a[1]!, cosLat), flat(b[0]!, b[1]!, cosLat), a, b])
    }
  }

  /** The nearest point on any state border, in degrees, and how far away it is. */
  const nearest = (point: number[]) => {
    const p = flat(point[0]!, point[1]!, cosLat)
    let best = { at: Infinity, on: point }
    for (const [a, b, da, db] of segments) {
      const { at, t } = toSegment(p, a, b)
      if (at >= best.at) continue
      // At the precision of the border it lands on, since that is the line it has to meet.
      const on = (i: number) => Math.round((da[i]! + (db[i]! - da[i]!) * t) * 1e5) / 1e5
      best = { at, on: [on(0), on(1)] }
    }
    return best
  }

  // A closed ring's repeated last point would otherwise start a chain of its own.
  const points = ring.slice(0, -1)
  const near = points.map(nearest)
  const drop = near.map((n) => n.at <= within)
  if (!drop.some(Boolean)) return [ring]
  if (drop.every(Boolean)) return []

  // Rotated to start on a dropped point, so a chain running across the ring's own seam stays whole.
  const start = drop.indexOf(true)
  const at = (i: number) => (start + i) % points.length
  const chains: number[][][] = []
  let chain: number[][] | null = null
  for (let i = 0; i <= points.length; i++) {
    const here = at(i % points.length)
    if (i < points.length && !drop[here]) {
      chain ??= [near[at(i - 1)]!.on, points[at(i - 1)]!]
      chain.push(points[here]!)
      continue
    }
    if (chain) chains.push([...chain, points[here]!, near[here]!.on])
    chain = null
  }
  return chains
}

/**
 * Which relations to trace, and which extract holds each.
 *
 * The list is the ground the planner can measure: Brandenburg and Berlin because the search covers
 * them, Saxony and Saxony-Anhalt because their surveys answer a browser. Berlin comes out of
 * Brandenburg's extract, which encloses it.
 */
const STATES: { extract: string; names: string[] }[] = [
  { extract: 'brandenburg', names: ['Berlin', 'Brandenburg'] },
  { extract: 'sachsen', names: ['Sachsen'] },
  { extract: 'sachsen-anhalt', names: ['Sachsen-Anhalt'] },
]

const isState = (tags: Record<string, string>, wanted: string[]) =>
  tags.boundary === 'administrative' &&
  tags.admin_level === '4' &&
  tags.type === 'boundary' &&
  wanted.includes(tags.name ?? '')

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

/** Every outline in one extract, as GeoJSON features. */
async function trace(extract: string, WANTED: string[]) {
  const PBF = await ensureExtract(extract)

  console.log('[1/3] relations')
  const wantWays = new Map<number, string>()
  const found = new Map<string, number>()
  readWaysAndRelations(
    PBF,
    () => {},
    (rel) => {
      if (!isState(rel.tags, WANTED)) return
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

  return features
}

/**
 * The outline of the ground the republisher can hold, read back from `npm run states`.
 *
 * Not traced here, because it is not this tool's fact. It is Geofabrik's clipping polygon -- the
 * shape that decides what is in a German extract -- and the source registry tests points against
 * exactly this ring. Reading the committed ring rather than re-deriving it is what guarantees the
 * dashed line never promises ground the registry declines: it cannot drift from something it is a
 * literal subset of.
 */
const germanyRing = (): number[][] => {
  const found = (states as { name: string; rings: number[][][] }[]).find(
    (s) => s.name === 'Germany',
  )
  if (!found) throw new Error('states.json has no Germany ring -- run `npm run states` first')
  return found.rings[0]!
}

/** The tolerance that ring was simplified at. See `trimToStates`, which needs it to match. */
const COARSE_TOLERANCE = 2500

async function main() {
  const traced = []
  for (const { extract, names } of STATES) {
    console.log(`\n== ${names.join(', ')}`)
    traced.push(...(await trace(extract, names)))
  }

  /**
   * Germany is drawn at the coarse tolerance, unlike the states, and says something weaker.
   *
   * A state border here means a survey answers at full quality, canopy included; this one means
   * only that the republisher might hold terrain. So it is drawn as the coarse ring with every
   * stretch a state border already covers taken out -- a subset of the registry's own ring, which
   * is what keeps the dashed line honest. See `trimToStates`.
   */
  const ring = germanyRing()
  const drawn = trimToStates(
    ring,
    traced.flatMap((f) => f.geometry.coordinates),
    COARSE_TOLERANCE,
  )
  console.log(
    `\n== Germany\n  drawn as ${drawn.length} chain(s), ` +
      `${drawn.reduce((n, c) => n + c.length, 0)} of ${ring.length} points -- ` +
      'the rest is already a state border',
  )
  const features = [
    ...traced,
    {
      type: 'Feature' as const,
      properties: { name: 'Germany' },
      geometry: { type: 'MultiLineString' as const, coordinates: drawn },
    },
  ]

  await mkdir(new URL('../web/public/', import.meta.url).pathname, { recursive: true })
  const text = JSON.stringify({ type: 'FeatureCollection', features })
  await writeFile(OUT, text)
  console.log(`\nwrote boundaries.json: ${features.length} outlines, ${(text.length / 1024).toFixed(0)} KB`)
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
