// Reversible encryption for secrets we must send back out (supplier API keys).
// AES-256-GCM with a key derived from JWT_SECRET; rotating JWT_SECRET means
// supplier keys have to be re-entered in the admin panel.
import crypto from 'crypto';
import config from '../config.js';

const key = () => crypto.createHash('sha256').update('supplier-keys:' + config.admin.jwtSecret).digest();

export function encryptSecret(plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const ct = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), ct.toString('base64')].join(':');
}

export function decryptSecret(enc) {
  const [v, iv, tag, ct] = String(enc).split(':');
  if (v !== 'v1') throw new Error('Unknown secret format');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(ct, 'base64')), decipher.final()]).toString('utf8');
}
