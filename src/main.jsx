import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import './styles-preview.css';
import './styles-agent.css';
import './styles-composer.css';
import App from './App.jsx';
import { StoreProvider } from './state/store.jsx';
import { ToastProvider } from './state/toast.jsx';

/** Electron / 桌面外壳：简约可折叠 chrome */
const isDesktop =
  typeof navigator !== 'undefined' &&
  (/Electron/i.test(navigator.userAgent) || window.cortexDesktop === true);
if (isDesktop) document.documentElement.classList.add('is-desktop');

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <StoreProvider>
      <ToastProvider>
        <App />
      </ToastProvider>
    </StoreProvider>
  </StrictMode>,
);
