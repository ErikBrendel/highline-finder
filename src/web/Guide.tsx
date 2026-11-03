import { useEffect, useState } from 'react'
import { useRemembered } from './remembered.js'
import { CoverageMap } from './CoverageMap.js'
import type { Region } from '../shared/types.js'

/**
 * The panel that says what this is, open until it is closed.
 *
 * There are two arrivals and they want different pages. Someone who opens the map is looking at
 * twenty-five thousand red lines over Brandenburg that explain none of themselves: not where the
 * measurements come from, not why there is nothing past the border, not that the anchors can be
 * dragged. Someone who follows a link into the full-screen view is looking at one line and wants to
 * know what it is -- and the map guide, laid over that, buries the thing they came for under a page
 * about filters they cannot see.
 *
 * So: one guide per view, and whichever view you land in is the one you are told about. The other
 * is shown once, the first time you reach it.
 *
 * Both are in this file on purpose. They share a frame, a closing animation and -- the part that
 * matters -- the same warning, which is the one paragraph neither arrival may miss. Kept apart they
 * would drift; kept here the duplication is visible to whoever edits either.
 */

export type GuideKind = 'line' | 'map'

const SEEN: Record<GuideKind, string> = {
  line: 'highline-finder.guide-seen.line',
  map: 'highline-finder.guide-seen.map',
}

/**
 * Whether this view's guide is showing.
 *
 * Only "has this been seen" outlives the page. Whether it is open right now does not: it used to,
 * and that made a reload reopen a panel the reader had left open behind a line they wanted to look
 * at. Seen is a fact about the reader, open is a fact about this second.
 */
export function useGuide(kind: GuideKind): { open: boolean; show: () => void; close: () => void } {
  const [seenLine, setSeenLine] = useRemembered(SEEN.line, false)
  const [seenMap, setSeenMap] = useRemembered(SEEN.map, false)
  const [asked, setAsked] = useState(false)
  const seen = kind === 'line' ? seenLine : seenMap
  return {
    open: asked || !seen,
    show: () => setAsked(true),
    close: () => {
      setAsked(false)
      ;(kind === 'line' ? setSeenLine : setSeenMap)(true)
    },
  }
}

/** The one paragraph both arrivals get, because it is the one neither may miss. */
const Caveat = () => (
  <div className="warn">
    <b>What it cannot tell you:</b> who owns the ground, whether the tree is sound, or whether
    anyone may walk in. Access, permission and the judgement to rig stay with you.
  </div>
)

/**
 * For someone who followed a link into one line.
 *
 * Short, because there is a picture behind this panel that they are trying to get to, and every
 * sentence here is a sentence between them and it. Nothing about coverage, filters or the urban
 * half: that is the map's guide, and they will get it when they reach the map.
 *
 * Nothing here claims a resolution or a data source, because the line in front of them may be a
 * found one in Brandenburg or two anchors somebody dropped on the far side of the country, and
 * those are measured against different surveys. The panel itself says when the ground under this
 * line is thinner than it looks.
 */
const LineGuide = () => (
  <>
    <p className="lead">
      One span, measured against the public survey of the ground it crosses.
    </p>
    <p className="lead quiet">
      A computed line, not a logged spot: it was found by reading the terrain. Nothing here records
      whether anyone has ever rigged it.
    </p>

    <h2><span className="ico">📐</span>What was measured</h2>
    <ul>
      <li>
        The ground along the whole span, what is standing on it wherever a surface model covers
        that ground, and the curve a loaded line actually hangs in.
      </li>
      <li>Length, air and clearance are measured rather than estimated.</li>
      <li>Where the survey is thinner than that, the panel says so instead of quietly guessing.</li>
    </ul>

    <h2><span className="ico">🎚️</span>What you can change</h2>
    <ul>
      <li><b>Sag</b> and the <b>rig height</b> at each end. Everything re-measures as you move them.</li>
      <li>Drag either anchor to move the span itself.</li>
      <li>The address bar follows all of it, so <b>share</b> sends exactly what you are looking at.</li>
    </ul>

    <h2><span className="ico">🗺️</span>Behind this</h2>
    <ul>
      <li>Close the full view and the map is underneath it.</li>
    </ul>

    <Caveat />
  </>
)

/** For someone who arrived at the map. The original guide, and still the longer of the two. */
const MapGuide = ({ regions }: { regions: Region[] | null }) => (
  <>
    <p className="lead">
      Candidate highlines, found by measuring the public LiDAR survey of Berlin and Brandenburg.
    </p>

    <h2><span className="ico">🛰️</span>The data</h2>
    <ul>
      <li>Terrain, canopy and buildings, published free and open by the state surveys.</li>
      <li>
        Anywhere in Germany you can place two anchors by hand and have the span measured against
        the real ground. What differs is how much there is to measure it against:
      </li>
    </ul>
    <CoverageMap regions={regions} />

    <h2><span className="ico">🗺️</span>On the map</h2>
    <ul>
      <li>
        <b>Lines</b> hang where they are drawn, from a district-wide zoom inward. Click one for its
        ground profile.
      </li>
      <li><b>Hotspots</b> are the same lines clustered, for browsing zoomed out.</li>
      <li>
        <b>Background</b>: orthophoto (satellite), hillshade or OSM, with the option to mix them.
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
      <li>The crosshair beside the zoom buttons puts the map where you are.</li>
    </ul>

    <Caveat />
  </>
)

export function Guide({
  kind,
  onClose,
  regions,
}: {
  kind: GuideKind
  onClose: () => void
  regions: Region[] | null
}) {
  /**
   * Kept on the page until it has finished leaving.
   *
   * CSS cannot animate an element that is being removed, so closing sets a flag instead of
   * unmounting, the stylesheet plays the arrival backwards, and `onClose` is called when that
   * animation ends. Every way out goes through `leave` for that reason -- the backdrop, the button
   * and Escape -- so none of them can skip the flight back to the corner the guide came from.
   */
  const [closing, setClosing] = useState(false)
  const leave = () => setClosing(true)

  /**
   * A backstop, because the failure this guards against is one that has already happened once.
   *
   * Unmounting hangs off `animationend`, and an animation that never runs never ends -- the first
   * version of the leaving animation reused the arrival's name, so the browser did not restart it,
   * nothing fired, and the invisible backdrop stayed over the page eating clicks. Whatever the
   * stylesheet does or fails to do, the dialog goes after this.
   */
  useEffect(() => {
    if (!closing) return
    const late = setTimeout(onClose, 900)
    return () => clearTimeout(late)
  }, [closing, onClose])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') leave()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <div className="guidewrap" data-closing={closing || undefined} onClick={leave}>
      <div
        className="guide"
        role="dialog"
        aria-modal="true"
        aria-label="About Highline Finder"
        onClick={(e) => e.stopPropagation()}
        // On the card rather than the backdrop: the card is what moves, and the two animations are
        // not the same length. Guarded, because the arrival ends here too.
        onAnimationEnd={() => closing && onClose()}
      >
        <div className="head">
          <strong>Highline Finder</strong>
          <button className="close" onClick={leave}>
            close
          </button>
        </div>
        <div className="body">
          {kind === 'line' ? <LineGuide /> : <MapGuide regions={regions} />}
        </div>
      </div>
    </div>
  )
}
