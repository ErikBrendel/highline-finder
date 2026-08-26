import type { LineKind } from '../shared/types.js'

/**
 * Collapses every feasible line's anchors into a handful of "interesting spots".
 *
 * The purpose is a layer you can read at the scale of a whole state: not which line to walk, but
 * which valley to go and look at. So it is built from every walkable line, not from the capped and
 * deduped candidate list -- a place where 400 near-identical spans work is more interesting than
 * one where a single line does, and the candidate list deliberately throws that difference away.
 *
 * "Worth a trip" is stricter than the search's own definition of feasible, because this layer says
 * yes or no where everything else reports a figure. Two conditions, and both are needed.
 *
 * A blockage ceiling, because answering yes on the strength of a thousand lines that all run
 * through 20 m of pine is answering a different question than the one being asked -- one measured
 * spot lit up on 1,066 endpoints whose best line scored 39. And a score floor, because blockage
 * alone cannot tell that spot apart from the Mueggelberge, where the best line scores 63 and no
 * line at all is completely clear of trees. Score already folds canopy together with exposure and
 * length, so it separates the two cases that blockage on its own confuses.
 *
 * Data volume is the point. Two AOIs produce ~79k endpoints and about 300 spots at a 50 m radius,
 * a few tens of kilobytes, and the count grows with *terrain* rather than with area searched --
 * flat ground contributes nothing at all. That is what should let this cover Brandenburg when the
 * candidate list cannot.
 *
 * Greedy, best-first, same shape as the candidate dedup: endpoints are visited in descending score
 * and each either joins a spot within `radius` or starts one. A spot therefore sits exactly on the
 * best anchor in its neighbourhood rather than on a centroid, which also keeps it fixed -- so the
 * grid index below stays exact with a single ring of neighbours.
 */

export interface Endpoint {
  e: number
  n: number
  /** The kind of the line this endpoint belongs to, which is what the three spot layers split on. */
  kind: LineKind
  score: number
  /** Fraction of the span's interior that intersects canopy. */
  blocked: number
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

/** Whether a line is good enough to mark the ground around it as worth going to look at. */
export function isWalkable(p: Endpoint): boolean {
  return p.blocked <= HOTSPOT_MAX_BLOCKED && p.score >= HOTSPOT_MIN_SCORE
}

export interface Hotspot {
  e: number
  n: number
  /** Feasible-line endpoints that collapsed into this spot. */
  count: number
  /** Best score among the lines anchored here. */
  score: number
}

export function clusterEndpoints(points: Endpoint[], radius: number): Hotspot[] {
  const spots: Hotspot[] = []
  // Cell size equals the radius, so anything within reach of a point is in one of the nine cells
  // around it. Spots never move, so this stays exact.
  const cells = new Map<string, Hotspot[]>()
  const cellKey = (e: number, n: number) => `${Math.floor(e / radius)}_${Math.floor(n / radius)}`

  // The same total order as the candidate dedup, for the same reason: a spot sits on the best
  // endpoint in its neighbourhood, so a tie decided by list position would move the spot depending
  // on how the endpoints happened to be pooled. Position is the tie-break, an endpoint having no id.
  const bestFirst = (a: Endpoint, b: Endpoint) => b.score - a.score || a.e - b.e || a.n - b.n
  for (const p of [...points].sort(bestFirst)) {
    const cx = Math.floor(p.e / radius)
    const cy = Math.floor(p.n / radius)
    let hit: Hotspot | null = null
    let best = radius

    for (let dx = -1; dx <= 1 && !hit; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (const s of cells.get(`${cx + dx}_${cy + dy}`) ?? []) {
          const d = Math.hypot(s.e - p.e, s.n - p.n)
          if (d <= best) {
            best = d
            hit = s
          }
        }
      }
    }

    if (hit) {
      hit.count++
      continue
    }
    const spot: Hotspot = { e: p.e, n: p.n, count: 1, score: p.score }
    spots.push(spot)
    const key = cellKey(p.e, p.n)
    const bucket = cells.get(key)
    if (bucket) bucket.push(spot)
    else cells.set(key, [spot])
  }
  return spots
}
