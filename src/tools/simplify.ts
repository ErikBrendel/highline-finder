/**
 * Douglas-Peucker, on whatever units the points are already in.
 *
 * Shared by the two tools that reduce an official boundary to something worth bundling: the state
 * outlines the planner routes by, and the borders the map draws. Both want the shape and none of
 * the surveying -- a state border is published to the field boundary, which at the zoom either is
 * looked at is a fraction of a pixel.
 */
export function simplify(pts: number[][], tolerance: number): number[][] {
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
