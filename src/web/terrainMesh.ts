import type { Pos } from '../shared/grid.js'

/**
 * A square of ground, turned into something three.js can draw.
 *
 * Deliberately knows nothing about three.js: it reads the samplers the rest of the app already
 * fills and produces plain typed arrays. That keeps the whole of the geometry -- which is the part
 * that can be wrong in ways nobody notices -- testable without a WebGL context, and keeps three out
 * of every module that merely wants to describe a patch of hillside.
 *
 * Coordinates come out local to the patch centre and in three.js's convention: X east, Y up,
 * Z south. Local because a UTM easting is six digits and float32 has seven, so a mesh built in
 * absolute coordinates would quantise to about a decimetre and shimmer as the camera moves.
 */

export const COVER = { ground: 0, canopy: 1, building: 2, water: 3 } as const
export type CoverClass = (typeof COVER)[keyof typeof COVER]

/** What a patch needs to know about the world. NaN height means the survey has not covered it. */
export interface Readers {
  /** Bare earth, with nothing standing on it. */
  ground(e: number, n: number): number
  /** What is actually there -- canopy, roofs, or the ground where neither. */
  surface(e: number, n: number): number
  building(e: number, n: number): boolean
  water(e: number, n: number): boolean
}

export interface Patch {
  /** Vertices per side. */
  side: number
  /** Metres between vertices. */
  step: number
  centre: Pos
  /** The visible skin: canopy and roofs where they stand, bare earth where they do not. */
  height: Float32Array
  /** Bare earth under it, so the two can be told apart. */
  ground: Float32Array
  cover: Uint8Array
  /** Range of the measured heights, for framing a camera on them. */
  low: number
  high: number
  /** Fraction of the patch the survey actually covered. */
  measured: number
}

/**
 * Reads a square patch centred on `centre`, `2 * halfSide` metres across.
 *
 * Anything the survey has not delivered comes back NaN and stays NaN: a hole in the mesh is the
 * honest picture, where a plausible height invented to fill it would be a hillside that is not
 * there. `measured` says how much of the square is real, so the caller can say so.
 */
export function samplePatch(centre: Pos, halfSide: number, side: number, read: Readers): Patch {
  const step = (2 * halfSide) / (side - 1)
  const height = new Float32Array(side * side)
  const ground = new Float32Array(side * side)
  const cover = new Uint8Array(side * side)
  let low = Infinity
  let high = -Infinity
  let seen = 0

  for (let row = 0; row < side; row++) {
    // Row 0 is the north edge, so it walks south -- the order the vertices are wanted in below.
    const n = centre.n + halfSide - row * step
    for (let col = 0; col < side; col++) {
      const e = centre.e - halfSide + col * step
      const i = row * side + col
      const bare = read.ground(e, n)
      const skin = read.surface(e, n)
      // The surface model can read below bare earth by a few centimetres where the two surveys
      // disagree; the skin is whichever is higher, so a roof is never buried in its own hillside.
      const top = Number.isNaN(skin) ? bare : Number.isNaN(bare) ? skin : Math.max(bare, skin)
      height[i] = top
      ground[i] = bare
      cover[i] = classOf(e, n, bare, top, read)
      if (!Number.isNaN(top)) {
        seen++
        if (top < low) low = top
        if (top > high) high = top
      }
    }
  }
  return {
    side,
    step,
    centre,
    height,
    ground,
    cover,
    low: seen ? low : 0,
    high: seen ? high : 0,
    measured: seen / (side * side),
  }
}

/** How tall something has to stand above bare earth before it is vegetation rather than noise. */
const CANOPY_FROM = 2

function classOf(e: number, n: number, bare: number, top: number, read: Readers): CoverClass {
  if (read.building(e, n)) return COVER.building
  if (read.water(e, n)) return COVER.water
  if (!Number.isNaN(bare) && !Number.isNaN(top) && top - bare >= CANOPY_FROM) return COVER.canopy
  return COVER.ground
}

/** The palette, matching the profile chart's so the two views name the same things the same way. */
export const COVER_RGB: Record<CoverClass, [number, number, number]> = {
  [COVER.ground]: [0.42, 0.35, 0.28],
  [COVER.canopy]: [0.25, 0.49, 0.25],
  [COVER.building]: [0.60, 0.64, 0.72],
  [COVER.water]: [0.18, 0.43, 0.62],
}

export interface MeshData {
  /** Three floats a vertex: east, up, south, local to the patch centre. */
  positions: Float32Array
  colors: Float32Array
  indices: Uint32Array
}

/**
 * Two triangles per cell, minus every cell that touches ground nobody measured.
 *
 * Dropping the quad rather than the vertex, because a quad needs all four of its corners: a mesh
 * that interpolated across a missing one would draw a slope between a real height and a made-up
 * one, which is the one thing a picture of terrain must not do.
 *
 * Heights come out relative to `datum`, which the caller sets to the lowest point in the patch.
 * A metre above sea level is a hundred metres of nothing under the ground before the ground starts,
 * and the view exaggerates heights -- so absolute heights would send the whole landscape climbing
 * away from the camera every time the factor changed. Measured from its own floor, the ground stays
 * where it is and only its relief grows, which is what the factor is for.
 */
export function meshOf(patch: Patch, datum = 0): MeshData {
  const { side, step, height, cover } = patch
  const half = ((side - 1) * step) / 2
  const positions = new Float32Array(side * side * 3)
  const colors = new Float32Array(side * side * 3)

  for (let row = 0; row < side; row++) {
    for (let col = 0; col < side; col++) {
      const i = row * side + col
      const h = height[i]!
      positions[i * 3] = col * step - half
      positions[i * 3 + 1] = Number.isNaN(h) ? 0 : h - datum
      positions[i * 3 + 2] = row * step - half
      const rgb = COVER_RGB[cover[i] as CoverClass]
      colors[i * 3] = rgb[0]
      colors[i * 3 + 1] = rgb[1]
      colors[i * 3 + 2] = rgb[2]
    }
  }

  const indices: number[] = []
  for (let row = 0; row + 1 < side; row++) {
    for (let col = 0; col + 1 < side; col++) {
      const a = row * side + col
      const b = a + 1
      const c = a + side
      const d = c + 1
      if (Number.isNaN(height[a]! + height[b]! + height[c]! + height[d]!)) continue
      indices.push(a, c, b, b, c, d)
    }
  }
  return { positions, colors, indices: Uint32Array.from(indices) }
}
