import assert from "node:assert/strict";
import test from "node:test";
import {
  Markdown, TuiMainScreen, setCapabilities, setCellDimensions, visibleWidth,
  type DefaultTextStyle, type Terminal,
} from "@earendil-works/pi-tui";
import { ImageStore } from "../src/images.js";
import { installMarkdownImagePatch, isImageLine } from "../src/markdown-patch.js";
import { dataUrl, load, theme } from "./helpers.js";

class TestTui extends TuiMainScreen {
  flush(): void { this.doRender(); }
}

function setup() {
  setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
  setCellDimensions({ widthPx: 10, heightPx: 20 });
}

function imageRows(line: string): number {
  const rows = Number(/\x1b_G[^;]*\br=(\d+)/.exec(line)?.[1]);
  assert.ok(rows > 1, "fixture must span several terminal rows");
  return rows;
}

test("reserved Kitty rows remain zero-width after Markdown padding and background styling", async () => {
  setup();
  const store = new ImageStore();
  await load(store);
  const patch = installMarkdownImagePatch({ cwd: process.cwd(), store, requestRender() {} });
  try {
    const originals: Array<{ md: Markdown; descriptor: PropertyDescriptor }> = [];
    const styles: Array<DefaultTextStyle | undefined> = [undefined, { bgColor: (s) => `\x1b[44m${s}\x1b[0m` }];
    for (const padding of [0, 2]) for (const style of styles) {
      const md = new Markdown(`- ![plot](${dataUrl})\n\nAfter`, padding, 1, theme, style);
      originals.push({ md, descriptor: Object.getOwnPropertyDescriptor(md, "cachedLines")! });
      const lines = md.render(60);
      const start = lines.findIndex(isImageLine);
      assert.ok(start >= 0);
      const rows = imageRows(lines[start]!);
      for (let offset = 1; offset < rows; offset++) {
        assert.equal(visibleWidth(lines[start + offset]!), 0,
          "Pi only pre-clears image rows whose visible width is zero");
      }
      assert.ok(!lines.join("").includes("pi_md_img"), "internal markers are removed");
      assert.equal((md as unknown as { defaultTextStyle?: DefaultTextStyle }).defaultTextStyle, style);
      assert.deepEqual(md.render(60), lines, "cached rendering keeps the blank rows");
    }
    patch.uninstall();
    for (const { md, descriptor } of originals) {
      assert.deepEqual(Object.getOwnPropertyDescriptor(md, "cachedLines"), { ...descriptor, value: undefined });
    }
  } finally { patch.uninstall(); store.dispose(); }
});

test("Pi pre-clears every Kitty row before drawing on full and differential renders", async () => {
  setup();
  const store = new ImageStore();
  await load(store);
  const patch = installMarkdownImagePatch({ cwd: process.cwd(), store, requestRender() {} });
  let writes = "";
  const terminal: Terminal = {
    columns: 60, rows: 40, kittyProtocolActive: false,
    write: (data) => { writes += data; },
    start() {}, stop() {}, async drainInput() {}, moveBy() {}, hideCursor() {}, showCursor() {},
    clearLine() {}, clearFromCursor() {}, clearScreen() {}, setTitle() {}, setProgress() {},
  };
  const tui = new TestTui(terminal);
  const source = (caption: string) => `Before\n\n![${caption}](${dataUrl})\n\nAfter`;
  const md = new Markdown(source("first"), 1, 0, theme);
  tui.addChild(md);
  try {
    for (const caption of ["first", "changed"]) {
      md.setText(source(caption));
      const lines = md.render(terminal.columns);
      const image = lines.find(isImageLine)!;
      const rows = imageRows(image);
      writes = "";
      tui.flush();
      // This is the host's multi-row drawing path: reserve/clear rows, move up,
      // draw, then skip the reserved rows. Drawing ordinary space-padded rows
      // after the image instead erases its lower rows in WezTerm.
      assert.ok(writes.includes(`\x1b[${rows - 1}A${image}\x1b[${rows - 1}B`),
        `${caption}: host must draw the complete image after preparing its rows`);
    }
  } finally { patch.uninstall(); store.dispose(); }
});
