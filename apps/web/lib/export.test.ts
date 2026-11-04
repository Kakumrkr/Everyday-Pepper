import { describe, expect, it } from 'vitest';
import { EXPORT_PATH, fetchExport, fileNameOf } from './export';

// The export's download (S51, AC-W1-37): the file under the api's name, and each refusal said.

const answering = (response: Response | Error) => {
  const calls: string[] = [];
  const fetch = ((path: string) => {
    calls.push(path);
    return response instanceof Error ? Promise.reject(response) : Promise.resolve(response);
  }) as typeof globalThis.fetch;
  return { fetch, calls };
};

describe('fileNameOf', () => {
  it('takes a plain name, and falls back for anything else', () => {
    expect(fileNameOf('attachment; filename="pepper-export-fade-2099-03-10.zip"')).toBe(
      'pepper-export-fade-2099-03-10.zip',
    );
    expect(fileNameOf(null)).toBe('pepper-export.zip');
    expect(fileNameOf('attachment; filename="../../etc/passwd"')).toBe('pepper-export.zip');
  });
});

describe('fetchExport', () => {
  it('gives the ZIP with its name', async () => {
    const { fetch, calls } = answering(
      new Response(new Uint8Array([1, 2, 3]), {
        headers: {
          'content-type': 'application/zip',
          'content-disposition': 'attachment; filename="pepper-export-fade-2099-03-10.zip"',
        },
      }),
    );
    const result = await fetchExport(fetch);
    expect(calls).toEqual([EXPORT_PATH]);
    if (!result.ok) throw new Error(result.message);
    expect(result.data.name).toBe('pepper-export-fade-2099-03-10.zip');
    expect(result.data.file.size).toBe(3);
  });

  it.each([
    [429, 'You’ve downloaded it a few times this hour. Try again in a little while.'],
    [403, 'Only the owner can download the business’s data.'],
    [500, 'Something went wrong. Try again.'],
  ])('says what a %i means', async (status, message) => {
    const { fetch } = answering(Response.json({ code: 'x' }, { status }));
    expect(await fetchExport(fetch)).toMatchObject({ ok: false, status, message });
  });

  it('says when the phone is offline', async () => {
    const { fetch } = answering(new TypeError('Failed to fetch'));
    expect(await fetchExport(fetch)).toMatchObject({ ok: false, status: 0 });
  });
});
