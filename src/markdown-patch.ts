import type { MarkdownTransformContext } from "@earendil-works/pi-coding-agent";
import {
  Image, Markdown, allocateImageId, getCapabilities, wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { ImageStore, resolveSource, type Raster } from "./images.js";

// These are ordinary JS methods in pi-tui 0.87.1, although declared private in TS.
// Keep all access to the version-sensitive surface here.
interface Token {
  type: string;
  text?: string;
  raw?: string;
  href?: string;
  tokens?: Token[];
}
interface MarkdownInternals {
  text: string;
  paddingX: number;
  defaultTextStyle?: { italic?: boolean };
  cachedLines?: string[];
  invalidate(): void;
  renderToken: TokenRenderer;
  renderInlineTokens: InlineRenderer;
}
type TokenRenderer = (this: MarkdownInternals, token: Token, width: number, ...args: unknown[]) => string[];
type InlineRenderer = (this: MarkdownInternals, tokens: Token[], ...args: unknown[]) => string;
interface Placement { raster: Raster; id: number; width: number; indent: number }
interface Frame {
  rootWidth: number;
  width: number;
  table: boolean;
  root: number;
  ordinal: number;
  placements: Map<number, Placement>;
}
interface State {
  ref: WeakRef<MarkdownInternals>;
  notify: () => void;
  ids: Map<string, number>;
  source?: string;
  width?: number;
  cache?: WeakRef<string[]>;
  epoch?: number;
  root: number;
  frame?: Frame;
  restoreCache?: () => void;
}
export interface PatchOptions {
  cwd: string;
  store: ImageStore;
  requestRender(): void;
  showImages?: boolean;
  maxWidthCells?: number;
}
export interface ImagePatch {
  noteSource(text: string, context: MarkdownTransformContext): void;
  beginMessage(): void;
  configure(options: { cwd: string; showImages: boolean; maxWidthCells: number }): void;
  isEnabled(): boolean;
  setEnabled(enabled: boolean): void;
  invalidate(): void;
  uninstall(): void;
}

export const isImageLine = (line: string): boolean => line.includes("\x1b_G") || line.includes("\x1b]1337;File=");
const markerPattern = /\x1b_pi_md_img;(\d+)\x1b\\/g;
const reservedRowMarker = "\x1b_pi_md_img_row\x1b\\";
const cleanLabel = (text: string) => text.replace(/[\x00-\x1f\x7f-\x9f]/g, " ").slice(0, 512) || "image";

/** Patch token rendering, never Markdown.render (which pi-math wraps and rearms). */
export function installMarkdownImagePatch(options: PatchOptions): ImagePatch {
  const prototype = Markdown.prototype as unknown as MarkdownInternals;
  if (typeof prototype.renderToken !== "function" || typeof prototype.renderInlineTokens !== "function") {
    throw new Error("Unsupported pi-tui Markdown internals; tested with Pi 0.87.1");
  }
  const baseToken = prototype.renderToken;
  const baseInline = prototype.renderInlineTokens;
  const baseInvalidate = prototype.invalidate;
  const states = new WeakMap<MarkdownInternals, State>();
  const refs = new Set<WeakRef<MarkdownInternals>>();
  let installed = true;
  let enabled = true;
  let cwd = options.cwd;
  let showImages = options.showImages ?? true;
  let maxWidthCells = options.maxWidthCells ?? 60;
  let epoch = 0;
  let sourceNote: { text: string; context: MarkdownTransformContext; epoch: number } | undefined;
  let stream: { source: string; ids: Map<string, number> } | undefined;
  let redrawQueued = false;

  function redraw(): void {
    if (redrawQueued || !installed) return;
    redrawQueued = true;
    queueMicrotask(() => {
      redrawQueued = false;
      if (installed) options.requestRender();
    });
  }

  function stateFor(markdown: MarkdownInternals): State {
    let state = states.get(markdown);
    if (state) return state;
    const ref = new WeakRef(markdown);
    state = {
      ref, ids: new Map(), root: 0,
      notify: () => {
        if (!installed) return;
        ref.deref()?.invalidate();
        redraw();
      },
    };
    states.set(markdown, state);
    refs.add(ref);
    if (refs.size % 256 === 0) for (const old of refs) if (!old.deref()) refs.delete(old);
    return state;
  }

  function startPass(markdown: MarkdownInternals, state: State, width: number): void {
    const note = sourceNote?.text === markdown.text ? sourceNote : undefined;
    if (state.source === markdown.text && state.width === width &&
        state.cache?.deref() === markdown.cachedLines && state.epoch === note?.epoch) return;
    state.root = 0;
    state.width = width;
    state.source = markdown.text;
    state.cache = markdown.cachedLines ? new WeakRef(markdown.cachedLines) : undefined;
    state.epoch = note?.epoch;
    if (note?.context.messageType === "assistant" && note.context.isStreaming) {
      if (!stream || !markdown.text.startsWith(stream.source)) stream = { source: markdown.text, ids: new Map() };
      stream.source = markdown.text;
      state.ids = stream.ids;
    }
  }

  function preserveBlankImageRows(markdown: MarkdownInternals, state: State): boolean {
    if (state.restoreCache) return true;
    const descriptor = Object.getOwnPropertyDescriptor(markdown, "cachedLines");
    if (!descriptor?.configurable || !("value" in descriptor)) return false;
    let cached = markdown.cachedLines;
    const get = () => cached;
    Object.defineProperty(markdown, "cachedLines", {
      configurable: true,
      enumerable: descriptor.enumerable,
      get,
      set(lines: string[] | undefined) {
        // Core Markdown pads every non-image row, including Image's empty
        // reservation rows. Pi's main-screen renderer requires zero-width rows
        // to pre-clear the entire image area before drawing (otherwise WezTerm
        // erases the image's lower rows). Normalize after padding, at cache
        // assignment, which occurs immediately before core render returns this
        // same array. This avoids wrapping render and cycling with pi-math.rearm.
        if (lines) for (let i = 0; i < lines.length; i++) {
          if (lines[i]!.includes(reservedRowMarker)) lines[i] = "";
        }
        cached = lines;
      },
    });
    state.restoreCache = () => {
      const target = state.ref.deref();
      if (target && Object.getOwnPropertyDescriptor(target, "cachedLines")?.get === get) {
        Object.defineProperty(target, "cachedLines", { ...descriptor, value: cached });
      }
    };
    return true;
  }

  function insertImages(lines: string[], frame: Frame, paddingX: number): string[] {
    if (!frame.placements.size) return lines;
    const output: string[] = [];
    for (const line of lines) {
      if (isImageLine(line)) { output.push(line); continue; }
      for (const wrapped of wrapTextWithAnsi(line, frame.rootWidth)) {
        const placements: Placement[] = [];
        const caption = wrapped.replace(markerPattern, (_match, index: string) => {
          const placement = frame.placements.get(Number(index));
          if (placement) placements.push(placement);
          return "";
        });
        output.push(caption);
        for (const placement of placements) {
          const image = new Image(placement.raster.base64, "image/png", { fallbackColor: (s) => s }, {
            imageId: placement.id,
            maxWidthCells,
          }, placement.raster.dimensions);
          for (const row of image.render(placement.width)) {
            // Markdown deliberately bypasses padding/wrapping for image protocol rows.
            output.push(isImageLine(row) ? " ".repeat(paddingX + placement.indent) + row :
              row === "" ? reservedRowMarker : row);
          }
        }
      }
    }
    return output;
  }

  const patchedToken: TokenRenderer = function (token, width, ...args) {
    if (!installed) return baseToken.call(this, token, width, ...args);
    const state = stateFor(this);
    const outer = state.frame;
    if (!outer) startPass(this, state, width);
    const frame: Frame = outer ?? {
      rootWidth: width, width, table: false, root: state.root++, ordinal: 0, placements: new Map(),
    };
    const previousWidth = frame.width;
    const previousTable = frame.table;
    frame.width = width;
    frame.table ||= token.type === "table";
    state.frame = frame;
    try {
      const lines = baseToken.call(this, token, width, ...args);
      return outer ? lines : insertImages(lines, frame, this.paddingX ?? 0);
    } finally {
      frame.width = previousWidth;
      frame.table = previousTable;
      state.frame = outer;
    }
  };

  const patchedInline: InlineRenderer = function (tokens, ...args) {
    if (!installed) return baseInline.call(this, tokens, ...args);
    const state = stateFor(this);
    const frame = state.frame;
    const mapped = tokens.flatMap((token): Token[] => {
      if (token.type !== "image") return [token];
      const label = cleanLabel(token.text ?? "");
      const source = resolveSource(token.href ?? "", cwd);
      const text: Token = { type: "text", raw: label, text: label };
      const caption: Token = source?.href
        ? { type: "link", raw: label, text: label, href: source.href, tokens: [text] }
        : text;
      if (!frame || frame.table) return [caption];
      const ordinal = frame.ordinal++;
      if (!enabled || !showImages || !getCapabilities().images || this.defaultTextStyle?.italic || !source) return [caption];
      const entry = options.store.request(source, state.notify);
      if (entry?.status !== "ready" || !preserveBlankImageRows(this, state)) return [caption];
      const identity = `${frame.root}:${ordinal}:${source.key}`;
      let id = state.ids.get(identity);
      if (id === undefined) { id = allocateImageId(); state.ids.set(identity, id); }
      const index = frame.placements.size;
      frame.placements.set(index, {
        raster: entry.raster, id, width: frame.width, indent: Math.max(0, frame.rootWidth - frame.width),
      });
      const marker = `\x1b_pi_md_img;${index}\x1b\\`;
      return [caption, { type: "text", raw: marker, text: marker }];
    });
    return baseInline.call(this, mapped, ...args);
  };

  function patchedInvalidate(this: MarkdownInternals): void {
    const state = states.get(this);
    if (state) state.source = undefined;
    baseInvalidate.call(this);
  }

  function invalidate(): void {
    for (const ref of refs) {
      const markdown = ref.deref();
      if (markdown) markdown.invalidate();
      else refs.delete(ref);
    }
    redraw();
  }

  prototype.renderToken = patchedToken;
  prototype.renderInlineTokens = patchedInline;
  prototype.invalidate = patchedInvalidate;
  return {
    noteSource(text, context) { sourceNote = { text, context, epoch: ++epoch }; },
    beginMessage() { stream = undefined; sourceNote = undefined; },
    configure(next) {
      if (cwd === next.cwd && showImages === next.showImages && maxWidthCells === next.maxWidthCells) return;
      cwd = next.cwd;
      showImages = next.showImages;
      maxWidthCells = next.maxWidthCells;
      invalidate();
    },
    isEnabled: () => enabled,
    setEnabled(value) { enabled = value; invalidate(); },
    invalidate,
    uninstall() {
      if (!installed) return;
      invalidate();
      installed = false;
      if (prototype.renderToken === patchedToken) prototype.renderToken = baseToken;
      if (prototype.renderInlineTokens === patchedInline) prototype.renderInlineTokens = baseInline;
      if (prototype.invalidate === patchedInvalidate) prototype.invalidate = baseInvalidate;
      for (const ref of refs) {
        const markdown = ref.deref();
        if (markdown) states.get(markdown)?.restoreCache?.();
      }
      refs.clear();
      stream = undefined;
      sourceNote = undefined;
    },
  };
}
