import { describe, expect, it } from 'vitest'
import {
  cellsPerSourceTile,
  dropField,
  tilePasses,
  tilesWithRoofAnchors,
  tilesWorthLoading,
} from './coarse.js'
import { DEFAULT_PARAMS } from './params.js'
import { Grid } from '../shared/grid.js'

/** A 3 x 1 km strip of 16 m cells, flat except where `steep` says otherwise. */
function strip(steep: (e: number, n: number) => number): Grid {
  const res = 16
  const w = 3000 / res
  const h = 1000 / res
  const g = Grid.filled(w, h, 400000, 5800000 + 1000, res)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const e = 400000 + (x + 0.5) * res
      const n = 5800000 + 1000 - (y + 0.5) * res
      g.data[y * w + x] = 50 - steep(e, n)
    }
  }
  return g
}

describe('tilesWorthLoading', () => {
  it('ignores a handful of steep cells in an otherwise flat tile', () => {
    // A single 32 m pothole in the middle tile: three cells deep enough, thousands not.
    const g = strip((e, n) => (Math.hypot(e - 401500, n - 5800500) < 24 ? 20 : 0))
    const drop = dropField(g, 32)
    expect(tilesWorthLoading(drop, 10, 0.02, 500).size).toBe(0)
    // With the old any-single-cell rule the pothole would have pulled in its neighbours too.
    expect(tilesWorthLoading(drop, 10, 0, 500).size).toBeGreaterThan(0)
  })

  it('takes a tile whose steep ground covers enough of it', () => {
    // The eastern third drops away as a slope, so most of that tile's cells qualify.
    const g = strip((e) => Math.max(0, (e - 402000) / 2))
    const tiles = tilesWorthLoading(dropField(g, 32), 10, 0.02, 500)
    expect(tiles.has('33402-5800')).toBe(true)
  })

  it('extends the margin from the steep cells, not from whole tiles', () => {
    // Steep ground only at the far east edge: the tile 2 km west is out of a line's reach.
    const g = strip((e) => Math.max(0, (e - 402000) / 2))
    const tiles = tilesWorthLoading(dropField(g, 32), 10, 0.02, 500)
    expect(tiles.has('33401-5800')).toBe(true)
    expect(tiles.has('33400-5800')).toBe(false)
  })

  it('keeps everything when the threshold is zero', () => {
    const g = strip(() => 0)
    expect(tilesWorthLoading(dropField(g, 32), 0, 0, 500).size).toBeGreaterThan(0)
  })
})

describe('tilePasses', () => {
  it('counts what the fetching rule counts, tile for tile', () => {
    const g = strip((e) => Math.max(0, (e - 402000) / 2))
    const drop = dropField(g, 32)
    const needed = cellsPerSourceTile(drop.res) * 0.02
    const kept = tilesWorthLoading(drop, 10, 0.02, 0)
    for (const t of tilePasses(drop, 10)) {
      const name = `33${t.e / 1000 - 0.5}-${(t.n - 500) / 1000}`
      expect(kept.has(name)).toBe(t.passing >= needed)
    }
  })

  it('says nothing about a tile it has barely seen', () => {
    // A grid snapped outwards to its own resolution overhangs its window by up to a cell, which
    // clips a row and a column of tiles it has seen a fraction of a per cent of.
    const flat = strip(() => 0)
    const g = Grid.filled(flat.w + 1, flat.h + 1, flat.e0, flat.n1 + flat.res, flat.res)
    g.data.fill(50)
    expect(tilePasses(dropField(g, 32), 10)).toHaveLength(3)
  })
})

describe('tilesWithRoofAnchors', () => {
  /** Flat ground at 40 m over one tile and its neighbours, which the terrain rule reads as flat. */
  const flat = (): Grid => {
    const g = Grid.filled(64 * 3, 64 * 3, 400000, 5800000 + 3000, 16)
    g.data.fill(40)
    return g
  }
  const faceIn = (tile: string, z: number) => {
    const [e, n] = tile.slice(2).split('-').map(Number) as [number, number]
    const [e0, n0] = [e * 1000 + 500, n * 1000 + 500]
    return { ring: [e0, n0, e0 + 20, n0, e0 + 20, n0 + 20, e0, n0 + 20, e0, n0], z }
  }
  const p = { ...DEFAULT_PARAMS, maskMinRoofs: 1 }
  /** A roof exactly at the bar this rule sets, which is well above the one a line has to clear. */
  const tall = 40 + p.maskMinRoofDrop

  it('keeps a tile for a building tall enough to anchor on, where the terrain says nothing', () => {
    const coarse = flat()
    const faces = new Map([['33401-5801', [faceIn('33401-5801', tall)]]])
    // The terrain rule, on this ground, wants nothing at all.
    expect(tilesWorthLoading(dropField(coarse, p.maskRadius), p.maskMinDrop, p.maskMinCoverage, 0).size)
      .toBe(0)
    expect(tilesWithRoofAnchors(faces, coarse, p, 0).has('33401-5801')).toBe(true)
  })

  it('ignores a building the ground does not fall far enough below', () => {
    const faces = new Map([['33401-5801', [faceIn('33401-5801', tall - 0.1)]]])
    expect(tilesWithRoofAnchors(faces, flat(), p, 0).size).toBe(0)
  })

  it('holds roofs to a far higher bar than a line does', () => {
    // The point of maskMinRoofDrop. A building a line could happily anchor on is not on its own
    // worth fetching a square kilometre at 1 m for, or every village in Brandenburg qualifies.
    const anchorable = 40 + p.minDropDepth
    expect(anchorable).toBeLessThan(tall)
    const faces = new Map([['33401-5801', [faceIn('33401-5801', anchorable)]]])
    expect(tilesWithRoofAnchors(faces, flat(), p, 0).size).toBe(0)
  })

  it('pulls in the ground a line off that roof would cross', () => {
    const faces = new Map([['33401-5801', [faceIn('33401-5801', tall)]]])
    const near = tilesWithRoofAnchors(faces, flat(), p, 500)
    // The eight neighbours as well, since a line runs up to maxLength from the roof.
    expect(near.size).toBe(9)
    expect(near.has('33400-5800')).toBe(true)
    expect(near.has('33402-5802')).toBe(true)
  })

  it('ignores a roof no urban area covers', () => {
    // The pre-pass half of the same rule: outside an urban area a building cannot pull its tile in,
    // which is what stops every village on flat ground claiming a square kilometre at 1 m.
    const faces = new Map([['33401-5801', [faceIn('33401-5801', tall)]]])
    expect(tilesWithRoofAnchors(faces, flat(), p, 0, { covers: () => false }).size).toBe(0)
    expect(tilesWithRoofAnchors(faces, flat(), p, 0, { covers: () => true }).size).toBe(1)
  })

  it('respects the roof count a tile has to reach', () => {
    const faces = new Map([['33401-5801', [faceIn('33401-5801', tall)]]])
    expect(tilesWithRoofAnchors(faces, flat(), { ...p, maskMinRoofs: 2 }, 0).size).toBe(0)
  })
})
