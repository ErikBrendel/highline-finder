import { describe, expect, it } from 'vitest'
import { scanAnchors } from './openness.js'
import { gridFrom } from './testing.js'
import { DEFAULT_PARAMS } from './params.js'
import { sectorOf } from '../shared/geo.js'
import type { Params } from '../shared/types.js'

const p: Params = { ...DEFAULT_PARAMS, anchorStep: 5 }

const EAST = sectorOf(Math.PI / 2, p.sectorCount)
const WEST = sectorOf((3 * Math.PI) / 2, p.sectorCount)

/** Nearest scanned anchor to a coordinate, or undefined if that point was rejected. */
function anchorAt(anchors: ReturnType<typeof scanAnchors>['anchors'], e: number, n: number) {
  return anchors.find((a) => Math.abs(a.e - e) <= 2.5 && Math.abs(a.n - n) <= 2.5)
}

describe('scanAnchors', () => {
  it('rejects flat terrain entirely', () => {
    const { anchors, scanned } = scanAnchors(gridFrom(300, 300, () => 40), p)
    expect(scanned).toBeGreaterThan(1000)
    expect(anchors).toHaveLength(0)
  })

  it('opens only the sectors facing a drop', () => {
    // Plateau at 50 m west of e=200, floor at 20 m east of it.
    const { anchors } = scanAnchors(gridFrom(400, 400, (e) => (e < 200 ? 50 : 20)), p)
    const rim = anchorAt(anchors, 197.5, 200)
    expect(rim).toBeDefined()
    expect(rim!.open[EAST]).toBe(1)
    expect(rim!.open[WEST]).toBe(0)
  })

  it('is blocked by an obstruction in front of a drop, unlike a plain slope test', () => {
    // Same cliff, but a 12 m wall sits between the anchor and the edge. The terrain still
    // "falls off to the east", yet no line can leave in that direction.
    const walled = gridFrom(400, 400, (e) => {
      if (e >= 210 && e <= 214) return 62
      return e < 220 ? 50 : 20
    })
    const rim = anchorAt(scanAnchors(walled, p).anchors, 197.5, 200)
    expect(rim?.open[EAST] ?? 0).toBe(0)
  })

  it('measures the required drop from anchor height, not from the ground', () => {
    // The probe sits aFrameMax above the terrain, so the ground only has to fall
    // minProbeDrop - aFrameMax for the drop condition to be met.
    const needed = p.minProbeDrop - p.aFrameMax
    const step = (drop: number) => gridFrom(400, 400, (e) => (e < 200 ? 50 : 50 - drop))
    expect(anchorAt(scanAnchors(step(needed - 1), p).anchors, 197.5, 200)?.open[EAST] ?? 0).toBe(0)
    expect(anchorAt(scanAnchors(step(needed + 1), p).anchors, 197.5, 200)!.open[EAST]).toBe(1)
  })
})
