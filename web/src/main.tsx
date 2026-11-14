import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { listenServiceWorker } from './lib/push';
import { navigate } from './router';
import './styles/app.css';
import './styles/deck.css';
import './styles/extra.css';
import './styles/plan3.css';

// 웹 알림을 누르면 서비스 워커가 열린 탭에 그 세션 주소를 알려 준다.
listenServiceWorker((to) => navigate(to));

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
