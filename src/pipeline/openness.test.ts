import { describe, expect, it } from 'vitest'
import { packSectors, scanAnchors } from './openness.js'
import { gridFrom } from './testing.js'
import { DEFAULT_PARAMS } from './params.js'
import { sectorOf } from '../shared/geo.js'
import type { Params } from '../shared/types.js'

const p: Params = DEFAULT_PARAMS

const EAST = sectorOf(Math.PI / 2, p.sectorCount)
const WEST = sectorOf((3 * Math.PI) / 2, p.sectorCount)

/** Nearest scanned anchor to a coordinate, or undefined if that point was rejected. */
function anchorAt(anchors: ReturnType<typeof scanAnchors>['anchors'], e: number, n: number) {
  return anchors.find((a) => Math.abs(a.e - e) <= 2.5 && Math.abs(a.n - n) <= 2.5)
}

/** Plateau at 50 m west of e=200, floor `depth` metres lower to the east. */
const cliff = (depth: number) => gridFrom(400, 400, (e) => (e < 200 ? 50 : 50 - depth))

describe('drop prefilter', () => {
  it('rejects flat terrain without considering any direction', () => {
    const r = scanAnchors(gridFrom(300, 300, () => 40), p)
    expect(r.scanned).toBeGreaterThan(1000)
    expect(r.passedDropTest).toBe(0)
    expect(r.anchors).toHaveLength(0)
  })

  it('measures the required drop from the attachment point, not the ground', () => {
    // The attachment sits aFrameMax up, so the terrain only has to fall minDropDepth - aFrameMax.
    const needed = p.minDropDepth - p.aFrameMax
    expect(scanAnchors(cliff(needed - 1), p).passedDropTest).toBe(0)
    expect(scanAnchors(cliff(needed + 1), p).passedDropTest).toBeGreaterThan(0)
  })

  it('only counts a drop inside dropSearchRadius', () => {
    // One pit, two radii: widening the search brings more of the plateau into range.
    const pit = cliff(20)
    const near = scanAnchors(pit, { ...p, dropSearchRadius: 25 })
    const wide = scanAnchors(pit, { ...p, dropSearchRadius: 75 })
    expect(near.passedDropTest).toBeGreaterThan(0)
    expect(near.passedDropTest).toBeLessThan(near.scanned)
    expect(wide.passedDropTest).toBeGreaterThan(near.passedDropTest)
  })
})

describe('directional scan', () => {
  it('opens only the sectors where the ground falls away', () => {
    const rim = anchorAt(scanAnchors(cliff(30), p).anchors, 197.5, 200)
    expect(rim).toBeDefined()
    expect(rim!.open[EAST]).toBe(1)
    expect(rim!.open[WEST]).toBe(0)
  })

  it('is blocked by an obstruction in front of a drop, unlike a plain slope test', () => {
    // Same cliff, but a wall sits between the anchor and the edge. The terrain still falls away to
    // the east, yet no line can leave in that direction.
    const walled = gridFrom(400, 400, (e) => {
      if (e >= 210 && e <= 214) return 62
      return e < 220 ? 50 : 20
    })
    expect(anchorAt(scanAnchors(walled, p).anchors, 197.5, 200)?.open[EAST] ?? 0).toBe(0)
  })

  it('can pass the drop test yet have no usable direction at all', () => {
    // A narrow slot deep enough to satisfy the omnidirectional test, with terrain either side of it
    // at anchor height. Nothing can leave this point, and the two stages disagreeing like this is
    // exactly what makes the directional scan worth running after the cheap one.
    const slot = gridFrom(400, 400, (e) => (e >= 215 && e <= 219 ? 40 : 50))
    const r = scanAnchors(slot, p)
    expect(r.passedDropTest).toBeGreaterThan(0)
    expect(r.anchors).toHaveLength(0)
  })

  it('keeps a steadily descending ramp open', () => {
    const ramp = gridFrom(400, 400, (e) => (e < 200 ? 50 : 50 - (e - 200) * 0.3))
    expect(anchorAt(scanAnchors(ramp, p).anchors, 202.5, 200)!.open[EAST]).toBe(1)
  })
})

describe('packSectors', () => {
  it('round-trips a mask, four sectors per hex digit, least significant bit first', () => {
    const open = new Uint8Array(8)
    open[0] = 1
    open[3] = 1
    open[4] = 1
    expect(packSectors(open)).toBe('91')

    const decode = (hex: string, i: number) => (parseInt(hex[i >> 2]!, 16) >> (i & 3)) & 1
    const hex = packSectors(open)
    for (let i = 0; i < open.length; i++) expect(decode(hex, i)).toBe(open[i])
  })
})

describe('disc confirmation', () => {
  it('rejects a drop that only the square min window could reach', () => {
    // A pit placed diagonally, just past dropSearchRadius but inside the square window's corner.
    const r = p.dropSearchRadius
    const diag = Math.round(r * 0.8)
    const pit = gridFrom(300, 300, (e, n) =>
      e >= 150 + diag && n >= 150 + diag ? 30 : 50,
    )
    const corner = Math.hypot(diag, diag)
    expect(corner).toBeGreaterThan(r)
    expect(corner).toBeLessThan(r * Math.SQRT2)

    // The point at (150,150) sees the pit only in the square window's corner, not within the disc.
    const at150 = scanAnchors(pit, p).anchors.find(
      (a) => Math.abs(a.e - 152.5) <= 2.5 && Math.abs(a.n - 152.5) <= 2.5,
    )
    expect(at150).toBeUndefined()
  })

  it('records how far the terrain actually falls', () => {
    const rim = scanAnchors(cliff(20), p).anchors.find((a) => Math.abs(a.e - 197.5) <= 2.5)!
    // Attachment is aFrameMax above 50 m ground, floor at 30 m.
    expect(rim.dropDepth).toBeCloseTo(50 + p.aFrameMax - 30, 1)
  })
})
