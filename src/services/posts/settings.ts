import type { PostScope, PostSelection } from './types';

export function defaultSelection(): PostSelection { return { quality: 'full res', images: true, files: true, text: true, fallbackToThumbnail: true, excludedFileTypes: [], extractArchives: false }; }
export function validSelection(value: unknown): PostSelection {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid content selection.');
  const selection = value as Record<string, unknown>;
  if (!['thumbnail', 'full res', 'both'].includes(String(selection.quality)) || ['images', 'files', 'text'].some(key => typeof selection[key] !== 'boolean')) throw new Error('Invalid content selection.');
  if (selection.fallbackToThumbnail !== undefined && typeof selection.fallbackToThumbnail !== 'boolean') throw new Error('Invalid thumbnail fallback selection.');
  if (selection.extractArchives !== undefined && typeof selection.extractArchives !== 'boolean') throw new Error('Invalid archive extraction setting.');
  const excluded = selection.excludedFileTypes;
  if (excluded !== undefined && (!Array.isArray(excluded) || excluded.length > 1000 || excluded.some(type => typeof type !== 'string' || !/^[a-z0-9_-]{1,64}(?:\.[a-z0-9_-]{1,64}){0,2}$/.test(type)))) throw new Error('Invalid file type selection.');
  return { quality: selection.quality as PostSelection['quality'], images: selection.images as boolean, files: selection.files as boolean, text: selection.text as boolean,
    ...(selection.fallbackToThumbnail !== undefined ? { fallbackToThumbnail: selection.fallbackToThumbnail as boolean } : {}),
    ...(selection.extractArchives !== undefined ? { extractArchives: selection.extractArchives as boolean } : {}),
    ...(excluded !== undefined ? { excludedFileTypes: [...new Set(excluded as string[])].sort() } : {}) };
}
export function archiveSettings(source: PostScope, selection: PostSelection) {
  const { origin, platform, creatorId } = source;
  return { format: 'archive-ripper-settings', version: 1, source: { origin, platform, creatorId }, selection: { ...defaultSelection(), ...validSelection(selection) } };
}
export function parseSettings(value: unknown, source: PostScope): PostSelection {
  const settings = value as ReturnType<typeof archiveSettings> | null;
  if (!settings || settings.format !== 'archive-ripper-settings' || settings.version !== 1) throw new Error('Invalid archive settings.json.');
  if (settings.source?.origin !== source.origin || settings.source?.platform !== source.platform || settings.source?.creatorId !== source.creatorId) throw new Error('settings.json belongs to a different website, service, or creator.');
  return { ...defaultSelection(), ...validSelection(settings.selection) };
}
