import { createRoot } from 'react-dom/client'
import 'maplibre-gl/dist/maplibre-gl.css'
import './styles.css'
import { App } from './App.js'
import { ErrorBoundary } from './ErrorBoundary.js'
import { installTileCache } from './tileCache.js'

// Must run before any map is created, so the first tile request already goes through the cache.
installTileCache()

createRoot(document.getElementById('root')!).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>,
)
