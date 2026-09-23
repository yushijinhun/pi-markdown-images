import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { convertToPng } from "@earendil-works/pi-coding-agent";
import { getImageDimensions, type ImageDimensions } from "@earendil-works/pi-tui";

export interface ImageSource {
  key: string;
  href?: string;
  kind: "file" | "http" | "data";
  value: string;
}
export interface Raster {
  base64: string;
  dimensions: ImageDimensions;
}
export type ImageEntry =
  | { status: "pending"; listeners: Set<() => void> }
  | { status: "ready"; raster: Raster }
  | { status: "error"; error: string };

export function resolveSource(href: string, cwd: string): ImageSource | undefined {
  if (!href || /[\x00-\x1f\x7f-\x9f]/.test(href)) return undefined;
  try {
    if (/^data:/i.test(href)) {
      if (href.length > 24 * 1024 * 1024) return undefined;
      return { key: `data:${createHash("sha256").update(href).digest("hex")}`, kind: "data", value: href };
    }
    if (/^https?:/i.test(href)) {
      const url = new URL(href);
      if (url.username || url.password) return undefined;
      url.hash = "";
      return { key: url.href, href: url.href, kind: "http", value: url.href };
    }
    let path: string;
    if (/^file:/i.test(href)) path = fileURLToPath(href);
    else {
      if (/^[a-z][a-z\d+.-]*:/i.test(href) || href.startsWith("//")) return undefined;
      // Marked percent-encodes spaces in inline destinations.
      const decoded = decodeURIComponent(href);
      path = decoded.startsWith("~/") ? resolve(homedir(), decoded.slice(2)) : resolve(cwd, decoded);
    }
    const url = pathToFileURL(path).href;
    return { key: url, href: url, kind: "file", value: path };
  } catch {
    return undefined;
  }
}

const MiB = 1024 * 1024;
const DEFAULT_LIMITS = {
  sourceBytes: 16 * MiB,
  pixels: 16_000_000,
  pngBytes: 24 * MiB,
  cacheBytes: 64 * MiB,
  entries: 128,
  concurrency: 4,
  timeoutMs: 15_000,
};
export type ImageLimits = typeof DEFAULT_LIMITS;

function sniffMime(data: Buffer): string {
  if (data.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) return "image/png";
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return "image/jpeg";
  if (/^GIF8[79]a$/.test(data.toString("ascii", 0, 6))) return "image/gif";
  if (data.toString("ascii", 0, 4) === "RIFF" && data.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  throw new Error("Unsupported image (expected PNG, JPEG, GIF, or WebP)");
}

async function readSource(source: ImageSource, signal: AbortSignal, limit: number): Promise<Buffer> {
  signal.throwIfAborted();
  if (source.kind === "data") {
    const match = /^data:image\/(?:png|jpe?g|gif|webp);base64,([A-Za-z0-9+/]*={0,2})$/i.exec(source.value);
    if (!match?.[1]) throw new Error("Unsupported image data URL");
    if (match[1].length > Math.ceil(limit / 3) * 4) throw new Error("Image exceeds source byte limit");
    const data = Buffer.from(match[1], "base64");
    if (data.length > limit) throw new Error("Image exceeds source byte limit");
    return data;
  }
  if (source.kind === "file") {
    const file = await open(source.value, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      const stat = await file.stat();
      if (!stat.isFile()) throw new Error("Image path is not a regular file");
      if (stat.size > limit) throw new Error("Image exceeds source byte limit");
      const chunks: Buffer[] = [];
      let size = 0;
      for (;;) {
        signal.throwIfAborted();
        const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, limit - size + 1));
        const { bytesRead } = await file.read(buffer);
        if (!bytesRead) break;
        size += bytesRead;
        if (size > limit) throw new Error("Image exceeds source byte limit");
        chunks.push(buffer.subarray(0, bytesRead));
      }
      return Buffer.concat(chunks, size);
    } finally {
      await file.close();
    }
  }
  const response = await fetch(source.value, {
    signal,
    credentials: "omit",
    headers: { Accept: "image/png,image/jpeg,image/gif,image/webp" },
  });
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new Error(`Image request failed: HTTP ${response.status}`);
  }
  const reader = response.body.getReader();
  try {
    const declaredSize = Number(response.headers.get("content-length"));
    if (declaredSize > limit) throw new Error("Image exceeds source byte limit");
    const chunks: Buffer[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new Error("Image exceeds source byte limit");
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks, size);
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

async function loadRaster(source: ImageSource, signal: AbortSignal, limits: ImageLimits): Promise<Raster> {
  const data = await readSource(source, signal, limits.sourceBytes);
  signal.throwIfAborted();
  const mime = sniffMime(data);
  const base64 = data.toString("base64");
  const dimensions = getImageDimensions(base64, mime);
  if (!dimensions || dimensions.widthPx < 1 || dimensions.heightPx < 1 ||
      dimensions.widthPx * dimensions.heightPx > limits.pixels) {
    throw new Error("Invalid image dimensions or image exceeds pixel limit");
  }
  const png = await convertToPng(base64, mime);
  signal.throwIfAborted();
  if (!png) throw new Error("Could not decode image");
  if (png.data.length * 0.75 > limits.pngBytes) throw new Error("Converted PNG exceeds byte limit");
  const pngDimensions = getImageDimensions(png.data, "image/png");
  if (!pngDimensions || pngDimensions.widthPx * pngDimensions.heightPx > limits.pixels) {
    throw new Error("Invalid converted image dimensions");
  }
  return { base64: png.data, dimensions: pngDimensions };
}

/** Bounded, deduplicated async loads. Entries remain cached until clear(). */
export class ImageStore {
  private readonly limits: ImageLimits;
  private entries = new Map<string, ImageEntry>();
  private queue: Array<{ source: ImageSource; entry: Extract<ImageEntry, { status: "pending" }> }> = [];
  private controller = new AbortController();
  private active = 0;
  private bytes = 0;
  private disposed = false;
  lastError: string | undefined;

  constructor(limits: Partial<ImageLimits> = {}) {
    this.limits = { ...DEFAULT_LIMITS, ...limits };
  }

  get size(): number { return this.entries.size; }
  get cacheBytes(): number { return this.bytes; }

  request(source: ImageSource, onSettled: () => void): ImageEntry | undefined {
    if (this.disposed) return undefined;
    let entry = this.entries.get(source.key);
    if (!entry) {
      // Do not evict visible sources: eviction would cause a load/redraw loop in a
      // transcript with more images than the cache can hold.
      if (this.entries.size >= this.limits.entries) return undefined;
      entry = { status: "pending", listeners: new Set() };
      this.entries.set(source.key, entry);
      this.queue.push({ source, entry });
    }
    if (entry.status === "pending") entry.listeners.add(onSettled);
    this.pump();
    return entry;
  }

  clear(): void {
    this.controller.abort();
    this.controller = new AbortController();
    this.queue = [];
    this.entries.clear();
    this.bytes = 0;
    this.lastError = undefined;
  }

  dispose(): void {
    this.disposed = true;
    this.clear();
  }

  private pump(): void {
    while (!this.disposed && this.active < this.limits.concurrency && this.queue.length) {
      const { source, entry } = this.queue.shift()!;
      const generation = this.controller;
      const signal = AbortSignal.any([generation.signal, AbortSignal.timeout(this.limits.timeoutMs)]);
      this.active++;
      void loadRaster(source, signal, this.limits).then((raster) => {
        if (generation.signal.aborted) return;
        if (this.bytes + raster.base64.length > this.limits.cacheBytes) throw new Error("Image cache byte limit reached");
        this.entries.set(source.key, { status: "ready", raster });
        this.bytes += raster.base64.length;
      }).catch((error: unknown) => {
        if (generation.signal.aborted) return;
        this.lastError = error instanceof Error ? error.message : String(error);
        this.entries.set(source.key, { status: "error", error: this.lastError });
      }).finally(() => {
        this.active--;
        if (!generation.signal.aborted) {
          for (const notify of entry.listeners) notify();
        }
        entry.listeners.clear();
        this.pump();
      });
    }
  }
}
