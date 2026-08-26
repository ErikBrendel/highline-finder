import { describe, expect, it } from 'vitest'
import {
  CHUNK_M,
  chunkArea,
  chunkAt,
  chunkBounds,
  chunkName,
  chunksOver,
  parseChunk,
} from './chunks.js'
import { workAreas } from './regions.js'
import { DEFAULT_AOIS, DEFAULT_PARAMS } from './params.js'
import { owns } from './regions.js'

const p = DEFAULT_PARAMS

describe('the chunk lattice', () => {
  it('tiles the plane exactly once', () => {
    // Every point belongs to the chunk that owns it, and to no other. Half-open bounds are what
    // make that true on the seams, which is where a duplicate line would otherwise appear.
    for (const [e, n] of [[0, 0], [424000, 5832000], [423999.9, 5839999.9], [-1, -1]] as const) {
      const here = chunkAt(e, n)
      expect(owns(chunkBounds(here), e, n)).toBe(true)
      for (const [de, dn] of [[-1, 0], [1, 0], [0, -1], [0, 1]] as const) {
        expect(owns(chunkBounds({ e: here.e + de, n: here.n + dn }), e, n)).toBe(false)
      }
    }
  })

  it('does not move when the search area does', () => {
    // The whole point of a fixed grid: a chunk is where it is, not where the run started.
    expect(chunkBounds(parseChunk('53_729'))).toEqual({
      minE: 424000, minN: 5832000, maxE: 432000, maxN: 5840000,
    })
  })

  it('rejects a name it cannot read rather than searching nowhere', () => {
    expect(() => parseChunk('53-729')).toThrow(/not a chunk name/)
    expect(() => parseChunk('')).toThrow()
  })

  it('round-trips a name', () => {
    expect(chunkName(chunkAt(424001, 5832001))).toBe('53_729')
  })
})

describe('chunksOver', () => {
  it('covers a box with the chunks that own its ground', () => {
    const box = { minE: 423000, minN: 5831000, maxE: 425000, maxN: 5833000 }
    expect(chunksOver(box).map(chunkName).sort())
      .toEqual(['52_728', '52_729', '53_728', '53_729'])
  })
})

describe('a chunk as a unit of work', () => {
  const area = chunkArea(parseChunk('53_729'))

  it('loads further than it owns, by more than a partner can reach', () => {
    const reach = (a: number, b: number) => Math.abs(a - b)
    expect(reach(area.bbox.minE, area.owns!.minE)).toBeGreaterThanOrEqual(p.maxLength)
    expect(reach(area.bbox.maxE, area.owns!.maxE)).toBeGreaterThanOrEqual(p.maxLength)
    expect(reach(area.bbox.maxN, area.owns!.maxN)).toBeGreaterThanOrEqual(p.maxLength)
    // South is only probed, not paired across, but the probes still need ground under them.
    expect(reach(area.bbox.minN, area.owns!.minN))
      .toBeGreaterThanOrEqual(p.nearProbeLength + p.dropSearchRadius)
  })

  it('scans anchors over everything it loaded, not only what it owns', () => {
    // A partner in the halo has to exist as an anchor or the line across the seam is never found.
    // What stops the halo producing duplicates is `owns`, which terrainPairs applies.
    expect(area.boxes).toEqual([area.bbox])
  })

  it('is on the lattice whatever its halo does', () => {
    expect(area.owns!.maxE - area.owns!.minE).toBe(CHUNK_M)
    expect(area.owns!.minE % CHUNK_M).toBe(0)
    expect(area.owns!.minN % CHUNK_M).toBe(0)
  })
})

describe('chunks and areas of interest side by side', () => {
  it('never merge, however close they are', () => {
    // workAreas unions areas of interest within maxLength of each other. Chunks are built outside
    // it entirely, which is the only reason a swathe of them does not collapse into one region.
    const merged = workAreas(DEFAULT_AOIS, p.maxLength)
    const chunks = ['52_728', '53_728', '52_729', '53_729'].map((n) => chunkArea(parseChunk(n)))
    const ids = new Set([...merged, ...chunks].map((a) => a.id))
    expect(ids.size).toBe(merged.length + chunks.length)
    for (const c of chunks) expect(c.aois).toHaveLength(1)
  })
})
