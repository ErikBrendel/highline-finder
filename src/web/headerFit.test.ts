import { describe, expect, it, vi } from 'vitest'
import { fitLevel } from './headerFit.js'

/**
 * The ladder is walked from fewest concessions to most, and stops at the first rung that fits.
 * `fits` is the browser being asked whether the row overflows; here it is a predicate.
 */
describe('fitLevel', () => {
  const fitsFrom = (first: number) => (level: number) => level >= first

  it('gives up nothing when the row already fits', () => {
    expect(fitLevel(4, fitsFrom(0))).toBe(0)
  })

  it('gives up one thing at a time, and stops as soon as it fits', () => {
    expect(fitLevel(4, fitsFrom(1))).toBe(1)
    expect(fitLevel(4, fitsFrom(3))).toBe(3)
  })

  it('stops asking once a rung fits, rather than walking to the bottom', () => {
    const fits = vi.fn(fitsFrom(1))
    fitLevel(4, fits)
    expect(fits).toHaveBeenCalledTimes(2)
  })

  it('bottoms out rather than running off the ladder', () => {
    expect(fitLevel(4, () => false)).toBe(4)
  })

  it('depends on what fits and not on what it last decided, so a resize cannot oscillate', () => {
    const at = (first: number) => fitLevel(4, fitsFrom(first))
    expect([at(0), at(3), at(0)]).toEqual([0, 3, 0])
  })
})
