export interface BusinessCursor { createdAt: string; id: string; }

export function encodeBusinessCursor(value: BusinessCursor) {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

export function decodeBusinessCursor(cursor?: string): BusinessCursor | null {
  if (!cursor) return null;
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Partial<BusinessCursor>;
    if (typeof value.createdAt !== 'string' || Number.isNaN(Date.parse(value.createdAt)) || typeof value.id !== 'string' || !value.id) throw new Error();
    return { createdAt: value.createdAt, id: value.id };
  } catch {
    throw new Error('Invalid company pagination cursor');
  }
}

export function companyPageLimit(limit = 20) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Company page limit must be between 1 and 100');
  return limit;
}
