import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, RouterProvider } from 'react-router';
import '@fontsource/bricolage-grotesque/800.css';
import '@fontsource-variable/inter';
import './styles/global.css';
import { App } from './App';

// One route for now; Phase 2 adds /s/:code for joining a session by link.
const router = createBrowserRouter([{ path: '/', element: <App /> }]);

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root element');

createRoot(root).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
