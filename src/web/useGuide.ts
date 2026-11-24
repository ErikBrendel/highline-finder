import { useState } from 'react'
import { useRemembered } from './remembered.js'

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
