import type { Pos } from '../shared/grid.js'

/** The square of ground currently on screen, which outlives the line that chose it. */
export interface Ground {
  centre: Pos
  halfSide: number
  /** Height everything in the scene is measured from -- the floor of the patch. */
  datum: number
}

/** The middle of everything to be shown, and how far it reaches from there along either axis. */
export function spread(points: Pos[]): { centre: Pos; reach: number } {
  const es = points.map((p) => p.e)
  const ns = points.map((p) => p.n)
  const [e0, e1, n0, n1] = [Math.min(...es), Math.max(...es), Math.min(...ns), Math.max(...ns)]
  return { centre: { e: (e0 + e1) / 2, n: (n0 + n1) / 2 }, reach: Math.max(e1 - e0, n1 - n0) / 2 }
}
/**
 * Ground for the span to sit in rather than fill: a line with nothing around it says little. The
 * spot's other lines are fitted in too, with room round their ends.
 */
export const wantedHalfSide = (length: number, reach: number) => Math.max(140, length * 0.85, reach + 60)

/** Share of the patch's half-width that must stay clear beyond each anchor. */
const EDGE_ROOM = 0.25

/**
 * Whether the ground under the view has to be read again.
 *
 * Sticky on purpose. Dragging an anchor moves the line, and re-reading a quarter of a million
 * heights for every few metres of that would make the view stutter exactly while it is being used.
 * A patch is built with room around the span, so the span can wander inside it.
 *
 * What forces a rebuild is an anchor running out of ground. An anchor near the edge of the square
 * is an anchor you cannot see the surroundings of, which is the one thing this view is for -- and
 * the midpoint can sit comfortably in the middle while an end is out at the rim, so it is the ends
 * that are asked. Measured per axis rather than as a distance, because the patch is a square: an
 * anchor is short of ground when it is close to a *side*, not when it is far from the centre.
 */
export function stale(held: Ground | null, a: Pos, b: Pos, others: Pos[] = []): boolean {
  if (!held) return true
  const want = wantedHalfSide(Math.hypot(b.e - a.e, b.n - a.n), spread([a, b, ...others]).reach)
  if (want > held.halfSide * 1.3 || want < held.halfSide * 0.62) return true
  const room = held.halfSide * (1 - EDGE_ROOM)
  return [a, b, ...others].some(
    (p) => Math.max(Math.abs(p.e - held.centre.e), Math.abs(p.n - held.centre.n)) > room,
  )
}
