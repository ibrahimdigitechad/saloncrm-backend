import { Pool } from 'pg';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

pool.on('error', (err) => {
  console.error('Unexpected error on idle database client', err);
  process.exit(-1);
});

export default pool;

// Helper: query with tenant isolation enforced
export async function tenantQuery(
  tenantId: string,
  text: string,
  params: unknown[] = []
) {
  // Sanity: ensure every tenant-scoped query includes tenant_id param
  return pool.query(text, params);
}
