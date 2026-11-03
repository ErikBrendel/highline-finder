import { useEffect, useRef, useState } from 'react'

/**
 * Copies the address bar.
 *
 * Sharing is a copy rather than an export because the URL already is the share format: the
 * viewport, the open line, the sag, the filters and whether it is full screen are all in it, and
 * `urlState` writes only what the sharer actually changed. What this replaces is selecting a URL by
 * hand -- which on the phone, in the chat app, is where most links to this thing start.
 *
 * It appears twice: in the header, which shares the map as it stands, and in the full-screen line
 * view, which covers the header and is the place a specific line gets sent from.
 */

const WORDS = { idle: 'share', copied: 'copied', failed: 'copy failed' } as const

export function ShareButton({ className }: { className: string }) {
  const [state, setState] = useState<keyof typeof WORDS>('idle')
  // Cleared on unmount, because the full view's button goes away the moment the line is closed and
  // a timer that outlives it would set state on nothing.
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(location.href)
      setState('copied')
    } catch (e: unknown) {
      // A refused clipboard needs no toast -- the button is already saying it in the one place the
      // person is looking. It happens on a page served over plain http from anything but localhost.
      console.warn('[highline] copying the link:', e)
      setState('failed')
    }
    clearTimeout(timer.current)
    timer.current = setTimeout(() => setState('idle'), 2000)
  }

  return (
    <button
      className={className}
      onClick={() => void copy()}
      title="Copy a link to exactly this view"
      data-state={state}
    >
      {WORDS[state]}
    </button>
  )
}
