import { availableParallelism } from 'node:os'
import { Worker } from 'node:worker_threads'
import type { Anchor } from './openness.js'
import type { GridShare } from '../shared/grid.js'
import type { MaskShare } from '../shared/anchoring.js'
import type { Candidate, Params } from '../shared/types.js'

/**
 * A fixed set of worker threads sharing one region's rasters.
 *
 * The three expensive stages -- the pair search, the profile pass and the local refinement -- all
 * do the same shape of work: a long list of independent items, each read-only against the same
 * rasters. That is the case worker threads are for, and the reason it was not simply done from the
 * start is memory: the terrain and surface grids are 700 MB each on the biggest region, so a pool
 * that copied them would need twelve gigabytes to use eight cores. The grids and masks are
 * therefore allocated on SharedArrayBuffers and passed by reference; nothing writes to them once
 * they are assembled.
 *
 * The road network is the exception. It is a map of buckets holding objects, which cannot live in
 * shared memory without being rewritten as typed arrays -- so each worker loads it from the same
 * on-disk blocks instead. That costs half a second and about 40 MB per worker, against the several
 * minutes the parallel stages save.
 *
 * Determinism is a requirement, not a bonus: dedup keeps the best line in each neighbourhood by a
 * stable sort, so the order candidates arrive in decides which of two equal-scoring lines survives.
 * Every stage therefore splits its input into one contiguous chunk per worker and concatenates the
 * results back in chunk order, which reproduces the serial order exactly.
 */

export interface Scene {
  ground: GridShare
  roofs: MaskShare | null
  water: MaskShare | null
  bbox: { minE: number; minN: number; maxE: number; maxN: number }
  params: Params
}

/** Anchors as flat arrays, so the pair search can read them from shared memory. */
export interface AnchorTable {
  /** `[e, n, ground, anchorMin, anchorMax, dropDepth]` per anchor. */
  fields: SharedArrayBuffer
  /** `sectorCount` bytes per anchor, one per sector. */
  open: SharedArrayBuffer
  count: number
  sectorCount: number
}

export const ANCHOR_FIELDS = 6

export function shareAnchors(anchors: Anchor[], sectorCount: number): AnchorTable {
  const fields = new Float64Array(new SharedArrayBuffer(anchors.length * ANCHOR_FIELDS * 8))
  const open = new Uint8Array(new SharedArrayBuffer(anchors.length * sectorCount))
  anchors.forEach((a, i) => {
    const at = i * ANCHOR_FIELDS
    fields[at] = a.e
    fields[at + 1] = a.n
    fields[at + 2] = a.ground
    fields[at + 3] = a.anchorMin
    fields[at + 4] = a.anchorMax
    fields[at + 5] = a.dropDepth
    open.set(a.open, i * sectorCount)
  })
  return {
    fields: fields.buffer as SharedArrayBuffer,
    open: open.buffer as SharedArrayBuffer,
    count: anchors.length,
    sectorCount,
  }
}

export function readAnchors(table: AnchorTable): Anchor[] {
  const fields = new Float64Array(table.fields)
  const open = new Uint8Array(table.open)
  const out: Anchor[] = []
  for (let i = 0; i < table.count; i++) {
    const at = i * ANCHOR_FIELDS
    const bits = open.subarray(i * table.sectorCount, (i + 1) * table.sectorCount)
    out.push({
      e: fields[at]!,
      n: fields[at + 1]!,
      ground: fields[at + 2]!,
      anchorMin: fields[at + 3]!,
      anchorMax: fields[at + 4]!,
      dropDepth: fields[at + 5]!,
      open: bits,
      openCount: bits.reduce((s, v) => s + v, 0),
    })
  }
  return out
}

export type Job =
  | { kind: 'pairs'; anchors: AnchorTable; from: number; to: number }
  | { kind: 'score'; pairs: SharedArrayBuffer; total: number; anchors: AnchorTable; from: number; to: number }
  | { kind: 'refine'; candidates: Candidate[] }
  | { kind: 'surface'; grid: GridShare }

export interface Done {
  /** Whatever the job produced, shaped by its kind. */
  value: unknown
  /** Seconds per phase and counts per tally, so the run report still sees inside the hot loops. */
  phases: [string, number][]
  counts: [string, number][]
}

/** One less than the cores, so the main thread stays responsive while the pool works. */
export const poolSize = () => Math.max(1, Math.min(16, availableParallelism() - 1))

export class Pool {
  private readonly workers: Worker[] = []
  private readonly idle: Worker[] = []
  private readonly queue: { job: Job; resolve: (d: Done) => void; reject: (e: Error) => void }[] = []
  private readonly busy = new Map<Worker, { resolve: (d: Done) => void; reject: (e: Error) => void }>()
  private ready: Promise<void>

  constructor(scene: Scene, size = poolSize()) {
    const url = new URL('./workerBoot.mjs', import.meta.url)
    const starts: Promise<void>[] = []
    for (let i = 0; i < size; i++) {
      const worker = new Worker(url, { workerData: scene })
      this.workers.push(worker)
      starts.push(
        new Promise<void>((resolve, reject) => {
          worker.once('message', (m: { ready?: true; error?: string }) => {
            if (m.error) reject(new Error(m.error))
            else resolve()
          })
          worker.once('error', reject)
        }).then(() => {
          worker.on('message', (m: Done & { error?: string }) => {
            const waiting = this.busy.get(worker)
            this.busy.delete(worker)
            if (!waiting) return
            if (m.error) waiting.reject(new Error(m.error))
            else waiting.resolve(m)
            this.take(worker)
          })
          worker.on('error', (e) => {
            const waiting = this.busy.get(worker)
            this.busy.delete(worker)
            waiting?.reject(e)
          })
          this.idle.push(worker)
        }),
      )
    }
    this.ready = Promise.all(starts).then(() => undefined)
  }

  private take(worker: Worker): void {
    const next = this.queue.shift()
    if (!next) {
      this.idle.push(worker)
      return
    }
    this.busy.set(worker, next)
    worker.postMessage(next.job)
  }

  /**
   * Sends one job to every worker, for the scene changes they all have to see.
   *
   * Not `run` with one job per worker: that hands jobs to whichever worker is free, so two could
   * land on the same one and leave another without the surface model it is about to be asked to
   * read. Only valid between stages, which is the only time it is wanted.
   */
  async broadcast(job: Job): Promise<void> {
    await this.ready
    if (this.busy.size || this.queue.length) throw new Error('broadcast while the pool is working')
    await Promise.all(
      this.workers.map(
        (worker) =>
          new Promise<Done>((resolve, reject) => {
            this.idle.splice(this.idle.indexOf(worker), 1)
            this.busy.set(worker, { resolve, reject })
            worker.postMessage(job)
          }),
      ),
    )
  }

  /** Runs every job and returns the results in the order the jobs were given. */
  async run(jobs: Job[]): Promise<Done[]> {
    await this.ready
    return Promise.all(
      jobs.map(
        (job) =>
          new Promise<Done>((resolve, reject) => {
            const waiting = { job, resolve, reject }
            const worker = this.idle.pop()
            if (!worker) {
              this.queue.push(waiting)
              return
            }
            this.busy.set(worker, waiting)
            worker.postMessage(job)
          }),
      ),
    )
  }

  get size(): number {
    return this.workers.length
  }

  async close(): Promise<void> {
    await Promise.all(this.workers.map((w) => w.terminate()))
  }
}

/** Contiguous ranges covering `total`, one per worker, so the results concatenate in input order. */
export function chunks(total: number, parts: number): [number, number][] {
  if (total === 0) return []
  const per = Math.ceil(total / parts)
  const out: [number, number][] = []
  for (let from = 0; from < total; from += per) out.push([from, Math.min(total, from + per)])
  return out
}
