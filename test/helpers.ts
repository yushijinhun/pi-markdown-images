import assert from "node:assert/strict";
import { crc32, deflateSync } from "node:zlib";
import type { MarkdownTheme } from "@earendil-works/pi-tui";
import { ImageStore, resolveSource, type ImageEntry } from "../src/images.js";

const plain = (text: string) => text;
export const theme: MarkdownTheme = {
  heading: plain, link: plain, linkUrl: plain, code: plain, codeBlock: plain,
  codeBlockBorder: plain, quote: plain, quoteBorder: plain, hr: plain, listBullet: plain,
  bold: plain, italic: plain, strikethrough: plain, underline: plain,
};

function chunk(type: string, data: Buffer): Buffer {
  const content = Buffer.concat([Buffer.from(type), data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(content));
  return Buffer.concat([length, content, checksum]);
}

export function png(width = 120, height = 80): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const pixels = Buffer.alloc((width * 3 + 1) * height, 180);
  for (let row = 0; row < height; row++) pixels[row * (width * 3 + 1)] = 0;
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"), chunk("IHDR", header),
    chunk("IDAT", deflateSync(pixels)), chunk("IEND", Buffer.alloc(0)),
  ]);
}

export const dataUrl = `data:image/png;base64,${png().toString("base64")}`;

export async function load(store: ImageStore, href = dataUrl, cwd = process.cwd()): Promise<ImageEntry> {
  const source = resolveSource(href, cwd);
  assert.ok(source, "source resolves");
  let finish!: () => void;
  const settled = new Promise<void>((resolve) => { finish = resolve; });
  const entry = store.request(source, finish);
  assert.ok(entry, "cache accepts source");
  if (entry.status === "pending") await settled;
  const result = store.request(source, () => {});
  assert.ok(result);
  return result;
}

export function kittyIds(lines: string[]): number[] {
  return lines.flatMap((line) => [...line.matchAll(/\x1b_G[^;]*\bi=(\d+)/g)].map((m) => Number(m[1])));
}
