import { takeCounts, takePhases } from '../shared/phases.js'

/**
 * The run report: what each stage cost and how much data it passed on.
 *
 * Two things this exists to fix. Stages used to be printed sorted by cost, which answers "what is
 * expensive" and destroys the only other thing the list knows -- the shape of the pipeline, which
 * is the part that tells you whether a stage is expensive because it is slow or because everything
 * upstream of it handed it too much work. And the funnel counts were scattered through the log next
 * to the stage that happened to produce them, so relating one to another meant scrolling.
 *
 * So: one table, in the order the work happens, with the counts flowing down it. A stage's `out` is
 * the next stage's `in`, and where it is not -- because the unit changed from cells to anchors to
 * pairs -- the table says so rather than pretending the numbers are comparable.
 *
 * Three levels. A *stage* is timed by the clock and the processor. A *phase* is a timed part of a
 * stage, measured from inside a hot loop by phases.ts. A *step* is a counted part of a stage, with
 * no time of its own -- the prefilters inside the pair search are steps, since they are branches in
 * one loop and there is nothing separable to time.
 *
 * Steps come from two places and are treated identically: the flow callback here, and `phaseCount`
 * from inside a hot loop. The ones declared here land first, so a stage's own funnel reads before
 * the detail of how one part of it spent its iterations.
 */

export interface Flow {
  /** What the stage was handed, and the noun it counts. */
  from?: [number, string]
  /** What it passed on. */
  to?: [number, string]
  /** Counted sub-steps, each a share of the one before it (the first, a share of `from`). */
  steps?: [string, number][]
}

interface Row {
  label: string
  cpu: number
  wall: number
  from?: [number, string]
  to?: [number, string]
  steps: Map<string, number>
  phases: Map<string, number>
}

/** Insertion-ordered, which is what makes the table readable: it is the pipeline, top to bottom. */
const rows = new Map<string, Row>()

function rowFor(rawLabel: string): Row {
  // Summed across regions: which stage is expensive matters more than which region was, so the
  // "(region 3/7)" a live log line carries is not part of the stage's identity.
  const label = rawLabel.replace(/ \(region[^)]*\)/, '')
  const held = rows.get(label)
  if (held) return held
  const made: Row = { label, cpu: 0, wall: 0, steps: new Map(), phases: new Map() }
  rows.set(label, made)
  return made
}

function apply(row: Row, flow: Flow | undefined): void {
  if (flow?.from) row.from = [(row.from?.[0] ?? 0) + flow.from[0], flow.from[1]]
  if (flow?.to) row.to = [(row.to?.[0] ?? 0) + flow.to[0], flow.to[1]]
  for (const [name, n] of flow?.steps ?? []) row.steps.set(name, (row.steps.get(name) ?? 0) + n)
}

const totalCpu = () => [...rows.values()].reduce((s, r) => s + r.cpu, 0)

/**
 * Times a stage on the clock *and* on the processor, reporting the processor figure when the two
 * disagree.
 *
 * Wall clock alone is a trap on a laptop. A run left overnight reported a stage at 1926s that had
 * taken 597s of CPU -- the machine had slept -- and that number was taken at face value and
 * diagnosed as a performance regression that did not exist. A stage that spends its time waiting on
 * the network legitimately shows a gap too, which is worth seeing for its own sake.
 *
 * Whatever the hot-loop timer accrued while this ran is attributed here, so a stage that calls into
 * instrumented code gets its phase breakdown without having to ask for one.
 */
export async function stage<T>(
  label: string,
  run: () => T | Promise<T>,
  flow?: (out: T) => Flow,
): Promise<T> {
  takePhases()
  takeCounts()
  const started = Date.now()
  const cpuBefore = process.cpuUsage()
  const out = await run()
  const seconds = (Date.now() - started) / 1000
  const cpu = process.cpuUsage(cpuBefore)
  const cpuSeconds = (cpu.user + cpu.system) / 1e6

  const row = rowFor(label)
  row.cpu += cpuSeconds
  row.wall += seconds
  for (const [name, ms] of takePhases()) {
    row.phases.set(name, (row.phases.get(name) ?? 0) + ms / 1000)
  }
  apply(row, flow?.(out))
  for (const [name, n] of takeCounts()) row.steps.set(name, (row.steps.get(name) ?? 0) + n)

  // Only worth two numbers live when they differ enough to change what you would conclude.
  const split = seconds > cpuSeconds * 1.2 + 1 ? `, ${cpuSeconds.toFixed(1)}s cpu` : ''
  console.log(`${label}  [${seconds.toFixed(1)}s${split}]`)
  return out
}

/** Records counts for a stage that is not worth timing, so it still appears in the funnel. */
export function record(label: string, flow: Flow): void {
  apply(rowFor(label), flow)
}

/** Short enough to line up in a column, precise enough to compare two runs. */
export function compact(n: number): string {
  const abs = Math.abs(n)
  if (abs < 10_000) return n.toLocaleString('en-US')
  if (abs < 1e6) return `${(n / 1e3).toFixed(abs < 1e5 ? 1 : 0)}k`
  if (abs < 1e9) return `${(n / 1e6).toFixed(abs < 1e8 ? 1 : 0)}M`
  return `${(n / 1e9).toFixed(2)}G`
}

function share(n: number, d: number): string {
  if (!(d > 0)) return ''
  const v = (100 * n) / d
  return `${v.toFixed(v >= 10 ? 0 : v >= 1 ? 1 : 2)}%`
}

/**
 * How much of what came in came out -- as a percentage when the stage narrowed, and as a
 * multiplier when it widened.
 *
 * Not every stage counts the same noun at both ends. Four tiles become 1.2 million cells and
 * eighteen hundred anchors become four thousand pairs, and rendering either as a percentage
 * produced the honest but useless "29739500.0%". A stage that fans out is measured by its fan-out.
 */
function flowOf(n: number, d: number): string {
  if (!(d > 0)) return ''
  if (n <= d) return share(n, d)
  const factor = n / d
  // Past ten thousand the two ends are not the same kind of thing at all -- cells per tile, say --
  // and the number is a unit conversion wearing a funnel's clothes. Better blank. Three thousand
  // pairs per anchor is a real figure about the search and stays.
  if (factor > 10_000) return ''
  return `x${factor >= 10 ? Math.round(factor).toLocaleString('en-US') : factor.toFixed(1)}`
}

const amount = (v: [number, string] | undefined) => (v ? `${compact(v[0])} ${v[1]}` : '')

/**
 * A stage's phases, converted onto the same clock as the stage and completed with the part of it
 * that no phase covered.
 *
 * Phases are read off `performance.now()`, because a `process.cpuUsage()` call per phase is a
 * syscall and these are timed two million times a run. So they arrive as wall figures for a table
 * of processor figures, and on a laptop that slept mid-stage they came out larger than the stage
 * containing them -- 564s of raster walk inside 128s of pairing, which is the exact failure this
 * file's stage timer was written to prevent.
 *
 * Converting at the stage's own wall-to-processor ratio is the correction available without making
 * the instrument expensive. It assumes the lost time was spread evenly through the stage, which a
 * sleep is not; where the two clocks agree, which is most stages, the factor is 1 and the figures
 * are exact either way.
 */
export function phaseRows(
  cpu: number,
  wall: number,
  phases: Iterable<readonly [string, number]>,
): [string, number][] {
  const onProcessor = wall > 0 ? Math.min(1, cpu / wall) : 1
  const scaled = [...phases].map(([name, seconds]): [string, number] => [name, seconds * onProcessor])
  if (!scaled.length) return scaled
  // What the stage did outside any phase -- the enumeration around the pair search's raster walk,
  // say. Named rather than left as a gap, so the phase list adds up to the stage above it.
  const rest = cpu - scaled.reduce((s, [, seconds]) => s + seconds, 0)
  if (rest > cpu * 0.02) scaled.push(['everything else', rest])
  return scaled.sort((a, b) => b[1] - a[1])
}

export interface Line {
  label: string
  time: string
  wall: string
  pct: string
  from: string
  to: string
  kept: string
}

/** The rendered table as data, which is what the tests read. */
export function reportLines(): Line[] {
  const total = totalCpu()
  const out: Line[] = []
  for (const row of rows.values()) {
    // A stage whose two clocks agree gets one number. They part in both directions and both are
    // worth seeing: a download or a sleep leaves the clock ahead, a pool of threads leaves it behind.
    const drifted = row.wall > row.cpu * 1.2 + 1 || row.cpu > row.wall * 1.2 + 1
    out.push({
      label: row.label,
      time: `${row.cpu.toFixed(1)}s`,
      wall: drifted ? `${row.wall.toFixed(0)}s` : '',
      pct: share(row.cpu, total),
      from: amount(row.from),
      to: amount(row.to),
      kept: row.from && row.to ? flowOf(row.to[0], row.from[0]) : '',
    })
    // Steps first, so the funnel stays unbroken down the page: each chains off the one above it,
    // and the first off what reached the stage.
    let previous = row.from?.[0]
    for (const [name, n] of row.steps) {
      out.push({
        label: `  . ${name}`,
        time: '',
        wall: '',
        pct: '',
        from: '',
        to: compact(n),
        kept: previous === undefined ? '' : flowOf(n, previous),
      })
      previous = n
    }
    // Then what the stage spent its time on, which explains the cost rather than the flow.
    for (const [name, seconds] of phaseRows(row.cpu, row.wall, row.phases)) {
      out.push({
        label: `  . ${name}`,
        time: `${seconds.toFixed(1)}s`,
        wall: '',
        pct: share(seconds, total),
        from: '',
        to: '',
        kept: '',
      })
    }
  }
  return out
}

export function renderReport(wallSeconds: number): void {
  const rendered = reportLines()
  if (!rendered.length) return
  const total = totalCpu()
  const w = (pick: (l: Line) => string, head: string) =>
    Math.max(head.length, ...rendered.map((l) => pick(l).length))
  const cols = {
    label: w((l) => l.label, 'stage'),
    time: w((l) => l.time, 'cpu'),
    wall: w((l) => l.wall, 'clock'),
    pct: w((l) => l.pct, 'share'),
    from: w((l) => l.from, 'in'),
    to: w((l) => l.to, 'out'),
    kept: w((l) => l.kept, 'kept'),
  }
  const row = (l: Line) =>
    (
      `  ${l.label.padEnd(cols.label)}  ${l.time.padStart(cols.time)} ` +
      `${l.wall.padStart(cols.wall)} ${l.pct.padStart(cols.pct)}   ` +
      `${l.from.padStart(cols.from)} ${l.to ? '->' : '  '} ${l.to.padEnd(cols.to)} ` +
      `${l.kept.padStart(cols.kept)}`
    ).trimEnd()

  console.log('\nwhere the time went and what flowed through, in the order it happens:')
  console.log(
    row({ label: 'stage', time: 'cpu', wall: 'clock', pct: 'share', from: 'in', to: 'out', kept: 'kept' })
      .replace(' -> ', '    '),
  )
  for (const l of rendered) console.log(row(l))
  console.log(
    `  ${'total'.padEnd(cols.label)}  ${total.toFixed(1).concat('s').padStart(cols.time)} ` +
      `${wallSeconds.toFixed(0).concat('s').padStart(cols.wall)}`,
  )
  console.log(
    '\n  cpu is processor time summed over every thread; clock is shown where the two differ --\n' +
      '  ahead of cpu for a download or a sleep, behind it wherever the worker pool ran.',
  )
}
