import { createRoot } from 'react-dom/client'
import 'maplibre-gl/dist/maplibre-gl.css'
import './styles.css'
import { App } from './App.js'
import { ErrorBoundary } from './ErrorBoundary.js'
import { installTileCache } from './tileCache.js'
import { installShadedTiles } from './shaded.js'
import { installStackedTiles } from './stacked.js'

// All three must run before any map is created, so the first tile request already goes through
// them: the cache, the relief multiply, and the per-survey stack each answer their own scheme.
installTileCache()
installShadedTiles()
installStackedTiles()

createRoot(document.getElementById('root')!).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>,
)
