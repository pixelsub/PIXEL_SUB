import crypto from 'crypto';

const PREFIX = 'psk_';

// Keys are 32 random bytes, so a plain SHA-256 is enough to store them safely
// (no salt/bcrypt needed for high-entropy secrets) and lets us look them up
// by hash in one indexed query.
export function hashApiKey(raw) {
  return crypto.createHash('sha256').update(String(raw)).digest('hex');
}

export function generateApiKey() {
  const raw = PREFIX + crypto.randomBytes(32).toString('base64url');
  return { raw, hash: hashApiKey(raw), prefix: raw.slice(0, PREFIX.length + 6) };
}
