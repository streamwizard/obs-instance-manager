// Builds an attachment Content-Disposition header that is safe for any
// filename: an ASCII-only quoted fallback plus an RFC 5987 filename* for the
// exact (percent-encoded) name. Never interpolate a raw filename into a
// header value.
export function attachmentDisposition(name: string): string {
  const asciiName = name.replace(/[^A-Za-z0-9._-]/g, "_");
  return `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}
