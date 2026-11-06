import 'reflect-metadata';
import {
  ImportBatchIdSchema,
  TenantIdSchema,
  UserIdSchema,
  type ImportPreview,
} from '@pepper/contracts';
import { systemClock, type TenantContext } from '@pepper/core';
import type { Database } from '@pepper/db';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatOptions } from './chat.service.js';

// The suggestions service with the domain replaced (S56a.2, AC-W1-47): without a model, or
// when the model fails, the import comes back unchanged as an outcome, never an error; the
// path with a model runs against real Postgres in imports.int.test.ts.

const imports = vi.hoisted(() => ({ getImport: vi.fn() }));
const ai = vi.hoisted(() => ({ suggestImportColumns: vi.fn() }));
vi.mock('@pepper/imports', async (original) => ({
  ...(await original<object>()),
  getImport: imports.getImport,
}));
vi.mock('@pepper/ai', async (original) => ({
  ...(await original<object>()),
  suggestImportColumns: ai.suggestImportColumns,
}));

const { LlmError, ScriptedProvider } = await import('@pepper/ai');
const { ImportSuggestionsService } = await import('./import-suggestions.controller.js');

const TENANT: TenantContext = {
  tenantId: TenantIdSchema.parse('0199f0a4-7c1e-7d2a-9b3c-4d5e6f708192'),
  userId: UserIdSchema.parse('0199f0a4-7c1e-7d2a-9b3c-4d5e6f708193'),
  role: 'owner',
};
const ID = ImportBatchIdSchema.parse('0199f0a4-7c1e-7d2a-9b3c-4d5e6f708194');
const PREVIEW = { batch: { id: ID }, rows: [] } as unknown as ImportPreview;
const OPTIONS = { monthlyTokens: 1_000_000 } as ChatOptions;
const db = { db: {} as Database };

beforeEach(() => {
  imports.getImport.mockReset().mockResolvedValue(PREVIEW);
  ai.suggestImportColumns.mockReset();
});

describe('ImportSuggestionsService', () => {
  it('answers "ai_off" without a model, and asks nothing', async () => {
    const service = new ImportSuggestionsService(db, null, OPTIONS, systemClock);
    expect(await service.suggest(TENANT, ID)).toEqual({ outcome: 'ai_off', preview: PREVIEW });
    expect(ai.suggestImportColumns).not.toHaveBeenCalled();
  });

  it('answers "unavailable" when the model fails, and throws anything else', async () => {
    const service = new ImportSuggestionsService(
      db,
      new ScriptedProvider([]),
      OPTIONS,
      systemClock,
    );
    ai.suggestImportColumns.mockRejectedValueOnce(new LlmError('timeout', 'slow'));
    expect(await service.suggest(TENANT, ID)).toEqual({
      outcome: 'unavailable',
      preview: PREVIEW,
    });
    ai.suggestImportColumns.mockRejectedValueOnce(new Error('boom'));
    await expect(service.suggest(TENANT, ID)).rejects.toThrow('boom');
  });
});
