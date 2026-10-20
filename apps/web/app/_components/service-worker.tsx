'use client';

import { useEffect } from 'react';
import { registerServiceWorker } from '../../lib/pwa';

/** Registers the offline service worker once the app has loaded (renders nothing). */
export function ServiceWorker() {
  useEffect(() => {
    void registerServiceWorker(navigator, process.env.NODE_ENV === 'production');
  }, []);
  return null;
}
