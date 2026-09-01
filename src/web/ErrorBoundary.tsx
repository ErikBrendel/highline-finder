import { Component, useEffect, useState, type ErrorInfo, type ReactNode } from 'react'
import { failureText, onFailure, type Failure } from './report.js'

/**
 * Catches a crash and shows it, instead of leaving a black page.
 *
 * React unmounts the whole tree when a render throws, so without this the app becomes an empty
 * document and the only evidence is in the browser console -- which is the one place a person
 * reporting the bug is least likely to look, and the one place the text cannot be copied out of
 * conveniently. The point here is not recovery, it is that the stack ends up somewhere a person
 * can select, copy and paste back.
 *
 * Window-level handlers as well as the boundary, because the two catch different halves. A boundary
 * only sees errors thrown during render, and a great deal of this app happens in effects and
 * promises -- a failed tile fetch, an Overpass request, an elevation window -- none of which reach
 * it. Those do not blank the page, so they are shown as a dismissible banner rather than as a
 * replacement for the app.
 *
 * And a third half, which is the one that actually bit: a failure the app deliberately catches and
 * carries on from never becomes an unhandled rejection, so neither handler above ever sees it. Those
 * come through report.ts, and are listed quietly at the foot of the screen rather than thrown in
 * front of the map -- the app is still working, and the point is that the reason exists somewhere a
 * person can read it.
 */

interface Caught {
  error: unknown
  /** React's component stack, where the boundary itself caught it. */
  componentStack?: string
  /** Whether the app is still mounted behind this, or was torn down by the throw. */
  fatal: boolean
}

interface State {
  caught: Caught | null
}

function describe(caught: Caught): string {
  const { error } = caught
  const lines = [
    error instanceof Error ? `${error.name}: ${error.message}` : `Thrown value: ${String(error)}`,
  ]
  if (error instanceof Error && error.stack) lines.push('', error.stack)
  if (caught.componentStack) lines.push('', 'Component stack:', caught.componentStack.trim())
  lines.push('', `${navigator.userAgent}`, location.href)
  return lines.join('\n')
}

export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { caught: null }

  static getDerivedStateFromError(error: unknown): State {
    return { caught: { error, fatal: true } }
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    this.setState({ caught: { error, componentStack: info.componentStack ?? undefined, fatal: true } })
  }

  componentDidMount(): void {
    window.addEventListener('error', this.onWindowError)
    window.addEventListener('unhandledrejection', this.onRejection)
  }

  componentWillUnmount(): void {
    window.removeEventListener('error', this.onWindowError)
    window.removeEventListener('unhandledrejection', this.onRejection)
  }

  // Only the first one: a broken render loop can throw every frame, and replacing the report each
  // time would make it impossible to read, let alone copy.
  private readonly show = (caught: Caught) => {
    if (!this.state.caught) this.setState({ caught })
  }

  private readonly onWindowError = (e: ErrorEvent) =>
    this.show({ error: e.error ?? e.message, fatal: false })

  private readonly onRejection = (e: PromiseRejectionEvent) =>
    this.show({ error: e.reason, fatal: false })

  render(): ReactNode {
    const { caught } = this.state
    return (
      <>
        {/* A non-fatal error leaves the app usable, so it keeps rendering underneath. */}
        {(!caught || !caught.fatal) && this.props.children}
        {caught && (
          <ErrorReport
            caught={caught}
            onDismiss={caught.fatal ? null : () => this.setState({ caught: null })}
          />
        )}
        {import.meta.env.DEV && <SoftFailures />}
      </>
    )
  }
}

/**
 * Failures the app survived, kept at the corner of the screen while developing.
 *
 * Deliberately unobtrusive and deliberately not dismissible-forever: these are the ones that used
 * to be invisible, and a spinner that never resolves needs its reason to still be on screen when
 * someone finally looks for it.
 *
 * Development only. A refused elevation window or a timed-out Overpass query is a fact about the
 * survey servers, not about anything a visitor did or can do -- the app is designed to keep working
 * through them, and a counter in the corner asks them to worry about a thing that is being handled.
 * `report` still logs every one to the console, so the reason is there for whoever opens it. Vite
 * folds the constant away, so the panel leaves the bundle entirely.
 */
function SoftFailures() {
  const [list, setList] = useState<Failure[]>([])
  const [open, setOpen] = useState(false)
  useEffect(
    () =>
      onFailure((f) =>
        setList((held) => [f, ...held.filter((x) => x.what !== f.what)].slice(0, 8)),
      ),
    [],
  )
  if (!list.length) return null
  const total = list.reduce((n, f) => n + f.count, 0)
  return (
    <div className="softfail" data-open={open}>
      <button onClick={() => setOpen((v) => !v)}>
        {total} background {total === 1 ? 'failure' : 'failures'}
      </button>
      {open && (
        <ul>
          {list.map((f) => (
            <li key={f.what}>
              <strong>{f.what}</strong>
              {f.count > 1 && <span className="times">&times;{f.count}</span>}
              <span>{failureText(f.error)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function ErrorReport({ caught, onDismiss }: { caught: Caught; onDismiss: (() => void) | null }) {
  const text = describe(caught)
  const [copyLabel, setCopyLabel] = useState('copy')

  // The clipboard API needs a secure context and a permission, and this is the moment least worth
  // failing silently at -- so say which happened, and leave the text selectable either way.
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text)
      setCopyLabel('copied')
    } catch {
      setCopyLabel('blocked — select it instead')
    }
    setTimeout(() => setCopyLabel('copy'), 2500)
  }

  return (
    <div className="crash" data-fatal={caught.fatal}>
      <div className="crash-head">
        <strong>{caught.fatal ? 'The app crashed' : 'Something failed in the background'}</strong>
        <span className="spacer" />
        <button onClick={copy}>{copyLabel}</button>
        {onDismiss ? (
          <button onClick={onDismiss}>dismiss</button>
        ) : (
          <button onClick={() => location.reload()}>reload</button>
        )}
      </div>
      <pre>{text}</pre>
    </div>
  )
}
