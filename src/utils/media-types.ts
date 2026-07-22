// Extension allowlist + magic-byte sniffing for OBS media uploads.
//
// Purpose is NOT antivirus (files land in the user's own isolated container and
// are never executed) but to stop non-media blobs -- executables, scripts, HTML
// -- from being stored in our S3, and to catch a hostile file masquerading via
// a fake extension/Content-Type (e.g. evil.exe renamed cat.png). We therefore
// verify the actual leading bytes match the claimed extension, never trusting
// the filename or the client's Content-Type.
//
// SVG is deliberately excluded: it's XML that can carry scripts, so it's an XSS
// risk if a media file is ever rendered/served, and OBS doesn't need it.

// Enough bytes to cover every signature below (RIFF form type sits at 8..11).
export const MEDIA_SNIFF_BYTES = 16;

function ascii(head: Uint8Array, offset: number, text: string): boolean {
  if (head.length < offset + text.length) return false;
  for (let i = 0; i < text.length; i++) {
    if (head[offset + i] !== text.charCodeAt(i)) return false;
  }
  return true;
}

function bytes(head: Uint8Array, offset: number, sig: number[]): boolean {
  if (head.length < offset + sig.length) return false;
  for (let i = 0; i < sig.length; i++) {
    if (head[offset + i] !== sig[i]) return false;
  }
  return true;
}

// Each matcher inspects the leading bytes and returns true if they look like
// that format. Keyed by the extensions the format legitimately uses.
type Matcher = (head: Uint8Array) => boolean;

const isPng: Matcher = (h) => bytes(h, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const isJpg: Matcher = (h) => bytes(h, 0, [0xff, 0xd8, 0xff]);
const isGif: Matcher = (h) => ascii(h, 0, "GIF8");
const isWebp: Matcher = (h) => ascii(h, 0, "RIFF") && ascii(h, 8, "WEBP");
const isBmp: Matcher = (h) => ascii(h, 0, "BM");
const isIsoBmff: Matcher = (h) => ascii(h, 4, "ftyp"); // mp4/m4v/m4a/mov
const isMatroska: Matcher = (h) => bytes(h, 0, [0x1a, 0x45, 0xdf, 0xa3]); // webm/mkv
const isWav: Matcher = (h) => ascii(h, 0, "RIFF") && ascii(h, 8, "WAVE");
const isOgg: Matcher = (h) => ascii(h, 0, "OggS");
const isFlac: Matcher = (h) => ascii(h, 0, "fLaC");
const isMp3: Matcher = (h) => ascii(h, 0, "ID3") || (h[0] === 0xff && ((h[1] ?? 0) & 0xe0) === 0xe0);
const isAac: Matcher = (h) => h[0] === 0xff && ((h[1] ?? 0) & 0xf6) === 0xf0; // ADTS
const isTtf: Matcher = (h) => bytes(h, 0, [0x00, 0x01, 0x00, 0x00]);
const isOtf: Matcher = (h) => ascii(h, 0, "OTTO");
const isWoff: Matcher = (h) => ascii(h, 0, "wOFF");
const isWoff2: Matcher = (h) => ascii(h, 0, "wOF2");

// extension -> the matcher(s) whose format that extension denotes. An upload is
// accepted only if its extension is present here AND one of its matchers passes.
const EXTENSION_MATCHERS: Record<string, Matcher[]> = {
  // images
  png: [isPng],
  jpg: [isJpg],
  jpeg: [isJpg],
  gif: [isGif],
  webp: [isWebp],
  bmp: [isBmp],
  // video
  mp4: [isIsoBmff],
  m4v: [isIsoBmff],
  mov: [isIsoBmff],
  webm: [isMatroska],
  mkv: [isMatroska],
  // audio
  m4a: [isIsoBmff],
  mp3: [isMp3],
  aac: [isAac],
  wav: [isWav],
  ogg: [isOgg],
  oga: [isOgg],
  ogv: [isOgg],
  flac: [isFlac],
  // fonts (used by OBS text sources)
  ttf: [isTtf],
  otf: [isOtf],
  woff: [isWoff],
  woff2: [isWoff2],
};

export const ALLOWED_MEDIA_EXTENSIONS = new Set(Object.keys(EXTENSION_MATCHERS));

// Returns the lowercased extension (no dot) of a file name, or null if none.
export function extensionOf(name: string): string | null {
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return null;
  return name.slice(dot + 1).toLowerCase();
}

export function isAllowedExtension(ext: string | null): boolean {
  return ext !== null && ALLOWED_MEDIA_EXTENSIONS.has(ext);
}

// True if the leading bytes match the format denoted by the extension. Reject
// (false) when the extension is unknown or the magic bytes don't correspond --
// this is what stops a renamed executable from being stored.
export function contentMatchesExtension(ext: string | null, head: Uint8Array): boolean {
  if (ext === null) return false;
  const matchers = EXTENSION_MATCHERS[ext];
  if (!matchers) return false;
  return matchers.some((m) => m(head));
}
