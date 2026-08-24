import type { Pos, Sampler } from './grid.js'
import { lineHeightAt } from './scoring.js'
import type { Params, ProfileSample, StoredProfile } from './types.js'

/**
 * Samples terrain and surface along a span, with the line at the given sag.
 *
 * Shared between the search and the interactive planner so a hand-placed line is measured by
 * exactly the same rule as a found one, and the two are directly comparable.
 */
export function buildProfile(
  a: Pos,
  b: Pos,
  hA: number,
  hB: number,
  length: number,
  ground: Sampler,
  surface: Sampler,
  p: Params,
): ProfileSample[] {
  const sag = p.sagRatio * length
  const de = (b.e - a.e) / length
  const dn = (b.n - a.n) / length
  const steps = Math.min(p.profilePoints, Math.max(8, Math.round(length / p.profileStep)))
  const out: ProfileSample[] = []
  const r2 = (v: number) => Math.round(v * 100) / 100
  for (let i = 0; i <= steps; i++) {
    const t = i / steps
    const d = t * length
    const e = a.e + de * d
    const n = a.n + dn * d
    const g = ground.sample(e, n)
    out.push({
      d: r2(d),
      ground: r2(g),
      surface: r2(Math.max(g, surface.sample(e, n) || g)),
      line: r2(lineHeightAt(hA, hB, sag, t)),
    })
  }
  return out
}

/**
 * Drops everything about a profile that can be recomputed, for storage.
 *
 * `d` is `i/(n-1) * length` and `line` follows from the two attachment heights and the sag, both
 * already on the candidate -- so storing them is pure duplication, and they were more than half the
 * bytes of the largest field in the dataset. Parallel arrays rather than an array of objects for
 * the same reason: two key names per line instead of two per sample.
 */
export function packProfile(p: ProfileSample[]): StoredProfile {
  return { ground: p.map((s) => s.ground), surface: p.map((s) => s.surface) }
}

/** Rebuilds the full profile, with the line placed at `sagRatio`. Exact, not an approximation. */
export function unpackProfile(
  sp: StoredProfile,
  length: number,
  hA: number,
  hB: number,
  sagRatio: number,
): ProfileSample[] {
  const last = sp.ground.length - 1
  const sag = sagRatio * length
  const r2 = (v: number) => Math.round(v * 100) / 100
  return sp.ground.map((ground, i) => {
    const t = last > 0 ? i / last : 0
    return {
      d: r2(t * length),
      ground,
      surface: sp.surface[i] ?? ground,
      line: r2(lineHeightAt(hA, hB, sag, t)),
    }
  })
}
