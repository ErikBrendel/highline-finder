import { toUtm33 } from '../shared/geo.js'
import type { Aoi } from '../shared/types.js'

/**
 * Turns a list of areas of interest into the areas actually rasterised.
 *
 * Two problems come with allowing more than one AOI, and merging solves both. Overlapping AOIs
 * would scan their shared ground twice and report the same line twice -- the global dedup pass
 * catches that, but only after paying for it. Worse, two AOIs that merely touch would each miss
 * every line crossing the seam, because neither grid holds both anchors.
 *
 * So any two AOIs whose boxes come within `reach` of each other are rasterised together as one
 * grid. `reach` is the longest line the search will consider: closer than that and a line could
 * span the gap, further and no line could, so the split is exact rather than a heuristic. The union
 * box is bounded -- two AOIs plus `reach` -- so this cannot quietly balloon into a regional raster.
 *
 * Anchors are still confined to `boxes`, the individual AOIs. The ground between two merged AOIs is
 * read but not searched, which is what "the AOI is where we look" should mean.
 */

export interface Box {
  minE: number
  minN: number
  maxE: number
  maxN: number
}

export interface WorkArea {
  aois: Aoi[]
  /** One box per AOI: where anchors may sit. */
  boxes: Box[]
  /** The union, plus nothing: what gets rasterised. */
  bbox: Box
}

export function boxOf(aoi: Aoi): Box {
  const corners = [
    toUtm33(aoi.south, aoi.west),
    toUtm33(aoi.south, aoi.east),
    toUtm33(aoi.north, aoi.west),
    toUtm33(aoi.north, aoi.east),
  ]
  return {
    minE: Math.min(...corners.map((c) => c[0])),
    maxE: Math.max(...corners.map((c) => c[0])),
    minN: Math.min(...corners.map((c) => c[1])),
    maxN: Math.max(...corners.map((c) => c[1])),
  }
}

export function contains(box: Box, e: number, n: number): boolean {
  return e >= box.minE && e <= box.maxE && n >= box.minN && n <= box.maxN
}

const union = (a: Box, b: Box): Box => ({
  minE: Math.min(a.minE, b.minE),
  minN: Math.min(a.minN, b.minN),
  maxE: Math.max(a.maxE, b.maxE),
  maxN: Math.max(a.maxN, b.maxN),
})

const within = (a: Box, b: Box, reach: number): boolean =>
  a.minE - reach <= b.maxE &&
  b.minE - reach <= a.maxE &&
  a.minN - reach <= b.maxN &&
  b.minN - reach <= a.maxN

export function workAreas(aois: Aoi[], reach: number): WorkArea[] {
  const areas: WorkArea[] = aois.map((aoi) => {
    const box = boxOf(aoi)
    return { aois: [aoi], boxes: [box], bbox: box }
  })

  // Merge until nothing more can merge: one merge can bring two previously distant areas together.
  for (let merged = true; merged; ) {
    merged = false
    outer: for (let i = 0; i < areas.length; i++) {
      for (let j = i + 1; j < areas.length; j++) {
        if (!within(areas[i]!.bbox, areas[j]!.bbox, reach)) continue
        const [a, b] = [areas[i]!, areas[j]!]
        areas.splice(j, 1)
        areas[i] = {
          aois: [...a.aois, ...b.aois],
          boxes: [...a.boxes, ...b.boxes],
          bbox: union(a.bbox, b.bbox),
        }
        merged = true
        break outer
      }
    }
  }
  return areas
}
