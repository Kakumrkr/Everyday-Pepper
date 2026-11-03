import { readFileSync } from 'node:fs';
import { mappingOf, suggestMapping } from './mapping.js';
import { parseImportFile } from './parse.js';
import {
  mapRows,
  planRows,
  type KnownClient,
  type MappedRow,
  type MatchIndex,
  type PlannedRow,
} from './rows.js';

// Test helpers: the fixtures, and an in-memory business that applies a plan as the service
// does (create, fill empty fields, remember external ids and row identities).

export function fixture(name: string): Buffer {
  return readFileSync(new URL(`./fixtures/${name}`, import.meta.url));
}

export class MemoryBusiness {
  readonly clients: KnownClient[] = [];
  private readonly refs = new Map<string, KnownClient>();
  private readonly hashes = new Map<string, KnownClient>();

  index(): MatchIndex {
    const byPhone = new Map<string, KnownClient[]>();
    for (const client of this.clients) {
      if (client.phone !== null)
        byPhone.set(client.phone, [...(byPhone.get(client.phone) ?? []), client]);
    }
    return {
      byExternalId: this.refs,
      byEmail: new Map(this.clients.flatMap((c) => (c.email === null ? [] : [[c.email, c]]))),
      byPhone,
      byHash: this.hashes,
    };
  }

  apply(rows: readonly MappedRow[], plan: readonly PlannedRow[]): void {
    plan.forEach((planned, i) => {
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- one plan per row
      const row = rows[i]!;
      let client: KnownClient | undefined;
      if (planned.outcome === 'create') {
        client = {
          id: `c${String(this.clients.length + 1)}`,
          name: row.name ?? '',
          email: row.email,
          phone: row.phone,
        };
        this.clients.push(client);
      } else if (planned.outcome === 'merge' || planned.outcome === 'unchanged') {
        client = this.clients.find((c) => c.id === planned.clientId);
        if (client !== undefined) Object.assign(client, planned.fills);
      }
      if (client === undefined) return;
      if (row.externalId !== null && !this.refs.has(row.externalId))
        this.refs.set(row.externalId, client);
      if (!this.hashes.has(row.hash)) this.hashes.set(row.hash, client);
    });
  }

  /** Stages and imports a file with its suggested mapping. */
  import(bytes: Uint8Array): PlannedRow[] {
    const table = parseImportFile(bytes);
    const rows = mapRows(table, mappingOf(suggestMapping(table).columns));
    const plan = planRows(table.format, rows, this.index());
    this.apply(rows, plan);
    return plan;
  }
}
