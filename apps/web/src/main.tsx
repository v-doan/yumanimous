import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, RouterProvider } from 'react-router';
import '@fontsource/bricolage-grotesque/800.css';
import '@fontsource-variable/inter';
import './styles/global.css';
import { App } from './App';
import { HomePage } from './pages/HomePage';
import { NotFound } from './pages/NotFound';
import { SessionPage } from './pages/SessionPage';

// `/s/:code` is the link shared in the group chat.
const router = createBrowserRouter([
  {
    element: <App />,
    children: [
      { path: '/', element: <HomePage /> },
      { path: '/s/:code', element: <SessionPage /> },
      { path: '*', element: <NotFound /> },
    ],
  },
]);

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root element');

createRoot(root).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
