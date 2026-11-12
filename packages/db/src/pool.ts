import pg from 'pg';

export interface PoolOptions {
  /**
   * Every transaction on this pool is READ ONLY: Postgres itself rejects any write.
   * Used by mcp-session, so even a buggy query can't change a session.
   */
  readOnly?: boolean;
}

export function createPool(connectionString: string, { readOnly = false }: PoolOptions = {}) {
  return new pg.Pool({
    connectionString,
    // `options` is sent at connect time; it sets the default for every transaction.
    ...(readOnly ? { options: '-c default_transaction_read_only=on' } : {}),
  });
}
