import pg from 'pg';
import { z } from 'zod';

// Pepper's operators (S59.2, ADR-0062): granted and revoked only here, on the migration role,
// by the `operator` script; nothing over HTTP can make an account an operator. The grant
// takes effect at the next request and its removal at once (every operator transaction
// checks it). Accounts are named by their sign-in email.

const EmailSchema = z.email().max(254);
const NoteSchema = z.string().trim().min(3).max(200);

export interface OperatorGrant {
  email: string;
  name: string;
  grantedAt: Date;
  note: string;
}

async function withAdmin<T>(url: string, work: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
}

/** Grants the operator role to the account with `email` (again: its note is replaced). */
export async function grantOperator(
  migrationUrl: string,
  input: { email: string; note: string },
): Promise<'granted' | 'no_account'> {
  const email = EmailSchema.parse(input.email.trim().toLowerCase());
  const note = NoteSchema.parse(input.note);
  return withAdmin(migrationUrl, async (client) => {
    const { rowCount } = await client.query(
      `INSERT INTO platform_operators (user_id, note)
         SELECT id, $2 FROM users WHERE lower(email) = $1
       ON CONFLICT (user_id) DO UPDATE SET note = excluded.note`,
      [email, note],
    );
    return rowCount === 1 ? 'granted' : 'no_account';
  });
}

/** Takes the role away from the account with `email`; its next request is refused. */
export async function revokeOperator(
  migrationUrl: string,
  email: string,
): Promise<'revoked' | 'not_an_operator'> {
  const address = EmailSchema.parse(email.trim().toLowerCase());
  return withAdmin(migrationUrl, async (client) => {
    const { rowCount } = await client.query(
      `DELETE FROM platform_operators o USING users u
        WHERE u.id = o.user_id AND lower(u.email) = $1`,
      [address],
    );
    return rowCount === 1 ? 'revoked' : 'not_an_operator';
  });
}

/** Every operator, the oldest grant first. */
export async function listOperators(migrationUrl: string): Promise<OperatorGrant[]> {
  return withAdmin(migrationUrl, async (client) => {
    const { rows } = await client.query<{
      email: string;
      name: string;
      granted_at: Date;
      note: string;
    }>(
      `SELECT u.email, u.name, o.granted_at, o.note
         FROM platform_operators o JOIN users u ON u.id = o.user_id
        ORDER BY o.granted_at, u.email`,
    );
    return rows.map((row) => ({
      email: row.email,
      name: row.name,
      grantedAt: row.granted_at,
      note: row.note,
    }));
  });
}
