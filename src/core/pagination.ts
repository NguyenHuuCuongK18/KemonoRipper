import type { ApiMessage, Checkpoint } from './types';
import { stableToken } from './mediaNormalizer';
export const PAGE_SIZE = 150; // Measured in Chromium; see docs/API_RECON.md.
export function advancePage(checkpoint: Checkpoint, messages: ApiMessage[]): Checkpoint {
  const next = structuredClone(checkpoint);
  next.attempts = 0; next.nextAttemptAt = 0; next.error = null;
  if (!messages.length) { next.pages++; next.coverage = 'complete'; next.terminal = 'empty-page'; return next; }
  const fingerprint = stableToken(messages.map(m => m.id).join(','));
  if (next.pageFingerprints.includes(fingerprint)) throw new Error('API repeated an earlier page; pagination stopped with incomplete coverage');
  if (next.pages >= 10000) throw new Error('Safety page limit reached; coverage is incomplete');
  next.pageFingerprints.push(fingerprint); next.pages++;
  next.messageIds = [...new Set([...next.messageIds, ...messages.map(m => m.id)])];
  next.offset += PAGE_SIZE; next.coverage = 'scanning';
  return next;
}
