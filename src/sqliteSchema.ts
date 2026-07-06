/**
 * Minimal, testable schema evolution for Durable Object SQLite.
 *
 * A Durable Object's SQLite tables persist across deploys, so a table created
 * by an earlier version keeps its original columns forever — `CREATE TABLE IF
 * NOT EXISTS` is a no-op once the table exists and never reconciles new columns.
 * New columns must therefore be added with an explicit, idempotent
 * `ALTER TABLE ADD COLUMN`, gated on `PRAGMA table_info` so it runs at most once.
 */

export type SqlExec = (query: string, ...bindings: unknown[]) => Iterable<unknown>;

/**
 * Add `column` to `table` if PRAGMA table_info shows it is absent.
 * Returns whether an ALTER was issued. Idempotent.
 *
 * `table`/`column`/`type` are interpolated into DDL, so callers must pass
 * trusted identifiers (they are compile-time constants here — never user input).
 */
export function ensureSqliteColumn(
  exec: SqlExec,
  table: string,
  column: string,
  type: string
): { added: boolean } {
  const info = exec(`PRAGMA table_info(${table})`);
  const existing = new Set(
    [...info].map((row) => String((row as Record<string, unknown>).name))
  );
  if (existing.has(column)) return { added: false };
  exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  return { added: true };
}
