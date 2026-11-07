import {
  SUPPORT_SCREENSHOTS_PER_DAY,
  SupportReplyInputSchema,
  TenantIdSchema,
  type TenantId,
  type UserId,
} from '@pepper/contracts';
import {
  addMembership,
  createDatabase,
  grantOperator,
  listDueOutboxMessages,
  operatorAccessLog,
  readBusinessExport,
  withTenant,
  type Database,
  type DatabaseHandle,
} from '@pepper/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Actor } from './actor.js';
import { ManualClock } from './clock.js';
import {
  SupportLimitReachedError,
  SupportScreenshotNotFoundError,
  SupportScreenshotRejectedError,
  SupportScreenshotsNotAttachableError,
  SupportScreenshotsUnavailableError,
} from './errors.js';
import { outboxKeyFrom, type EmailMessage, type Mailer } from './outbox.js';
import { createBusiness } from './services/business.js';
import { deliverOutboxMessage } from './services/outbox.js';
import {
  readOperatorInbox,
  readOperatorScreenshotImage,
  readOperatorThread,
  replyAsOperator,
} from './services/operator-support.js';
import { runSupportHousekeeping } from './services/support-housekeeping.js';
import {
  deleteAllSupportScreenshotImages,
  discardSupportScreenshot,
  readScreenshotsForExport,
  readSupportScreenshotImage,
  uploadSupportScreenshot,
  type ScreenshotStorage,
} from './services/support-screenshots.js';
import {
  openSupportThread,
  readSupportThread,
  replyToSupportThread,
  type SupportOptions,
} from './services/support.js';
import { insertUser, startTestDatabase, type TestDatabase } from './test-support.js';

// Screenshots on support requests against real Postgres (S59.2.3, ADR-0062 Part 3, AC-X-27…31):
// the upload's limits and cleaning, attaching to a request or reply, who is served which image,
// the console's logged reads and the inbox count, the 24 h sweep, the deletion and the export.

let database: TestDatabase;
let db: Database;
let admin: DatabaseHandle;
let tenant: TenantId;
let other: TenantId;
// Ana owns Juniper, Jess and Ben are staff; Olga owns another business; Olive is an operator.
let ana: UserId;
let jess: UserId;
let ben: UserId;
let olga: UserId;
let olive: UserId;

const key = outboxKeyFrom('an-integration-test-outbox-secret-32+');
let clock: ManualClock;
let store: FakeScreenshots;
let options: SupportOptions;

const actor = (userId: UserId, role: 'owner' | 'manager' | 'staff', at = tenant): Actor => ({
  context: { tenantId: at, userId, role },
});
const meta = { userAgent: 'Mozilla/5.0 (iPhone) Test' };
const shots = () => ({ store, clock });

class FakeMailer implements Mailer {
  readonly sent: EmailMessage[] = [];
  async send(message: EmailMessage): Promise<void> {
    await Promise.resolve();
    this.sent.push(message);
  }
}

async function deliverAll(): Promise<EmailMessage[]> {
  const mailer = new FakeMailer();
  for (const due of await listDueOutboxMessages(db, clock.now(), 100)) {
    await deliverOutboxMessage(db, due, { key, mailer, clock });
  }
  return mailer.sent;
}

/**
 * The storage port in memory: a "PNG" (its first byte) is kept at 480 and 800 px, anything else
 * refused. The real check and remake are `@pepper/storage`'s, tested there and through the api.
 */
class FakeScreenshots implements ScreenshotStorage {
  readonly images = new Map<string, Uint8Array>();
  failDeletes = false;

  process(bytes: Uint8Array): ReturnType<ScreenshotStorage['process']> {
    if (bytes[0] !== 0x89) {
      return Promise.resolve({
        kind: 'rejected',
        reason: 'unsupported_type',
        message: 'Use a JPEG, PNG or WebP screenshot.',
      });
    }
    return Promise.resolve({
      kind: 'image',
      width: 800,
      height: 600,
      variants: [
        { width: 480, data: Uint8Array.of(4, 8, 0) },
        { width: 800, data: Uint8Array.of(8, 0, 0) },
      ],
    });
  }

  put(tenantId: string, id: string, width: number, data: Uint8Array): Promise<void> {
    this.images.set(`${tenantId}/${id}/${String(width)}`, data);
    return Promise.resolve();
  }

  get(tenantId: string, id: string, width: number): Promise<Uint8Array | null> {
    return Promise.resolve(this.images.get(`${tenantId}/${id}/${String(width)}`) ?? null);
  }

  delete(
    screenshots: readonly { tenantId: string; id: string; widths: readonly number[] }[],
  ): Promise<void> {
    if (this.failDeletes) return Promise.reject(new Error('store down'));
    for (const { tenantId, id, widths } of screenshots) {
      for (const width of widths) this.images.delete(`${tenantId}/${id}/${String(width)}`);
    }
    return Promise.resolve();
  }

  has(tenantId: string, id: string, width: number): boolean {
    return this.images.has(`${tenantId}/${id}/${String(width)}`);
  }
}

const png = Uint8Array.of(0x89, 0x50, 0x4e, 0x47);

beforeAll(async () => {
  database = await startTestDatabase();
  db = database.app.db;
  admin = createDatabase({ url: database.migrationUrl, maxConnections: 1 });
  ana = await insertUser(db, 'Ana Ruiz', 'ana@juniper-shots.test');
  jess = await insertUser(db, 'Jess Park', 'jess@juniper-shots.test');
  ben = await insertUser(db, 'Ben Okafor', 'ben@juniper-shots.test');
  olga = await insertUser(db, 'Olga', 'olga@fig-shots.test');
  olive = await insertUser(db, 'Olive Operator', 'olive@pepper-ops-shots.test');
  await grantOperator(database.migrationUrl, {
    email: 'olive@pepper-ops-shots.test',
    note: 'tests',
  });
  tenant = TenantIdSchema.parse(
    (
      await createBusiness(db, ana, {
        name: 'Juniper Hair Studio',
        slug: 'juniper-shots',
        timeZone: 'America/New_York',
      })
    ).id,
  );
  other = TenantIdSchema.parse(
    (await createBusiness(db, olga, { name: 'Fig', slug: 'fig-shots', timeZone: 'UTC' })).id,
  );
  await withTenant(db, tenant, async (tx) => {
    await addMembership(tx, { userId: jess, role: 'staff' });
    await addMembership(tx, { userId: ben, role: 'staff' });
  });
});

// Each test a few days after the last, so a day's limits and earlier emails don't carry over.
let day = Date.UTC(2026, 10, 7, 15);

beforeEach(async () => {
  day += 3 * 24 * 60 * 60 * 1000;
  clock = new ManualClock(new Date(day));
  store = new FakeScreenshots();
  options = {
    outboxKey: key,
    supportEmail: 'support@pepper.test',
    baseUrl: 'https://app.pepper.test',
    release: '1.4.0+abc',
    clock,
  };
  await deliverAll();
});

afterAll(async () => {
  await admin.close();
  await database.stop();
});

describe('uploading (AC-X-28)', () => {
  it('keeps the remade image at its widths under the business, seen by its uploader', async () => {
    const shot = await uploadSupportScreenshot(db, actor(jess, 'staff'), png, shots());
    expect(shot).toMatchObject({ width: 800, height: 600 });
    expect(store.has(tenant, shot.id, 480) && store.has(tenant, shot.id, 800)).toBe(true);
    // Its uploader sees its preview before sending it; the thumbnail is the narrowest width.
    const thumb = await readSupportScreenshotImage(
      db,
      actor(jess, 'staff'),
      shot.id,
      'thumb',
      shots(),
    );
    expect(thumb).toEqual({ body: Uint8Array.of(4, 8, 0), contentType: 'image/webp' });
    const full = await readSupportScreenshotImage(
      db,
      actor(jess, 'staff'),
      shot.id,
      'full',
      shots(),
    );
    expect(full.body).toEqual(Uint8Array.of(8, 0, 0));
  });

  it('refuses what the storage refuses, and keeps nothing', async () => {
    await expect(
      uploadSupportScreenshot(db, actor(jess, 'staff'), Uint8Array.of(0x47, 0x49, 0x46), shots()),
    ).rejects.toThrow(SupportScreenshotRejectedError);
    await expect(
      uploadSupportScreenshot(db, actor(jess, 'staff'), Uint8Array.of(0x47, 0x49, 0x46), shots()),
    ).rejects.toMatchObject({
      reason: 'unsupported_type',
      message: 'Use a JPEG, PNG or WebP screenshot.',
    });
    expect(store.images.size).toBe(0);
  });

  it('allows 20 a day per person, removed ones included; none without a store', async () => {
    const small = png;
    for (let i = 0; i < SUPPORT_SCREENSHOTS_PER_DAY; i += 1) {
      const shot = await uploadSupportScreenshot(db, actor(ben, 'staff'), small, shots());
      if (i === 0) await discardSupportScreenshot(db, actor(ben, 'staff'), shot.id, shots());
    }
    await expect(uploadSupportScreenshot(db, actor(ben, 'staff'), small, shots())).rejects.toEqual(
      new SupportLimitReachedError('screenshots'),
    );
    // Someone else's day is their own.
    await expect(
      uploadSupportScreenshot(db, actor(jess, 'staff'), small, shots()),
    ).resolves.toBeDefined();
    await expect(
      uploadSupportScreenshot(db, actor(jess, 'staff'), small, { store: null, clock }),
    ).rejects.toBeInstanceOf(SupportScreenshotsUnavailableError);
  });
});

describe('attaching and reading (AC-X-27, AC-X-29)', () => {
  it('a request carries its screenshots in order; readers of the thread see them, nobody else', async () => {
    const first = await uploadSupportScreenshot(db, actor(jess, 'staff'), png, shots());
    const second = await uploadSupportScreenshot(db, actor(jess, 'staff'), png, shots());
    const created = await openSupportThread(
      db,
      actor(jess, 'staff'),
      { kind: 'problem', message: 'The calendar is empty', screenshotIds: [second.id, first.id] },
      meta,
      options,
    );
    const thread = await readSupportThread(db, actor(jess, 'staff'), created.id ?? '', { clock });
    expect(thread.messages[0]?.screenshots.map((s) => s.id)).toEqual([second.id, first.id]);
    expect(thread.screenshotCount).toBe(2);
    // The owner reads every request; another staff member and another business don't.
    await expect(
      readSupportScreenshotImage(db, actor(ana, 'owner'), first.id, 'full', shots()),
    ).resolves.toMatchObject({ contentType: 'image/webp' });
    for (const reader of [actor(ben, 'staff'), actor(olga, 'owner', other)]) {
      await expect(
        readSupportScreenshotImage(db, reader, first.id, 'full', shots()),
      ).rejects.toBeInstanceOf(SupportScreenshotNotFoundError);
    }
    await expect(
      readSupportScreenshotImage(db, actor(ana, 'owner'), 'not-an-id', 'full', shots()),
    ).rejects.toBeInstanceOf(SupportScreenshotNotFoundError);
    // The team's email says there are screenshots, never carries them.
    const team = (await deliverAll()).find((mail) => mail.to === 'support@pepper.test');
    expect(team?.text).toContain('Screenshots: 2 — open the request in the console to see them.');
  });

  it('refuses the whole message for a screenshot that isn’t the sender’s own unsent one', async () => {
    const bens = await uploadSupportScreenshot(db, actor(ben, 'staff'), png, shots());
    await expect(
      openSupportThread(
        db,
        actor(jess, 'staff'),
        { kind: 'problem', message: 'Look at this', screenshotIds: [bens.id] },
        meta,
        options,
      ),
    ).rejects.toBeInstanceOf(SupportScreenshotsNotAttachableError);
    const removed = await uploadSupportScreenshot(db, actor(jess, 'staff'), png, shots());
    await discardSupportScreenshot(db, actor(jess, 'staff'), removed.id, shots());
    expect(store.has(tenant, removed.id, 480)).toBe(false);
    await expect(
      discardSupportScreenshot(db, actor(jess, 'staff'), removed.id, shots()),
    ).rejects.toBeInstanceOf(SupportScreenshotNotFoundError);
    const created = await openSupportThread(
      db,
      actor(jess, 'staff'),
      { kind: 'question', message: 'One more', screenshotIds: [] },
      meta,
      options,
    );
    await expect(
      replyToSupportThread(
        db,
        actor(jess, 'staff'),
        created.id ?? '',
        { message: 'And this', screenshotIds: [removed.id] },
        options,
      ),
    ).rejects.toBeInstanceOf(SupportScreenshotsNotAttachableError);
    // Nothing was written: the thread still has its one message.
    const thread = await readSupportThread(db, actor(jess, 'staff'), created.id ?? '', { clock });
    expect(thread.messages).toHaveLength(1);
    // A reply carries its own; three at most.
    const shot = await uploadSupportScreenshot(db, actor(jess, 'staff'), png, shots());
    const replied = await replyToSupportThread(
      db,
      actor(jess, 'staff'),
      created.id ?? '',
      { message: 'Here', screenshotIds: [shot.id] },
      options,
    );
    expect(replied.messages[1]?.screenshots.map((s) => s.id)).toEqual([shot.id]);
    expect(() =>
      SupportReplyInputSchema.parse({
        message: 'Too many',
        screenshotIds: [shot.id, removed.id, bens.id, '0190a000-0000-7000-8000-000000000999'],
      }),
    ).toThrow();
  });
});

describe('the console (AC-X-30)', () => {
  it('serves each image under its own access log row and counts them in the inbox', async () => {
    const shot = await uploadSupportScreenshot(db, actor(olga, 'owner', other), png, shots());
    const created = await openSupportThread(
      db,
      actor(olga, 'owner', other),
      { kind: 'problem', message: 'Broken', screenshotIds: [shot.id] },
      meta,
      options,
    );
    const operator = { userId: olive };
    const inbox = await readOperatorInbox(db, operator, { view: 'waiting' });
    const row = inbox.items.find((item) => item.id === created.id);
    expect(row?.source === 'thread' ? row.screenshotCount : null).toBe(1);
    const thread = await readOperatorThread(db, operator, created.id ?? '', { clock });
    expect(thread.messages[0]?.screenshots).toEqual([{ id: shot.id, width: 800, height: 600 }]);
    const count = async () =>
      (await admin.db.select().from(operatorAccessLog)).filter(
        (entry) => entry.action === 'screenshot.read' && entry.targetId === shot.id,
      ).length;
    expect(await count()).toBe(0);
    await readOperatorScreenshotImage(db, operator, shot.id, 'thumb', shots());
    await readOperatorScreenshotImage(db, operator, shot.id, 'full', shots());
    expect(await count()).toBe(2);
    // The team doesn't attach screenshots.
    await expect(
      replyAsOperator(
        db,
        operator,
        created.id ?? '',
        { message: 'Thanks', screenshotIds: [shot.id] },
        options,
      ),
    ).rejects.toBeInstanceOf(SupportScreenshotsNotAttachableError);
  });
});

describe('the sweep, the export and the deletion (AC-X-28, AC-X-31)', () => {
  it('deletes unsent uploads after 24 h with their images; sent ones stay', async () => {
    // The job won't run ahead of the database's clock: this test replays a past day.
    clock.set(new Date(Date.now() - 3 * 24 * 60 * 60 * 1000));
    const unsent = await uploadSupportScreenshot(db, actor(jess, 'staff'), png, shots());
    const sent = await uploadSupportScreenshot(db, actor(jess, 'staff'), png, shots());
    await openSupportThread(
      db,
      actor(jess, 'staff'),
      { kind: 'idea', message: 'An idea', screenshotIds: [sent.id] },
      meta,
      options,
    );
    const sweep = () =>
      runSupportHousekeeping(db, {
        outboxKey: key,
        supportEmail: null,
        baseUrl: null,
        mailer: null,
        clock,
        store,
      });
    // Earlier tests' leftovers go in the first pass; this test's wait a day.
    clock.advanceBy(23 * 60 * 60 * 1000);
    await sweep();
    expect(store.has(tenant, unsent.id, 480)).toBe(true);
    clock.advanceBy(2 * 60 * 60 * 1000);
    const result = await sweep();
    expect(result.swept).toBeGreaterThanOrEqual(1);
    expect(result.failed).toBe(0);
    expect(store.has(tenant, unsent.id, 480)).toBe(false);
    expect(store.has(tenant, sent.id, 480)).toBe(true);
    await expect(
      readSupportScreenshotImage(db, actor(jess, 'staff'), unsent.id, 'thumb', shots()),
    ).rejects.toBeInstanceOf(SupportScreenshotNotFoundError);
  });

  it('the export reads the sent images; the deletion removes every image', async () => {
    const sent = await uploadSupportScreenshot(db, actor(ana, 'owner'), png, shots());
    const unsent = await uploadSupportScreenshot(db, actor(ana, 'owner'), png, shots());
    await openSupportThread(
      db,
      actor(ana, 'owner'),
      { kind: 'problem', message: 'Look', screenshotIds: [sent.id] },
      meta,
      options,
    );
    const data = await withTenant(db, tenant, readBusinessExport);
    const ids = data.support.screenshots.map((s) => s.id);
    expect(ids).toContain(sent.id);
    expect(ids).not.toContain(unsent.id);
    const images = await readScreenshotsForExport(tenant, data.support.screenshots, store);
    expect(images.get(sent.id)).toEqual(Uint8Array.of(8, 0, 0));
    expect(await readScreenshotsForExport(tenant, data.support.screenshots, null)).toEqual(
      new Map(),
    );
    expect(await deleteAllSupportScreenshotImages(db, tenant, store)).toBeGreaterThanOrEqual(2);
    expect(store.has(tenant, sent.id, 800)).toBe(false);
    expect(store.has(tenant, unsent.id, 480)).toBe(false);
    // A store that fails keeps the business for the next pass.
    store.failDeletes = true;
    await expect(deleteAllSupportScreenshotImages(db, tenant, store)).rejects.toThrow('store down');
    await expect(deleteAllSupportScreenshotImages(db, tenant, null)).rejects.toThrow(
      'No object store',
    );
  });
});
