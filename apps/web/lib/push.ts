// Notifications on this device (S21, ADR-0026): what the switch on Home shows, and turning it
// on or off. The browser parts come in as arguments, so the logic tests without a browser.
// One browser subscription serves every business on the device: turning notifications off
// here only stops this business's pushes, so the browser subscription itself is kept.

/** What the switch shows. */
export type PushState =
  /** This deployment sends no pushes: the switch is hidden. */
  | 'unavailable'
  /** This browser cannot show pushes. */
  | 'unsupported'
  /** iPhone and iPad show pushes only for an app added to the Home Screen. */
  | 'install-first'
  /** The member blocked notifications for this site in the browser's settings. */
  | 'blocked'
  | 'off'
  | 'on';

/** The JSON a browser gives for its subscription (`PushSubscription.toJSON()`). */
export interface SubscriptionJson {
  endpoint?: string;
  expirationTime?: number | null;
  keys?: Record<string, string>;
}

export interface BrowserSubscription {
  endpoint: string;
  toJSON(): SubscriptionJson;
}

export interface BrowserPushManager {
  getSubscription(): Promise<BrowserSubscription | null>;
  subscribe(options: {
    userVisibleOnly: boolean;
    applicationServerKey: Uint8Array<ArrayBuffer>;
  }): Promise<BrowserSubscription>;
}

/** The browser as the switch needs it. */
export interface PushBrowser {
  /** The service worker's push manager; `null` without service workers or push. */
  pushManager: () => Promise<BrowserPushManager | null>;
  /** `Notification.permission`, or `null` without notifications. */
  permission: () => NotificationPermission | null;
  requestPermission: () => Promise<NotificationPermission>;
  /** An iPhone or iPad not running the app from the Home Screen. */
  needsInstall: () => boolean;
}

/** What the switch asks of the api. */
export interface PushApi {
  /** Whether this endpoint gets this business's pushes. */
  status(endpoint: string): Promise<boolean>;
  save(subscription: SubscriptionJson): Promise<boolean>;
  remove(endpoint: string): Promise<boolean>;
}

/** The VAPID public key (base64url) as the bytes `subscribe` takes. */
export function applicationServerKey(publicKey: string): Uint8Array<ArrayBuffer> {
  const base64 = publicKey.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '='));
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** The switch's state for this device and business. */
export async function readPushState(
  browser: PushBrowser,
  api: PushApi,
  publicKey: string | null,
): Promise<PushState> {
  if (publicKey === null) return 'unavailable';
  if (browser.needsInstall()) return 'install-first';
  const permission = browser.permission();
  const manager = await browser.pushManager();
  if (permission === null || manager === null) return 'unsupported';
  if (permission === 'denied') return 'blocked';
  const subscription = permission === 'granted' ? await manager.getSubscription() : null;
  if (subscription === null) return 'off';
  return (await api.status(subscription.endpoint)) ? 'on' : 'off';
}

/**
 * Turns this business's pushes on for the device: asks for permission if needed, subscribes
 * the browser (or reuses its subscription) and saves it. Returns the new state.
 */
export async function turnPushOn(
  browser: PushBrowser,
  api: PushApi,
  publicKey: string,
): Promise<PushState> {
  const manager = await browser.pushManager();
  if (manager === null) return 'unsupported';
  const permission =
    browser.permission() === 'granted' ? 'granted' : await browser.requestPermission();
  if (permission === 'denied') return 'blocked';
  if (permission !== 'granted') return 'off';
  const subscription =
    (await manager.getSubscription()) ??
    (await manager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: applicationServerKey(publicKey),
    }));
  return (await api.save(subscription.toJSON())) ? 'on' : 'off';
}

/** Turns this business's pushes off for the device. Returns the new state. */
export async function turnPushOff(browser: PushBrowser, api: PushApi): Promise<PushState> {
  const subscription = await (await browser.pushManager())?.getSubscription();
  if (subscription === null || subscription === undefined) return 'off';
  return (await api.remove(subscription.endpoint)) ? 'off' : 'on';
}

/** The real browser, for the switch. */
export function realBrowser(): PushBrowser {
  return {
    pushManager: async () => {
      if (!('serviceWorker' in navigator) || !('PushManager' in window)) return null;
      return (await navigator.serviceWorker.ready).pushManager;
    },
    permission: () => ('Notification' in window ? Notification.permission : null),
    requestPermission: () => Notification.requestPermission(),
    needsInstall: () =>
      /iPad|iPhone|iPod/.test(navigator.userAgent) &&
      !window.matchMedia('(display-mode: standalone)').matches,
  };
}
