/** The service worker's script (apps/web/public/sw.js, ADR-0023). */
export const SERVICE_WORKER_URL = '/sw.js';

/** The web app manifest (apps/web/public/manifest.webmanifest). */
export const MANIFEST_URL = '/manifest.webmanifest';

/** What `registerServiceWorker` needs of the browser. */
export interface ServiceWorkerHost {
  serviceWorker?: Pick<ServiceWorkerContainer, 'register'>;
}

/**
 * Registers the service worker that shows the offline page (production builds only: in
 * development it would keep serving the offline page while the dev server restarts). Never
 * throws: the app works the same without it. Returns whether it registered.
 */
export async function registerServiceWorker(
  host: ServiceWorkerHost,
  production: boolean,
): Promise<boolean> {
  if (!production || host.serviceWorker === undefined) return false;
  try {
    await host.serviceWorker.register(SERVICE_WORKER_URL, { scope: '/' });
    return true;
  } catch {
    return false;
  }
}
