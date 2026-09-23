import assert from "node:assert/strict";
import test from "node:test";
import { Markdown, setCapabilities, setCellDimensions } from "@earendil-works/pi-tui";
import { ImageStore } from "../src/images.js";
import { installMarkdownImagePatch, isImageLine } from "../src/markdown-patch.js";
import { dataUrl, kittyIds, load, theme } from "./helpers.js";

// Exercise the real pi-math implementation, sharing the same host pi-tui peer.
const mathRoot = import.meta.resolve("@monotykamary/pi-math");
const { installMarkdownMathPatch } = await import(new URL("./markdown-patch.ts", mathRoot).href);
const { createTerminalMathRenderer } = await import(new URL("./renderer.ts", mathRoot).href);

for (const order of ["math-first", "images-first"]) {
  test(`pi-math interoperability: ${order}, rearm, async completion, resize, cleanup`, async () => {
    setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
    setCellDimensions({ widthPx: 10, heightPx: 20 });
    const originalRender = Markdown.prototype.render;
    const renderer = await createTerminalMathRenderer();
    const store = new ImageStore();
    const installImages = () => installMarkdownImagePatch({ cwd: process.cwd(), store, requestRender() {} });
    const math = order === "math-first" ? installMarkdownMathPatch(renderer) : undefined;
    const images = installImages();
    const mathPatch = math ?? installMarkdownMathPatch(renderer);
    const source = `Inline $x^2$ and ![plot](${dataUrl}).\n\n$$\n\\frac{a}{b}\n$$`;
    const md = new Markdown(source, 1, 0, theme);
    try {
      mathPatch.rearm();
      mathPatch.rearm();
      const pending = md.render(70);
      await load(store);
      const complete = md.render(70);
      assert.equal(kittyIds(complete).length, kittyIds(pending).length + 1, "async plot appears alongside formulas");
      assert.ok(kittyIds(complete).length >= 3, "inline math, display math and Markdown plot all rendered");
      assert.equal((md as unknown as { text: string }).text, source);
      assert.deepEqual(md.render(70), complete);
      assert.ok(md.render(40).some(isImageLine));
      images.setEnabled(false);
      assert.ok(kittyIds(md.render(70)).length >= 2, "math still renders when images disabled");
      mathPatch.rearm();
      images.setEnabled(true);
      assert.ok(kittyIds(md.render(70)).length >= 3);
    } finally {
      images.uninstall();
      mathPatch.uninstall();
      store.dispose();
      renderer.clear();
    }
    assert.equal(Markdown.prototype.render, originalRender);
  });
}
