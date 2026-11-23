/**
 * A straight piece of a shadow: from `ta` to `tb` along the line, at heights `ya` to `yb`.
 *
 * Shadows are built from these rather than from points because they come from more than one
 * surface -- the exact ground around the anchors, the coarse mesh between, the canopy sheet over
 * either -- and pieces along one parameter can be laid over each other where points cannot.
 */
export interface Seg {
  ta: number
  tb: number
  ya: number
  yb: number
}

/** Every crossing of `from` to `to` with a whole number, as a fraction of the way along. */
export function crossings(from: number, to: number, out: number[]): void {
  if (from === to) return
  for (let k = Math.ceil(Math.min(from, to)); k <= Math.max(from, to); k++) out.push((k - from) / (to - from))
}

/** `cuts` sorted and clipped to [from, to], as the consecutive intervals between them. */
export function intervals(cuts: number[], from: number, to: number): [number, number][] {
  const inside = [from, to, ...cuts.filter((t) => t > from && t < to)].sort((p, q) => p - q)
  const out: [number, number][] = []
  for (let k = 0; k + 1 < inside.length; k++) {
    if (inside[k + 1]! - inside[k]! > 1e-9) out.push([inside[k]!, inside[k + 1]!])
  }
  return out
}

/** `top` wherever it has something, and `base` everywhere else. */
export function overlay(base: Seg[], top: Seg[]): Seg[] {
  const covered = top.map((s) => [s.ta, s.tb] as const)
  const out = [...top]
  for (const s of base) {
    const cuts = covered.flatMap(([a, b]) => [a, b])
    for (const [ta, tb] of intervals(cuts, s.ta, s.tb)) {
      const mid = (ta + tb) / 2
      if (covered.some(([a, b]) => mid > a && mid < b)) continue
      const y = (t: number) => s.ya + ((s.yb - s.ya) * (t - s.ta)) / (s.tb - s.ta)
      out.push({ ta, tb, ya: y(ta), yb: y(tb) })
    }
  }
  return out.sort((p, q) => p.ta - q.ta)
}

/**
 * Pieces in order as one polyline, `point` turning a place along the line and a height into
 * three floats. Where two pieces meet at different heights both are kept, which is a vertical step.
 */
export function polyline(segs: Seg[], point: (t: number, y: number) => [number, number, number]): Float32Array {
  const out: number[] = []
  for (const s of segs) {
    for (const [t, y] of [[s.ta, s.ya], [s.tb, s.yb]] as const) {
      const p = point(t, y)
      const n = out.length
      if (n && Math.abs(out[n - 3]! - p[0]) + Math.abs(out[n - 2]! - p[1]) + Math.abs(out[n - 1]! - p[2]) < 1e-6) continue
      out.push(...p)
    }
  }
  return Float32Array.from(out)
}
