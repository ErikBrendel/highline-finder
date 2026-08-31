import type { LineKind } from '../shared/types.js'

/**
 * Collapses the anchors of the kept lines into a handful of "interesting spots".
 *
 * The purpose is a layer you can read at the scale of a whole state: not which line to walk, but
 * which valley to go and look at.
 *
 * It used to be built from every feasible line rather than from the deduped list, on the argument
 * that a place where 400 near-identical spans work is more interesting than one where a single line
 * does. That was true and it cost too much to keep. The endpoints existed only inside a search --
 * ten million objects a statewide pass, built in the worker threads and pooled across them, which
 * is most of the memory a run used and the reason one chunk needed a twelve-gigabyte heap. Nothing
 * downstream could see them: a region file kept their 25 m grid and a count, so any question asked
 * of the layer afterwards, like which filters a spot still satisfies, could only be answered by
 * searching every region again.
 *
 * Built from the lines instead, the layer is derived from what a region file already holds. It can
 * be rebuilt from cached regions in seconds, it says exactly what the line list says, and a spot's
 * reading of a filter is the reading of the lines actually under it. What is given up is density:
 * `count` is now distinct lines rather than feasible spans, so it runs to tens rather than
 * thousands, and thinning has already flattened the tall peaks that argument was about.
 *
 * "Worth a trip" is stricter than the search's own definition of feasible, because this layer says
 * yes or no where everything else reports a figure. Two conditions, and both are needed.
 *
 * A blockage ceiling, because answering yes on the strength of lines that all run through 20 m of
 * pine is answering a different question than the one being asked -- one measured spot lit up on
 * 1,066 endpoints whose best line scored 39. And a score floor, because blockage alone cannot tell
 * that spot apart from the Mueggelberge, where the best line scores 63 and no line at all is
 * completely clear of trees. Score already folds canopy together with exposure and length, so it
 * separates the two cases that blockage on its own confuses.
 *
 * Clustering is greedy, best-first, the same shape as the candidate dedup: endpoints are visited in
 * descending score and each either joins a spot within `radius` or starts one. A spot therefore
 * sits exactly on the best anchor in its neighbourhood rather than on a centroid, which also keeps
 * it fixed -- so the grid index below stays exact with a single ring of neighbours.
 */

export interface Endpoint {
  e: number
  n: number
  /** The kind of the line this endpoint belongs to, which is what the two spot layers split on. */
  kind: LineKind
  score: number
  /** Fraction of the span's interior that intersects canopy. */
  blocked: number
  length: number
  exposure: number
  /** Off-level as a fraction of the span, which is the unit the filter is expressed in. */
  offLevel: number
}

/**
 * A place, how many line endpoints it stands for, and the best score among them.
 *
 * One type for both the input and the output of clustering, because a single endpoint and a drawn
 * spot are the same statement about a piece of ground -- which is what lets a spot be fed back in.
 */
export interface Spot {
  e: number
  n: number
  count: number
  /**
   * Best score among the endpoints this stands for -- and the only one of the extents below that
   * doubles as the spot's own reading, since the layer is drawn by it.
   */
  score: number
  /**
   * How far each filterable attribute reaches across the endpoints here, so the viewer can ask
   * whether a filter could still be satisfied somewhere in this spot without holding the lines.
   *
   * One bound each, not two, and which one is decided by the filter that reads it: a minimum on the
   * slider needs the largest value here, a maximum needs the smallest. The other half of each range
   * has no reader and would be file size spent on nothing. Length carries both because its filter
   * is a band with a thumb at each end.
   *
   * Every one of these is a min or a max, so merging two spots is merging the bounds -- associative
   * and commutative, so a spot means the same thing however the lines under it were batched.
   */
  lengthMin: number
  lengthMax: number
  exposureMax: number
  canopyMin: number
  offLevelMin: number
}

/**
 * Most canopy a line may run through and still mark its surroundings as worth a trip.
 *
 * Not zero. Requiring a completely clear line meant wooded hills with a good line through them
 * showed nothing at all, which is a worse answer than a slightly generous one.
 */
export const HOTSPOT_MAX_BLOCKED = 0.2

/** Lowest score that counts. Below this a line is technically feasible and practically not. */
export const HOTSPOT_MIN_SCORE = 55

/**
 * Radius the drawn spots collapse over. Ten times the candidate `dedupRadius`: this answers "is
 * this valley worth a trip", where two spots 60 m apart are the same answer.
 */
export const HOTSPOT_RADIUS = 50

/** Whether a line is good enough to mark the ground around it as worth going to look at. */
export function isWalkable(p: Endpoint): boolean {
  return p.blocked <= HOTSPOT_MAX_BLOCKED && p.score >= HOTSPOT_MIN_SCORE
}

/**
 * The same total order the candidate dedup uses, and for the same reason: a spot's position is "the
 * best anchor around here", so a tie decided by arrival order would move it depending on how the
 * input happened to be pooled.
 */
const bestFirst = (a: Spot, b: Spot) => b.score - a.score || a.e - b.e || a.n - b.n

/** One endpoint as a spot standing for itself, which is what clustering takes. */
export const spotOf = (p: Endpoint): Spot => ({
  e: p.e,
  n: p.n,
  count: 1,
  score: p.score,
  lengthMin: p.length,
  lengthMax: p.length,
  exposureMax: p.exposure,
  canopyMin: p.blocked,
  offLevelMin: p.offLevel,
})

export function clusterSpots(points: Spot[], radius: number): Spot[] {
  const spots: Spot[] = []
  // Cell size equals the radius, so anything within reach of a point is in one of the nine cells
  // around it. Spots never move, so this stays exact.
  const index = new Map<string, Spot[]>()
  const cellKey = (e: number, n: number) => `${Math.floor(e / radius)}_${Math.floor(n / radius)}`

  for (const p of [...points].sort(bestFirst)) {
    const cx = Math.floor(p.e / radius)
    const cy = Math.floor(p.n / radius)
    let hit: Spot | null = null
    let best = radius

    for (let dx = -1; dx <= 1 && !hit; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (const s of index.get(`${cx + dx}_${cy + dy}`) ?? []) {
          const d = Math.hypot(s.e - p.e, s.n - p.n)
          if (d <= best) {
            best = d
            hit = s
          }
        }
      }
    }

    if (hit) {
      // The spot keeps its own position and score -- it is visited best-first, so it already holds
      // the better of the two -- and grows to cover what this endpoint adds.
      hit.count += p.count
      hit.lengthMin = Math.min(hit.lengthMin, p.lengthMin)
      hit.lengthMax = Math.max(hit.lengthMax, p.lengthMax)
      hit.exposureMax = Math.max(hit.exposureMax, p.exposureMax)
      hit.canopyMin = Math.min(hit.canopyMin, p.canopyMin)
      hit.offLevelMin = Math.min(hit.offLevelMin, p.offLevelMin)
      continue
    }
    const spot: Spot = { ...p }
    spots.push(spot)
    const key = cellKey(p.e, p.n)
    const bucket = index.get(key)
    if (bucket) bucket.push(spot)
    else index.set(key, [spot])
  }
  return spots
}
