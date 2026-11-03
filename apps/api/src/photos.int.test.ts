import 'reflect-metadata';
import type { Server } from 'node:http';
import { Writable } from 'node:stream';
import {
  BusinessPhotoSchema,
  BusinessPhotosSchema,
  photoPath,
  PublicBusinessSchema,
  TenantIdSchema,
  UserIdSchema,
} from '@pepper/contracts';
import { addMembership, newId, prepareDatabase, withTenant, type DatabaseHandle } from '@pepper/db';
import { createLogger, createServiceApp, DATABASE } from '@pepper/runtime';
import { solidColorPhoto } from '@pepper/storage';
import {
  postgresUrlAs,
  startPostgres,
  startRedis,
  startSeaweedFs,
  totpCodeFromUri,
  type TestObjectStorage,
  type TestService,
} from '@pepper/testing';
import type { INestApplication } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import sharp from 'sharp';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from './app.module.js';
import { loadApiConfig } from './config.js';

// Booking page photos through the api against real Postgres, Redis and SeaweedFS (S47.2,
// ADR-0048, AC-W8-10…12): the owner's uploads checked and remade, the page's images from the
// app's origin with immutable caching, staff refused, one business's photo never through
// another's page.

const ORIGIN = 'http://localhost:3000';
const PASSWORD = 'correct horse battery staple';

let postgres: TestService;
let redis: TestService;
let storage: TestObjectStorage;
let app: INestApplication;
let server: Server;
let database: DatabaseHandle;
let ipCounter = 0;
let emailCounter = 0;

beforeAll(async () => {
  [postgres, redis, storage] = await Promise.all([startPostgres(), startRedis(), startSeaweedFs()]);
  const databaseUrl = postgresUrlAs(postgres.url, 'pepper_service', 'test-password');
  await prepareDatabase(postgres.url, databaseUrl);
  const config = loadApiConfig({
    DATABASE_URL: databaseUrl,
    REDIS_URL: redis.url,
    AUTH_SECRET: 'an-integration-test-secret-32-chars',
    OUTBOX_SECRET: 'an-integration-test-outbox-secret-32+',
    AUTH_BASE_URL: ORIGIN,
    LOG_LEVEL: 'warn',
    S3_ENDPOINT: storage.endpoint,
    S3_BUCKET: 'pepper-photos-test',
    S3_ACCESS_KEY_ID: storage.accessKeyId,
    S3_SECRET_ACCESS_KEY: storage.secretAccessKey,
  });
  const sink = new Writable({
    write(_chunk, _encoding, done) {
      done();
    },
  });
  app = await createServiceApp(AppModule.forRoot(config), config, {
    logger: createLogger(config, sink),
  });
  await app.init();
  server = app.getHttpServer() as Server;
  database = app.get<DatabaseHandle>(DATABASE);
}, 180_000);

afterAll(async () => {
  await app.close();
  await Promise.all([postgres.stop(), redis.stop(), storage.stop()]);
});

function browser() {
  const agent = request.agent(server);
  ipCounter += 1;
  const ip = `198.51.100.${String(ipCounter)}`;
  const send = <T extends request.Test>(test: T): T =>
    test.set('origin', ORIGIN).set('x-forwarded-for', ip);
  return {
    get: (path: string) => send(agent.get(path)),
    post: (path: string, body: object = {}) => send(agent.post(path)).send(body),
    put: (path: string, body: object) => send(agent.put(path)).send(body),
    patch: (path: string, body: object) => send(agent.patch(path)).send(body),
    delete: (path: string) => send(agent.delete(path)),
    upload: (kind: string, bytes: Buffer, type = 'image/jpeg') =>
      send(agent.post(`/v1/tenant/photos?kind=${kind}`))
        .set('content-type', type)
        .send(bytes),
  };
}
type Browser = ReturnType<typeof browser>;

async function signUp(name: string): Promise<{ browser: Browser; userId: string }> {
  const b = browser();
  emailCounter += 1;
  const email = `${name.split(' ')[0]?.toLowerCase() ?? 'member'}.${String(emailCounter)}@example.test`;
  const response = await b
    .post('/api/auth/sign-up/email', { name, email, password: PASSWORD })
    .expect(200);
  const userId = (response.body as { user: { id: string } }).user.id;
  await database.db.execute(sql`UPDATE users SET email_verified = true WHERE id = ${userId}`);
  await b.post('/api/auth/sign-in/email', { email, password: PASSWORD }).expect(200);
  return { browser: b, userId };
}

/** An owner with a business and a second factor, and a staff member of it. */
async function business() {
  const owner = await signUp('Ana Reyes');
  const slug = `fade-${newId().slice(-8)}`;
  const created = await owner.browser
    .post('/v1/tenants', { name: 'Fade Lab', timeZone: 'America/New_York', slug })
    .expect(201);
  const tenantId = TenantIdSchema.parse((created.body as { id: string }).id);
  const enabled = await owner.browser
    .post('/api/auth/two-factor/enable', { password: PASSWORD })
    .expect(200);
  const { totpURI } = enabled.body as { totpURI: string };
  await owner.browser
    .post('/api/auth/two-factor/verify-totp', { code: totpCodeFromUri(totpURI) })
    .expect(200);
  const staff = await signUp('Jess Moreno');
  await withTenant(database.db, tenantId, (tx) =>
    addMembership(tx, { userId: UserIdSchema.parse(staff.userId), role: 'staff' }),
  );
  await staff.browser.put('/v1/me/active-tenant', { tenantId }).expect(204);
  return { slug, owner: owner.browser, staff: staff.browser };
}

describe('photos through the api (S47.2)', () => {
  it('uploads a cover, captions it and serves it on the page with immutable caching', async () => {
    const b = await business();
    // A photo with a location in its metadata and a quarter-turn orientation.
    const tagged = await sharp(await solidColorPhoto(1400, 900))
      .withExif({ IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '40/1 44/1 0/1' } })
      .withMetadata({ orientation: 6 })
      .jpeg()
      .toBuffer();
    const added = await b.owner.upload('cover', tagged).expect(201);
    const cover = BusinessPhotoSchema.parse(added.body);
    expect(cover).toMatchObject({ kind: 'cover', width: 900, height: 1400, widths: [640, 900] });

    await b.owner.patch(`/v1/tenant/photos/${cover.id}`, { caption: 'The shop' }).expect(200);
    const listed = BusinessPhotosSchema.parse(
      (await b.owner.get('/v1/tenant/photos').expect(200)).body,
    );
    expect(listed.cover).toMatchObject({ id: cover.id, caption: 'The shop' });

    const page = PublicBusinessSchema.parse(
      (await browser().get(`/v1/public/businesses/${b.slug}`).expect(200)).body,
    );
    expect(page.photos.cover).toMatchObject({ id: cover.id, caption: 'The shop' });

    const image = await browser()
      .get(photoPath(b.slug, cover.id, 640))
      .buffer(true)
      .parse((response, done) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => {
          done(null, Buffer.concat(chunks));
        });
      })
      .expect(200);
    expect(image.headers['content-type']).toBe('image/webp');
    expect(image.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(image.headers['x-content-type-options']).toBe('nosniff');
    expect(image.headers['content-security-policy']).toBe("default-src 'none'");
    const meta = await sharp(image.body as Buffer).metadata();
    expect(meta).toMatchObject({ format: 'webp', width: 640 });
    expect(meta.exif).toBeUndefined();
    // A width it was not kept at is not served.
    await browser()
      .get(photoPath(b.slug, cover.id, 700))
      .expect(404);
  });

  it('refuses what is not a usable photo, saying what to fix', async () => {
    const b = await business();
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="900" height="900"/>');
    const refused = await b.owner.upload('gallery', svg, 'image/jpeg').expect(415);
    expect(refused.body).toMatchObject({ code: 'photo_rejected', reason: 'unsupported_type' });
    const small = await b.owner.upload('cover', await solidColorPhoto(800, 500)).expect(422);
    expect(small.body).toMatchObject({ code: 'photo_rejected', reason: 'too_small' });
    expect((small.body as { message: string }).message).toContain('600 px');
    await b.owner.upload('logo', Buffer.alloc(10 * 1024 * 1024 + 1)).expect(413);
    await b.owner.post('/v1/tenant/photos?kind=logo', { image: 'base64…' }).expect(415);
    await b.owner.upload('avatar', await solidColorPhoto(300, 300)).expect(400);
    expect(BusinessPhotosSchema.parse((await b.owner.get('/v1/tenant/photos')).body)).toEqual({
      logo: null,
      cover: null,
      gallery: [],
    });
  });

  it('lets staff change nothing, and keeps each business’s photos to its own page', async () => {
    const a = await business();
    const other = await business();
    await a.staff.upload('logo', await solidColorPhoto(300, 300)).expect(403);
    await a.staff.get('/v1/tenant/photos').expect(403);
    const logo = BusinessPhotoSchema.parse(
      (
        await a.owner
          .upload('logo', await solidColorPhoto(300, 300, 'png'), 'image/png')
          .expect(201)
      ).body,
    );
    await a.staff.delete(`/v1/tenant/photos/${logo.id}`).expect(403);
    await other.owner.delete(`/v1/tenant/photos/${logo.id}`).expect(404);
    await other.owner.patch(`/v1/tenant/photos/${logo.id}`, { caption: 'x' }).expect(404);
    await browser()
      .get(photoPath(other.slug, logo.id, 128))
      .expect(404);
    await browser()
      .get(photoPath(a.slug, logo.id, 128))
      .expect(200);
    await browser()
      .get(photoPath(a.slug, 'not-an-id', 128))
      .expect(404);
    await browser()
      .get(photoPath('No Such Page', logo.id, 128))
      .expect(404);
    // Removing it deletes its images too.
    await a.owner.delete(`/v1/tenant/photos/${logo.id}`).expect(204);
    await browser()
      .get(photoPath(a.slug, logo.id, 128))
      .expect(404);
  });

  it('needs the app’s origin to upload', async () => {
    const b = await business();
    const agent = request(server);
    await agent
      .post('/v1/tenant/photos?kind=logo')
      .set('origin', 'https://evil.example')
      .set('content-type', 'image/jpeg')
      .send(await solidColorPhoto(300, 300))
      .expect(403);
    expect(b.slug).toBeDefined();
  });
});
