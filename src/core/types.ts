import type { TransferPolicy } from './transferConcurrency';
export type Mode = 'thumbnail' | 'best' | 'original';
export interface ArchiveScope { serverId: string; channelId: string | null; serverName: string | null; channelName: string | null; service?: 'discord' }
export interface Scope extends ArchiveScope { channelId: string }
export interface Channel { id: string; name: string; parentId: string | null; type: number | null; postCount: number | null; sources?: ('api' | 'dom')[] }
export interface Server { id: string; name: string; channels: Channel[] }
export interface PageChannels { serverId: string; serverName: string | null; channels: Channel[] }
export interface Discovery { scope: ArchiveScope; server: Server | null; warning: string | null; apiChannelCount: number; domChannelCount: number }
export interface ApiMessage { id: string; server?: string; channel?: string; published?: string | null; content?: string | null; attachments?: { name?: string; path?: string }[] }
export interface MediaRecord extends Scope {
  id: string; jobId: string; messageId: string | null; publishedRaw: string | null; publishedAtUtc: string | null;
  attachmentIndex: number; attachmentId: string | null; originalFilename: string | null;
  kemonoPath: string | null; kemonoFileHash: string | null; originalUrl: string | null; discordCdnUrl: string | null;
  thumbnailUrl: string | null; resolvedUrl: string | null; mediaType: 'image' | 'video' | 'unknown';
  sourceType: 'api' | 'dom' | 'merged'; provenance: string[]; warnings: string[];
  status: 'discovered' | 'queued' | 'transferring' | 'staged' | 'downloaded' | 'failed' | 'skipped';
  savedPath: string | null; errorMessage: string | null; attempts: number; nextAttemptAt: number;
  downloadId: number | null; blobUrl: string | null; quality: 'thumbnail' | 'original' | null;
  bytes: number | null; sha256: string | null; mime: string | null; width: number | null; height: number | null;
  candidateFailures: { url: string; reason: string }[];
}
export interface Checkpoint {
  channelId: string; channelName: string | null; offset: number; pages: number; messageIds: string[];
  pageFingerprints: string[]; postCount: number | null; coverage: 'pending' | 'scanning' | 'complete' | 'incomplete';
  terminal: 'empty-page' | null; failures: { offset: number; reason: string; at: string }[];
  attempts: number; nextAttemptAt: number; error: string | null; domMessages: number;
}
export interface Job {
  service?: 'discord';
  id: string; serverId: string; serverName: string | null; mode: Mode; tryOriginal: boolean;
  channels: Checkpoint[]; status: 'scanning' | 'indexed' | 'downloading' | 'paused' | 'cancelled' | 'finished';
  resumeStatus: 'scanning' | 'indexed' | 'downloading' | 'finished'; createdAt: string; updatedAt: string;
  warnings: string[]; autoManifest: boolean; manifestState: 'pending' | 'saving' | 'saved' | 'failed';
  manifestDownloads: { id: number; blobUrl: string; path: string; state: 'in_progress' | 'complete' | 'interrupted' }[];
  apiNextAt: number; mediaNextAt: number;
  transferPolicy?: TransferPolicy;
  scope?: 'server' | 'selected' | 'channel'; sourceUrl?: string; discoveredChannelCount?: number;
  channelDiscovery?: 'api+dom' | 'api' | 'dom' | 'current-channel';
  destination?: { kind: 'folder'; name: string; directoryId?: string } | { kind: 'browser' } | { kind: 'zip' };
  destinationError?: string | null;
  manifestPaths?: string[];
  archive?: { state: 'pending' | 'building' | 'ready' | 'saving' | 'saved' | 'failed'; filename: string; blobUrl: string | null; downloadId: number | null; bytes: number; entries: number; progress: number; total: number; error: string | null; cacheCleared?: boolean; cacheCleanupError?: string | null };
}
export interface Summary { discovered: number; downloaded: number; staged: number; failed: number; skipped: number; queued: number; pages: number; messages: number; incomplete: boolean }
export type Command =
  | { type: 'DISCOVER'; url: string }
  | { type: 'START'; url: string; channelIds: string[]; mode: Mode; tryOriginal: boolean; allChannels?: boolean }
  | { type: 'LIST' }
  | { type: 'DETAIL'; jobId: string; includeMedia?: boolean }
  | { type: 'DESTINATION'; jobId: string; kind: 'folder' | 'browser' | 'zip'; directoryId?: string }
  | { type: 'ACTION'; jobId: string; action: 'pause' | 'resume' | 'cancel' | 'download' | 'retry' | 'save-zip' | 'clear-cache' }
  | { type: 'DOM'; url: string; records: MediaRecord[]; messageCount: number }
  | { type: 'EXPORT'; jobId: string; format: 'json' | 'csv' | 'failures' }
  | { type: 'DASHBOARD' };
export type Reply<T> = { ok: true; data: T } | { ok: false; error: string };
