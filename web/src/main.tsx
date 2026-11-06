import { StrictMode, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import AssessApp from './assess/AssessApp.tsx'

// #/map → original XRayMap map tool; everything else → 입지 심사 화면
function Root() {
  const [isMap, setIsMap] = useState(location.hash.startsWith('#/map'))
  useEffect(() => {
    const on = () => setIsMap(location.hash.startsWith('#/map'))
    window.addEventListener('hashchange', on)
    return () => window.removeEventListener('hashchange', on)
  }, [])
  return isMap ? <App /> : <AssessApp />
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
)
