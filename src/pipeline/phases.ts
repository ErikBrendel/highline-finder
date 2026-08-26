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

export function enablePhases(): void {
  on = true
}

/** Start of a phase. Returns 0 when disabled, which `phaseDone` then ignores. */
export const phaseAt = (): number => (on ? performance.now() : 0)

export function phaseDone(name: string, since: number): void {
  if (!on) return
  elapsed.set(name, (elapsed.get(name) ?? 0) + (performance.now() - since))
}

/** Milliseconds per phase since the last call, which also clears them. */
export function takePhases(): Map<string, number> {
  const out = new Map(elapsed)
  elapsed.clear()
  return out
}
