// Expected, user-facing media failures. Carries the HTTP status the file
// routes respond with (routes/files.ts).
export class MediaError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 | 413,
  ) {
    super(message);
  }
}
