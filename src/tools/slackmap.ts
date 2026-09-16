import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { toUtm33 } from '../shared/geo.js'
import { planLine } from '../shared/plan.js'
import { VIEWER_PROFILE } from '../shared/profile.js'
import { failureText, failures } from '../web/report.js'
import {
  PLANNED_REFINE_RADIUS,
  optimizeFrame,
  scanMargin,
  startingSpacing,
  type Plan,
} from '../web/optimize.js'
import { sourceFor } from '../web/sources.js'
import { ensureTerrain, groundSampler, roofs, surfaceKnown, surfaceSampler } from '../web/terrain.js'
import { useCacheStore } from '../web/tileCache.js'
import type { Pos } from '../shared/grid.js'
import type { Candidate, LineKind, Params } from '../shared/types.js'

/**
 * Asks whether the lines people have actually walked are lines this tool would have found.
 *
 * Run it by hand: `npm run slackmap`. Nothing downstream consumes the output -- this is a check,
 * not a build step, and what it produces is an argument about whether the numbers this project
 * prints are the numbers somebody standing on the line would recognise.
 *
 * Why this and not a fixture. Every test in this repo is a statement about the code agreeing with
 * itself: the profile sampler agrees with the grid, the score agrees with its parts. None of them
 * can tell you the terrain model is right, because none of them has ever been outdoors. The ISA's
 * world map has about fifty German highlines with a length and a height somebody rigged and then
 * wrote down, which is the only outside opinion available, and it costs one CORS-open request.
 *
 * **The question is not "what is under this pin".** That was the first version of this tool and it
 * measured the wrong thing. A highline anchor sits at the top of a drop by definition, which is the
 * one place on the terrain where moving three metres sideways changes the ground height by twenty
 * -- `fgh6NBA` has sixty-four metres of relief within fifteen of its pin. A point somebody dropped
 * on a phone map is not good to three metres, so reading the terrain literally under it reported
 * cliff faces as anchors and called a 34 m line offlevel by 16, which is not a fact about the line
 * or about this model. It is a fact about the pin.
 *
 * So each line is measured twice: once exactly as pinned, and once after letting the app's own
 * anchor search walk both ends up to {@link SEARCH_RADIUS} metres. The second is the real question
 * -- *is there a line like the reported one roughly here* -- and it is asked with the same
 * optimiser the planner's "improve this line" button runs, so a yes means the app would find it
 * too. The first is kept only to show how much of the disagreement was the pin.
 *
 * What comes out:
 *
 *   - **Length.** Their recorded length against what we measure. Mostly a check on their data, and
 *     a line whose pins and length disagree by a factor is one whose height means nothing either.
 *   - **Drop.** Their `height` against the ground's fall below the straight anchor-to-anchor chord.
 *     Reported beside `exposure` -- the gap under the *sagging* line -- because those are two
 *     different questions wearing one word, and only the first is what a person means by height.
 *   - **Violations.** Whether the search would accept each real, walked line. One that our own hard
 *     filters reject is either a filter set too tight or a line nobody should have rigged.
 *
 * None of it is a scoreboard. Community heights are eyeballed and rounded upward, lengths are
 * sometimes the webbing rather than the gap. One line disagreeing says nothing; a consistent bias
 * across forty says something.
 */

const LINES_GEOJSON = 'https://data.slackmap.com/geojson/lines/all.geojson'
const details = (id: string) => `https://api.slackmap.com/line/${id}/details`

const META = new URL('../web/public/meta.json', import.meta.url).pathname
const CACHE = new URL('../../data/cache/tiles/', import.meta.url).pathname

/**
 * How far either anchor may move from its pin, in metres.
 *
 * "Roughly this spot", which is all a map click promises. Wide enough to step off a cliff face onto
 * the edge above it -- the error being corrected for -- and narrow enough that what comes back is
 * still recognisably the reported line rather than a better one nearby. How far each end actually
 * travelled is reported per line, so a run that spent the whole budget is visible rather than
 * flattering.
 */
const SEARCH_RADIUS = 8

/** Frames of descent before a line is called converged, whatever the optimiser still wants. */
const MAX_FRAMES = 400

/** The two-point geometry and the handful of properties the bulk dump carries. */
interface MapLine {
  properties: { id: string; lt?: string; c: string; l?: string }
  geometry: { type: string; coordinates: number[][] }
}

/** What the detail endpoint adds, and the two fields worth comparing against. */
interface LineDetails {
  name?: string
  length?: number
  height?: number
}

/**
 * The browser's tile cache, backed by a directory.
 *
 * Same keys, same bytes, same code path -- see `useCacheStore`. Without it a second run re-fetches
 * every elevation tile, and the republisher that answers for twelve of the sixteen states allows
 * twelve hundred an hour.
 */
const cacheFile = (key: string) => join(CACHE, `${createHash('sha1').update(key).digest('hex')}.bin`)

const diskCache = {
  async read(key: string): Promise<ArrayBuffer | null> {
    try {
      const b = await readFile(cacheFile(key))
      return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer
    } catch {
      return null
    }
  },
  async write(key: string, bytes: ArrayBuffer): Promise<void> {
    await writeFile(cacheFile(key), Buffer.from(bytes))
  },
}

async function germanHighlines(): Promise<MapLine[]> {
  console.log(`downloading ${LINES_GEOJSON}`)
  const res = await fetch(LINES_GEOJSON, { headers: { 'User-Agent': 'highline-finder/0.1' } })
  if (!res.ok) throw new Error(`slackmap lines failed: HTTP ${res.status}`)
  const all = ((await res.json()) as { features: MapLine[] }).features
  const mine = all.filter((f) => f.properties.c === 'DE' && f.properties.lt === 'h')
  console.log(`  ${all.length} lines worldwide, ${mine.length} German highlines`)
  return mine
}

/** One line's own page. A failure here costs its name and its recorded figures, not its geometry. */
async function detailsOf(id: string): Promise<LineDetails> {
  const res = await fetch(details(id), { headers: { 'User-Agent': 'highline-finder/0.1' } })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return (await res.json()) as LineDetails
}

/**
 * How far the ground falls away below the straight anchor-to-anchor chord, at its worst.
 *
 * The second of two things both called "height", and the one a person means. `exposure` is the
 * largest gap between the *sagging* line and the terrain, which is the right number for deciding
 * whether a line is worth walking; what somebody reports from the anchor is the drop under the
 * rigging, with no sag in it. On a short line over a gorge the two agree. On a long one they
 * cannot: 5 % of Sandgrube Grunewald's 437 m is 22 m of sag against a recorded height of 20, so the
 * sagging line reaches the pit floor and `exposure` collapses to nothing.
 */
function chordDrop(c: Candidate): number {
  const g = c.profile?.ground
  if (!g?.length) return NaN
  let worst = 0
  for (let i = 0; i < g.length; i++) {
    const t = g.length > 1 ? i / (g.length - 1) : 0
    const here = c.a.anchor + (c.b.anchor - c.a.anchor) * t - g[i]!
    if (here > worst) worst = here
  }
  return worst
}

/**
 * The terrain's vertical range within a pin's worth of an anchor: what a sloppy pin is worth here.
 *
 * Not used to judge anything -- the search is what handles it -- but reported per line, because it
 * is the difference between a figure that disagrees and a figure that was never determined. Two
 * metres means the pin barely mattered; forty means it was the only thing that did.
 */
function relief(a: Pos, b: Pos): number {
  const spread = (p: Pos) => {
    let lo = Infinity
    let hi = -Infinity
    for (let de = -SEARCH_RADIUS; de <= SEARCH_RADIUS; de++) {
      for (let dn = -SEARCH_RADIUS; dn <= SEARCH_RADIUS; dn++) {
        if (de * de + dn * dn > SEARCH_RADIUS * SEARCH_RADIUS) continue
        const v = groundSampler.sample(p.e + de, p.n + dn)
        if (!Number.isFinite(v)) continue
        lo = Math.min(lo, v)
        hi = Math.max(hi, v)
      }
    }
    return hi >= lo ? hi - lo : NaN
  }
  return Math.max(spread(a), spread(b))
}

interface Measured {
  candidate: Candidate
  drop: number
  violations: string[]
}

interface Row {
  id: string
  name: string
  kind: LineKind
  relief: number
  /** Furthest either anchor travelled from its pin. */
  moved: number
  canopyKnown: boolean
  theirLength?: number
  theirHeight?: number
  pinned: Measured
  found: Measured
}

/** Signed relative error in percent, or null where there is nothing to compare against. */
const err = (ours: number, theirs?: number): number | null =>
  theirs === undefined || theirs <= 0 ? null : ((ours - theirs) / theirs) * 100

const median = (xs: number[]): number => {
  if (!xs.length) return NaN
  const s = [...xs].sort((a, b) => a - b)
  const mid = s.length >> 1
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2
}

const pad = (v: string | number, n: number) => String(v).padStart(n)
const pct = (v: number | null) => (v === null ? '--' : v.toFixed(0))

function report(rows: Row[]): void {
  console.log(
    `\n${'id'.padEnd(9)}${'name'.padEnd(24)}${pad('len', 6)}${pad('theirs', 8)}${pad('Δ%', 6)}  ` +
      `${pad('drop', 5)}${pad('expo', 5)}${pad('theirs', 8)}${pad('Δ%', 6)}  ` +
      `${pad('clear', 6)}${pad('score', 6)}${pad('moved', 6)}${pad('relief', 7)}` +
      `  why the search would still refuse it`,
  )
  for (const r of rows) {
    const f = r.found
    console.log(
      `${r.id.padEnd(9)}${r.name.slice(0, 23).padEnd(24)}` +
        `${pad(f.candidate.length.toFixed(0), 6)}${pad(r.theirLength?.toFixed(0) ?? '--', 8)}` +
        `${pad(pct(err(f.candidate.length, r.theirLength)), 6)}  ` +
        `${pad(f.drop.toFixed(0), 5)}${pad(f.candidate.exposure.toFixed(0), 5)}` +
        `${pad(r.theirHeight?.toFixed(0) ?? '--', 8)}${pad(pct(err(f.drop, r.theirHeight)), 6)}  ` +
        `${pad(f.candidate.clearanceMin.toFixed(1), 6)}${pad(f.candidate.score.toFixed(0), 6)}` +
        `${pad(r.moved.toFixed(1), 6)}${pad(r.relief.toFixed(0), 7)}  ${f.violations.join(', ')}`,
    )
  }

  const spread = (name: string, errs: number[]) => {
    if (!errs.length) return console.log(`  ${name}: nothing to compare`)
    const within = (p: number) => errs.filter((e) => Math.abs(e) <= p).length
    console.log(
      `  ${name.padEnd(8)} ${pad(errs.length, 3)} comparable, ` +
        `median ${median(errs) >= 0 ? '+' : ''}${median(errs).toFixed(0)} %, ` +
        `median |error| ${median(errs.map(Math.abs)).toFixed(0)} %, ` +
        `within 10 %: ${within(10)}, within 25 %: ${within(25)}`,
    )
  }
  const errs = (of: (r: Row) => number, theirs: (r: Row) => number | undefined) =>
    rows.map((r) => err(of(r), theirs(r))).filter((v) => v !== null)
  const length = (r: Row) => r.theirLength
  const height = (r: Row) => r.theirHeight

  console.log(`\nAgreement, after letting each anchor look ${SEARCH_RADIUS} m around`)
  spread('length', errs((r) => r.found.candidate.length, length))
  spread('drop', errs((r) => r.found.drop, height))
  spread('expo', errs((r) => r.found.candidate.exposure, height))
  console.log('\nThe same lines measured exactly where the pins fell, for contrast')
  spread('length', errs((r) => r.pinned.candidate.length, length))
  spread('drop', errs((r) => r.pinned.drop, height))

  /**
   * Lines whose recorded height the terrain cannot account for at all.
   *
   * Half of ours or less, after the search has had its eight metres, means the disagreement is not
   * a matter of degree: the anchors are not on the ground. A line strung forty metres up between
   * two trees, or off a tower, has a drop this project cannot see, because what it models is the
   * terrain and -- inside Brandenburg only -- the roofs. Listed rather than averaged in, because
   * they are the bulk of the residual bias and they are not evidence about the elevation model.
   */
  const unexplained = rows.filter((r) => {
    const e = err(r.found.drop, r.theirHeight)
    return e !== null && e <= -50
  })
  if (unexplained.length) {
    console.log(
      `\n  ${unexplained.length} of ${rows.length} record a height more than twice the drop the ` +
        `terrain has to offer.\n  Anchored in something -- trees, a tower, a building outside ` +
        `Brandenburg's city model:\n  ${unexplained.map((r) => r.id).join(' ')}\n` +
        `  Set those aside and what is left is the terrain model being asked a question it can\n` +
        `  answer:`,
    )
    const rest = rows.filter((r) => !unexplained.includes(r))
    spread('drop', rest.map((r) => err(r.found.drop, r.theirHeight)).filter((v) => v !== null))
  }

  const stuck = rows.filter((r) => r.moved > SEARCH_RADIUS - 0.5).length
  console.log(
    `\n  Anchors moved a median of ${median(rows.map((r) => r.moved)).toFixed(1)} m of the ` +
      `${SEARCH_RADIUS} m allowed, and ${stuck} of ${rows.length}\n  spent it all -- those were ` +
      `still improving when they hit the edge, so their figures are a floor.`,
  )

  // By rule, not by wording: every violation names the figure that broke it, so counting the
  // strings gives one bucket per line and no shape at all.
  const rule = (v: string) => v.replace(/-?\d+(\.\d+)?/g, 'N')
  const byRule = new Map<string, number>()
  for (const r of rows) {
    for (const v of r.found.violations) byRule.set(rule(v), (byRule.get(rule(v)) ?? 0) + 1)
  }
  const clean = (pick: (r: Row) => Measured) => rows.filter((r) => !pick(r).violations.length).length
  console.log(
    `\nWould the search accept these real lines?\n` +
      `  ${clean((r) => r.found)} of ${rows.length} pass every hard filter somewhere within ` +
      `${SEARCH_RADIUS} m of their pins\n  (${clean((r) => r.pinned)} of ${rows.length} exactly ` +
      `where pinned).`,
  )
  for (const [r, n] of [...byRule].sort((x, y) => y[1] - x[1])) console.log(`  ${pad(n, 4)}  ${r}`)

  const blind = rows.filter((r) => !r.canopyKnown).length
  if (blind) console.log(`\n  ${blind} of ${rows.length} sit where no survey publishes a canopy.`)
}

async function main() {
  await mkdir(CACHE, { recursive: true })
  useCacheStore(diskCache)
  const params = (JSON.parse(readFileSync(META, 'utf8')) as { params: Params }).params
  const fine = { ...params, ...VIEWER_PROFILE }
  const scene = { roofs }

  const lines = await germanHighlines()
  const rows: Row[] = []
  const skipped: string[] = []

  // The app announces every survivable failure to the console, which is right in a browser and
  // wrong here: the answer is a table and the noise is forty stack traces per line over ground
  // nobody surveys. Nothing is lost -- `failures()` keeps them all, and they are summarised below.
  const loud = console.error
  console.error = () => {}

  /**
   * The reported figures, at the viewer's resolution.
   *
   * Gaps are not tolerated: a line measured over ground the survey never covered would report a
   * clearance minimum that never looked at the hill which sets it, and reading that as agreement or
   * disagreement would be worse than admitting there is no answer.
   */
  const measure = (a: Pos, b: Pos): Measured | null => {
    const r = planLine(a, b, groundSampler, surfaceSampler, params.sagRatio, fine, null, scene)
    return r ? { candidate: r.candidate, drop: chordDrop(r.candidate), violations: r.violations } : null
  }

  /**
   * The best line the app's own anchor search can reach from these pins.
   *
   * Run to convergence rather than for one animation frame, and over the dataset's coarse profile
   * exactly as the planner's own button does -- the winner is re-measured at full resolution
   * afterwards, so no reported number is the search's approximation of itself.
   */
  const searchFrom = async (origin: Plan): Promise<Plan> => {
    const reach = SEARCH_RADIUS / PLANNED_REFINE_RADIUS
    let plan = origin
    let spacing = startingSpacing(reach)
    for (let i = 0; i < MAX_FRAMES; i++) {
      const advance = await optimizeFrame(
        plan,
        {
          origin,
          ground: groundSampler,
          surface: surfaceSampler,
          sagRatio: params.sagRatio,
          params,
          rig: null,
          scene,
          reach,
          ensure: (at, s) =>
            ensureTerrain(
              at.a,
              at.b,
              scanMargin(Math.hypot(at.b.e - at.a.e, at.b.n - at.a.n), s, params),
            ),
        },
        spacing,
      )
      if (!advance) return plan
      plan = advance.plan
      spacing = advance.spacing
    }
    return plan
  }

  for (const [i, line] of lines.entries()) {
    const [from, to] = line.geometry.coordinates
    if (!from || !to) continue
    const [ae, an] = toUtm33(from[1]!, from[0]!)
    const [be, bn] = toUtm33(to[1]!, to[0]!)
    const pins: Plan = { a: { e: ae, n: an }, b: { e: be, n: bn } }
    const id = line.properties.id

    // Outside what any source will answer for -- the planner's own coverage rule, not a guess.
    if (!sourceFor(ae, an) || !sourceFor(be, bn)) {
      skipped.push(`${id}: no elevation source covers it`)
      continue
    }

    const info = await detailsOf(id).catch((e: unknown) => {
      skipped.push(`${id}: its detail page answered ${failureText(e)}`)
      return {} as LineDetails
    })
    const name = info.name ?? ''
    process.stdout.write(`\r[${i + 1}/${lines.length}] ${name.slice(0, 40).padEnd(44)}`)

    // A source that has nothing here throws rather than returning empty, and one line in Austria
    // tagged as German is enough to end the run. The windows that did arrive are kept; whether
    // enough of them arrived is a question `planLine` answers on its own.
    await ensureTerrain(pins.a, pins.b, SEARCH_RADIUS * 4).catch(() => {})
    const pinned = measure(pins.a, pins.b)
    if (!pinned) {
      skipped.push(`${id} ${name}: the survey has no height for one of its anchors`)
      continue
    }

    const best = await searchFrom(pins).catch(() => pins)
    const found = measure(best.a, best.b) ?? pinned
    rows.push({
      id,
      name,
      kind: found.candidate.kind,
      relief: relief(pins.a, pins.b),
      moved: Math.max(
        Math.hypot(best.a.e - pins.a.e, best.a.n - pins.a.n),
        Math.hypot(best.b.e - pins.b.e, best.b.n - pins.b.n),
      ),
      canopyKnown: surfaceKnown(best.a, best.b),
      theirLength: info.length,
      theirHeight: info.height,
      pinned,
      found,
    })
  }

  console.error = loud
  process.stdout.write('\r'.padEnd(60) + '\r')
  report(rows)

  // Every survivable failure the run met, collapsed by cause rather than by window: a line over
  // ground no service holds produces one of these per window, and a dozen stack traces between
  // each row of the table would bury the table.
  const causes = new Map<string, number>()
  for (const f of failures()) {
    const text = failureText(f.error)
    causes.set(text, (causes.get(text) ?? 0) + f.count)
  }
  if (causes.size) {
    console.log('\nFetches that failed and were survived')
    for (const [text, n] of [...causes].sort((x, y) => y[1] - x[1])) {
      console.log(`  ${pad(n, 5)}x  ${text}`)
    }
  }

  if (skipped.length) {
    console.log(`\nNot measured (${skipped.length})`)
    for (const s of skipped) console.log(`  ${s}`)
  }
  console.log('\nAny line above: https://slackmap.com/line/<id>')
}

main().catch((e: unknown) => {
  console.error(e)
  process.exit(1)
})
