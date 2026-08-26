import proj4 from 'proj4'

/**
 * Brandenburg geobasis rasters are EPSG:25833 (ETRS89 / UTM zone 33N) with DHHN2016 heights.
 * Tiles are 1 km squares named by the km values of their south-west corner, with the UTM zone
 * prefixed onto the easting: E 407000..408000 / N 5784000..5785000 is `33407-5784`.
 */
export const UTM33 =
  '+proj=utm +zone=33 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs'

export function toUtm33(lat: number, lon: number): [number, number] {
  const [e, n] = proj4('EPSG:4326', UTM33, [lon, lat])
  return [e, n]
}

export function toWgs84(e: number, n: number): { lat: number; lon: number } {
  const [lon, lat] = proj4(UTM33, 'EPSG:4326', [e, n])
  return { lat, lon }
}

export function tileId(e: number, n: number): string {
  return `33${Math.floor(e / 1000)}-${Math.floor(n / 1000)}`
}

/** Every 1 km tile touching the given EPSG:25833 bounds. */
export function tilesForBounds(minE: number, minN: number, maxE: number, maxN: number): string[] {
  const ids: string[] = []
  for (let e = Math.floor(minE / 1000); e <= Math.floor(maxE / 1000); e++) {
    for (let n = Math.floor(minN / 1000); n <= Math.floor(maxN / 1000); n++) {
      ids.push(`33${e}-${n}`)
    }
  }
  return ids
}

/** Compass bearing in radians, 0 = north, increasing clockwise. */
export function bearingOf(dE: number, dN: number): number {
  const b = Math.atan2(dE, dN)
  return b < 0 ? b + 2 * Math.PI : b
}

export function sectorOf(bearing: number, sectorCount: number): number {
  return Math.floor((bearing / (2 * Math.PI)) * sectorCount) % sectorCount
}

export function oppositeBearing(bearing: number): number {
  return (bearing + Math.PI) % (2 * Math.PI)
}

/**
 * The EPSG:25833 bounding box of a latitude/longitude rectangle.
 *
 * The two are not the same shape: a lat/lon rectangle maps to a quadrilateral rotated by the grid
 * convergence, and this is the axis-aligned box around it -- slightly larger than the rectangle
 * asked for. That box, not the rectangle, is what the search actually confines anchors to, so it is
 * also what the map should draw when it claims to be showing an area of interest.
 */
export function utmBounds(a: { south: number; west: number; north: number; east: number }): {
  minE: number
  minN: number
  maxE: number
  maxN: number
} {
  const corners = [
    toUtm33(a.south, a.west),
    toUtm33(a.south, a.east),
    toUtm33(a.north, a.west),
    toUtm33(a.north, a.east),
  ]
  return {
    minE: Math.min(...corners.map((c) => c[0])),
    maxE: Math.max(...corners.map((c) => c[0])),
    minN: Math.min(...corners.map((c) => c[1])),
    maxN: Math.max(...corners.map((c) => c[1])),
  }
}
