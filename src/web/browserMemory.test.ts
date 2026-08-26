import { describe, expect, it } from 'vitest'
import { Grid } from '../shared/grid.js'
import { RoofMask } from '../shared/anchoring.js'
import { WaterMask } from '../shared/water.js'

/**
 * The browser has no shared memory, and asking for it there is not a slow path but a crash.
 *
 * `SharedArrayBuffer` exists only on a cross-origin isolated page, and this app is not served with
 * the headers that would make it one. When the worker pool landed, `Grid.filled` and the WaterMask
 * constructor started allocating shared buffers for everyone -- so every elevation window in the
 * planner threw a ReferenceError before it made a single request, and the app reported "no
 * elevation coverage for this spot" for every line on Earth.
 *
 * These run with the constructor taken away, which is exactly the browser's situation.
 */
describe('what the browser allocates', () => {
  const withoutSharedMemory = (fn: () => void) => {
    const held = (globalThis as { SharedArrayBuffer?: unknown }).SharedArrayBuffer
    delete (globalThis as { SharedArrayBuffer?: unknown }).SharedArrayBuffer
    try {
      fn()
    } finally {
      ;(globalThis as { SharedArrayBuffer?: unknown }).SharedArrayBuffer = held
    }
  }

  it('builds the rasters the planner needs without shared memory', () => {
    withoutSharedMemory(() => {
      const geom = { w: 8, h: 8, e0: 0, n1: 8, res: 1 }
      expect(Grid.filled(8, 8, 0, 8, 1).data).toHaveLength(64)
      expect(new WaterMask(geom).covers(1, 1)).toBe(false)
      expect(RoofMask.forGrid(Grid.filled(8, 8, 0, 8, 1)).count()).toBe(0)
    })
  })

  it('still hands the pipeline shared buffers when it asks for them', () => {
    const geom = { w: 8, h: 8, e0: 0, n1: 8, res: 1 }
    expect(Grid.shared(8, 8, 0, 8, 1).data.buffer).toBeInstanceOf(SharedArrayBuffer)
    expect(WaterMask.shared(geom).share().buffer).toBeInstanceOf(SharedArrayBuffer)
    expect(Grid.filled(8, 8, 0, 8, 1).data.buffer).toBeInstanceOf(ArrayBuffer)
  })
})
