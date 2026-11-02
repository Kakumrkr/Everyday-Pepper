import {
  MAX_GALLERY_PHOTOS,
  TenantIdSchema,
  TenantSlugSchema,
  type TenantId,
  type UserId,
} from '@pepper/contracts';
import { createBusiness, ForbiddenError, type Actor } from '@pepper/core';
import { addMembership, listAuditEntries, newId, withTenant, type Database } from '@pepper/db';
import {
  ImageRejectedError,
  MemoryObjectStore,
  solidColorPhoto,
  type ObjectStore,
} from '@pepper/storage';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GalleryFullError, PhotoNotFoundError } from './errors.js';
import {
  addPhoto,
  changePhotoCaption,
  listPhotos,
  readPagePhoto,
  removePhoto,
} from './services/business-photos.js';
import { getPublicBusiness } from './services/public-booking.js';
import { insertUser, startTestDatabase, type TestDatabase } from './test-support.js';

// The booking page's photos (S47.2, ADR-0048, AC-W8-10…12) against real Postgres, with the
// in-memory object store (the S3 adapter's own contract test runs against SeaweedFS).

let database: TestDatabase;
let db: Database;
let slugs = 0;
let jpeg: Buffer;

beforeAll(async () => {
  database = await startTestDatabase();
  db = database.app.db;
  jpeg = await solidColorPhoto(900, 700);
});

afterAll(async () => {
  await database.stop();
});

async function newBusiness() {
  slugs += 1;
  const slug = TenantSlugSchema.parse(`photos-${String(slugs)}`);
  const ownerId = await insertUser(db, 'Ana');
  const tenant = await createBusiness(db, ownerId, {
    name: 'Fade Lab',
    slug,
    timeZone: 'America/New_York',
  });
  const tenantId: TenantId = TenantIdSchema.parse(tenant.id);
  const actor = (userId: UserId, role: 'owner' | 'manager' | 'staff'): Actor => ({
    context: { tenantId, userId, role },
    requestId: `req-${role}`,
  });
  const [managerId, staffId] = [await insertUser(db, 'Marco'), await insertUser(db, 'Jess')];
  await withTenant(db, tenantId, async (tx) => {
    await addMembership(tx, { userId: managerId, role: 'manager' });
    await addMembership(tx, { userId: staffId, role: 'staff' });
  });
  const store = new MemoryObjectStore();
  return {
    slug,
    tenantId,
    store,
    owner: actor(ownerId, 'owner'),
    manager: actor(managerId, 'manager'),
    staff: actor(staffId, 'staff'),
  };
}

async function auditActions(tenantId: TenantId): Promise<string[]> {
  return withTenant(db, tenantId, async (tx) =>
    (await listAuditEntries(tx, { limit: 100 }))
      .map((entry) => entry.action)
      .filter((action) => action.startsWith('business_photo.'))
      .reverse(),
  );
}

describe('booking page photos (AC-W8-10)', () => {
  it('adds a logo and a cover, stores each width, and shows them on the page', async () => {
    const b = await newBusiness();
    const logo = await addPhoto(db, b.owner, { kind: 'logo', bytes: jpeg }, { store: b.store });
    expect(logo).toMatchObject({ kind: 'logo', widths: [128, 256], width: 900, height: 700 });
    const cover = await addPhoto(
      db,
      b.manager,
      { kind: 'cover', bytes: jpeg, caption: ' The shop on Main ' },
      { store: b.store },
    );
    expect(cover).toMatchObject({ kind: 'cover', widths: [640, 900], caption: 'The shop on Main' });
    expect(b.store.keys()).toEqual(
      [
        ...logo.widths.map((w) => `tenants/${b.tenantId}/photos/${logo.id}/${String(w)}.webp`),
        ...cover.widths.map((w) => `tenants/${b.tenantId}/photos/${cover.id}/${String(w)}.webp`),
      ].sort(),
    );
    const page = await getPublicBusiness(db, b.slug);
    expect(page.photos).toEqual({
      logo: { id: logo.id, widths: [128, 256], width: 900, height: 700, caption: null },
      cover: {
        id: cover.id,
        widths: [640, 900],
        width: 900,
        height: 700,
        caption: 'The shop on Main',
      },
      gallery: [],
    });
    expect(await auditActions(b.tenantId)).toEqual([
      'business_photo.added',
      'business_photo.added',
    ]);
  });

  it('replaces the logo, deleting the old images after the new row is in', async () => {
    const b = await newBusiness();
    const first = await addPhoto(db, b.owner, { kind: 'logo', bytes: jpeg }, { store: b.store });
    const second = await addPhoto(db, b.owner, { kind: 'logo', bytes: jpeg }, { store: b.store });
    expect((await listPhotos(db, b.owner)).logo?.id).toBe(second.id);
    expect(b.store.keys().some((key) => key.includes(first.id))).toBe(false);
    expect(b.store.keys().filter((key) => key.includes(second.id))).toHaveLength(2);
    expect(await auditActions(b.tenantId)).toEqual([
      'business_photo.added',
      'business_photo.removed',
      'business_photo.added',
    ]);
  });

  it('refuses a file that is not a usable photo and stores nothing', async () => {
    const b = await newBusiness();
    await expect(
      addPhoto(db, b.owner, { kind: 'cover', bytes: Buffer.from('<svg/>') }, { store: b.store }),
    ).rejects.toBeInstanceOf(ImageRejectedError);
    await expect(
      addPhoto(
        db,
        b.owner,
        { kind: 'cover', bytes: await solidColorPhoto(800, 400) },
        { store: b.store },
      ),
    ).rejects.toMatchObject({ reason: 'too_small' });
    expect(b.store.keys()).toEqual([]);
    expect((await listPhotos(db, b.owner)).cover).toBeNull();
  });

  it('lets staff change nothing and see nothing here', async () => {
    const b = await newBusiness();
    await expect(
      addPhoto(db, b.staff, { kind: 'logo', bytes: jpeg }, { store: b.store }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(listPhotos(db, b.staff)).rejects.toBeInstanceOf(ForbiddenError);
    const logo = await addPhoto(db, b.owner, { kind: 'logo', bytes: jpeg }, { store: b.store });
    await expect(changePhotoCaption(db, b.staff, logo.id, 'x')).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    await expect(removePhoto(db, b.staff, logo.id, { store: b.store })).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });

  it('deletes the stored images again when the row can’t be written', async () => {
    const b = await newBusiness();
    // A business id with no business: the images are stored, then the row's insert is refused
    // by its foreign key.
    const stranger: Actor = {
      ...b.owner,
      context: { ...b.owner.context, tenantId: TenantIdSchema.parse(newId()) },
    };
    await expect(
      addPhoto(db, stranger, { kind: 'logo', bytes: jpeg }, { store: b.store }),
    ).rejects.toThrow();
    expect(b.store.keys()).toEqual([]);
  });

  it('keeps the row when old images can’t be deleted, and says so', async () => {
    const b = await newBusiness();
    const failing: ObjectStore = {
      put: (key, body, type) => b.store.put(key, body, type),
      get: (key) => b.store.get(key),
      head: (key) => b.store.head(key),
      delete: () => Promise.reject(new Error('storage down')),
    };
    const errors: unknown[] = [];
    const options = { store: failing, onCleanupError: (error: unknown) => errors.push(error) };
    await addPhoto(db, b.owner, { kind: 'logo', bytes: jpeg }, options);
    const second = await addPhoto(db, b.owner, { kind: 'logo', bytes: jpeg }, options);
    expect((await listPhotos(db, b.owner)).logo?.id).toBe(second.id);
    expect(errors).toHaveLength(1);
  });
});

describe('the gallery (AC-W8-11)', () => {
  it('holds 12 photos, oldest first, refuses the 13th, and removes one with its images', async () => {
    const b = await newBusiness();
    const small = await solidColorPhoto(600, 600, 'png');
    const added = [];
    for (let i = 0; i < MAX_GALLERY_PHOTOS; i += 1) {
      added.push(
        await addPhoto(db, b.owner, { kind: 'gallery', bytes: small }, { store: b.store }),
      );
    }
    expect((await listPhotos(db, b.owner)).gallery.map((p) => p.id)).toEqual(
      added.map((p) => p.id),
    );
    await expect(
      addPhoto(db, b.owner, { kind: 'gallery', bytes: small }, { store: b.store }),
    ).rejects.toBeInstanceOf(GalleryFullError);
    const [first] = added;
    if (first === undefined) throw new Error('no photo');
    await removePhoto(db, b.owner, first.id, { store: b.store });
    expect(b.store.keys().some((key) => key.includes(first.id))).toBe(false);
    await expect(removePhoto(db, b.owner, first.id, { store: b.store })).rejects.toBeInstanceOf(
      PhotoNotFoundError,
    );
    await expect(
      addPhoto(db, b.owner, { kind: 'gallery', bytes: small }, { store: b.store }),
    ).resolves.toMatchObject({ kind: 'gallery' });
  });

  it('lets only 12 in when uploads race', async () => {
    const b = await newBusiness();
    const small = await solidColorPhoto(600, 600, 'webp');
    for (let i = 0; i < MAX_GALLERY_PHOTOS - 2; i += 1) {
      await addPhoto(db, b.owner, { kind: 'gallery', bytes: small }, { store: b.store });
    }
    const results = await Promise.allSettled(
      Array.from({ length: 4 }, () =>
        addPhoto(db, b.owner, { kind: 'gallery', bytes: small }, { store: b.store }),
      ),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(2);
    expect(
      results.filter((r) => r.status === 'rejected' && r.reason instanceof GalleryFullError),
    ).toHaveLength(2);
    expect((await listPhotos(db, b.owner)).gallery).toHaveLength(MAX_GALLERY_PHOTOS);
    // Every refused upload's images were deleted again: 12 photos, one key per width.
    const photos = (await listPhotos(db, b.owner)).gallery;
    expect(b.store.keys()).toHaveLength(photos.reduce((n, p) => n + p.widths.length, 0));
  });

  it('sets and clears a caption, auditing only whether there is one', async () => {
    const b = await newBusiness();
    const photo = await addPhoto(db, b.owner, { kind: 'gallery', bytes: jpeg }, { store: b.store });
    expect(await changePhotoCaption(db, b.manager, photo.id, ' Skin fade ')).toMatchObject({
      caption: 'Skin fade',
    });
    await changePhotoCaption(db, b.manager, photo.id, 'Skin fade');
    expect(await changePhotoCaption(db, b.manager, photo.id, '')).toMatchObject({ caption: null });
    expect(await auditActions(b.tenantId)).toEqual([
      'business_photo.added',
      'business_photo.updated',
      'business_photo.updated',
    ]);
    const entries = await withTenant(db, b.tenantId, (tx) => listAuditEntries(tx, { limit: 10 }));
    expect(JSON.stringify(entries)).not.toContain('Skin fade');
    await expect(changePhotoCaption(db, b.owner, 'not-an-id', 'x')).rejects.toBeInstanceOf(
      PhotoNotFoundError,
    );
  });
});

describe('photos on the public page (AC-W8-12)', () => {
  it('serves a listed width through the page’s own business only', async () => {
    const a = await newBusiness();
    const other = await newBusiness();
    const photo = await addPhoto(db, a.owner, { kind: 'gallery', bytes: jpeg }, { store: a.store });
    const body = await readPagePhoto(db, a.slug, photo.id, 640, a.store);
    expect(body?.byteLength).toBeGreaterThan(0);
    // Not a width it was kept at; not through another business's page; not an id at all.
    expect(await readPagePhoto(db, a.slug, photo.id, 641, a.store)).toBeNull();
    expect(await readPagePhoto(db, other.slug, photo.id, 640, a.store)).toBeNull();
    expect(await readPagePhoto(db, a.slug, 'x', 640, a.store)).toBeNull();
    expect(
      await readPagePhoto(db, TenantSlugSchema.parse('no-such-page'), photo.id, 640, a.store),
    ).toBeNull();
    // Another business can't remove or caption it either.
    await expect(removePhoto(db, other.owner, photo.id, { store: a.store })).rejects.toBeInstanceOf(
      PhotoNotFoundError,
    );
    await expect(changePhotoCaption(db, other.owner, photo.id, 'x')).rejects.toBeInstanceOf(
      PhotoNotFoundError,
    );
    expect((await getPublicBusiness(db, other.slug)).photos).toEqual({
      logo: null,
      cover: null,
      gallery: [],
    });
  });
});
