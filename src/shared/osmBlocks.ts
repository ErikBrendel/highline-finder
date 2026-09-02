import { gunzipSync, gzipSync } from 'fflate'
import type { RoadWay } from './roads.js'
import { ROAD_TIERS, type RoadTier } from './types.js'

/**
 * The on-disk form of the OpenStreetMap data this project ships with itself.
 *
 * Roads and water used to be fetched from the public Overpass API at run time, by the pipeline and
 * by the browser separately. That was wrong twice over. It is a shared community service and asking
 * it for a state's road network got this project's machine refused outright; and the two halves
 * asked it independently, so they could disagree about what a line passes over -- which is exactly
 * the thing the project insists on for terrain and roofs.
 *
 * So the data is extracted once from a Geofabrik extract (see src/tools/osmRefresh.ts), reduced to
 * what the search actually reads, and committed. The pipeline and the browser then load the same
 * bytes, the deployed site depends on nothing at run time, and there is no failure mode left to
 * handle.
 *
 * Blocked at 8 km so the browser fetches one to four for a line rather than a state's worth, and
 * the pipeline just loads every block its region touches.
 *
 * Coordinates are stored in decimetres of EPSG:25833, delta-encoded along each way. A tenth of a
 * metre is finer than anything the rest of the project measures -- the rasters are 1 m -- but it is
 * what keeps a crossing's position along a span exact enough to draw, and it costs about one extra
 * byte per point over metres.
 */

const MAGIC = 0x314f4c48 // "HLO1"

/** Block side in metres. Also the lattice the block keys are on. */
export const BLOCK = 8000

/** Decimetres per metre: the quantisation of every stored coordinate. */
const UNITS_PER_M = 10

/**
 * What a stored feature is. The road tiers come first so a tier index is its own kind index.
 *
 * Water is here rather than in a file of its own because it comes from the same extract in the same
 * pass, and a line that crosses a lake usually crosses the road beside it too -- one fetch, not two.
 */
export const OSM_KINDS = [...ROAD_TIERS, 'water', 'waterway', 'island'] as const

export type OsmKind = (typeof OSM_KINDS)[number]

export const isRoadKind = (kind: OsmKind): kind is RoadTier =>
  (ROAD_TIERS as readonly string[]).includes(kind)

export interface OsmFeature {
  /**
   * The OpenStreetMap way id.
   *
   * Stored because a way is written whole into every block it touches, so loading two neighbouring
   * blocks yields the road between them twice -- and a road indexed twice reports every crossing of
   * it twice. Delta-encoded over features sorted by id, which costs about two bytes each.
   */
  id: number
  kind: OsmKind
  /** The OSM tag value, so a crossing can be named rather than merely classified. */
  name: string
  /** Half the carriageway in metres. 0 for water. */
  half: number
  bridge: boolean
  /** Flat `[e, n, e, n, ...]` in EPSG:25833 metres. */
  pts: number[]
}

/**
 * A block's features as the two things that read them, with roads seen twice dropped.
 *
 * `seen` carries across calls so a caller loading several blocks deduplicates across all of them,
 * which is the case that matters: the duplicate is always a way lying across a block boundary.
 *
 * Roads only, and that distinction is the whole of this comment. The two are looked up differently.
 * A road is counted -- every crossing it makes of a line is a crossing, so a road indexed in two
 * neighbouring blocks reports its crossing twice and the line is charged for it twice. Water is
 * asked spatially: is *this point* inside a lake, of the rings the block under it holds. Dropping a
 * lake from the second block it touches does not deduplicate it, it deletes it from half of itself
 * -- and the half of the span over the missing half is then held to the clearance owed to dry
 * ground. A ring kept twice costs a second point-in-polygon test and answers the same.
 */
export function splitFeatures(
  features: OsmFeature[],
  seen: Set<number>,
): { roads: RoadWay[]; water: Water } {
  const roads: RoadWay[] = []
  const water: Water = { rings: [], islands: [] }
  for (const f of features) {
    if (isRoadKind(f.kind)) {
      if (seen.has(f.id)) continue
      seen.add(f.id)
      roads.push({ tier: f.kind, kind: f.name, half: f.half, bridge: f.bridge, pts: f.pts })
    } else if (f.kind === 'water') water.rings.push(f.pts)
    else if (f.kind === 'island') water.islands.push(f.pts)
  }
  return { roads, water }
}

/**
 * Water outlines and the islands standing in them, as flat `[e, n, ...]` rings in EPSG:25833.
 *
 * Two lists rather than a winding rule, because they arrive as two lists: OSM multipolygons name
 * their inner rings, so nothing has to be inferred from ring orientation -- which is a good thing,
 * since orientation in OSM is not reliably maintained. A point is water when it is inside a ring
 * and inside no island.
 */
export interface Water {
  rings: number[][]
  islands: number[][]
}

export const blockKey = (e: number, n: number) =>
  `${Math.floor(e / BLOCK)}-${Math.floor(n / BLOCK)}`

/** The south-west corner of a block, from its key. */
export function blockOrigin(key: string): { e: number; n: number } {
  const [bx, by] = key.split('-').map(Number) as [number, number]
  return { e: bx * BLOCK, n: by * BLOCK }
}

/** Every block key a bounding box touches. */
export function blockKeysFor(minE: number, minN: number, maxE: number, maxN: number): string[] {
  const out: string[] = []
  for (let bx = Math.floor(minE / BLOCK); bx <= Math.floor(maxE / BLOCK); bx++) {
    for (let by = Math.floor(minN / BLOCK); by <= Math.floor(maxN / BLOCK); by++) {
      out.push(`${bx}-${by}`)
    }
  }
  return out
}

/** Growable byte sink. Doubling rather than concatenating; a block is a few hundred kilobytes. */
class Writer {
  private buf = new Uint8Array(1 << 16)
  private at = 0

  private room(n: number): void {
    if (this.at + n <= this.buf.length) return
    let size = this.buf.length
    while (size < this.at + n) size *= 2
    const grown = new Uint8Array(size)
    grown.set(this.buf.subarray(0, this.at))
    this.buf = grown
  }

  varint(v: number): void {
    // Unsigned only, and checked: a negative reaching here writes its low byte and silently
    // corrupts everything after it, which is exactly what a stitched water outline's negated
    // relation id did. Signed values go through `signed`.
    if (v < 0 || !Number.isInteger(v)) throw new Error(`varint wants a non-negative integer, got ${v}`)
    this.room(10)
    while (v >= 0x80) {
      this.buf[this.at++] = (v & 0x7f) | 0x80
      v = Math.floor(v / 128)
    }
    this.buf[this.at++] = v
  }

  /** Zigzag, so a small negative delta costs one byte rather than ten. */
  signed(v: number): void {
    this.varint(v < 0 ? -v * 2 - 1 : v * 2)
  }

  text(s: string): void {
    const bytes = new TextEncoder().encode(s)
    this.varint(bytes.length)
    this.room(bytes.length)
    this.buf.set(bytes, this.at)
    this.at += bytes.length
  }

  done(): Uint8Array {
    return this.buf.subarray(0, this.at)
  }
}

class ByteReader {
  at = 0

  constructor(private readonly buf: Uint8Array) {}

  varint(): number {
    let out = 0
    let shift = 1
    for (;;) {
      if (this.at >= this.buf.length) throw new Error('varint ran past the end of the block')
      const byte = this.buf[this.at++]!
      out += (byte & 0x7f) * shift
      if (byte < 0x80) return out
      shift *= 128
    }
  }

  signed(): number {
    const v = this.varint()
    return v % 2 === 0 ? v / 2 : -(v + 1) / 2
  }

  text(): string {
    const len = this.varint()
    const out = new TextDecoder().decode(this.buf.subarray(this.at, this.at + len))
    this.at += len
    return out
  }

  get done(): boolean {
    return this.at >= this.buf.length
  }
}

/**
 * Packs one block's features, gzipped.
 *
 * Names go in a table because a block holds a few dozen distinct OSM values across thousands of
 * ways, and geometry is delta-encoded from the block's own corner so the first point of a way costs
 * three bytes rather than seven.
 */
export function encodeBlock(key: string, features: OsmFeature[]): Uint8Array {
  const origin = blockOrigin(key)
  const names = new Map<string, number>()
  for (const f of features) if (!names.has(f.name)) names.set(f.name, names.size)

  const w = new Writer()
  w.varint(MAGIC)
  w.varint(names.size)
  for (const name of names.keys()) w.text(name)
  w.varint(features.length)

  let lastId = 0
  for (const f of [...features].sort((a, b) => a.id - b.id)) {
    // Zigzag rather than plain: ids are sorted so the deltas are non-negative, but the first one is
    // the whole id, and a stitched water outline carries its relation id negated to keep it out of
    // the way ids' space.
    w.signed(f.id - lastId)
    lastId = f.id
    // Tier and the bridge flag share a varint: one byte each over a million ways is a megabyte.
    w.varint(OSM_KINDS.indexOf(f.kind) | (f.bridge ? 8 : 0))
    w.varint(names.get(f.name)!)
    w.varint(Math.round(f.half * UNITS_PER_M))
    w.varint(f.pts.length / 2)
    let e = Math.round(origin.e * UNITS_PER_M)
    let n = Math.round(origin.n * UNITS_PER_M)
    for (let i = 0; i < f.pts.length; i += 2) {
      const pe = Math.round(f.pts[i]! * UNITS_PER_M)
      const pn = Math.round(f.pts[i + 1]! * UNITS_PER_M)
      w.signed(pe - e)
      w.signed(pn - n)
      e = pe
      n = pn
    }
  }
  return gzipSync(w.done())
}

export function decodeBlock(key: string, bytes: Uint8Array): OsmFeature[] {
  const origin = blockOrigin(key)
  const r = new ByteReader(gunzipSync(bytes))
  if (r.varint() !== MAGIC) throw new Error(`not an OSM block file: ${key}`)

  const names: string[] = []
  const nameCount = r.varint()
  for (let i = 0; i < nameCount; i++) names.push(r.text())

  const out: OsmFeature[] = []
  const featureCount = r.varint()
  let id = 0
  for (let i = 0; i < featureCount; i++) {
    id += r.signed()
    const head = r.varint()
    const kind = OSM_KINDS[head & 7]!
    const bridge = (head & 8) !== 0
    const name = names[r.varint()]!
    const half = r.varint() / UNITS_PER_M
    const points = r.varint()
    const pts: number[] = []
    let e = Math.round(origin.e * UNITS_PER_M)
    let n = Math.round(origin.n * UNITS_PER_M)
    for (let p = 0; p < points; p++) {
      e += r.signed()
      n += r.signed()
      pts.push(e / UNITS_PER_M, n / UNITS_PER_M)
    }
    out.push({ id, kind, name, half, bridge, pts })
  }
  return out
}
