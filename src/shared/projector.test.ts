import { describe, expect, it } from 'vitest'
import { latticeProjector, toUtm32, toWgs84 } from './geo.js'

/**
 * Reprojecting a raster asks where every destination cell falls in the source, and a window is
 * sixty-five thousand cells. This samples the mapping on a lattice and reads it off in between, so
 * what matters is that the shortcut is invisible against a source grid of one metre.
 */
const exact = (e: number, n: number): [number, number] => {
  const w = toWgs84(e, n)
  return toUtm32(w.lat, w.lon)
}

describe('latticeProjector', () => {
  // A window on Halle, which is the case this exists for: zone 33 coordinates over zone 32 data.
  const [e0, n0, size] = [288_000, 5_707_000, 256]
  const approx = latticeProjector(exact, e0, n0, size)

  it('agrees with the real projection to well under the size of a source cell', () => {
    let worst = 0
    for (let i = 0; i <= 40; i++) {
      for (let j = 0; j <= 40; j++) {
        const [e, n] = [e0 + (size * i) / 40, n0 + (size * j) / 40]
        const [ax, ay] = approx(e, n)
        const [ex, ey] = exact(e, n)
        worst = Math.max(worst, Math.hypot(ax - ex, ay - ey))
      }
    }
    expect(worst).toBeLessThan(0.01)
  })

  it('is exact at the lattice points it was built from', () => {
    for (const [e, n] of [[e0, n0], [e0 + size, n0], [e0, n0 + size], [e0 + size, n0 + size]]) {
      const [ax, ay] = approx(e!, n!)
      const [ex, ey] = exact(e!, n!)
      expect(Math.hypot(ax - ex, ay - ey)).toBeLessThan(1e-6)
    }
  })

  it('carries a zone 33 easting into the very different zone 32 one', () => {
    const [e32] = approx(e0, n0)
    // The same ground, four hundred kilometres apart in what the two zones call it.
    expect(e32 - e0).toBeGreaterThan(400_000)
  })
})
