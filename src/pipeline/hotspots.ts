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
 * Two steps, and the split is what lets this cover a state.
 *
 *   1. Endpoints are reduced to a fixed grid the moment they are produced, one cell keeping how
 *      many endpoints fell in it and where the best of them was. The grid is pinned to the
 *      projection rather than to whatever area is being searched, so two runs that meet at a seam
 *      agree cell for cell and their aggregates simply add -- see `gridSpots`.
 *   2. The pooled cells are clustered, greedily and best-first, into the spots that get drawn.
 *
 * Volume is the reason for step 1. A 141 km2 area produces 3.2 million endpoints and Brandenburg
 * would produce something like 151 million, which is not a thing to hold in memory or write to a
 * region file. The same ground is at most 226,000 grid cells, of which only the ones with a
 * walkable line in them exist at all -- and the count grows with *terrain* rather than with area
 * searched, since flat ground contributes nothing.
 *
 * Clustering is greedy, best-first, the same shape as the candidate dedup: cells are visited in
 * descending score and each either joins a spot within `radius` or starts one. A spot therefore
 * sits exactly on the best anchor in its neighbourhood rather than on a centroid, which also keeps
 * it fixed -- so the grid index below stays exact with a single ring of neighbours.
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
 * A place, how many line endpoints it stands for, and the best score among them.
 *
 * One type for both steps, because a grid cell and a drawn spot are the same statement about a
 * piece of ground -- which is also what makes the two composable: clustering weighted points is
 * the same operation whether the weights came from endpoints or from cells.
 */
export interface Spot {
  e: number
  n: number
  count: number
  score: number
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

/**
 * Cell size the endpoints are reduced to before anything is stored.
 *
 * Half the cluster radius, so a cell is small enough that collapsing it to one point cannot move a
 * spot by more than a fraction of the distance the clustering was already going to collapse. Larger
 * and the grid starts deciding where spots sit; smaller buys nothing but file size.
 */
export const SPOT_RES = HOTSPOT_RADIUS / 2

/** Whether a line is good enough to mark the ground around it as worth going to look at. */
export function isWalkable(p: Endpoint): boolean {
  return p.blocked <= HOTSPOT_MAX_BLOCKED && p.score >= HOTSPOT_MIN_SCORE
}

/**
 * The same total order the candidate dedup uses, and for the same reason: both the cell's
 * representative and the spot's position are "the best point around here", so a tie decided by
 * arrival order would move them depending on how the input happened to be pooled.
 */
const bestFirst = (a: Spot, b: Spot) => b.score - a.score || a.e - b.e || a.n - b.n

export const spotOf = (p: Endpoint): Spot => ({ e: p.e, n: p.n, count: 1, score: p.score })

/**
 * Reduces weighted points to one per `res` metre cell, keeping the best point in each.
 *
 * Also the merge: cells from two runs are themselves weighted points, and feeding them back through
 * this combines them exactly. That is the property the whole chunked plan needs -- an aggregate
 * computed piecewise has to equal the one computed whole, or the map changes at every seam.
 *
 * The lattice is fixed to the projection, not to the input, so which cell a point lands in does not
 * depend on what else was in the batch. Output is sorted rather than left in map order for the same
 * reason: two runs that saw the same ground write the same file.
 */
export function gridSpots(points: Iterable<Spot>, res: number): Spot[] {
  const cells = new Map<string, Spot>()
  for (const p of points) {
    const key = `${Math.floor(p.e / res)}_${Math.floor(p.n / res)}`
    const at = cells.get(key)
    if (!at) {
      cells.set(key, { ...p })
      continue
    }
    at.count += p.count
    if (bestFirst(p, at) < 0) {
      at.e = p.e
      at.n = p.n
      at.score = p.score
    }
  }
  return [...cells.values()].sort((a, b) => a.e - b.e || a.n - b.n)
}

export function clusterSpots(cells: Spot[], radius: number): Spot[] {
  const spots: Spot[] = []
  // Cell size equals the radius, so anything within reach of a point is in one of the nine cells
  // around it. Spots never move, so this stays exact.
  const index = new Map<string, Spot[]>()
  const cellKey = (e: number, n: number) => `${Math.floor(e / radius)}_${Math.floor(n / radius)}`

  for (const p of [...cells].sort(bestFirst)) {
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
      hit.count += p.count
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
