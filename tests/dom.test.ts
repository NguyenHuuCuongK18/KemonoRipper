// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { it, expect } from 'vitest';
import messages from './fixtures/channel-1268995994440302725-0.sanitized.json';
import { scanDom } from '../src/content/domScanner';
import { normalizeMessages } from '../src/core/mediaNormalizer';
import { mergeMedia } from '../src/core/deduplicator';
import { scope } from './helpers';
it('recovers all real rendered media and merges with API records', () => {
  document.body.innerHTML = readFileSync('tests/fixtures/channel.sanitized.html', 'utf8');
  const dom = scanDom(document, scope); expect(dom.messageCount).toBe(32); expect(dom.records).toHaveLength(57);
  const merged = mergeMedia(normalizeMessages(messages, scope, 'test-job'), dom.records.map(record => ({ ...record, jobId: 'test-job' })));
  expect(merged).toHaveLength(57); expect(merged[0].sourceType).toBe('merged'); expect(merged[0].originalUrl).toContain('https://n3.kemono.cr/data/');
  expect(merged[0].publishedAtUtc).toBe('2024-08-02T18:17:01.880Z');
});
it('ignores avatars and emoji and handles a supported lazy thumbnail', () => {
  // Synthetic edge case, not a claim about live HTML structure.
  const url = 'https://img.kemono.cr/thumbnail/data' + messages[0].attachments[0].path;
  document.body.innerHTML = `<div id="message-123"><img class="avatar" src="${url}"><img class="emoji" src="https://cdn.discordapp.com/emojis/123.png"><a href="${url}"><img data-src="${url}"></a></div>`;
  expect(scanDom(document, scope).records).toHaveLength(1);
});
it('classifies originals and previews by their paths on variable archive hosts', () => {
  const path = messages[0].attachments[0].path;
  const original = `https://img.pawchive.pw/data${path}?f=image.png`;
  const thumbnail = `https://media.eu.pawchive.pw/thumbnail/data${path}`;
  document.body.innerHTML = `<div id="message-123"><a href="${original}"><img data-src="${thumbnail}"></a></div>`;
  const result = scanDom(document, scope).records;
  expect(result).toHaveLength(1);
  expect(result[0].originalUrl).toBe(original);
  expect(result[0].thumbnailUrl).toBe(thumbnail);
});
