/**
 * Bootstrap for the worker threads.
 *
 * Plain JavaScript, and the only file in the pipeline that is. A worker started on a `.ts` entry
 * gets Node's own type stripping, which removes the types but does not do the other half of what
 * tsx does for the main thread: rewriting a `./x.js` specifier to the `./x.ts` that is actually on
 * disk. Every import in this project is written that way, so the worker died on its first one.
 *
 * Registering tsx's resolver here, before the real entry is imported, gives the worker the same
 * module resolution the main thread has.
 */
import { register } from 'tsx/esm/api'

register()
await import('./worker.ts')
