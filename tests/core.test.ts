import { describe, it, expect } from 'vitest';
import messages from './fixtures/channel-1268995994440302725-0.sanitized.json';
import first from './fixtures/channel-1268993704975274117-0.sanitized.json';
import second from './fixtures/channel-1268993704975274117-150.sanitized.json';
import { normalizeMessages, normalizeTimestamp } from '../src/core/mediaNormalizer';
import { mergeMedia } from '../src/core/deduplicator';
import { candidates, detectImage } from '../src/core/mediaResolver';
import { safeSegment, buildFilename } from '../src/core/filenameBuilder';
import { advancePage } from '../src/core/pagination';
import { csv, manifest } from '../src/storage/manifestExporter';
import { checkpoint, scope, job } from './helpers';
describe('sanitized live channel fixture', () => {
  it('indexes all 57 attachments from 32 real messages without fabricating originals', () => {
    const records = normalizeMessages(messages, scope, 'test-job');
    expect(messages).toHaveLength(32); expect(records).toHaveLength(57);
    const bird = records.find(record => record.originalFilename === 'bird_01.png')!;
    expect(bird.messageId).toBe(scope.channelId);
    expect(bird.thumbnailUrl).toBe('https://img.kemono.cr/thumbnail/data/82/79/8279311a88d313cf25b6f1ad302ac7f82203f9712829b82785b0b3fac3e0871e.png');
    expect(bird.attachmentId).toBeNull(); expect(bird.discordCdnUrl).toBeNull(); expect(bird.originalUrl).toBeNull();
    expect(bird.publishedRaw).toBe('2024-08-02T18:17:01.880000'); expect(bird.publishedAtUtc).toBe('2024-08-02T18:17:01.880Z');
    expect(mergeMedia(records, records)).toHaveLength(57);
  });
  it('preserves distinct attachment ordinals even when names and paths repeat', () => {
    const record = messages[0]; const attachment = record.attachments[0];
    const records = normalizeMessages([{ ...record, attachments: [attachment, attachment] }], scope, 'test-job');
    expect(mergeMedia([], records)).toHaveLength(2);
    expect(buildFilename(records[0], 'png')).not.toBe(buildFilename(records[1], 'png'));
  });
  it('retains byte validation separately from the original hash', () => {
    const record = normalizeMessages(messages, scope, 'test-job')[0];
    record.bytes = 55959; record.sha256 = 'eb1d7a6022f5772f1e7b8cf8d94223b271601c43dc15b29ef6899d5f7aadab43';
    expect(record.sha256).not.toBe(record.kemonoFileHash);
    expect(JSON.parse(manifest(job(), [record])).media[0].bytes).toBe(55959);
  });
  it('extracts only explicitly present Discord image links', () => {
    const records = normalizeMessages([{ id: '123', content: 'https://cdn.discordapp.com/attachments/123/456/bird.png?ex=123 https://cdn.discordapp.com/avatars/123/a.png' }], scope, 'test-job');
    expect(records).toHaveLength(1); expect(records[0].discordCdnUrl).toContain('/attachments/123/456/bird.png');
    expect(records[0].attachmentId).toBeNull(); expect(records[0].publishedAtUtc).toBeNull();
  });
});
describe('measured pagination', () => {
  it('processes both pages and requires a validated empty page to finish', () => {
    let cp = checkpoint('1268993704975274117');
    cp = advancePage(cp, first); expect(cp.offset).toBe(150); expect(cp.coverage).toBe('scanning');
    cp = advancePage(cp, second); expect(cp.offset).toBe(300); expect(cp.coverage).toBe('scanning');
    cp = advancePage(cp, []); expect(cp.messageIds).toHaveLength(209); expect(cp.coverage).toBe('complete'); expect(cp.terminal).toBe('empty-page');
  });
  it('stops repeated pages with an error instead of claiming completeness', () => {
    const cp = advancePage(checkpoint(), messages);
    expect(() => advancePage(cp, messages)).toThrow('repeated'); expect(cp.coverage).toBe('scanning');
  });
});
describe('files and source policy', () => {
  it('interprets naive dates as UTC and rejects invalid dates', () => {
    expect(normalizeTimestamp('2024-08-02T18:17:01.880123')).toBe('2024-08-02T18:17:01.880Z');
    expect(normalizeTimestamp('2024-08-02T18:17:01+07:00')).toBe('2024-08-02T11:17:01.000Z');
    expect(normalizeTimestamp('2024-02-30T18:17:01')).toBeNull(); expect(normalizeTimestamp('garbage')).toBeNull();
  });
  it('uses safe folders and deterministic publication-based filenames', () => {
    expect(safeSegment('CON')).toBe('_CON'); expect(safeSegment('../evil\\name')).not.toMatch(/[\\/]/);
    const record = normalizeMessages(messages, scope, 'test-job')[0];
    expect(buildFilename(record, 'png')).toContain('/2024-08-02_181701Z_1268995994440302725_001_');
    record.publishedAtUtc = null; expect(buildFilename(record, 'jpg')).toContain('unknown-date');
  });
  it('keeps original attempts opt-in, and never substitutes previews in original mode', () => {
    const record = normalizeMessages(messages, scope, 'test-job')[0];
    record.originalUrl = `https://n3.kemono.cr/data${record.kemonoPath}`;
    expect(candidates(record, { mode: 'best', tryOriginal: false })[0].quality).toBe('thumbnail');
    expect(candidates(record, { mode: 'best', tryOriginal: true }).map(c => c.quality)).toEqual(['original', 'thumbnail']);
    expect(candidates(record, { mode: 'original', tryOriginal: false })).toHaveLength(1);
  });
  it('recognizes actual formats and rejects HTML even with an image MIME', () => {
    expect(detectImage(new TextEncoder().encode('<html>Error page</html>'))).toBeNull();
    expect(detectImage(Uint8Array.from([137,80,78,71,13,10,26,10,0,0,0,0]))?.ext).toBe('png');
    expect(detectImage(Uint8Array.from([255,216,255,224,0,0,0,0,0,0,0,0]))?.ext).toBe('jpg');
  });
  it('exports all metadata without fetching bytes and protects CSV cells', () => {
    const record = normalizeMessages(messages, scope, 'test-job')[0]; record.originalFilename = '=HYPERLINK("bad")';
    expect(csv([record])).toContain("'=HYPERLINK");
    expect(JSON.parse(manifest(job(), [record])).media[0].status).toBe('discovered');
    expect(JSON.parse(manifest(job(), [record])).media[0]).not.toHaveProperty('blobUrl');
  });
});
