/**
 * Collapses every feasible line's anchors into a handful of "interesting spots".
 *
 * The purpose is a layer you can read at the scale of a whole state: not which line to walk, but
 * which valley to go and look at. So it is built from every line that passed the hard constraints,
 * not from the capped and deduped candidate list -- a place where 400 near-identical spans work is
 * more interesting than one where a single line does, and the candidate list deliberately throws
 * that difference away.
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
  score: number
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

  for (const p of [...points].sort((a, b) => b.score - a.score)) {
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
