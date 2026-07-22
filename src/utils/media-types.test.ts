import { test, expect } from "bun:test";
import {
  contentMatchesExtension,
  extensionOf,
  isAllowedExtension,
} from "./media-types";

const PNG_HEAD = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0, 0, 0, 0]);
const MP4_HEAD = new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 0, 0]);
const MZ_EXE = new Uint8Array([0x4d, 0x5a, 0x90, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);

test("extensionOf lowercases and strips dot", () => {
  expect(extensionOf("Clip.MP4")).toBe("mp4");
  expect(extensionOf("noext")).toBeNull();
  expect(extensionOf(".hidden")).toBeNull();
});

test("allowlist gates known media extensions only", () => {
  expect(isAllowedExtension("png")).toBe(true);
  expect(isAllowedExtension("exe")).toBe(false);
  expect(isAllowedExtension("svg")).toBe(false); // deliberately excluded
  expect(isAllowedExtension(null)).toBe(false);
});

test("magic bytes must match the claimed extension", () => {
  expect(contentMatchesExtension("png", PNG_HEAD)).toBe(true);
  expect(contentMatchesExtension("mp4", MP4_HEAD)).toBe(true);
});

test("rejects an executable disguised with a media extension", () => {
  expect(contentMatchesExtension("png", MZ_EXE)).toBe(false);
  // real PNG bytes but wrong claimed extension also fails
  expect(contentMatchesExtension("mp4", PNG_HEAD)).toBe(false);
});
