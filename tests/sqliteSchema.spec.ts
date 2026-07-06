import { describe, expect, it } from 'vitest';

import { ensureSqliteColumn, type SqlExec } from '../src/sqliteSchema';

/**
 * Simulates a Durable Object SQLite table whose schema evolves. PRAGMA
 * table_info returns the current columns; ALTER TABLE ADD COLUMN mutates them.
 * This is the exact trap the migration guards against: on an existing DO the
 * table already exists, so the column must be added explicitly.
 */
function makeFakeSql(initialColumns: string[]) {
  const columns = [...initialColumns];
  const statements: string[] = [];
  const exec: SqlExec = (query: string) => {
    statements.push(query);
    const info = /^\s*PRAGMA table_info\((\w+)\)/i.exec(query);
    if (info) {
      return columns.map((name, cid) => ({ cid, name }));
    }
    const alter = /ALTER TABLE \w+ ADD COLUMN (\w+)/i.exec(query);
    if (alter) {
      columns.push(alter[1]);
      return [];
    }
    return [];
  };
  return { exec, columns, statements };
}

describe('ensureSqliteColumn (DO schema evolution)', () => {
  it('adds the column to an OLD table that predates it (the migration case)', () => {
    const sql = makeFakeSql([
      'id',
      'user_id',
      'scope',
      'email',
      'authenticated_at',
      'updated_at',
    ]);

    const result = ensureSqliteColumn(
      sql.exec,
      'session_auth',
      'orgx_user_id',
      'TEXT'
    );

    expect(result.added).toBe(true);
    expect(sql.columns).toContain('orgx_user_id');
    expect(sql.statements.some((s) => /ALTER TABLE/i.test(s))).toBe(true);
  });

  it('is a no-op (no ALTER) when the column already exists', () => {
    const sql = makeFakeSql([
      'id',
      'user_id',
      'orgx_user_id',
      'scope',
      'email',
      'authenticated_at',
      'updated_at',
    ]);

    const result = ensureSqliteColumn(
      sql.exec,
      'session_auth',
      'orgx_user_id',
      'TEXT'
    );

    expect(result.added).toBe(false);
    expect(sql.statements.some((s) => /ALTER TABLE/i.test(s))).toBe(false);
  });

  it('is idempotent across repeated calls (runs at most once)', () => {
    const sql = makeFakeSql(['id', 'user_id']);

    const first = ensureSqliteColumn(sql.exec, 'session_auth', 'orgx_user_id', 'TEXT');
    const second = ensureSqliteColumn(sql.exec, 'session_auth', 'orgx_user_id', 'TEXT');

    expect(first.added).toBe(true);
    expect(second.added).toBe(false);
    expect(sql.statements.filter((s) => /ALTER TABLE/i.test(s))).toHaveLength(1);
  });
});
