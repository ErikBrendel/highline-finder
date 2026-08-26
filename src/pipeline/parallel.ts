import { addPhase, phaseCount } from '../shared/phases.js'
import { chunks, type AnchorTable, type Done, type Pool } from './pool.js'
import { poolScored, type FindResult, type RefineResult, type Scored, type TerrainPairs } from './lines.js'
import type { Candidate, Params } from '../shared/types.js'

/**
 * The three expensive stages, run across the pool.
 *
 * Each is the same shape: split the input into contiguous chunks, run them, concatenate the results
 * in chunk order. The order is not incidental -- dedup keeps the best line in each neighbourhood by
 * a stable sort, so the sequence candidates arrive in decides ties, and a parallel run has to
 * produce the dataset a serial one would. Contiguous chunks concatenated in order reproduce the
 * serial sequence exactly, for any number of chunks.
 *
 * Four chunks per worker rather than one, because anchors are not spread evenly over a region: one
 * chunk per worker leaves whichever worker drew the town centre still running while the rest idle.
 */

const SPLIT = 4

/** What the workers measured inside their hot loops, folded back into this thread's report. */
function fold(results: Done[]): void {
  for (const done of results) {
    for (const [name, ms] of done.phases) addPhase(name, ms)
    for (const [name, n] of done.counts) phaseCount(name, n)
  }
}

export async function pairInParallel(
  pool: Pool,
  table: AnchorTable,
  p: Params,
): Promise<TerrainPairs> {
  const ranges = chunks(table.count, pool.size * SPLIT)
  const results = await pool.run(
    ranges.map(([from, to]) => ({ kind: 'pairs' as const, anchors: table, from, to })),
  )
  fold(results)

  const parts = results.map((d) => d.value as TerrainPairs)
  const count = parts.reduce((s, part) => s + part.count, 0)
  const pairs = new Int32Array(count * 2)
  let at = 0
  for (const part of parts) {
    pairs.set(part.pairs, at)
    at += part.pairs.length
  }
  const sum = (pick: (part: TerrainPairs) => number) => parts.reduce((s, part) => s + pick(part), 0)
  return {
    pairs,
    count,
    pairsInRange: sum((x) => x.pairsInRange),
    pairsSectorPassed: sum((x) => x.pairsSectorPassed),
    pairsLevelEnough: sum((x) => x.pairsLevelEnough),
  }
}

export async function scoreInParallel(
  pool: Pool,
  table: AnchorTable,
  found: TerrainPairs,
  p: Params,
): Promise<FindResult> {
  const shared = new Int32Array(new SharedArrayBuffer(found.pairs.length * 4))
  shared.set(found.pairs)
  const results = await pool.run(
    chunks(found.count, pool.size * SPLIT).map(([from, to]) => ({
      kind: 'score' as const,
      pairs: shared.buffer as SharedArrayBuffer,
      total: found.count,
      anchors: table,
      from,
      to,
    })),
  )
  fold(results)
  return poolScored(results.map((d) => d.value as Scored), found, p)
}

export async function refineInParallel(
  pool: Pool,
  candidates: Candidate[],
): Promise<RefineResult> {
  const results = await pool.run(
    chunks(candidates.length, pool.size * SPLIT).map(([from, to]) => ({
      kind: 'refine' as const,
      candidates: candidates.slice(from, to),
    })),
  )
  fold(results)
  const parts = results.map((d) => d.value as RefineResult)
  const sum = (pick: (part: RefineResult) => number) => parts.reduce((s, x) => s + pick(x), 0)
  return {
    candidates: parts.flatMap((part) => part.candidates),
    improved: sum((x) => x.improved),
    totalGain: sum((x) => x.totalGain),
    evaluations: sum((x) => x.evaluations),
  }
}
