import { describe, expect, it } from 'vitest'
import { patchAxes, tileRange, zoomFor } from './ortho.js'

/**
 * The imagery under the 3D view: which tiles to ask for, and where the square sits in them.
 *
 * All of it is arithmetic between two projections, which is exactly the kind of thing that looks
 * right on screen while being a few metres out -- so it is checked against what the patch is
 * actually made of rather than against itself.
 */

const BERLIN = 52.5
const EDGE = 20037508.342789244

describe('zoomFor', () => {
  it('keeps the tiles across the square bounded, whatever the span', () => {
    for (const halfSide of [60, 140, 300, 500]) {
      const z = zoomFor(halfSide, BERLIN)
      const tile = ((2 * EDGE) / 2 ** z) * Math.cos((BERLIN * Math.PI) / 180)
      expect((2 * halfSide) / tile).toBeLessThanOrEqual(6)
    }
  })

  it('asks for more detail of a smaller square', () => {
    expect(zoomFor(80, BERLIN)).toBeGreaterThan(zoomFor(400, BERLIN))
  })

  /** Twenty centimetres is all the surveys hold; past it the same photograph arrives larger. */
  it('stops at what the imagery actually resolves', () => {
    expect(zoomFor(10, BERLIN)).toBe(19)
  })
})

describe('tileRange', () => {
  it('covers the box it is given, inclusive of both edges', () => {
    const span = (2 * EDGE) / 2 ** 10
    const box = {
      minX: -EDGE + 2.5 * span,
      maxX: -EDGE + 4.2 * span,
      minY: -0.5 * span,
      maxY: 0.5 * span,
    }
    expect(tileRange(box, 10)).toEqual({ x0: 2, x1: 4, y0: 2 ** 9 - 1, y1: 2 ** 9 })
  })
})

describe('patchAxes', () => {
  /**
   * The square is in UTM and the imagery is in Web Mercator, and the two disagree about north by
   * up to three degrees. Pasting one into the other by its bounding box slips every roof in the
   * texture off the roof in the model, so the axes are measured rather than assumed.
   */
  const origin = { x: 1_500_000, y: 6_900_000, res: 0.3 }

  it('measures a patch axis as a rotation and a scale, not as an identity', () => {
    const axes = patchAxes({ e: 390_000, n: 5_820_000 }, 200, origin)
    // East in UTM is not east in Mercator: the north component is small and must not be zero.
    expect(Math.abs(axes.ey / axes.ex)).toBeGreaterThan(0.001)
    expect(Math.abs(axes.ey / axes.ex)).toBeLessThan(0.06)
    // Both axes carry the same scale to within Mercator's own stretch across the square, which
    // over a few hundred metres is a quarter of a percent and is why this is not an identity.
    const east = Math.hypot(axes.ex, axes.ey)
    expect(Math.abs(Math.hypot(axes.nx, axes.ny) / east - 1)).toBeLessThan(0.01)
  })

  it('agrees with what the mesh is built from: east is right, north is up the image', () => {
    const axes = patchAxes({ e: 390_000, n: 5_820_000 }, 200, origin)
    expect(axes.ex).toBeGreaterThan(0)
    expect(axes.ny).toBeLessThan(0)
  })
})
