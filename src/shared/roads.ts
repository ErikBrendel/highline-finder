import type { Pos, Sampler } from './grid.js'
import { sideHalfWidthAt } from './profile.js'
import type { Roads } from './scene.js'
import type { Crossing, Params, RoadTier } from './types.js'

/** Total clearance a crossing demands: the base every line owes, plus its class's surcharge. */
export function requiredOver(x: Crossing, p: Params): number {
  return p.minClearance + p.roadClearance[x.tier]
}

/**
 * Roads, paths and railways under a line, and how much air each of them demands.
 *
 * A highline over a road is a normal thing to rig, with the local authority's blessing. What
 * decides whether it is plausible is height: a forest path can be taped shut for an afternoon, a
 * Bundesstraße cannot, and nothing at all can be done about an electrified railway. So this is a
 * clearance rule keyed on what is underneath, not a rule against crossing things.
 *
 * For scale: German law wants 4.50 m of clearance over a road -- the 4.00 m a lorry may legally be
 * plus half a metre -- and 4.70 m under new motorway structures. The figures in `roadClearance` run
 * from two to five times that, deliberately. A bridge deck is rigid and its height is surveyed; a
 * slackline sags under a walker, is rigged by hand, and can drop that walker onto whatever is
 * beneath it. The road standard is the wrong reference class.
 *
 * Vectors, not a raster. OSM gives a centreline plus an optional width tag, so rasterising means
 * inventing a width, drawing the invention at 1 m and then measuring it back. Intersecting the span
 * with the segments uses the geometry that actually exists and returns the exact distance along the
 * span, which is also what the profile chart needs to draw.
 *
 * Proximity, not intersection. A road two metres to the side is still under the line once the wind
 * gets up -- the same reason clearance is measured across a band rather than along a ray -- so a
 * road counts when it comes within the band, and a road the span crosses outright is just the case
 * where that distance is zero. This is why a road running *beside* the line for two hundred metres
 * is no longer invisible, and why the answer is a stretch of the span rather than a point on it.
 */

/**
 * OSM tag values that carry traffic, by how much air a line over them needs.
 *
 * Judgement calls, and the ones worth arguing about are noted. The tiers themselves are in
 * params.ts, since which of them is 8 m and which is 12 is a tunable, not a fact.
 *
 *   path      Closable. A forest track or a footpath can be taped off for a rigging day, so it asks
 *             for nothing beyond the clearance every line already needs.
 *   cycle     Closable too, but a cyclist arrives fast, quietly and without looking up.
 *   street    Cars at town speeds, and a lorry may still be 4 m tall.
 *   road      A through road: lorries at 100, and closing it needs more than goodwill.
 *   highway   Motorway, Kraftfahrstraße, and every railway. Nothing here can be stopped for you,
 *             and a railway adds a 15 kV contact wire at 5.5 m over the rail.
 */
const HIGHWAY_TIERS: Record<string, RoadTier> = {
  path: 'path',
  footway: 'path',
  bridleway: 'path',
  steps: 'path',
  // A closable street, but one that is full of people when it is not closed.
  pedestrian: 'path',
  via_ferrata: 'path',
  cycleway: 'cycle',
  // Promoted to 'cycle' by tracktype below: a made-up forest road carries forestry lorries.
  track: 'path',
  residential: 'street',
  living_street: 'street',
  unclassified: 'street',
  road: 'street',
  service: 'street',
  tertiary: 'road',
  secondary: 'road',
  // Bundesstraße. Arguably the top tier -- it is the largest road that is not a motorway -- but it
  // has junctions, cyclists and a lower limit, so it sits with the other through roads for now.
  primary: 'road',
  trunk: 'highway',
  motorway: 'highway',
  busway: 'highway',
  bus_guideway: 'highway',
  raceway: 'highway',
}

/**
 * `railway=*` values that carry something a line has to stay clear of.
 *
 * An allowlist, because the key is mostly lifecycle and furniture: `abandoned`, `disused`, `razed`,
 * `construction` and `proposed` are all places where a railway is not, and `platform`, `turntable`,
 * `switch` and the rest are parts of a station rather than track. Treating the key as "railway =
 * yes" cost the default area two thirds of its candidates over five abandoned alignments through a
 * forest, which have no track, no train and no wire.
 *
 * `preserved` is in because heritage railways run trains. `miniature` is out because a 7¼ inch park
 * railway is a garden feature.
 */
const LIVE_RAILWAYS = new Set([
  'rail',
  'light_rail',
  'subway',
  'tram',
  'narrow_gauge',
  'funicular',
  'monorail',
  'preserved',
])

/** Half the carriageway, in metres, where the tags do not say. */
const DEFAULT_HALF: Record<RoadTier, number> = {
  path: 1,
  cycle: 1.5,
  street: 3,
  road: 4,
  highway: 12.5,
}

/** Metres per lane, for deriving a width from a lane count. */
const LANE_WIDTH = 3.25

export interface RoadWay {
  tier: RoadTier
  /** The OSM value, kept so the chart can name what it drew. */
  kind: string
  /** Half the carriageway width: the requirement holds this far either side of the centreline. */
  half: number
  /**
   * Traffic on a deck rather than on the ground, so the clearance is owed to the deck. The terrain
   * model is bare earth and has no bridge in it at all, but the surface model is photogrammetric
   * and does -- so a crossing marked here is measured against that instead.
   */
  bridge: boolean
  /** Centreline in EPSG:25833, flat as `[e, n, e, n, ...]`. */
  pts: number[]
}

export type Tags = Record<string, string | undefined>

/**
 * What a tagged way demands, or null if it is not something a line has to clear.
 *
 * Tunnels are dropped: a road in a tunnel is not under the line, it is under the ground the line is
 * already being measured against.
 */
export function classifyWay(tags: Tags): { tier: RoadTier; kind: string; half: number } | null {
  if (tags.tunnel && tags.tunnel !== 'no') return null

  if (tags.railway) {
    // Every live railway sits at the top: a train cannot be stopped for a rigging day, and an
    // electrified one carries 15 kV on a wire 5.5 m over the rail, which no permission makes safe.
    if (!LIVE_RAILWAYS.has(tags.railway)) return null
    return { tier: 'highway', kind: tags.railway, half: halfWidth(tags, 'highway') }
  }

  const kind = tags.highway
  if (!kind) return null
  let tier = HIGHWAY_TIERS[kind]
  if (!tier) return null

  // A grade1 or grade2 track is a made-up surface, which is what forestry lorries drive on.
  if (kind === 'track' && (tags.tracktype === 'grade1' || tags.tracktype === 'grade2')) {
    tier = 'cycle'
  }
  if (kind === 'service' && (tags.service === 'driveway' || tags.service === 'parking_aisle')) {
    tier = 'cycle'
  }
  if (tier === 'path' && tags.bicycle === 'designated') tier = 'cycle'

  return { tier, kind, half: halfWidth(tags, tier) }
}

function halfWidth(tags: Tags, tier: RoadTier): number {
  const width = Number(tags.width)
  if (Number.isFinite(width) && width > 0) return width / 2
  const lanes = Number(tags.lanes)
  if (Number.isFinite(lanes) && lanes > 0) return (lanes * LANE_WIDTH) / 2
  return DEFAULT_HALF[tier]
}

/** Where on a segment the nearest point to `p` lies. */
function nearestOnSegment(
  px: number,
  py: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): Pos {
  const ex = x1 - x0
  const ey = y1 - y0
  const len2 = ex * ex + ey * ey
  const u = len2 === 0 ? 0 : Math.min(1, Math.max(0, ((px - x0) * ex + (py - y0) * ey) / len2))
  return { e: x0 + ex * u, n: y0 + ey * u }
}

function distToSegment2(
  px: number,
  py: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): number {
  const foot = nearestOnSegment(px, py, x0, y0, x1, y1)
  return (px - foot.e) ** 2 + (py - foot.n) ** 2
}

/**
 * The two elevation models, for reading a road's own height rather than the line's.
 *
 * Optional throughout: a caller with no raster to hand -- the unit tests, and anything measuring
 * pure geometry -- gets crossings without a carrier, and the metrics fall back to the profile
 * underneath the line.
 */
export interface Elevation {
  ground: Sampler
  surface: Sampler
}

/**
 * Where a span comes within the band of each way, as a stretch of distances along it.
 *
 * The test at fraction `t` along the span is `distance(t) <= halfWidth(t) + half`: the band only has
 * to reach the near *kerb*, since the requirement already holds half a carriageway either side of
 * the centreline. Intersection is the special case where the distance is zero, so a span crossing a
 * road at right angles gives what it always did.
 *
 * The stretch is a single interval, and provably so rather than by assumption. Distance to a convex
 * set is a convex function of the point, and a road segment is convex, so `distance(t)` is convex;
 * the band half-width is `4t(1-t)` scaled, which is concave; so the difference is convex and the
 * set where it is negative is an interval. That is what lets the two ends be found by bisection
 * from the minimum instead of by marching along the span.
 *
 * A way touching the span more than once -- a hairpin, or a road running beside it and turning
 * across it -- still yields one crossing per segment that reaches the band, which is right: each is
 * a separate place the line has to be high enough. Segments of one way that overlap along the span
 * collapse in the metrics, since only the tightest matters.
 */
export function crossingsAlong(
  a: Pos,
  b: Pos,
  ways: Iterable<RoadWay>,
  p: Params,
  elevation?: Elevation,
): Crossing[] {
  const out: Crossing[] = []
  const se = b.e - a.e
  const sn = b.n - a.n
  const length = Math.hypot(se, sn)
  if (length === 0) return out
  const r1 = (v: number) => Math.round(v * 10) / 10

  for (const way of ways) {
    const { pts } = way
    for (let i = 0; i + 3 < pts.length; i += 2) {
      const x0 = pts[i]!
      const y0 = pts[i + 1]!
      const x1 = pts[i + 2]!
      const y1 = pts[i + 3]!
      /** How far the near kerb is from the centreline at `t`, negative once the band reaches it. */
      const shortfall = (t: number) =>
        Math.sqrt(distToSegment2(a.e + se * t, a.n + sn * t, x0, y0, x1, y1)) -
        way.half -
        sideHalfWidthAt(t, length, p)

      // Ternary search on a convex function: 40 rounds shrink the bracket by (2/3)^40, far past the
      // decimetre the result is rounded to.
      let lo = 0
      let hi = 1
      for (let k = 0; k < 40 && hi - lo > 1e-6; k++) {
        const m1 = lo + (hi - lo) / 3
        const m2 = hi - (hi - lo) / 3
        if (shortfall(m1) < shortfall(m2)) hi = m2
        else lo = m1
      }
      const tightest = (lo + hi) / 2
      const gap = shortfall(tightest)
      if (gap > 0) continue

      // Convexity again: one root each side of the minimum, or the span end where there is none.
      const root = (from: number, to: number) => {
        if (shortfall(from) <= 0) return from
        let inside = to
        let outside = from
        for (let k = 0; k < 24; k++) {
          const mid = (inside + outside) / 2
          if (shortfall(mid) <= 0) inside = mid
          else outside = mid
        }
        return inside
      }

      const t0 = root(0, tightest)
      const t1 = root(1, tightest)
      out.push({
        d: r1(tightest * length),
        from: r1(t0 * length),
        to: r1(t1 * length),
        offset: r1(Math.max(0, gap + sideHalfWidthAt(tightest, length, p))),
        kind: way.kind,
        tier: way.tier,
        onBridge: way.bridge,
        carrier: elevation
          ? carrierHeight(a, se, sn, [t0, tightest, t1], x0, y0, x1, y1, way.bridge, elevation)
          : undefined,
      })
    }
  }
  return mergeOverlapping(out)
}

/**
 * How high the road runs, read at the road's own position.
 *
 * Sampled where the span is nearest it, at both ends of the stretch and at the tightest point, and
 * the highest of the three kept -- one number, and the strictest reading of a road that climbs
 * across the band. A bridge is read from the surface model, because the terrain model is bare earth
 * and runs straight under a deck.
 */
function carrierHeight(
  a: Pos,
  se: number,
  sn: number,
  ts: number[],
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  bridge: boolean,
  elevation: Elevation,
): number | undefined {
  const model = bridge ? elevation.surface : elevation.ground
  let highest = -Infinity
  for (const t of ts) {
    const foot = nearestOnSegment(a.e + se * t, a.n + sn * t, x0, y0, x1, y1)
    const h = model.sample(foot.e, foot.n)
    if (h > highest) highest = h
  }
  return Number.isFinite(highest) ? Math.round(highest * 100) / 100 : undefined
}

/**
 * Collapses crossings of the same kind whose stretches overlap, which are the same piece of road.
 *
 * A road is a chain of segments and each is tested separately, so one bending gently past the line
 * used to arrive as a dozen crossings covering the same ground -- a dozen slabs stacked in the
 * chart and a dozen entries in the dataset. Only *overlapping* ranges merge: two roads with a gap
 * between them stay two crossings, because the ground in that gap is not a road and the line is
 * entitled to be lower over it.
 *
 * The survivor keeps the closest approach of the group, which is the station the icon belongs at.
 * Also what makes the order total, so the bucketed index and an exhaustive scan cannot disagree
 * about which of two crossings at the same distance comes first.
 */
function mergeOverlapping(all: Crossing[]): Crossing[] {
  const groups = new Map<string, Crossing[]>()
  for (const x of all) {
    const key = `${x.kind}|${x.tier}|${x.onBridge}`
    const group = groups.get(key)
    if (group) group.push(x)
    else groups.set(key, [x])
  }

  const out: Crossing[] = []
  for (const group of groups.values()) {
    let open: Crossing | null = null
    for (const x of group.sort((u, v) => u.from - v.from || u.to - v.to || u.d - v.d)) {
      if (open && x.from <= open.to) {
        open.to = Math.max(open.to, x.to)
        // The highest of the merged pieces, for the same reason one piece keeps its highest probe.
        if (x.carrier !== undefined && (open.carrier === undefined || x.carrier > open.carrier)) {
          open.carrier = x.carrier
        }
        if (x.offset < open.offset) {
          open.offset = x.offset
          open.d = x.d
        }
        continue
      }
      open = { ...x }
      out.push(open)
    }
  }
  return out.sort((x, y) => x.d - y.d || x.from - y.from || x.to - y.to)
}

/**
 * Ways bucketed on a lattice, so a span only pays for the ones near it.
 *
 * The overwhelming majority of spans cross nothing at all -- this is Brandenburg forest, and the
 * search evaluates several million lines a run -- so what matters is that the empty answer costs a
 * handful of map lookups rather than a scan of the road network.
 *
 * Ways are split into single segments and each is registered in every bucket its bounding box
 * touches. A segment that crosses the span therefore always sits in a bucket the span itself enters
 * -- which is why the walk below has to be an exact grid traversal rather than sampled steps: a
 * span can clip the corner of a bucket without any sample landing in it, and the road inside would
 * simply not be found.
 */
export class RoadIndex implements Roads {
  /** Every segment, once. Buckets hold indices into this so a segment can be deduplicated by id. */
  private readonly pieces: RoadWay[] = []
  private readonly buckets = new Map<number, number[]>()
  /** Query number each segment was last returned for, so a repeat costs a comparison. */
  private stamps = new Int32Array(0)
  private query = 0
  /** Widest carriageway held, so a query knows how far off the span a road can still count. */
  private widest = 0

  constructor(private readonly cell = 100) {}

  private static key(cx: number, cy: number): number {
    // One integer rather than a string: this is built once per region over hundreds of thousands of
    // segments, and string keys were most of that time.
    return cx * 4294967296 + cy
  }

  add(way: RoadWay): void {
    const { pts } = way
    if (way.half > this.widest) this.widest = way.half
    for (let i = 0; i + 3 < pts.length; i += 2) {
      const id = this.pieces.length
      this.pieces.push({ ...way, pts: pts.slice(i, i + 4) })
      const c0 = Math.floor(Math.min(pts[i]!, pts[i + 2]!) / this.cell)
      const c1 = Math.floor(Math.max(pts[i]!, pts[i + 2]!) / this.cell)
      const r0 = Math.floor(Math.min(pts[i + 1]!, pts[i + 3]!) / this.cell)
      const r1 = Math.floor(Math.max(pts[i + 1]!, pts[i + 3]!) / this.cell)
      for (let cx = c0; cx <= c1; cx++) {
        for (let cy = r0; cy <= r1; cy++) {
          const k = RoadIndex.key(cx, cy)
          const bucket = this.buckets.get(k)
          if (bucket) bucket.push(id)
          else this.buckets.set(k, [id])
        }
      }
    }
  }

  /**
   * Every segment in a bucket within `margin` of the span, each returned once.
   *
   * Amanatides-Woo traversal: step to whichever of the next column or the next row boundary the
   * span reaches first, so exactly the buckets the segment enters are visited and none is stepped
   * over.
   *
   * The margin is served by dilating each visited bucket, which is exact rather than approximate: a
   * point within `margin` of the span has a nearest point on the span in some visited bucket, and
   * two points less than `reach` cells apart on each axis cannot differ by more than `reach` bucket
   * indices. It costs `(2*reach+1)^2` map lookups per step -- irrelevant next to the raster work,
   * and paid only by spans that have any road near them at all.
   */
  near(a: Pos, b: Pos, margin = 0): RoadWay[] {
    const out: RoadWay[] = []
    if (!this.buckets.size) return out
    if (this.stamps.length < this.pieces.length) this.stamps = new Int32Array(this.pieces.length)
    const stamp = ++this.query
    const reach = Math.ceil(margin / this.cell)

    const { cell } = this
    let cx = Math.floor(a.e / cell)
    let cy = Math.floor(a.n / cell)
    const endX = Math.floor(b.e / cell)
    const endY = Math.floor(b.n / cell)
    const de = b.e - a.e
    const dn = b.n - a.n
    const stepX = Math.sign(de)
    const stepY = Math.sign(dn)
    // Distance in t along the span between successive boundaries of each axis, and to the first one.
    const tDeltaX = de === 0 ? Infinity : Math.abs(cell / de)
    const tDeltaY = dn === 0 ? Infinity : Math.abs(cell / dn)
    let tMaxX =
      de === 0 ? Infinity : ((cx + (stepX > 0 ? 1 : 0)) * cell - a.e) / de
    let tMaxY =
      dn === 0 ? Infinity : ((cy + (stepY > 0 ? 1 : 0)) * cell - a.n) / dn

    // Exactly the number of boundaries the span can cross, so the walk terminates on arithmetic
    // rather than on a floating-point comparison landing the right way.
    const visits = Math.abs(endX - cx) + Math.abs(endY - cy) + 1
    for (let visit = 0; visit < visits; visit++) {
      for (let dx = -reach; dx <= reach; dx++) {
        for (let dy = -reach; dy <= reach; dy++) {
          const bucket = this.buckets.get(RoadIndex.key(cx + dx, cy + dy))
          if (!bucket) continue
          for (const id of bucket) {
            if (this.stamps[id] === stamp) continue
            this.stamps[id] = stamp
            out.push(this.pieces[id]!)
          }
        }
      }
      if (tMaxX < tMaxY) {
        cx += stepX
        tMaxX += tDeltaX
      } else {
        cy += stepY
        tMaxY += tDeltaY
      }
    }
    return out
  }

  crossings(a: Pos, b: Pos, p: Params, elevation?: Elevation): Crossing[] {
    // Widest the band ever gets on this span, plus the widest carriageway: past that, no road in the
    // bucket could reach the line however the two are angled.
    const margin = sideHalfWidthAt(0.5, Math.hypot(b.e - a.e, b.n - a.n), p) + this.widest
    const ways = this.near(a, b, margin)
    return ways.length ? crossingsAlong(a, b, ways, p, elevation) : []
  }

  /** Buckets holding at least one segment, for reporting how much road a region carries. */
  get size(): number {
    return this.buckets.size
  }

  get segments(): number {
    return this.pieces.length
  }
}
