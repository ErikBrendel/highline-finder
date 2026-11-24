import { useEffect, useState } from 'react'
import type { Spots } from './useSpots.js'

/**
 * Shows or hides the secret spots, from the top bar, and `h` hides them from anywhere.
 *
 * Hiding is one click or one key and never asks anything, because it is what someone does when a
 * person walks up or a screen share starts. Showing asks for the password when one is set.
 */
export function SecretToggle({ secrets, className }: { secrets: Spots['secrets']; className: string }) {
  const [asking, setAsking] = useState(false)
  const [password, setPassword] = useState('')
  const [wrong, setWrong] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'h' || e.metaKey || e.ctrlKey || e.altKey) return
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return
      secrets.hide()
      setAsking(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [secrets.hide])

  const click = () => {
    if (secrets.shown) return secrets.hide()
    if (!secrets.locked) return void secrets.reveal('')
    setAsking(!asking)
    setWrong(false)
  }
  const unlock = async () => {
    setBusy(true)
    const ok = await secrets.reveal(password)
    setBusy(false)
    setWrong(!ok)
    if (!ok) return
    setAsking(false)
    setPassword('')
  }

  return (
    <span className="secretwrap">
      <button
        className={className}
        data-active={secrets.shown || undefined}
        onClick={click}
        title={secrets.shown ? 'Hide the secret spots (h)' : 'Show the secret spots'}
      >
        {secrets.shown ? 'hide secret' : 'secret'}
      </button>
      {asking && (
        <form className="unlock" onSubmit={(e) => { e.preventDefault(); void unlock() }}>
          <input
            type="password"
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => e.key === 'Escape' && setAsking(false)}
            autoFocus
          />
          <button type="submit" disabled={busy}>{busy ? '…' : 'show'}</button>
          {wrong && <span className="bad">wrong password</span>}
        </form>
      )}
    </span>
  )
}
