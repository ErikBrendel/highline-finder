import { useEffect, useState } from 'react'

/**
 * Whether a media query matches, kept in step with the window.
 *
 * For the few decisions a stylesheet cannot make. An SVG's `viewBox` is the one this exists for:
 * it is a coordinate system rather than a style, nothing in CSS can reach it, and it is what
 * decides how large the chart's own labels come out -- see `CHART_WIDE` in ProfileChart. Anything
 * a media query in styles.css can do still belongs there.
 *
 * The query string is the dependency, so a caller passing a literal re-subscribes never and a
 * caller building one re-subscribes when it changes. Read once during the first render as well as
 * in the effect, because a chart that mounts at the wrong size and corrects itself a frame later
 * is a visible jump on exactly the screens this is for.
 */
export function useMedia(query: string): boolean {
  const [matches, setMatches] = useState(() => matchMedia(query).matches)
  useEffect(() => {
    const mq = matchMedia(query)
    const sync = () => setMatches(mq.matches)
    sync()
    mq.addEventListener('change', sync)
    return () => mq.removeEventListener('change', sync)
  }, [query])
  return matches
}
