import 'reflect-metadata';
import type { IncomingHttpHeaders, Server } from 'node:http';
import {
  ApiErrorSchema,
  ImportBatchIdSchema,
  ImportPreviewSchema,
  TenantIdSchema,
  UserIdSchema,
  UtcDateTimeSchema,
  type ImportBatch,
  type ImportPreview,
  type MembershipRole,
} from '@pepper/contracts';
import {
  ImportFileError,
  ImportMappingInvalidError,
  ImportNotFoundError,
  ImportNotReadyError,
  ImportNotStagedError,
  ImportNotUndoableError,
} from '@pepper/imports';
import { DATABASE } from '@pepper/runtime';
import { Global, HttpException, HttpStatus, Module, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { TenancyService } from '../account/tenancy.service.js';
import { AuthModule } from '../auth/auth.module.js';
import { AuthService, type AuthSession } from '../auth/auth.service.js';
import { apiError } from '../auth/guards.js';
import { RateLimiter, type RateLimit } from '../http/rate-limit.js';
import { ImportsModule } from './imports.module.js';
import { ImportsService } from './imports.service.js';

// `/v1/imports` with the import service replaced (S48, ADR-0049): who may call it, how the
// file is read, and how each refusal is answered. The service runs against real Postgres in
// packages/modules/imports, and the whole path in imports.int.test.ts.

const ORIGIN = 'http://localhost:3000';
const TENANT = TenantIdSchema.parse('0199f0a4-7c1e-7d2a-9b3c-4d5e6f708192');
const USER = UserIdSchema.parse('0199f0a4-7c1e-7d2a-9b3c-4d5e6f708193');
const IMPORT_ID = ImportBatchIdSchema.parse('0199f0a4-7c1e-7d2a-9b3c-4d5e6f708194');
const BATCH: ImportBatch = {
  id: IMPORT_ID,
  status: 'staged',
  format: 'csv',
  preset: null,
  columns: [{ column: 'Name', field: 'name', by: 'header', later: null }],
  problems: [],
  counts: { rows: 1, create: 1, merge: 0, unchanged: 0, invalid: 0, skipped: 0 },
  createdAt: UtcDateTimeSchema.parse('2026-11-03T12:00:00.000Z'),
  committedAt: null,
  finishedAt: null,
  undoUntil: null,
  undoneAt: null,
  undo: null,
};
const PREVIEW: ImportPreview = {
  batch: BATCH,
  rows: [
    {
      row: 2,
      name: 'Ana',
      email: null,
      phone: null,
      outcome: 'create',
      reasons: [],
      clientId: null,
    },
  ],
};
const FILE = Buffer.from('Name\nAna\n');

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
const imports = {
  list: vi.fn(() => Promise.resolve([BATCH])),
  stage: vi.fn((): Promise<ImportPreview> => Promise.resolve(PREVIEW)),
  get: vi.fn((): Promise<ImportPreview> => Promise.resolve(PREVIEW)),
  remap: vi.fn((): Promise<ImportPreview> => Promise.resolve(PREVIEW)),
  commit: vi.fn((): Promise<ImportBatch> => Promise.resolve({ ...BATCH, status: 'queued' })),
  undo: vi.fn((): Promise<ImportBatch> => Promise.resolve({ ...BATCH, status: 'undone' })),
  discard: vi.fn(() => Promise.resolve()),
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
      ImportsModule,
    ],
  })
    .overrideProvider(AuthService)
    .useValue(new FakeAuth())
    .overrideProvider(TenancyService)
    .useValue(tenancy)
    .overrideProvider(ImportsService)
    .useValue(imports)
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
const upload = (query = '', type = 'text/csv', body: Buffer | string = FILE) =>
  request(server)
    .post(`/v1/imports${query}`)
    .set('cookie', 'signed-in')
    .set('origin', ORIGIN)
    .set('content-type', type)
    .send(body);
const post = (path: string) =>
  request(server).post(path).set('cookie', 'signed-in').set('origin', ORIGIN);

function code(body: unknown): string {
  return ApiErrorSchema.parse(body).code;
}

describe('/v1/imports (AC-W1-3, AC-W1-17…19)', () => {
  it.each<MembershipRole>(['owner', 'manager'])('a(n) %s lists imports', async (r) => {
    role = r;
    const response = await request(server)
      .get('/v1/imports')
      .set('cookie', 'signed-in')
      .expect(200);
    expect(response.body).toEqual([BATCH]);
    expect(imports.list).toHaveBeenCalledWith(context());
  });

  it('403 for staff before reading or counting the file, 401 signed out', async () => {
    role = 'staff';
    expect(code((await upload().expect(403)).body)).toBe('forbidden');
    expect(hits).toEqual([]);
    expect(imports.stage).not.toHaveBeenCalled();
    await request(server).get('/v1/imports').expect(401);
  });

  it.each([
    ['text/csv', ''],
    ['application/octet-stream', '?format=json'],
    ['application/x-ndjson', ''],
    ['text/plain; charset=utf-8', ''],
    ['application/vnd.ms-excel', ''],
  ])('stages a file sent as %s, counted per member', async (type, query) => {
    const response = await upload(query, type).expect(201);
    expect(ImportPreviewSchema.parse(response.body)).toEqual(PREVIEW);
    expect(imports.stage).toHaveBeenCalledWith(context(), FILE, query === '' ? undefined : 'json');
    expect(hits).toEqual([{ limit: 'client-import', key: USER }]);
  });

  it('refuses another type, a JSON body, an unknown format and a file over 5 MB', async () => {
    expect(code((await upload('', 'image/png').expect(415)).body)).toBe('import_rejected');
    const json = await post('/v1/imports')
      .send([{ name: 'Ana' }])
      .expect(415);
    expect(json.body).toMatchObject({ code: 'import_rejected', reason: 'unsupported_type' });
    expect((await upload('?format=xlsx').expect(400)).body).toMatchObject({
      code: 'validation_failed',
    });
    const big = Buffer.alloc(5 * 1024 * 1024 + 1, 0x41);
    expect(code((await upload('', 'text/csv', big).expect(413)).body)).toBe('import_too_large');
    expect(imports.stage).not.toHaveBeenCalled();
  });

  it('answers a file the service can’t read with its sentence, and 429 over the limit', async () => {
    imports.stage.mockRejectedValueOnce(
      new ImportFileError('too_many_rows', 'The file has more than 10,000 clients.'),
    );
    expect((await upload().expect(422)).body).toEqual({
      code: 'import_rejected',
      message: 'The file has more than 10,000 clients.',
      reason: 'too_many_rows',
    });
    imports.stage.mockRejectedValueOnce(new ImportFileError('too_large', 'Too big'));
    expect(code((await upload().expect(413)).body)).toBe('import_too_large');
    overLimit = 'client-import';
    expect(code((await upload().expect(429)).body)).toBe('too_many_requests');
  });

  it('gets, remaps, commits, undoes and discards by id', async () => {
    await request(server).get(`/v1/imports/${IMPORT_ID}`).set('cookie', 'signed-in').expect(200);
    expect(imports.get).toHaveBeenCalledWith(context(), IMPORT_ID);
    const columns = [{ column: 'Name', field: 'name' }];
    await request(server)
      .put(`/v1/imports/${IMPORT_ID}/mapping`)
      .set('cookie', 'signed-in')
      .set('origin', ORIGIN)
      .send({ columns })
      .expect(200);
    expect(imports.remap).toHaveBeenCalledWith(context(), IMPORT_ID, { columns });
    expect((await post(`/v1/imports/${IMPORT_ID}/commit`).expect(202)).body).toMatchObject({
      status: 'queued',
    });
    expect((await post(`/v1/imports/${IMPORT_ID}/undo`).expect(200)).body).toMatchObject({
      status: 'undone',
    });
    await request(server)
      .delete(`/v1/imports/${IMPORT_ID}`)
      .set('cookie', 'signed-in')
      .set('origin', ORIGIN)
      .expect(204);
    expect(imports.discard).toHaveBeenCalledWith(context(), IMPORT_ID);
  });

  it('refuses a malformed mapping, and treats a malformed id as not found', async () => {
    const bad = await request(server)
      .put(`/v1/imports/${IMPORT_ID}/mapping`)
      .set('cookie', 'signed-in')
      .set('origin', ORIGIN)
      .send({ columns: [{ column: 'Name', field: 'birthday' }] })
      .expect(400);
    expect(code(bad.body)).toBe('validation_failed');
    const missing = await request(server).get('/v1/imports/not-an-id').set('cookie', 'signed-in');
    expect([missing.status, code(missing.body)]).toEqual([404, 'import_not_found']);
    expect(imports.get).not.toHaveBeenCalled();
  });

  it('answers each refusal with its code, and the owner’s sentence where there is one', async () => {
    imports.get.mockRejectedValueOnce(new ImportNotFoundError());
    expect(
      code((await request(server).get(`/v1/imports/${IMPORT_ID}`).set('cookie', 'signed-in')).body),
    ).toBe('import_not_found');
    imports.commit.mockRejectedValueOnce(new ImportNotStagedError());
    expect(code((await post(`/v1/imports/${IMPORT_ID}/commit`).expect(409)).body)).toBe(
      'import_not_staged',
    );
    imports.commit.mockRejectedValueOnce(new ImportNotReadyError('Choose the name column.'));
    expect((await post(`/v1/imports/${IMPORT_ID}/commit`).expect(409)).body).toEqual({
      code: 'import_not_ready',
      message: 'Choose the name column.',
    });
    imports.undo.mockRejectedValueOnce(new ImportNotUndoableError('It’s already undone.'));
    expect((await post(`/v1/imports/${IMPORT_ID}/undo`).expect(409)).body).toEqual({
      code: 'import_not_undoable',
      message: 'It’s already undone.',
    });
    imports.remap.mockRejectedValueOnce(new ImportMappingInvalidError('No column “X”.'));
    const remap = await request(server)
      .put(`/v1/imports/${IMPORT_ID}/mapping`)
      .set('cookie', 'signed-in')
      .set('origin', ORIGIN)
      .send({ columns: [{ column: 'X', field: 'name' }] })
      .expect(422);
    expect(remap.body).toEqual({ code: 'import_mapping_invalid', message: 'No column “X”.' });
  });
});
