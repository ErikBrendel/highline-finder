import { useEffect, useRef, useState } from 'react'

/**
 * Hands over the address bar: the native share sheet on a touch device, the clipboard everywhere
 * else.
 *
 * Sharing is the URL rather than an export because the URL already is the share format: the
 * viewport, the open line, the sag, the filters and whether it is full screen are all in it, and
 * `urlState` writes only what the sharer actually changed. What this replaces is selecting a URL by
 * hand -- which on the phone, in the chat app, is where most links to this thing start.
 *
 * It appears twice: in the header, which shares the map as it stands, and in the full-screen line
 * view, which covers the header and is the place a specific line gets sent from.
 */

const WORDS = { idle: 'share', copied: 'copied', failed: 'copy failed' } as const

// The sheet is the better path only where the targets are chat apps and the alternative is copy,
// switch app, paste. Desktop Chrome and Safari also offer `share`, but there it opens a Mail and
// AirDrop sheet in front of someone who was most likely about to paste into something already open.
// So this asks about the input device rather than about the API or the user agent string.
const wantsSheet = () =>
  typeof navigator.share === 'function' && matchMedia('(pointer: coarse)').matches

export function ShareButton({ className }: { className: string }) {
  const [state, setState] = useState<keyof typeof WORDS>('idle')
  // Cleared on unmount, because the full view's button goes away the moment the line is closed and
  // a timer that outlives it would set state on nothing.
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])

  const say = (word: keyof typeof WORDS) => {
    setState(word)
    clearTimeout(timer.current)
    timer.current = setTimeout(() => setState('idle'), 2000)
  }

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(location.href)
      say('copied')
    } catch (e: unknown) {
      // A refused clipboard needs no toast -- the button is already saying it in the one place the
      // person is looking. It happens on a page served over plain http from anything but localhost.
      console.warn('[highline] copying the link:', e)
      say('failed')
    }
  }

  const share = async () => {
    if (!wantsSheet()) return copy()
    try {
      await navigator.share({ url: location.href })
      // The sheet was the feedback, and nothing went to the clipboard, so the label stays put.
    } catch (e: unknown) {
      // Dismissing the sheet is a decision, not a failure, and must not read as one.
      if (e instanceof DOMException && e.name === 'AbortError') return
      console.warn('[highline] sharing the link:', e)
      await copy()
    }
  }

  return (
    <button
      className={className}
      onClick={() => void share()}
      title="Send a link to exactly this view"
      data-state={state}
    >
      {WORDS[state]}
    </button>
  )
}
