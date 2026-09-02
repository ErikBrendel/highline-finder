import { describe, expect, it } from 'vitest'
import { stale, type Ground } from './Terrain3D.js'

/**
 * When the ground under the 3D view has to be read again.
 *
 * The whole point is that it usually does not. Reading a patch is a quarter of a million heights;
 * doing it for every few metres an anchor is nudged would make the view stutter exactly while
 * someone is using it, so a patch is built with room around the span and the span is allowed to
 * wander inside it.
 */
const held: Ground = { centre: { e: 400_000, n: 5_785_000 }, halfSide: 200, datum: 30 }
/** A line of the length this patch was built for, with its ends offset east by the given metres. */
const line = (aEast: number, bEast: number) => [
  { e: held.centre.e + aEast, n: held.centre.n },
  { e: held.centre.e + bEast, n: held.centre.n },
] as const

describe('stale', () => {
  it('has to build one when there is none', () => {
    const [a, b] = line(-100, 100)
    expect(stale(null, a, b)).toBe(true)
  })

  it('lets the line wander inside the patch it was given', () => {
    expect(stale(held, ...line(-100, 100))).toBe(false)
    expect(stale(held, ...line(-60, 140))).toBe(false)
  })

  /** The complaint this rule exists for: an anchor at the rim has no surroundings to look at. */
  it('rebuilds once an anchor runs out of ground beyond it', () => {
    expect(stale(held, ...line(-100, 149))).toBe(false)
    expect(stale(held, ...line(-100, 152))).toBe(true)
  })

  it('asks the ends and not the middle, which can sit still while an end leaves', () => {
    // Midpoint dead centre, both anchors out at the rim.
    expect(stale(held, ...line(-190, 190))).toBe(true)
  })

  it('measures against the sides of the square rather than the distance from its centre', () => {
    const [a] = line(0, 0)
    const corner = { e: held.centre.e + 140, n: held.centre.n + 140 }
    // 198 m from the centre, which is inside a 200 m radius -- but 140 m along each axis, which is
    // comfortably inside a 150 m limit per side.
    expect(Math.hypot(140, 140)).toBeGreaterThan(150)
    expect(stale(held, a, corner)).toBe(false)
  })

  it('rebuilds when the line wants a square of a noticeably different size', () => {
    // A much longer line, still centred: it needs a bigger square whatever its ends are doing.
    expect(stale(held, ...line(-160, 160))).toBe(true)
    // And a much shorter one does not go on looking at a field. Asked of a wide patch, since the
    // smallest square is 140 m a side and nothing is small enough to shrink out of a 200 m one.
    const wide: Ground = { ...held, halfSide: 400 }
    expect(stale(wide, ...line(-20, 20))).toBe(true)
  })

  /**
   * The rule has to settle in one step. Re-centring on the line's own midpoint with a square sized
   * to its length always leaves each end well inside the new edge -- if it did not, an anchor at
   * the rim would rebuild into another patch it was at the rim of, for ever.
   */
  it('is satisfied by the patch it asks for, at every length', () => {
    for (const len of [20, 50, 140, 300, 500]) {
      const a = { e: 0, n: 0 }
      const b = { e: len * Math.SQRT1_2, n: len * Math.SQRT1_2 }
      const chosen: Ground = {
        centre: { e: (a.e + b.e) / 2, n: (a.n + b.n) / 2 },
        halfSide: Math.max(140, len * 0.85),
        datum: 0,
      }
      expect(stale(chosen, a, b)).toBe(false)
    }
  })
})
