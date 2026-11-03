import { TenantIdSchema, type TenantId } from '@pepper/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from './client.js';
import { newId } from './ids.js';
import {
  countBusinessPhotos,
  deleteBusinessPhoto,
  deleteBusinessPhotosOfKind,
  findBusinessPhoto,
  insertBusinessPhoto,
  listBusinessPhotos,
  lockBusinessPhotos,
  updateBusinessPhotoCaption,
  type NewBusinessPhoto,
} from './repositories/business-photos.js';
import { createTenant } from './repositories/tenants.js';
import { withTenant } from './tenant.js';
import { sqlState, startTestDatabase, type TestDatabase } from './test-support.js';

// Booking page photos against real Postgres (S47.2, ADR-0048). Cross-tenant isolation of the
// table is in isolation.int.test.ts.

let database: TestDatabase;
let db: Database;
let tenant: TenantId;

const photo = (overrides: Partial<NewBusinessPhoto> = {}): NewBusinessPhoto => ({
  id: newId(),
  kind: 'gallery',
  widths: [320, 640],
  width: 900,
  height: 600,
  caption: null,
  ...overrides,
});

beforeAll(async () => {
  database = await startTestDatabase();
  db = database.app.db;
  const created = await createTenant(db, {
    name: 'Fade Lab',
    slug: 'fade-lab',
    timeZone: 'America/New_York',
  });
  tenant = TenantIdSchema.parse(created.id);
});

afterAll(async () => {
  await database.stop();
});

describe('business photos (S47.2)', () => {
  it('stores, lists oldest first, captions and deletes', async () => {
    await withTenant(db, tenant, async (tx) => {
      const first = await insertBusinessPhoto(tx, photo({ caption: 'Low taper' }));
      const second = await insertBusinessPhoto(tx, photo());
      expect((await listBusinessPhotos(tx)).map((row) => row.id)).toEqual([first.id, second.id]);
      expect(await countBusinessPhotos(tx, 'gallery')).toBe(2);
      expect((await updateBusinessPhotoCaption(tx, second.id, 'Beard'))?.caption).toBe('Beard');
      expect((await deleteBusinessPhoto(tx, first.id))?.id).toBe(first.id);
      expect(await findBusinessPhoto(tx, first.id)).toBeUndefined();
      expect(await deleteBusinessPhoto(tx, first.id)).toBeUndefined();
      await deleteBusinessPhoto(tx, second.id);
    });
  });

  it('keeps one logo and one cover per business', async () => {
    await withTenant(db, tenant, async (tx) => {
      await insertBusinessPhoto(tx, photo({ kind: 'logo', widths: [128] }));
      await insertBusinessPhoto(tx, photo({ kind: 'cover' }));
      await lockBusinessPhotos(tx);
      expect((await deleteBusinessPhotosOfKind(tx, 'logo')).length).toBe(1);
      await insertBusinessPhoto(tx, photo({ kind: 'logo', widths: [128] }));
      expect(await countBusinessPhotos(tx, 'logo')).toBe(1);
    });
    const error = await withTenant(db, tenant, (tx) =>
      insertBusinessPhoto(tx, photo({ kind: 'cover' })),
    ).catch((caught: unknown) => caught);
    expect(sqlState(error)).toBe('23505');
  });

  it('refuses an unknown kind, odd widths and long captions in the database too', async () => {
    const insertRaw = (values: string) =>
      withTenant(db, tenant, (tx) =>
        tx.execute(
          `INSERT INTO business_photos (id, kind, widths, width, height, caption) VALUES (gen_random_uuid(), ${values})`,
        ),
      ).catch((caught: unknown) => caught);
    expect(sqlState(await insertRaw("'avatar', '{320}', 10, 10, NULL"))).toBe('23514');
    expect(sqlState(await insertRaw("'gallery', '{}', 10, 10, NULL"))).toBe('23514');
    expect(sqlState(await insertRaw("'gallery', '{4000}', 10, 10, NULL"))).toBe('23514');
    expect(sqlState(await insertRaw("'gallery', '{320,640,960,1280}', 10, 10, NULL"))).toBe(
      '23514',
    );
    expect(sqlState(await insertRaw(`'gallery', '{320}', 10, 10, '${'x'.repeat(151)}'`))).toBe(
      '23514',
    );
    expect(sqlState(await insertRaw("'gallery', '{320}', 10, 10, ''"))).toBe('23514');
    await expect(
      withTenant(db, tenant, (tx) => insertBusinessPhoto(tx, photo({ caption: 'x'.repeat(151) }))),
    ).rejects.toThrow('Caption too long');
  });
});
