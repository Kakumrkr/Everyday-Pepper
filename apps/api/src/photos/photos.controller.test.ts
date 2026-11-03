import 'reflect-metadata';
import type { IncomingHttpHeaders, Server } from 'node:http';
import { GalleryFullError, PhotoNotFoundError } from '@pepper/appointments';
import {
  ApiErrorSchema,
  BusinessPhotoIdSchema,
  BusinessPhotoSchema,
  TenantIdSchema,
  UserIdSchema,
  UtcDateTimeSchema,
  type BusinessPhoto,
  type MembershipRole,
} from '@pepper/contracts';
import { DATABASE } from '@pepper/runtime';
import { ImageRejectedError } from '@pepper/storage';
import {
  Global,
  HttpException,
  HttpStatus,
  Module,
  ServiceUnavailableException,
  type INestApplication,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { TenancyService } from '../account/tenancy.service.js';
import { AuthModule } from '../auth/auth.module.js';
import { AuthService, type AuthSession } from '../auth/auth.service.js';
import { apiError } from '../auth/guards.js';
import { RateLimiter, type RateLimit } from '../http/rate-limit.js';
import { PhotosModule } from './photos.module.js';
import { PhotosService } from './photos.service.js';

const ORIGIN = 'http://localhost:3000';
const TENANT = TenantIdSchema.parse('0199f0a4-7c1e-7d2a-9b3c-4d5e6f708192');
const USER = UserIdSchema.parse('0199f0a4-7c1e-7d2a-9b3c-4d5e6f708193');
const PHOTO_ID = BusinessPhotoIdSchema.parse('0199f0a4-7c1e-7d2a-9b3c-4d5e6f708194');
const PHOTO: BusinessPhoto = {
  id: PHOTO_ID,
  kind: 'cover',
  widths: [640, 1280],
  width: 1600,
  height: 900,
  caption: null,
  createdAt: UtcDateTimeSchema.parse('2026-11-02T12:00:00.000Z'),
};
const IMAGE = new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 2, 3]);

class FakeAuth extends AuthService {
  session: AuthSession = {
    id: 'session-1',
    user: { id: USER, name: 'Ana', email: 'ana@example.test', twoFactorEnabled: true },
    activeTenantId: TENANT,
  };
  readonly setActiveTenant = vi.fn(() => Promise.resolve());
  handle = vi.fn(() => Promise.resolve());
  getSession(headers: IncomingHttpHeaders): Promise<AuthSession | null> {
    return Promise.resolve(headers.cookie === 'signed-in' ? this.session : null);
  }
}

let role: MembershipRole = 'owner';
const tenancy = { roleIn: vi.fn(() => Promise.resolve(role)) };
const photos = {
  list: vi.fn(() => Promise.resolve({ logo: null, cover: PHOTO, gallery: [] })),
  add: vi.fn((): Promise<BusinessPhoto> => Promise.resolve(PHOTO)),
  caption: vi.fn((): Promise<BusinessPhoto> => Promise.resolve({ ...PHOTO, caption: 'Fade' })),
  remove: vi.fn(() => Promise.resolve()),
  image: vi.fn((): Promise<Uint8Array | null> => Promise.resolve(IMAGE)),
  storage: vi.fn(() => ({})),
};
const hits: { limit: string; key: string }[] = [];
let overLimit: string | null = null;
const limiter = {
  hit: vi.fn((limit: RateLimit, key: string) => {
    hits.push({ limit: limit.name, key });
    if (limit.name !== overLimit) return Promise.resolve();
    return Promise.reject(
      new HttpException(apiError('too_many_requests'), HttpStatus.TOO_MANY_REQUESTS),
    );
  }),
};

@Global()
@Module({ providers: [{ provide: DATABASE, useValue: { db: {} } }], exports: [DATABASE] })
class FakeConnectionsModule {}

let app: INestApplication;
let server: Server;

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({
    imports: [
      FakeConnectionsModule,
      AuthModule.forRoot({ baseUrl: ORIGIN, secret: 'x'.repeat(32) }),
      PhotosModule.forRoot(null),
    ],
  })
    .overrideProvider(AuthService)
    .useValue(new FakeAuth())
    .overrideProvider(TenancyService)
    .useValue(tenancy)
    .overrideProvider(PhotosService)
    .useValue(photos)
    .overrideProvider(RateLimiter)
    .useValue(limiter)
    .compile();
  app = moduleRef.createNestApplication({ logger: false });
  await app.init();
  server = app.getHttpServer() as Server;
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  vi.clearAllMocks();
  role = 'owner';
  hits.length = 0;
  overLimit = null;
});

const context = () => ({ tenantId: TENANT, userId: USER, role });
const upload = (kind: string, type = 'image/jpeg') =>
  request(server)
    .post(`/v1/tenant/photos?kind=${kind}`)
    .set('cookie', 'signed-in')
    .set('origin', ORIGIN)
    .set('content-type', type)
    .send(Buffer.from(IMAGE));

function code(body: unknown): string {
  return ApiErrorSchema.parse(body).code;
}

describe('/v1/tenant/photos (AC-W8-10/11)', () => {
  it.each<MembershipRole>(['owner', 'manager'])('a(n) %s lists the photos', async (r) => {
    role = r;
    const response = await request(server)
      .get('/v1/tenant/photos')
      .set('cookie', 'signed-in')
      .expect(200);
    expect(response.body).toEqual({ logo: null, cover: PHOTO, gallery: [] });
    expect(photos.list).toHaveBeenCalledWith(context());
  });

  it('403 for staff, 401 signed out', async () => {
    role = 'staff';
    const forbidden = await request(server).get('/v1/tenant/photos').set('cookie', 'signed-in');
    expect([forbidden.status, code(forbidden.body)]).toEqual([403, 'forbidden']);
    expect(photos.list).not.toHaveBeenCalled();
    await request(server).get('/v1/tenant/photos').expect(401);
  });

  it('uploads the body as the image, counted per member', async () => {
    const response = await upload('cover').expect(201);
    expect(BusinessPhotoSchema.parse(response.body)).toEqual(PHOTO);
    expect(photos.add).toHaveBeenCalledWith(context(), 'cover', Buffer.from(IMAGE));
    expect(hits).toEqual([{ limit: 'photo-upload', key: USER }]);
  });

  it('refuses an unknown kind and a body that is not an image, storing nothing', async () => {
    expect((await upload('banner').expect(400)).body).toMatchObject({ code: 'validation_failed' });
    expect(code((await upload('cover', 'text/plain').expect(415)).body)).toBe('photo_rejected');
    expect(photos.add).not.toHaveBeenCalled();
  });

  it('503 storage_unavailable before reading the body or counting it', async () => {
    photos.storage.mockImplementationOnce(() => {
      throw new ServiceUnavailableException(apiError('storage_unavailable'));
    });
    expect(code((await upload('logo').expect(503)).body)).toBe('storage_unavailable');
    expect(hits).toEqual([]);
    expect(photos.add).not.toHaveBeenCalled();
  });

  it('429 over the upload limit, and the domain’s refusals with their codes', async () => {
    overLimit = 'photo-upload';
    expect(code((await upload('gallery').expect(429)).body)).toBe('too_many_requests');
    overLimit = null;
    photos.add.mockRejectedValueOnce(new GalleryFullError());
    expect(code((await upload('gallery').expect(409)).body)).toBe('gallery_full');
    photos.add.mockRejectedValueOnce(new ImageRejectedError('too_small', 'Use a bigger photo.'));
    expect((await upload('gallery').expect(422)).body).toEqual({
      code: 'photo_rejected',
      message: 'Use a bigger photo.',
      reason: 'too_small',
    });
  });

  it('sets a caption, and removes a photo with 204', async () => {
    const patched = await request(server)
      .patch(`/v1/tenant/photos/${PHOTO_ID}`)
      .set('cookie', 'signed-in')
      .set('origin', ORIGIN)
      .send({ caption: 'Fade' })
      .expect(200);
    expect(patched.body).toMatchObject({ caption: 'Fade' });
    expect(photos.caption).toHaveBeenCalledWith(context(), PHOTO_ID, 'Fade');
    await request(server)
      .delete(`/v1/tenant/photos/${PHOTO_ID}`)
      .set('cookie', 'signed-in')
      .set('origin', ORIGIN)
      .expect(204);
    expect(photos.remove).toHaveBeenCalledWith(context(), PHOTO_ID);
  });

  it('404 photo_not_found for a photo that isn’t the business’s', async () => {
    photos.remove.mockRejectedValueOnce(new PhotoNotFoundError());
    const response = await request(server)
      .delete('/v1/tenant/photos/not-an-id')
      .set('cookie', 'signed-in')
      .set('origin', ORIGIN)
      .expect(404);
    expect(code(response.body)).toBe('photo_not_found');
  });
});

describe('the booking page’s images (AC-W8-12)', () => {
  const path = `/v1/public/businesses/juniper/photos/${PHOTO_ID}`;

  it('serves a width as an immutable WebP, locked down, counted per address', async () => {
    const response = await request(server)
      .get(`${path}/640`)
      .set('x-forwarded-for', '203.0.113.7')
      .buffer(true)
      .parse((res, done) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          done(null, Buffer.concat(chunks));
        });
      })
      .expect(200);
    expect(new Uint8Array(response.body as Buffer)).toEqual(IMAGE);
    expect(response.headers).toMatchObject({
      'content-type': 'image/webp',
      'content-length': String(IMAGE.byteLength),
      'cache-control': 'public, max-age=31536000, immutable',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'",
      'cross-origin-resource-policy': 'same-origin',
    });
    expect(photos.image).toHaveBeenCalledWith('juniper', PHOTO_ID, 640);
    expect(hits).toEqual([{ limit: 'photo-read', key: '203.0.113.7' }]);
  });

  it.each([
    ['a width the image never has', `${path}/1921`],
    ['a width that is not a number', `${path}/wide`],
    ['a page name that cannot be one', `/v1/public/businesses/NO%20PAGE/photos/${PHOTO_ID}/640`],
  ])('404 photo_not_found for %s, without asking', async (_label, url) => {
    expect(code((await request(server).get(url).expect(404)).body)).toBe('photo_not_found');
    expect(photos.image).not.toHaveBeenCalled();
  });

  it('404 photo_not_found when the page, photo or width isn’t there', async () => {
    photos.image.mockResolvedValueOnce(null);
    const response = await request(server).get(`${path}/320`).expect(404);
    expect(code(response.body)).toBe('photo_not_found');
  });
});
