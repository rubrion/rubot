/**
 * Password hashing using PBKDF2-SHA256 via WebCrypto (Workers-compatible).
 *
 * Stored hash format: `pbkdf2-sha256$<iterations>$<salt-b64>$<hash-b64>`.
 * Iteration count is stored per-hash so it can be raised over time
 * without invalidating existing rows — `verifyPassword` reads the
 * iteration count back out of the stored string.
 */

const ALGO = "pbkdf2-sha256";
const ITERATIONS = 100_000;
const SALT_BYTES = 16;
const HASH_BYTES = 32;

function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function fromBase64(str: string): Uint8Array {
  const bin = atob(str);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function pbkdf2(
  password: string,
  salt: Uint8Array,
  iterations: number,
  hashBytes: number,
): Promise<Uint8Array> {
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    { name: "PBKDF2" },
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
    keyMaterial,
    hashBytes * 8,
  );
  return new Uint8Array(bits);
}

export async function hashPassword(password: string): Promise<string> {
  const salt = new Uint8Array(SALT_BYTES);
  crypto.getRandomValues(salt);
  const hash = await pbkdf2(password, salt, ITERATIONS, HASH_BYTES);
  return `${ALGO}$${ITERATIONS}$${toBase64(salt)}$${toBase64(hash)}`;
}

export async function verifyPassword(
  password: string,
  stored: string,
): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 4) return false;
  const [algo, iterStr, saltB64, hashB64] = parts;
  if (algo !== ALGO) return false;
  const iterations = parseInt(iterStr, 10);
  if (!Number.isFinite(iterations) || iterations <= 0) return false;

  const salt = fromBase64(saltB64);
  const expected = fromBase64(hashB64);
  const actual = await pbkdf2(password, salt, iterations, expected.length);

  if (actual.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < actual.length; i++) diff |= actual[i] ^ expected[i];
  return diff === 0;
}
