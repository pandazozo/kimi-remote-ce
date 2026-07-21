#!/usr/bin/env node
// Generate a LOGIN_PASSWORD_SCRYPT value for the gateway.
// Usage: node bin/hash-password.js <password>
import { randomBytes, scryptSync } from 'node:crypto';

const password = process.argv[2];
if (!password) {
  console.error('usage: node bin/hash-password.js <password>');
  process.exit(1);
}

const N = 16384;
const r = 8;
const p = 1;
const salt = randomBytes(16);
const hash = scryptSync(password, salt, 32, { N, r, p });

console.log(
  `scrypt:${N}:${r}:${p}:${salt.toString('base64')}:${hash.toString('base64')}`
);
