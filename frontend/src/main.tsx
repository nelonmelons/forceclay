import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

// No <StrictMode>: its dev-only double-mount races the WebSocket/getUserMedia setup
// (stale socket callbacks clobber the live refs). Real-time media providers don't benefit from it.
createRoot(document.getElementById('root')!).render(<App />)
