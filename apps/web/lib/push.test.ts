import { describe, expect, it, vi } from 'vitest';
import {
  applicationServerKey,
  readPushState,
  turnPushOff,
  turnPushOn,
  type BrowserPushManager,
  type BrowserSubscription,
  type PushApi,
  type PushBrowser,
} from './push';

const KEY =
  'BOPiFuHSQbAZSy6hLbAOJgmG176WEZwdfHOUmVFIWw7NZkX_Ll7w7bMZgi2aGDNGf11amFzaUB_WPL74rmUpMNI';
const ENDPOINT = 'https://fcm.googleapis.com/fcm/send/abc';

function subscription(endpoint = ENDPOINT): BrowserSubscription {
  return {
    endpoint,
    toJSON: () => ({ endpoint, expirationTime: null, keys: { p256dh: 'p', auth: 'a' } }),
  };
}

function setUp(
  options: {
    permission?: NotificationPermission | null;
    answer?: NotificationPermission;
    existing?: BrowserSubscription | null;
    manager?: boolean;
    needsInstall?: boolean;
    subscribed?: boolean;
    saves?: boolean;
  } = {},
) {
  const spies = {
    getSubscription: vi.fn(() => Promise.resolve(options.existing ?? null)),
    subscribe: vi.fn(() => Promise.resolve(subscription())),
    requestPermission: vi.fn(() => Promise.resolve(options.answer ?? 'granted')),
    status: vi.fn(() => Promise.resolve(options.subscribed ?? false)),
    save: vi.fn<PushApi['save']>(() => Promise.resolve(options.saves ?? true)),
    remove: vi.fn<PushApi['remove']>(() => Promise.resolve(true)),
  };
  const manager: BrowserPushManager = {
    getSubscription: spies.getSubscription,
    subscribe: spies.subscribe,
  };
  const browser: PushBrowser = {
    pushManager: () => Promise.resolve(options.manager === false ? null : manager),
    permission: () => (options.permission === undefined ? 'default' : options.permission),
    requestPermission: spies.requestPermission,
    needsInstall: () => options.needsInstall ?? false,
  };
  const api: PushApi = { status: spies.status, save: spies.save, remove: spies.remove };
  return { spies, browser, api };
}

describe('applicationServerKey', () => {
  it('decodes the base64url key to its 65 bytes', () => {
    const bytes = applicationServerKey(KEY);
    expect(bytes).toHaveLength(65);
    expect(bytes[0]).toBe(4);
    expect(Buffer.from(bytes).toString('base64url')).toBe(KEY);
  });
});

describe('readPushState', () => {
  it('is hidden when the deployment sends no pushes', async () => {
    const { browser, api } = setUp();
    expect(await readPushState(browser, api, null)).toBe('unavailable');
  });

  it('asks iPhone users to add the app to the Home Screen first', async () => {
    const { browser, api } = setUp({ needsInstall: true });
    expect(await readPushState(browser, api, KEY)).toBe('install-first');
  });

  it('knows a browser without push, and notifications blocked in settings', async () => {
    expect(await readPushState(setUp({ manager: false }).browser, setUp().api, KEY)).toBe(
      'unsupported',
    );
    expect(await readPushState(setUp({ permission: null }).browser, setUp().api, KEY)).toBe(
      'unsupported',
    );
    expect(await readPushState(setUp({ permission: 'denied' }).browser, setUp().api, KEY)).toBe(
      'blocked',
    );
  });

  it('is on only when this business has the device; off otherwise', async () => {
    const on = setUp({ permission: 'granted', existing: subscription(), subscribed: true });
    expect(await readPushState(on.browser, on.api, KEY)).toBe('on');
    expect(on.spies.status).toHaveBeenCalledWith(ENDPOINT);
    // Subscribed for another business on this device.
    const other = setUp({ permission: 'granted', existing: subscription(), subscribed: false });
    expect(await readPushState(other.browser, other.api, KEY)).toBe('off');
    // Never asked yet: no subscription is read.
    const fresh = setUp();
    expect(await readPushState(fresh.browser, fresh.api, KEY)).toBe('off');
    expect(fresh.spies.getSubscription).not.toHaveBeenCalled();
  });
});

describe('turnPushOn', () => {
  it('asks for permission, subscribes with the public key and saves the subscription', async () => {
    const { browser, api, spies } = setUp();
    expect(await turnPushOn(browser, api, KEY)).toBe('on');
    expect(spies.requestPermission).toHaveBeenCalled();
    expect(spies.subscribe).toHaveBeenCalledWith({
      userVisibleOnly: true,
      applicationServerKey: applicationServerKey(KEY),
    });
    expect(spies.save).toHaveBeenCalledWith(subscription().toJSON());
  });

  it("reuses the browser's subscription when there is one", async () => {
    const { browser, api, spies } = setUp({ permission: 'granted', existing: subscription() });
    expect(await turnPushOn(browser, api, KEY)).toBe('on');
    expect(spies.requestPermission).not.toHaveBeenCalled();
    expect(spies.subscribe).not.toHaveBeenCalled();
  });

  it('stops when permission is refused or dismissed, or the api refuses', async () => {
    const denied = setUp({ answer: 'denied' });
    expect(await turnPushOn(denied.browser, denied.api, KEY)).toBe('blocked');
    const dismissed = setUp({ answer: 'default' });
    expect(await turnPushOn(dismissed.browser, dismissed.api, KEY)).toBe('off');
    expect(dismissed.spies.subscribe).not.toHaveBeenCalled();
    const refused = setUp({ saves: false });
    expect(await turnPushOn(refused.browser, refused.api, KEY)).toBe('off');
    expect(await turnPushOn(setUp({ manager: false }).browser, refused.api, KEY)).toBe(
      'unsupported',
    );
  });
});

describe('turnPushOff', () => {
  it("removes this business's pushes for the device and keeps the browser's subscription", async () => {
    const existing = { ...subscription(), unsubscribe: vi.fn() };
    const { browser, api, spies } = setUp({ permission: 'granted', existing });
    expect(await turnPushOff(browser, api)).toBe('off');
    expect(spies.remove).toHaveBeenCalledWith(ENDPOINT);
    expect(existing.unsubscribe).not.toHaveBeenCalled();
  });

  it('is off without a subscription', async () => {
    const { browser, api, spies } = setUp();
    expect(await turnPushOff(browser, api)).toBe('off');
    expect(spies.remove).not.toHaveBeenCalled();
    expect(await turnPushOff(setUp({ manager: false }).browser, api)).toBe('off');
  });
});
