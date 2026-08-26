/**
 * One place every failure the app decides to survive is announced.
 *
 * The app is full of `catch` clauses that are correct in principle -- a missing city-model tile, a
 * refused IndexedDB, an Overpass timeout -- because none of them should take the map down. What was
 * wrong is that they all discarded the reason. Nothing reached the console, nothing reached the
 * error boundary (a swallowed rejection is never an unhandled one), and the user was left with a
 * spinner that never stopped or a message that blamed the data for a bug in the code.
 *
 * So: keep going, and say so. `report` is the seam. Every caller passes what it was trying to do,
 * in words a person could act on, and the failure goes to the console and to whoever is listening.
 *
 * Repeats collapse. Dragging across ground the elevation service is refusing produces one failure
 * per window per frame, and a hundred identical lines is not more informative than one with a
 * count on it.
 */

export interface Failure {
  /** What the app was trying to do, phrased for someone who cannot read the stack. */
  what: string
  error: unknown
  /** How many times this exact thing has failed, including this one. */
  count: number
}

const seen = new Map<string, Failure>()
const listeners = new Set<(f: Failure) => void>()

export const failureText = (error: unknown): string =>
  error instanceof Error ? `${error.name}: ${error.message}` : String(error)

export function report(what: string, error: unknown): void {
  const held = seen.get(what)
  const failure: Failure = { what, error, count: (held?.count ?? 0) + 1 }
  seen.set(what, failure)
  // Console first and always, so the detail is there even when nothing is listening yet.
  if (failure.count === 1) console.error(`[highline] ${what}:`, error)
  else if (failure.count % 25 === 0) console.error(`[highline] ${what} (x${failure.count}):`, error)
  for (const fn of listeners) fn(failure)
}

export function onFailure(fn: (f: Failure) => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/** Everything that has gone wrong this session, worst-repeated first. */
export const failures = (): Failure[] => [...seen.values()].sort((a, b) => b.count - a.count)
