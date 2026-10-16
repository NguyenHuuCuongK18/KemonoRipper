import { extractArchive } from './extractArchive';
import { stageWithWriter } from '../../storage/zipCache';
import type { ExtractedFile } from './types';

self.onmessage = async (event: MessageEvent<{ jobId: string; id: string; file: Blob; name: string; prefix: string; wasmUrl: string }>) => {
  const { jobId, id, file, name, prefix, wasmUrl } = event.data, files: ExtractedFile[] = [];
  try {
    await extractArchive(file, name, wasmUrl, async entry => {
      const entryId = `${id}:extract:${files.length + 1}`;
      const saved = await stageWithWriter(jobId, entryId, entry.write);
      if (saved.size !== entry.size) throw new Error('Extracted file is incomplete.');
      const result = { id: entryId, path: prefix + entry.path, bytes: saved.size }; files.push(result);
      self.postMessage({ type: 'file', file: result });
    }, () => self.postMessage({ type: 'progress' }));
    self.postMessage({ type: 'done', files });
  } catch (error) { self.postMessage({ type: 'done', files, error: error instanceof Error ? error.message : 'Archive extraction failed. The original was kept.' }); }
};
