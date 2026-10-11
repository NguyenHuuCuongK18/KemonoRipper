import type { Job } from '../../core/types';
import type { TransferPolicy } from '../../core/transferConcurrency';

export type Platform = 'fanbox' | 'patreon';
export type Quality = 'thumbnail' | 'full res';
export interface PostScope { origin: string; platform: Platform; creatorId: string; postId: string | null }
export interface Attachment { name?: string; path?: string; node?: number; server?: string }
export interface ApiPost {
  id: string; user: string; service: Platform; title?: string; content?: string; published?: string;
  file?: Attachment; attachments?: Attachment[]; has_full?: boolean; detail_fetched?: boolean; embed?: unknown;
}
export interface PostMedia { id: string; name: string; path: string; kind: 'image' | 'file'; thumbnailUrl: string | null; originalUrl: string | null }
export interface ArchivedPost { id: string; title: string; content: string; published: string | null; hasFull: boolean | null; media: PostMedia[]; embed: unknown }
export interface PostSelection { quality: 'thumbnail' | 'full res' | 'both'; images: boolean; files: boolean; text: boolean; fallbackToThumbnail?: boolean }
export interface PostTask {
  id: string; postId: string; quality: Quality; kind: 'image' | 'file' | 'text'; url: string | null; path: string;
  status: 'queued' | 'transferring' | 'staged' | 'downloaded' | 'failed' | 'unavailable';
  bytes: number | null; attempts: number; nextAt: number; error: string | null;
  synced?: boolean;
  fallbackUrl?: string;
  fallback?: boolean;
  fallbackReason?: string;
  fallbackChecked?: boolean;
}
export interface PostSyncFile { id: string; quality: Quality; kind: PostTask['kind']; path: string; bytes: number }
export interface PostSyncIndex {
  format: 'archive-ripper-post-sync'; version: 1;
  source: Omit<PostScope, 'postId'>; creatorName: string; updatedAt: string; selection: PostSelection;
  posts: { id: string; title: string; files: PostSyncFile[] }[];
}
export type PostDestination = { kind: 'zip' } | { kind: 'folder'; directoryId: string; name: string };
export interface PostJob {
  id: string; service: 'posts'; source: PostScope; sourceUrl: string; creatorName: string; createdAt: string; updatedAt: string;
  status: 'scanning' | 'ready' | 'downloading' | 'paused' | 'cancelled' | 'finished'; resumeStatus: 'scanning' | 'downloading';
  selection: PostSelection; scan: { offset: number; pages: number; total: number | null; complete: boolean; error: string | null; attempts: number; nextAt: number; fingerprints: string[] };
  posts: ArchivedPost[]; detailQueue: string[]; tasks: PostTask[]; archive: Job['archive']; nextAt: number; error: string | null;
  destination?: PostDestination; sync?: PostSyncIndex;
  autoDownload?: PostSelection;
  transferPolicy?: TransferPolicy;
}
export type PostCommand =
  | { type: 'POST_START'; url: string; expectedPosts?: number | null }
  | { type: 'POST_DETAIL'; jobId: string; limit?: number }
  | { type: 'POST_DOWNLOAD'; jobId: string; selection: PostSelection; destination?: 'folder' | 'zip' }
  | { type: 'POST_SYNC_IMPORT'; jobId: string; json: unknown }
  | { type: 'POST_SYNC_CONNECT'; jobId: string; directoryId: string; name: string }
  | { type: 'POST_FOLDER'; jobId: string; directoryId: string; name: string }
  | { type: 'POST_ACTION'; jobId: string; action: 'pause' | 'resume' | 'cancel' | 'retry' | 'save-zip' | 'clear-cache' | 'rescan' };
