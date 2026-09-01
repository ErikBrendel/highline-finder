import { useEffect, useState } from 'react'
import { report } from './report.js'

/**
 * The panel that says what this is, shown once unasked and thereafter on request.
 *
 * A map of twenty-five thousand red lines over Brandenburg explains none of itself: not where the
 * measurements come from, not why there is nothing past the border, not that the anchors can be
 * dragged. So it opens the first time and remembers that it did.
 */

const SEEN = 'highline-finder.guide-seen'

/**
 * Storage that may not be there.
 *
 * localStorage throws rather than returning null in a browser configured to refuse it -- private
 * windows, third-party contexts, storage blocked outright -- so both directions are guarded. The
 * fallback is to show the guide, which is the harmless way to be wrong: a reader who cannot be
 * remembered sees it again, rather than a first-time reader never seeing it at all.
 */
export function guideSeen(): boolean {
  try {
    return localStorage.getItem(SEEN) === '1'
  } catch (e) {
    report('reading whether the guide has been seen', e)
    return false
  }
}

export function rememberGuide(): void {
  try {
    localStorage.setItem(SEEN, '1')
  } catch (e) {
    report('remembering that the guide has been seen', e)
  }
}

export function useGuide(): { open: boolean; show: () => void; close: () => void } {
  const [open, setOpen] = useState(() => !guideSeen())
  return {
    open,
    show: () => setOpen(true),
    // Closing is the acknowledgement. There is no separate "don't show this again" because there
    // is nothing else the button could mean: it is a page of prose, and reading it is dismissing it.
    close: () => {
      rememberGuide()
      setOpen(false)
    },
  }
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
          <p>
            A search for places a highline could go, run over the public survey of Berlin and
            Brandenburg: the ground measured at one metre, every pair of standable points within
            range of each other tested for whether a line between them would clear what is under it.
          </p>
          <p>
            Nothing here has been visited. A line on this map is a calculation that survived every
            filter &mdash; a reason to go and look, not a reason to rig.
          </p>

          <h2>Where the data stops</h2>
          <p>
            At the two grey outlines, which are the state borders. The terrain model, the surface
            model with the trees in it and the 3D building model are all published free and open by
            the state, and no neighbour&rsquo;s data is loaded. Pan past the border and the map keeps
            working; there is simply nothing there to find.
          </p>

          <h2>Lines and hotspots</h2>
          <p>
            <b>Lines</b> are individual spans, drawn where they would hang. <b>Hotspots</b> are those
            same lines seen from far off &mdash; one blob per cluster, brighter where more of them
            fall together &mdash; for picking a corner of the state worth zooming into. Both follow
            the filters. Click a line to open its profile: the ground beneath it, the canopy, the
            roads it crosses, and how much air it has at its worst point.
          </p>

          <h2>Natural and urban</h2>
          <p>
            The split is by what the two ends stand on, not by what is around them. <b>Natural</b> is
            both ends on the ground, and it is complete: the whole state searched at one set of
            settings. <b>Urban</b> is at least one end on a roof, and it is unfinished &mdash; roofs
            count only inside the rectangles the map outlines while the urban filter is on, so there
            are no urban lines anywhere else. Berlin has none at all, because the building model
            covers Brandenburg only.
          </p>

          <h2>The filters</h2>
          <p>
            <b>Midspan sag</b> is the one that re-measures rather than hides: every line is
            re-checked against the terrain at the sag you set, and the ones that no longer clear it
            are gone. It cannot go below the value the search itself used, because no line was ever
            evaluated tighter than that. The rest &mdash; score, length, exposure, canopy, offlevel
            &mdash; only narrow what is already there. Length is spaced by ratio rather than by
            metres, because most of what is walkable lives in the first hundred.
          </p>

          <h2>The background</h2>
          <p>
            One slider, three maps: orthophoto, hillshade, OpenStreetMap. The labels jump straight to
            one; the positions between them are the imagery with the hillshade burned into it, which
            is how you read a slope and a road at the same time. Tiles are kept in the browser, so
            going back and forth is free after the first look.
          </p>

          <h2>Lines of your own</h2>
          <p>
            Every line here is a starting point, not a fixture. Select one and drag either anchor
            &mdash; the profile re-measures as it moves, fetching elevation for ground nobody has
            asked about before. Or right-click the map for <b>Set custom point A</b> and <b>B</b> and
            plan a span from nothing: the same measurements, anywhere in the two states, whether or
            not the search ever proposed anything there.
          </p>
          <p>
            The address bar follows the view, the selection and the filters, so a link is the map as
            you left it.
          </p>

          <h2>What it cannot tell you</h2>
          <p>
            Who owns the ground, whether the tree is sound, whether anyone may walk in, and whether
            the line is a good idea. Access, permission and the judgement to rig stay with you.
          </p>
        </div>
      </div>
    </div>
  )
}
