import type { Candidate } from '../shared/types.js'

/**
 * A candidate as it goes into candidates.json, which is not quite a candidate.
 *
 * The file is what the first visitor waits for -- four megabytes gzipped, before a single line can
 * be drawn -- so the numbers in it are written at the precision they are read at rather than at the
 * precision they happened to be computed at. Two families of number were being shipped whole:
 *
 *   - `lat`/`lon`, at seventeen significant digits. Anchors sit on a half-metre lattice and the
 *     figures are derived from `e`/`n`, which are in the file beside them, so every digit past the
 *     sixth decimal describes rounding in proj4 rather than a place on the ground.
 *   - `scoreParts`, five weights between 0 and 1 whose sum is rounded to one decimal before anyone
 *     sees it. `0.6849906723729243` is a bar in a panel that is 68 pixels wide.
 *
 * `kind` goes because the list it lands in already says it -- see Dataset.lines.
 *
 * Numbers, not structure: `id` could go the same way, since it is exactly the four coordinates
 * beside it, and lat/lon could go entirely and be projected in the browser. Both were measured and
 * neither is worth it. Rebuilding lat/lon costs 270 ms of proj4 on the main thread to save half a
 * megabyte, which is trading a download for a freeze, and the id is worth a tenth of the file for a
 * field every part of the viewer keys on.
 */
export function shipped({ kind, ...c }: Candidate): Omit<Candidate, 'kind'> {
  const r7 = (v: number) => Math.round(v * 1e7) / 1e7
  const r3 = (v: number) => Math.round(v * 1000) / 1000
  const at = (p: Candidate['a']) => ({ ...p, lat: r7(p.lat), lon: r7(p.lon) })
  const s = c.scoreParts
  return {
    ...c,
    a: at(c.a),
    b: at(c.b),
    scoreParts: {
      exposure: r3(s.exposure),
      length: r3(s.length),
      canopy: r3(s.canopy),
      margin: r3(s.margin),
      level: r3(s.level),
    },
  }
}
