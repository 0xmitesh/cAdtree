import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { KnowledgeExplorer } from './explorer';
import '../../src/index.css';
import './style.css';

if (!import.meta.env.DEV) throw new Error('Knowledge Lab is development-only.');
createRoot(document.getElementById('root')!).render(createElement(KnowledgeExplorer));
