import { createHash } from 'node:crypto';

/** The provider of an external seat (SPEC-INVESTIGACION-EXTERNA §6.4): whoever answers its folder, unobserved. */
export const EXTERNAL_SEAT = 'external-seat';

/** Who serves a model, as an identity to compare and never an address: the first 16 hex of the sha256 of its endpoint's host
    (SPEC-RIESGO-MODELOS §7.2: whether a validator's provider is the developer's). */
export function providerOf(url: string | undefined | null): string | null {
  /* An external seat (core/seat.ts): an agent outside the harness, never a host. */
  if (typeof url === 'string' && url.startsWith('seat:')) return EXTERNAL_SEAT;
  try { return url ? createHash('sha256').update(new URL(url).hostname.toLowerCase()).digest('hex').slice(0, 16) : null; } catch { return null; }
}
