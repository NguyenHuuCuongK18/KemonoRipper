import { safeSegment } from '../../core/filenameBuilder';

export function archiveEntryPath(input: string): string {
  const path = input.replaceAll('\\', '/');
  if (!path || path.startsWith('/') || /^[a-z]:/i.test(path) || /[\x00-\x1f]/.test(path)) throw new Error('Archive contains an unsafe file path.');
  const parts = path.split('/');
  while (parts[0] === '.') parts.shift();
  if (!parts.length || parts.some(part => !part || part === '.' || part === '..' || part.includes(':'))) throw new Error('Archive contains an unsafe file path.');
  return parts.map((part, index) => {
    const extension = index === parts.length - 1 ? /\.[a-z0-9_-]{1,64}$/i.exec(part)?.[0] : undefined;
    return extension ? safeSegment(part.slice(0, -extension.length), 'file') + extension : safeSegment(part, 'file');
  }).join('/');
}
