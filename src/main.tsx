import { StrictMode } from 'react';
import './i18n';
import { useTranslation } from 'react-i18next';
import { ScreenBoundary } from './app/ScreenBoundary';
import { createRoot } from 'react-dom/client';
import { App } from './app/App';
import './styles/app.css';

const container = document.getElementById('root');

if (!container) {
  throw new Error('Application root container is missing.');
}

function Root() {
  const { t } = useTranslation('common');
  return <ScreenBoundary resetKey="localization" failureMessage={t($ => $.translationsLoadFailed)}>
    <App />
  </ScreenBoundary>;
}

createRoot(container).render(<StrictMode><Root /></StrictMode>);
