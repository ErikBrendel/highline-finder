/**
 * A stopwatch for phases *inside* a hot loop, off unless the pipeline turns it on.
 *
 * The scoring stage is the single biggest consumer of the run and `stage()` can only say so as one
 * number, which is enough to know where to look and not enough to know what to do. Splitting it
 * means timing something called two million times, so the instrument has to be nearly free: a
 * `performance.now()` pair is about 25 ns, and six of them per line costs well under a second
 * against the several hundred the stage takes.
 *
 * Off by default so the unit tests and any future non-pipeline caller pay two branch predictions
 * and nothing else.
 */

let on = false
const elapsed = new Map<string, number>()
const tallies = new Map<string, number>()

export function enablePhases(): void {
  on = true
}

/** Start of a phase. Returns 0 when disabled, which `phaseDone` then ignores. */
export const phaseAt = (): number => (on ? performance.now() : 0)

export function phaseDone(name: string, since: number): void {
  if (!on) return
  elapsed.set(name, (elapsed.get(name) ?? 0) + (performance.now() - since))
}

/**
 * A running count of something the hot loop did, aggregated the same way a phase is.
 *
 * The companion to the stopwatch, and the answer where the stopwatch is unaffordable. Timing a
 * per-sample step inside `clearsTerrain` would cost several times the step itself, but counting the
 * samples costs an integer add -- and "how far does the walk get before it bails" is the question
 * worth asking there anyway.
 *
 * Count in a local variable inside the loop and call this once on the way out, rather than once per
 * iteration: at nine billion samples a run, even a branch is a cost worth not paying.
 */
export function phaseCount(name: string, n = 1): void {
  if (!on) return
  tallies.set(name, (tallies.get(name) ?? 0) + n)
}

/** Milliseconds per phase since the last call, which also clears them. */
export function takePhases(): Map<string, number> {
  const out = new Map(elapsed)
  elapsed.clear()
  return out
}

/** Counts since the last call, which also clears them. */
export function takeCounts(): Map<string, number> {
  const out = new Map(tallies)
  tallies.clear()
  return out
}
