/** south, west, north, east -- the shape the map reports its viewport in. */
export type Bbox = [number, number, number, number]

/** Whether two boxes share any ground, edges included. */
export const overlaps = (a: Bbox, b: Bbox) =>
  a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1]

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
  overlaps(b, [
    Math.min(a.lat, c.lat),
    Math.min(a.lon, c.lon),
    Math.max(a.lat, c.lat),
    Math.max(a.lon, c.lon),
  ])
