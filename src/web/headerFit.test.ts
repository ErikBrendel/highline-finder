import { describe, expect, it } from 'vitest'
import { fitLevel } from './headerFit.js'

/**
 * `need` descends because each step of the ladder gives something up: the header wants 430 px
 * saying everything, 245 px saying the least it can.
 */
const need = [430, 412, 328, 281, 245]

describe('fitLevel', () => {
  it('gives up nothing while everything fits, and one thing at a time as it stops', () => {
    expect(fitLevel(need, 800)).toBe(0)
    expect(fitLevel(need, 450)).toBe(1)
    expect(fitLevel(need, 360)).toBe(2)
    expect(fitLevel(need, 320)).toBe(3)
    expect(fitLevel(need, 300)).toBe(4)
  })

  it('keeps a gap rather than fitting exactly, so a fit is not a collision', () => {
    expect(fitLevel(need, 430)).not.toBe(0)
    expect(fitLevel(need, 454)).toBe(0)
  })

  it('depends on the room and not on what it last decided, so a resize cannot oscillate', () => {
    const at = (have: number) => fitLevel(need, have)
    expect([at(500), at(320), at(500)]).toEqual([0, 3, 0])
  })

  it('bottoms out rather than running off the ladder', () => {
    expect(fitLevel(need, 0)).toBe(need.length - 1)
  })
})
