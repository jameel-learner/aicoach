// Unambiguous alphabet: no 0/O, 1/I/L. Easy to read aloud in a classroom.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

/** Random class join code, e.g. "K7MPQ2XR". Uses Web Crypto (available in Workers, browsers, Hermes polyfills). */
export function generateJoinCode(length = 8): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let out = '';
  for (const b of bytes) out += ALPHABET[b % ALPHABET.length];
  return out;
}
