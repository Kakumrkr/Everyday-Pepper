import { v7 } from 'uuid';

/**
 * A new primary key: UUID v7 (time-ordered, so inserts stay index-friendly). Generated in the
 * app because Postgres 17 has no `uuidv7()`.
 */
export function newId(): string {
  return v7();
}
