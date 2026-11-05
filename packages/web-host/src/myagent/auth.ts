import { scrypt, timingSafeEqual } from 'node:crypto';

/** Verify the native admin_password.v1 record without exposing derived bytes. */
export async function verifyPasswordRecord(password: string, record: unknown): Promise<boolean> {
  if (!record || typeof record !== 'object' || typeof password !== 'string' || password.length > 4096) return false;
  const row = record as Record<string, unknown>;
  const { n, r, p } = row;
  if (row.schema !== 'admin_password.v1' || row.algorithm !== 'scrypt' ||
      typeof n !== 'number' || typeof r !== 'number' || typeof p !== 'number' ||
      !Number.isSafeInteger(n) || n < 1024 || (n & (n - 1)) !== 0 ||
      !Number.isSafeInteger(r) || r < 1 || r > 32 || !Number.isSafeInteger(p) || p < 1 || p > 16 ||
      128 * n * r * p > 32 * 1024 * 1024 || typeof row.updated_at !== 'number' || !Number.isFinite(row.updated_at)) return false;
  const decode = (value: unknown): Buffer | undefined => {
    if (typeof value !== 'string' || value.length > 1024) return undefined;
    const decoded = Buffer.from(value, 'base64');
    return decoded.toString('base64') === value ? decoded : undefined;
  };
  const salt = decode(row.salt);
  const digest = decode(row.hash);
  if (!salt || salt.length < 16 || !digest || digest.length < 16 || digest.length > 64) return false;
  return new Promise((resolve) => {
    scrypt(password, salt, digest.length, { N: n, r, p, maxmem: 64 * 1024 * 1024 }, (error, derived) => {
      resolve(!error && timingSafeEqual(derived, digest));
    });
  });
}
