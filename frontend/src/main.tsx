import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './styles/tailwind.css'
import './styles/design-system.css'
import './styles/schedule-redesign.css'
import App from './App.tsx'
import { loadGoogleMaps } from './utils/loadGoogleMaps'

// Start loading Google Maps early (fire-and-forget)
loadGoogleMaps().catch(() => {});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
