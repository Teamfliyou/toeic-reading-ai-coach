// TOTP (RFC 6238) : brique prête pour la MFA de l'administration. Pas encore
// branchée sur la connexion (voir docs/admin-mfa.md) : aucune MFA n'est imposée.

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(buffer) {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text) {
  const clean = String(text).toUpperCase().replace(/[\s=-]/g, "");
  let bits = 0;
  let value = 0;
  const bytes = [];
  for (const char of clean) {
    const index = ALPHABET.indexOf(char);
    if (index === -1) throw new Error("Secret TOTP invalide (base32 attendu).");
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/** Nouveau secret aléatoire de 160 bits, encodé en base32. */
export function generateSecret() {
  return base32Encode(randomBytes(20));
}

/** Code à usage unique pour un instant donné (HMAC-SHA1, pas de 30 s, 6 chiffres par défaut). */
export function totp(secretBase32, { time = Date.now(), step = 30, digits = 6 } = {}) {
  const counter = Math.floor(time / 1000 / step);
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac("sha1", base32Decode(secretBase32)).update(message).digest();
  const offset = hmac[hmac.length - 1] & 15;
  const binary =
    ((hmac[offset] & 0x7f) << 24) | (hmac[offset + 1] << 16) | (hmac[offset + 2] << 8) | hmac[offset + 3];
  return String(binary % 10 ** digits).padStart(digits, "0");
}

/** Vérifie un code en tolérant `window` pas de décalage d'horloge (±30 s par défaut). */
export function verifyTotp(secretBase32, token, { time = Date.now(), window = 1, step = 30, digits = 6 } = {}) {
  const candidate = String(token ?? "").replace(/\s/g, "");
  if (!new RegExp(`^\\d{${digits}}$`).test(candidate)) return false;
  let ok = false;
  for (let drift = -window; drift <= window; drift += 1) {
    const expected = totp(secretBase32, { time: time + drift * step * 1000, step, digits });
    // Comparaison en temps constant, sur tous les pas (pas de sortie anticipée).
    if (timingSafeEqual(Buffer.from(expected), Buffer.from(candidate))) ok = true;
  }
  return ok;
}

/** URL `otpauth://` à encoder en QR code pour les applications d'authentification. */
export function otpauthUrl({ secret, account, issuer = "Lernoviq" }) {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}
