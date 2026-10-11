import { describe, expect, it, vi } from 'vitest';
import fixture from './fixtures/post-11312487.sanitized.json';
import manifest from '../src/manifest.json';
import { PostClient } from '../src/services/posts/client';
import { createTasks, normalizePost, safePostMediaUrl } from '../src/services/posts/media';
import { safeMediaUrl } from '../src/core/urlParser';
import type { ApiPost, PostJob, PostScope } from '../src/services/posts/types';

const scope: PostScope = { origin: 'https://pawchive.pw', platform: 'fanbox', creatorId: fixture.user, postId: fixture.id };
const post = fixture as ApiPost;
const original = `https://n2.pawchive.pw/data${post.file!.path}?f=${post.file!.name}`;
const hosts = ['kemono.cr', 'pawchive.pw'].flatMap(domain =>
  ['', 'img.', 'file.', 'n1.', 'n2.', 'n3.', 'n4.', 'n5.', 'n42.', 'cdn.', 'media.eu.'].map(prefix => prefix + domain));

function tasks(value: ApiPost, source = scope) {
  return createTasks({ source, creatorName: 'Test creator', posts: [normalizePost(value, source)] } as PostJob,
    { quality: 'both', images: true, files: true, text: true });
}

describe('post media acceptance', () => {
  it('archives the reported main file even when the API says attachments: []', async () => {
    const transport = vi.fn().mockResolvedValue(new Response(JSON.stringify(post)));
    const value = await new PostClient(transport).post(scope);
    const selected = tasks(value);
    expect(value.attachments).toEqual([]);
    expect(normalizePost(value, scope).media).toHaveLength(1);
    expect(selected.filter(task => task.kind === 'image').map(task => [task.quality, task.url, task.status])).toEqual([
      ['thumbnail', `https://img.pawchive.pw/thumbnail/data${post.file!.path}`, 'queued'],
      ['full res', original, 'queued'],
    ]);
    expect(selected.filter(task => task.kind === 'text')).toHaveLength(2);
  });

  it.each([false, true])('retains the main file during profile discovery (wrapped list: %s)', async wrapped => {
    const transport = vi.fn().mockResolvedValue(new Response(JSON.stringify(wrapped ? { posts: [post] } : [post])));
    const list = await new PostClient(transport).posts({ ...scope, postId: null }, 0);
    expect(list).toHaveLength(1);
    expect(normalizePost(list[0], scope).media[0].originalUrl).toBe(original);
  });

  it.each(hosts)('accepts full-resolution media on %s through validation, metadata, and task creation', host => {
    const url = `https://${host}/data${post.file!.path}?f=original.jpeg&token=example`;
    expect(safePostMediaUrl(url)).toBe(url);
    expect(safeMediaUrl(url)).toBe(url);
    const value = { ...post, file: { ...post.file, node: undefined, server: url } };
    expect(tasks(value).find(task => task.quality === 'full res' && task.kind === 'image')?.url).toBe(url);
    const patterns = [...manifest.host_permissions, ...manifest.optional_host_permissions];
    expect(patterns.some(pattern => {
      const patternHost = pattern.slice('https://'.length, -'/*'.length);
      return patternHost.startsWith('*.') ? host === patternHost.slice(2) || host.endsWith(patternHost.slice(1)) : host === patternHost;
    })).toBe(true);
    const connect = manifest.content_security_policy.extension_pages.match(/connect-src ([^;]+)/)![1].split(' ');
    expect(connect.some(origin => origin === `https://${host}` ||
      origin.startsWith('https://*.') && host.endsWith('.' + origin.slice('https://*.'.length)))).toBe(true);
  });

  it.each(['kemono.cr', 'pawchive.pw'])('routes API nodes beyond n4 on %s', domain => {
    const source = { ...scope, origin: `https://${domain}` };
    for (const node of [1, 2, 3, 4, 5, 42, 128]) {
      const value = { ...post, file: { ...post.file, node } };
      expect(normalizePost(value, source).media[0].originalUrl).toBe(`https://n${node}.${domain}/data${post.file!.path}?f=${post.file!.name}`);
    }
  });

  it('keeps each attachment on its own server and prefers inline originals over synthesized URLs', () => {
    const url = `https://media.eu.pawchive.pw/data${post.file!.path}?f=original.jpeg&download=1`;
    const filePath = '/aa/bb/' + 'a'.repeat(64) + '.psd';
    const value = { ...post, file: { ...post.file, node: undefined },
      attachments: [{ name: 'source.psd', path: filePath, server: 'https://n42.kemono.cr' }],
      content: `<img src="https://img.pawchive.pw/thumbnail/data${post.file!.path}"><a href="${url.replaceAll('&', '&amp;')}">Original</a>` };
    const selected = tasks(value).filter(task => task.quality === 'full res');
    expect(selected.filter(task => task.kind === 'image')).toHaveLength(1);
    expect(selected.find(task => task.kind === 'image')?.url).toBe(url);
    expect(selected.find(task => task.kind === 'file')?.url).toBe(`https://n42.kemono.cr/data${filePath}?f=source.psd`);
  });

  it.each(['n42.pawchive.pw', 'https://n42.pawchive.pw', 'https://n42.pawchive.pw/'])('uses storage server metadata %s before a legacy node', server => {
    const media = normalizePost({ ...post, file: { ...post.file, server } }, scope).media;
    expect(media[0].originalUrl).toBe(`https://n42.pawchive.pw/data${post.file!.path}?f=${post.file!.name}`);
  });

  it.each(['/../../image.jpeg', '/data/avatars/image.jpeg', '/data/aa/bb/not-a-hash.jpeg'])('rejects non-attachment path %s on a trusted host', path => {
    expect(safePostMediaUrl(`https://n42.pawchive.pw${path}`)).toBeNull();
    expect(safeMediaUrl(`https://n42.pawchive.pw${path}`)).toBeNull();
  });

  it.each([
    'https://pawchive.pw.evil.example', 'https://evilkemono.cr', 'https://fakepawchive.pw',
    'https://kemono.cr.evil.example', 'https://pawchive.evil.example', 'https://kemono.example',
    'http://n2.pawchive.pw', 'https://n2.pawchive.pw:8443', 'https://user:pass@n2.pawchive.pw',
  ])('rejects unsafe host %s even when the archive name appears in it', host => {
    expect(safePostMediaUrl(`${host}/data${post.file!.path}`)).toBeNull();
    expect(safeMediaUrl(`${host}/data${post.file!.path}`)).toBeNull();
    const media = normalizePost({ ...post, file: {}, content: `<img src="${host}/data${post.file!.path}">` }, scope).media;
    expect(media).toHaveLength(0);
  });

  it('does not trust invalid server metadata or a server URL for a different file', () => {
    for (const server of ['https://evil.example', 'https://n2.pawchive.pw/data/aa/bb/' + 'a'.repeat(64) + '.jpeg']) {
      const media = normalizePost({ ...post, file: { ...post.file, server } }, scope).media;
      expect(media[0].originalUrl).toBe(original);
    }
  });

  it('retains text and unavailable originals without replacing them with thumbnails', () => {
    const value = { ...post, has_full: false, content: `<a href="${original}">Preview-only import</a>` };
    const selected = tasks(value);
    expect(selected.find(task => task.kind === 'image' && task.quality === 'full res')).toMatchObject({ url: null, status: 'unavailable' });
    expect(selected.filter(task => task.kind === 'text').every(task => task.status === 'queued')).toBe(true);
    expect(tasks({ ...post, file: {}, attachments: [] }).every(task => task.kind === 'text')).toBe(true);
  });
});
