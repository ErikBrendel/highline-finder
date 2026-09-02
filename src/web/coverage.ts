import outlines from './outlines.json'

/**
 * Which survey's ground a point is on, roughly and without asking anybody.
 *
 * The elevation sources have to choose a service before any request is made, and a bounding box is
 * a poor way to choose: Brandenburg's box takes in a corner of Saxony-Anhalt and most of Berlin's
 * surroundings, so a window over Halle used to be offered to Brandenburg first, declined, and only
 * then offered to the survey that holds it. That is a wasted round trip on every new area.
 *
 * So each source carries the outline of its state, simplified to a couple of kilometres and
 * bundled with the app -- fifteen kilobytes, no fetch, synchronous. It is a hint and never an
 * authority: a source that is asked about ground it does not hold still declines, and the next one
 * is asked. What it saves is asking a survey four hundred kilometres from its own territory.
 */

interface Outline {
  name: string
  rings: number[][][]
}

const byName = new Map((outlines as Outline[]).map((o) => [o.name, o.rings]))

/**
 * How far outside a coarse outline still counts as inside it.
 *
 * Two things have to fit in here. The simplification, which can cut a couple of kilometres across a
 * bend, and the fact that a survey usually answers a little way past its own border. Being generous
 * costs one request that comes back empty; being mean costs ground nobody can measure.
 */
export const SOURCE_MARGIN = 6000

const METRES_PER_DEGREE = 111_320

/** Whether a ring encloses the point, by ray casting. Degrees; the ring is closed implicitly. */
function encloses(ring: number[][], lon: number, lat: number): boolean {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i] as [number, number]
    const [xj, yj] = ring[j] as [number, number]
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

/** Distance from the point to the nearest edge of a ring, in metres. */
function distanceTo(ring: number[][], lon: number, lat: number): number {
  // Degrees to metres about this latitude, so a comparison in metres means what it says.
  const kx = METRES_PER_DEGREE * Math.cos((lat * Math.PI) / 180)
  const ky = METRES_PER_DEGREE
  let best = Infinity
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const ax = (ring[j]![0]! - lon) * kx
    const ay = (ring[j]![1]! - lat) * ky
    const bx = (ring[i]![0]! - lon) * kx
    const by = (ring[i]![1]! - lat) * ky
    const dx = bx - ax
    const dy = by - ay
    const len2 = dx * dx + dy * dy
    const t = len2 > 0 ? Math.min(1, Math.max(0, -(ax * dx + ay * dy) / len2)) : 0
    best = Math.min(best, Math.hypot(ax + dx * t, ay + dy * t))
  }
  return best
}

/** Whether a named state's ground is at or near this point. Unknown names cover everywhere. */
export function nearState(name: string, lon: number, lat: number, margin = SOURCE_MARGIN): boolean {
  const rings = byName.get(name)
  if (!rings) return true
  return rings.some((r) => encloses(r, lon, lat) || distanceTo(r, lon, lat) <= margin)
}
