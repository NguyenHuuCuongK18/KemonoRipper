// Pawchive also serves imported posts with IDs such as p-1237087.
export function isPostId(value: unknown): value is string {
  return typeof value === 'string' && /^(?:p-)?\d{1,40}$/.test(value);
}
