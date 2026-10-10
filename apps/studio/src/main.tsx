import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './ui/App';
import './styles/tokens.css';
import './styles/app.css';

const root = document.getElementById('root');
if (root === null) throw new Error('Studio root element missing');
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
