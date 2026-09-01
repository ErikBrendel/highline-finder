/** south, west, north, east -- the shape the map reports its viewport in. */
export type Bbox = [number, number, number, number]

export const holds = (b: Bbox, lat: number, lon: number) =>
  lat >= b[0] && lat <= b[2] && lon >= b[1] && lon <= b[3]

/**
 * Whether a line has anything to do with the view.
 *
 * Its own box against the view's, rather than either endpoint being inside: a line crossing the
 * screen with both anchors off it is on screen, and counting it as absent would be exactly wrong on
 * the zooms where a 500 m span is most of the width.
 */
export const touches = (
  b: Bbox,
  a: { lat: number; lon: number },
  c: { lat: number; lon: number },
) =>
  Math.min(a.lat, c.lat) <= b[2] &&
  Math.max(a.lat, c.lat) >= b[0] &&
  Math.min(a.lon, c.lon) <= b[3] &&
  Math.max(a.lon, c.lon) >= b[1]
