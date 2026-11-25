/**
 * How deep a rig puts the line, from its webbing, pretension, walker and backup slack.
 *
 * The line view has one number for all of this, the fall depth as a fraction of span, and this is
 * what turns a rig into it. A point load at midspan on a webbing of known stretch: walking is the
 * static balance, a leash fall and a backup fall are energy balances with nothing lost, so both
 * are worst cases -- real webbing turns part of a fall into heat. The webbing's own weight is left
 * out, which on a 500 m line hides roughly another percent of span.
 *
 * Forces are kN, lengths metres, stretch a fraction.
 */

export type Material = 'UHMWPE' | 'hybrid' | 'Vectran' | 'polyester' | 'nylon'

export interface Webbing {
  name: string
  maker: string
  material: Material
  /** What the maker says it is made of, in their words. */
  makeup: string
  gPerM: number
  /** Published stretch points, [kN, %]. Between and beyond them the curve is straight lines from 0. */
  curve: [number, number][]
  url: string
}

/** Retailer figures as published on 2026-11-24, and as uneven as that: some give one point, some six. */
export const WEBBINGS: Webbing[] = [
  {
    name: 'Y2K', maker: 'Slacktivity', material: 'hybrid', makeup: 'polyester sheath, UHMWPE core',
    gPerM: 33, curve: [[5, 1], [15, 2.3]], url: 'https://slacktivity.com/shop/y2k-high-tech-slackline-webbing/',
  },
  {
    name: 'Jumanji', maker: 'Spider Slacklines', material: 'UHMWPE', makeup: '100 % UHMWPE',
    gPerM: 31, curve: [[10, 2.9]], url: 'https://spider-slacklines.com/shop/en/highline-webbing/1369-7344-jumanji.html',
  },
  {
    name: 'Sky Diamond', maker: 'Spider Slacklines', material: 'hybrid', makeup: 'UHMWPE core, polyester and Vectran shell',
    gPerM: 33, curve: [[10, 3.8]],
    url: 'https://spider-slacklines.com/shop/en/highline-webbing/426-sky-diamond-longline-presale-9506919000.html',
  },
  {
    name: 'Spider Silk MK4', maker: 'Balance Community', material: 'hybrid', makeup: 'UHMWPE, polyester jacket',
    gPerM: 26, curve: [[6, 3.71], [10, 4.4]], url: 'https://www.balancecommunity.com/products/spider-silk-mk4',
  },
  {
    name: 'Spider Silk MK5', maker: 'Balance Community', material: 'Vectran', makeup: '95 % Vectran, 5 % UHMWPE',
    gPerM: 44, curve: [[5, 2.2], [10, 3.3]], url: 'https://www.balancecommunity.com/products/spider-silk-mk5',
  },
  {
    name: 'Mantra MK4', maker: 'Balance Community', material: 'polyester', makeup: '100 % polyester',
    gPerM: 76, curve: [[5, 1.5], [10, 3.65]], url: 'https://www.balancecommunity.com/products/mantra-mk4',
  },
  {
    name: 'Marathon', maker: 'Slacktivity', material: 'polyester', makeup: '100 % polyester',
    gPerM: 61.5, curve: [[10, 4]], url: 'https://slacktivity.com/shop/marathon-webbing/',
  },
  {
    name: 'Cosmic', maker: 'Spider Slacklines', material: 'polyester', makeup: 'tubular polyester',
    gPerM: 50, curve: [[5, 2.4], [10, 4.8], [20, 8.4]],
    url: 'https://spider-slacklines.com/shop/en/longline-webbings/359-1525-cosmic-longline.html',
  },
  {
    name: 'Green Mamba', maker: 'Spider Slacklines', material: 'polyester', makeup: 'polyester',
    gPerM: 44, curve: [[5, 3.2], [10, 5.2]],
    url: 'https://spider-slacklines.com/shop/en/webbings/627-5732-green-mamba-9506919000.html',
  },
  {
    name: 'Blue', maker: 'Balance Community', material: 'polyester', makeup: '100 % polyester',
    gPerM: 56, curve: [[5, 2.25], [10, 6.38]], url: 'https://www.balancecommunity.com/products/blue',
  },
  {
    name: 'Nylove', maker: 'Spider Slacklines', material: 'nylon', makeup: 'tubular polyamide',
    gPerM: 62, curve: [[5, 7.8], [10, 12.2]],
    url: 'https://spider-slacklines.com/shop/en/webbings/245-4547-nylove-longline-9506919000.html',
  },
  {
    name: 'redTube', maker: 'Slacktivity', material: 'nylon', makeup: 'tubular nylon',
    gPerM: 76, curve: [[1, 1.1], [2, 3.1], [3, 6.6], [4, 9.6], [5, 11.6], [10, 18.6]],
    url: 'https://slacktivity.com/shop/redtube-30m-200m/',
  },
]

/** Harness above the webbing while standing, and the leash it falls onto. */
export const HARNESS_ABOVE_M = 1
export const LEASH_M = 1.2

export interface Rig {
  webbing: Webbing
  pretensionKn: number
  walkerKg: number
  /** Span, anchor to anchor. */
  lengthM: number
  /** How much longer the backup is than the span. */
  backupSlackM: number
}

export function strainAt(curve: [number, number][], kn: number): number {
  const pts: [number, number][] = [[0, 0], ...curve]
  let i = 1
  while (i < pts.length - 1 && kn > pts[i]![0]) i++
  const [t0, e0] = pts[i - 1]!
  const [t1, e1] = pts[i]!
  return (e0 + ((e1 - e0) * (kn - t0)) / (t1 - t0)) / 100
}

/** Smallest x in [lo, hi] with `rises(x)` true, for a predicate that flips once. */
function bisect(lo: number, hi: number, rises: (x: number) => boolean): number {
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2
    if (rises(mid)) hi = mid
    else lo = mid
  }
  return (lo + hi) / 2
}

const tensionAt = (curve: [number, number][], strain: number) =>
  strain <= 0 ? 0 : bisect(0, 1000, (kn) => strainAt(curve, kn) >= strain)

/**
 * Upward pull of a webbing at midspan depth `s`, for one whose relaxed length is `rest`.
 * Slack until the V it forms is longer than that, and from there whatever its stretch demands.
 */
function lift(curve: [number, number][], length: number, rest: number, s: number): number {
  const half = Math.hypot(length / 2, s)
  return (2 * tensionAt(curve, (2 * half) / rest - 1) * s) / half
}

const weightKn = (kg: number) => (kg * 9.81) / 1000

/**
 * Deepest point of a fall that drops the harness `drop + s` while webbing pulling `f(s)` stops it.
 *
 * The fall starts at `from`, where the walker stood, so only depths past it can be the answer, and
 * whatever the webbing already held there is handed back to the fall rather than lost.
 */
function caught(f: (s: number) => number, w: number, drop: number, from: number, limit: number) {
  const ds = limit / 4000
  let s = 0
  let work = 0
  let stored = 0
  while (s < limit) {
    work += f(s + ds / 2) * ds
    s += ds
    if (s < from) continue
    if (!stored) stored = work
    if (work >= w * (s + drop) + stored) return s
  }
  return limit
}

export interface Depths {
  /** Midspan depth below the anchor chord, metres, of the line itself. */
  walking: number
  leashFall: number
  backupFall: number
}

export function depths(r: Rig): Depths {
  const { curve } = r.webbing
  const w = weightKn(r.walkerKg)
  const L = r.lengthM
  // The span is rigged at pretension, so its relaxed length is the span less that stretch.
  const mainRest = L / (1 + strainAt(curve, r.pretensionKn))
  const main = (s: number) => lift(curve, L, mainRest, s)
  const walking = bisect(0, L, (s) => main(s) >= w)
  // The harness falls from above the webbing to a leash's length below it.
  const drop = HARNESS_ABOVE_M + LEASH_M - walking
  const leashFall = caught(main, w, drop, walking, L)
  // The mainline is gone and takes its energy with it. A backup short enough to be taut where the
  // walker stood was already carrying some of them, and gives that back too.
  const backup = (s: number) => lift(curve, L, L + r.backupSlackM, s)
  const backupFall = caught(backup, w, drop, walking, L)
  return { walking, leashFall, backupFall }
}
