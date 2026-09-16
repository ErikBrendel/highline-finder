import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { toUtm33 } from '../shared/geo.js'
import { planLine } from '../shared/plan.js'
import { VIEWER_PROFILE } from '../shared/profile.js'
import { failureText, failures } from '../web/report.js'
import { sourceFor } from '../web/sources.js'
import { ensureTerrain, groundSampler, roofs, surfaceKnown, surfaceSampler } from '../web/terrain.js'
import { useCacheStore } from '../web/tileCache.js'
import type { Candidate, LineKind, Params } from '../shared/types.js'

/**
 * Measures every German highline the ISA's world map knows about, against what it records for them.
 *
 * Run it by hand: `npm run slackmap`. Nothing downstream consumes the output -- this is a check,
 * not a build step, and what it produces is an argument about whether the numbers this project
 * prints are the numbers a person standing on the line would recognise.
 *
 * Why this and not a fixture. Every test in this repo is a statement about the code agreeing with
 * itself: the profile sampler agrees with the grid, the score agrees with its parts. None of them
 * can tell you that the terrain model is right, because none of them has ever been outdoors.
 * slackmap has about fifty German highlines with a length and a height somebody rigged and then
 * wrote down, which is the only outside opinion available, and it costs one request to get.
 *
 * What comes out is three things, in rising order of interest:
 *
 *   - **Length.** Their recorded length against the distance between the two pins they drew. This
 *     mostly grades *their* data rather than ours -- we contribute a geodesic and nothing else --
 *     but a line whose pins and length disagree by a factor is one whose height means nothing
 *     either, and it has to be found before it can be excluded.
 *   - **Height.** Their `height` against our `exposure`, which is defined as the largest gap
 *     between line and terrain: how high the highline actually is. This is the real comparison.
 *   - **Violations.** Whether the search would have accepted each real, walked line. A rigged
 *     highline that our own hard filters reject is either a filter that is too strict or a line
 *     nobody should have rigged, and the two are worth telling apart.
 *
 * The numbers are not a scoreboard. Community heights are eyeballed from the anchor, lengths are
 * sometimes the webbing rather than the gap, and a pin dropped on a phone is good to maybe ten
 * metres. One line disagreeing says nothing at all; a consistent bias across forty says something.
 */

const LINES_GEOJSON = 'https://data.slackmap.com/geojson/lines/all.geojson'
const details = (id: string) => `https://api.slackmap.com/line/${id}/details`
const onSlackmap = (id: string) => `https://slackmap.com/line/${id}`

const META = new URL('../web/public/meta.json', import.meta.url).pathname
const CACHE = new URL('../../data/cache/tiles/', import.meta.url).pathname

/** The two-point geometry and the handful of properties the bulk dump carries. */
interface MapLine {
  properties: { id: string; lt?: string; c: string; l?: string }
  geometry: { type: string; coordinates: number[][] }
}

/** What the detail endpoint adds, and the two fields worth comparing against. */
interface LineDetails {
  name?: string
  type?: string
  length?: number
  height?: number
  isMeasured?: boolean
}

/**
 * The browser's tile cache, backed by a directory.
 *
 * Same keys, same bytes, same code path -- see `useCacheStore`. Without it a second run re-fetches
 * every elevation tile, and the republisher that answers for twelve of the sixteen states allows
 * twelve hundred an hour.
 */
const diskCache = {
  file: (key: string) => join(CACHE, `${createHash('sha1').update(key).digest('hex')}.bin`),
  async read(key: string): Promise<ArrayBuffer | null> {
    try {
      const bytes = await readFile(diskCache.file(key))
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
    } catch {
      return null
    }
  },
  async write(key: string, bytes: ArrayBuffer): Promise<void> {
    await writeFile(diskCache.file(key), Buffer.from(bytes))
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

interface Row {
  id: string
  name: string
  kind: LineKind
  theirLength?: number
  ourLength: number
  theirHeight?: number
  ourExposure: number
  ourDrop: number
  clearanceMin: number
  score: number
  canopyKnown: boolean
  violations: string[]
}

/**
 * How far the ground falls away below the straight anchor-to-anchor chord, at its worst.
 *
 * The second of two things both called "height", and the one a person means. `exposure` is the
 * largest gap between the *sagging* line and the terrain, which is the right number for deciding
 * whether a line is worth walking; what somebody standing at the anchor reports is the drop under
 * the rigging, with no sag in it. On a short line over a gorge the two agree. On a long one they
 * cannot: 5 % of 437 m is 22 m of sag, which is the whole of what Sandgrube Grunewald is recorded
 * as being high, so the sagged line reaches the pit floor and `exposure` collapses to nothing.
 *
 * Reported beside `exposure` rather than instead of it, because which of the two matches the
 * community figure better is exactly the question this tool exists to answer.
 */
function chordDrop(c: Candidate): number {
  const g = c.profile?.ground
  if (!g?.length) return NaN
  let worst = 0
  for (let i = 0; i < g.length; i++) {
    const t = g.length > 1 ? i / (g.length - 1) : 0
    const chord = c.a.anchor + (c.b.anchor - c.a.anchor) * t
    const here = chord - g[i]!
    if (here > worst) worst = here
  }
  return worst
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

function report(rows: Row[]): void {
  console.log(
    `\n${'id'.padEnd(9)}${'name'.padEnd(24)}${'kind'.padEnd(8)}` +
      `${pad('len', 7)}${pad('theirs', 8)}${pad('Δ%', 7)}  ` +
      `${pad('expo', 6)}${pad('drop', 6)}${pad('theirs', 8)}${pad('Δ%', 7)}  ` +
      `${pad('clear', 6)}${pad('score', 6)}  why the search would refuse it`,
  )
  for (const r of rows) {
    const dl = err(r.ourLength, r.theirLength)
    const dh = err(r.ourDrop, r.theirHeight)
    console.log(
      `${r.id.padEnd(9)}${r.name.slice(0, 23).padEnd(24)}${r.kind.padEnd(8)}` +
        `${pad(r.ourLength.toFixed(0), 7)}${pad(r.theirLength?.toFixed(0) ?? '--', 8)}` +
        `${pad(dl === null ? '--' : dl.toFixed(0), 7)}  ` +
        `${pad(r.ourExposure.toFixed(0), 6)}${pad(r.ourDrop.toFixed(0), 6)}` +
        `${pad(r.theirHeight?.toFixed(0) ?? '--', 8)}` +
        `${pad(dh === null ? '--' : dh.toFixed(0), 7)}  ` +
        `${pad(r.clearanceMin.toFixed(1), 6)}${pad(r.score.toFixed(0), 6)}  ` +
        `${r.violations.join(', ') || (r.canopyKnown ? '' : '(canopy unknown)')}`,
    )
  }

  const lengthErrs = rows.map((r) => err(r.ourLength, r.theirLength)).filter((v) => v !== null)
  const exposureErrs = rows.map((r) => err(r.ourExposure, r.theirHeight)).filter((v) => v !== null)
  const dropErrs = rows.map((r) => err(r.ourDrop, r.theirHeight)).filter((v) => v !== null)
  const spread = (name: string, errs: number[]) => {
    if (!errs.length) return console.log(`  ${name}: nothing to compare`)
    const within = (pct: number) => errs.filter((e) => Math.abs(e) <= pct).length
    console.log(
      `  ${name.padEnd(7)} ${errs.length} comparable, ` +
        `median ${median(errs) >= 0 ? '+' : ''}${median(errs).toFixed(0)} %, ` +
        `median |error| ${median(errs.map(Math.abs)).toFixed(0)} %, ` +
        `within 10 %: ${within(10)}, within 25 %: ${within(25)}`,
    )
  }
  console.log('\nAgreement')
  spread('length', lengthErrs)
  spread('drop', dropErrs)
  spread('expo', exposureErrs)
  /**
   * Urban lines split out where there are any, because over a city block the two sides are not
   * measuring the same ground: the height everything here works from is the composite -- terrain,
   * or the roof where there is one -- so a roof-to-roof line's drop is measured from the roofs,
   * while what gets written on slackmap is the height above the street.
   *
   * In practice there are none, and that is the finding rather than the absence of one. The city
   * model is Brandenburg's and stops at Berlin's border, so the roof lines in Mitte come out
   * classified as natural and measured as if the buildings under them were not there.
   */
  const bykind = (k: LineKind) =>
    rows.filter((r) => r.kind === k).map((r) => err(r.ourDrop, r.theirHeight)).filter((v) => v !== null)
  if (bykind('urban').length && bykind('natural').length) {
    spread('drop/nat', bykind('natural'))
    spread('drop/urb', bykind('urban'))
  }

  const failing = rows.filter((r) => r.violations.length)
  // By rule, not by wording. Every violation names the figure that broke it, so counting the
  // strings gives one bucket per line and no shape at all -- the numbers come out.
  const rule = (v: string) => v.replace(/-?\d+(\.\d+)?/g, 'N')
  const byRule = new Map<string, number>()
  for (const r of failing) for (const v of r.violations) byRule.set(rule(v), (byRule.get(rule(v)) ?? 0) + 1)
  console.log(
    `\nWould the search accept these real lines?\n` +
      `  ${rows.length - failing.length} of ${rows.length} pass every hard filter`,
  )
  for (const [rule, n] of [...byRule].sort((x, y) => y[1] - x[1])) {
    console.log(`  ${pad(n, 4)}  ${rule}`)
  }
  const blind = rows.filter((r) => !r.canopyKnown).length
  if (blind) console.log(`\n  ${blind} of ${rows.length} sit where no survey publishes a canopy.`)
}

async function main() {
  await mkdir(CACHE, { recursive: true })
  useCacheStore(diskCache)
  const params = (JSON.parse(readFileSync(META, 'utf8')) as { params: Params }).params
  const fine = { ...params, ...VIEWER_PROFILE }

  const lines = await germanHighlines()
  const rows: Row[] = []
  const skipped: string[] = []

  // The app announces every survivable failure to the console, which is right in a browser and
  // wrong here: the answer is a table and the noise is forty stack traces per line over ground
  // nobody surveys. Nothing is lost -- `failures()` keeps them all, and they are summarised below.
  const loud = console.error
  console.error = () => {}

  for (const [i, line] of lines.entries()) {
    const [from, to] = line.geometry.coordinates
    if (!from || !to) continue
    const [ae, an] = toUtm33(from[1]!, from[0]!)
    const [be, bn] = toUtm33(to[1]!, to[0]!)
    const a = { e: ae, n: an }
    const b = { e: be, n: bn }
    const id = line.properties.id

    // Outside what any source will answer for -- the planner's own coverage rule, not a guess.
    if (!sourceFor(a.e, a.n) || !sourceFor(b.e, b.n)) {
      skipped.push(`${id} no elevation source covers it`)
      continue
    }

    const info = await detailsOf(id).catch((e: unknown) => {
      skipped.push(`${id}: its detail page answered ${failureText(e)}`)
      return {} as LineDetails
    })
    const name = info.name ?? '(unnamed)'
    process.stdout.write(`\r[${i + 1}/${lines.length}] ${name.slice(0, 40).padEnd(42)}`)

    // A source that has nothing here throws rather than returning empty, and one line in Austria
    // tagged as German is enough to end the run. The windows that did arrive are kept; whether
    // enough of them arrived is a question `planLine` answers on its own.
    await ensureTerrain(a, b).catch(() => {})
    // Not tolerating gaps: a line measured over ground the survey never covered would report a
    // clearance minimum that simply did not look at the hill that sets it, and reading that as
    // agreement or disagreement would be worse than admitting there is no answer.
    const planned = planLine(a, b, groundSampler, surfaceSampler, params.sagRatio, fine, null, {
      roofs,
    })
    if (!planned) {
      skipped.push(`${id} ${name}: the survey has no height for one of its anchors`)
      continue
    }

    const c = planned.candidate
    rows.push({
      id,
      name,
      kind: c.kind,
      theirLength: info.length,
      ourLength: c.length,
      theirHeight: info.height,
      ourExposure: c.exposure,
      ourDrop: chordDrop(c),
      clearanceMin: c.clearanceMin,
      score: c.score,
      canopyKnown: surfaceKnown(a, b),
      violations: planned.violations,
    })
  }

  console.error = loud
  process.stdout.write('\r'.padEnd(60) + '\r')
  report(rows)

  // Every survivable failure the run met, collapsed by cause rather than by window. A line over
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
  console.log(`\nAny line above: ${onSlackmap('<id>')}`)
}

main().catch((e: unknown) => {
  console.error(e)
  process.exit(1)
})
