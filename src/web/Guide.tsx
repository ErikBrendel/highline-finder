import { useEffect, useState } from 'react'
import { report } from './report.js'

/**
 * The panel that says what this is, open until it is closed.
 *
 * A map of twenty-five thousand red lines over Brandenburg explains none of itself: not where the
 * measurements come from, not why there is nothing past the border, not that the anchors can be
 * dragged. So it starts open, and whether it is open survives a reload -- left open it comes back
 * open, closed it stays closed, and reopened from the header it is open again next time. One
 * remembered boolean rather than a "seen" flag beside a live one, because two would be able to
 * disagree about the same thing.
 */

const OPEN = 'highline-finder.guide-open'

/**
 * Storage that may not be there.
 *
 * localStorage throws rather than returning null in a browser configured to refuse it -- private
 * windows, third-party contexts, storage blocked outright -- so both directions are guarded. The
 * fallback is open, which is the harmless way to be wrong: a reader who cannot be remembered sees
 * the guide again, rather than a first-time reader never seeing it at all.
 */
export function guideOpen(): boolean {
  try {
    return localStorage.getItem(OPEN) !== '0'
  } catch (e) {
    report('reading whether the guide was left open', e)
    return true
  }
}

export function rememberGuideOpen(open: boolean): void {
  try {
    localStorage.setItem(OPEN, open ? '1' : '0')
  } catch (e) {
    report('remembering whether the guide is open', e)
  }
}

export function useGuide(): { open: boolean; show: () => void; close: () => void } {
  const [open, setOpen] = useState(guideOpen)
  const set = (to: boolean) => {
    rememberGuideOpen(to)
    setOpen(to)
  }
  return { open, show: () => set(true), close: () => set(false) }
}

export function Guide({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="guidewrap" onClick={onClose}>
      <div
        className="guide"
        role="dialog"
        aria-modal="true"
        aria-label="About Highline Finder"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="head">
          <strong>Highline Finder</strong>
          <button className="close" onClick={onClose}>
            close
          </button>
        </div>
        <div className="body">
          <p className="lead">
            Candidate highlines, found by measuring the public LiDAR survey of Berlin and
            Brandenburg.
          </p>

          <h2><span className="ico">🛰️</span>The data</h2>
          <ul>
            <li>Terrain, canopy and buildings, published free and open by the state.</li>
            <li>Berlin and Brandenburg only. The grey outlines are where it stops.</li>
          </ul>

          <h2><span className="ico">🗺️</span>On the map</h2>
          <ul>
            <li><b>Lines</b> hang where they are drawn. Click one for its ground profile.</li>
            <li><b>Hotspots</b> are the same lines clustered, for browsing zoomed out.</li>
            <li>
              <b>Background</b>: orthophoto (satellite), hillshade or OSM, with the option to mix
              them.
            </li>
          </ul>

          <h2><span className="ico">🌲</span>Natural and urban</h2>
          <ul>
            <li><b>Natural</b> &mdash; both ends on the ground. Complete: the whole state, one search.</li>
            <li>
              <b>Urban</b> &mdash; one end on a roof. Unfinished: only inside the outlined rectangles,
              and never in Berlin, which the building model does not cover.
            </li>
          </ul>

          <h2><span className="ico">🎚️</span>Filters</h2>
          <ul>
            <li><b>Sag</b> re-measures every line against the terrain.</li>
            <li>Use score, length, exposure, canopy and offlevel to narrow the results.</li>
          </ul>

          <h2><span className="ico">✏️</span>Lines of your own</h2>
          <ul>
            <li>Drag either anchor of a selected line; it re-measures as it moves.</li>
            <li>Right-click the map for <b>Set custom point A</b> / <b>B</b> to plan a span anywhere.</li>
            <li>The address bar follows the view, so a link is the map as you left it.</li>
          </ul>

          <div className="warn">
            <b>What it cannot tell you:</b> who owns the ground, whether the tree is sound, or
            whether anyone may walk in. Access, permission and the judgement to rig stay with you.
          </div>
        </div>
      </div>
    </div>
  )
}
