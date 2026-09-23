import assert from "node:assert/strict";
import test from "node:test";
import { Markdown, setCapabilities, setCellDimensions, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { ImageStore } from "../src/images.js";
import { installMarkdownImagePatch, isImageLine } from "../src/markdown-patch.js";
import { dataUrl, kittyIds, load, theme } from "./helpers.js";

function capabilities(images: "kitty" | "iterm2" | null = "kitty") {
  setCapabilities({ images, trueColor: true, hyperlinks: true });
  setCellDimensions({ widthPx: 10, heightPx: 20 });
}

test("async image loads invalidate an already rendered Markdown and preserve the source", async () => {
  capabilities();
  const store = new ImageStore();
  let redraw!: () => void;
  const rendered = new Promise<void>((resolve) => { redraw = resolve; });
  const patch = installMarkdownImagePatch({ cwd: process.cwd(), store, requestRender: redraw });
  const source = `Before ![a plot](${dataUrl}) after.`;
  const md = new Markdown(source, 1, 0, theme);
  try {
    assert.equal(md.render(50).some(isImageLine), false);
    await rendered;
    const lines = md.render(50);
    assert.equal(lines.filter(isImageLine).length, 1);
    assert.match(stripTerminalSequences(lines.join("\n")), /Before a plot after\./);
    assert.equal((md as unknown as { text: string }).text, source);
    assert.ok(lines.every((line) => visibleWidth(line) <= 50));
    assert.deepEqual(md.render(50), lines);
    assert.deepEqual(kittyIds(md.render(25)), kittyIds(lines), "resize keeps placement ID");
    patch.setEnabled(false);
    assert.equal(md.render(50).some(isImageLine), false);
    patch.setEnabled(true);
    assert.equal(md.render(50).some(isImageLine), true);
  } finally { patch.uninstall(); store.dispose(); }
});

test("native Markdown parsing handles references, lists, quotes and linked images; excludes code and tables", async () => {
  capabilities();
  const store = new ImageStore();
  await load(store);
  const patch = installMarkdownImagePatch({ cwd: process.cwd(), store, requestRender() {} });
  try {
    const samples = [
      `![caption][pic]\n\n[pic]: ${dataUrl}`,
      `- ![caption](${dataUrl})\n  - ![nested](${dataUrl})`,
      `> ![caption](${dataUrl})`,
      `[![caption](${dataUrl})](https://example.com)`,
      `**![caption](${dataUrl})**`,
      `long text before ![caption](${dataUrl}) and after ![second](${dataUrl})`,
    ];
    for (const source of samples) {
      const lines = new Markdown(source, 1, 0, theme).render(35);
      assert.equal(lines.filter(isImageLine).length, source.includes("nested") || source.includes("second") ? 2 : 1, source);
      assert.ok(lines.every((line) => visibleWidth(line) <= 35), "all lines fit terminal");
      assert.ok(!lines.join("").includes("pi_md_img"), "no internal markers escape");
      const ids = kittyIds(lines);
      assert.equal(new Set(ids).size, ids.length, "each occurrence has its own Kitty ID");
    }
    for (const source of [
      `\`![code](${dataUrl})\``,
      `\`\`\`md\n![code](${dataUrl})\n\`\`\``,
      `| image |\n| --- |\n| ![table](${dataUrl}) |`,
    ]) assert.equal(new Markdown(source, 0, 0, theme).render(40).some(isImageLine), false);
  } finally { patch.uninstall(); store.dispose(); }
});

test("streamed fresh Markdown instances reuse IDs; different messages do not", async () => {
  capabilities();
  const store = new ImageStore();
  await load(store);
  const patch = installMarkdownImagePatch({ cwd: process.cwd(), store, requestRender() {} });
  const render = (text: string, streaming: boolean) => new Markdown(text, 0, 0, theme, undefined, {
    transform: (text, width) => {
      patch.noteSource(text, { messageType: "assistant", isStreaming: streaming, availableWidth: width });
      return text;
    },
  }).render(60);
  try {
    const source = `![first](${dataUrl}) ![second](${dataUrl})`;
    const a = render(source, true);
    const b = render(source + "\n\nMore prose", true);
    assert.deepEqual(a.filter(isImageLine), b.filter(isImageLine));
    patch.beginMessage();
    assert.notDeepEqual(kittyIds(render(source, true)), kittyIds(a));
    assert.notDeepEqual(kittyIds(render(source, false)), kittyIds(render(source, false)));
  } finally { patch.uninstall(); store.dispose(); }
});

test("iTerm2 emits a graphic and reserved rows; unsupported terminals and reasoning never load", async () => {
  const store = new ImageStore();
  const patch = installMarkdownImagePatch({ cwd: process.cwd(), store, requestRender() {} });
  try {
    capabilities(null);
    const md = new Markdown("![missing](./no-such-image.png)", 0, 0, theme);
    assert.ok(md.render(60).join("").includes("file://"), "fallback is clickable");
    assert.equal(store.size, 0);
    capabilities();
    new Markdown(`![reasoning](${dataUrl})`, 0, 0, theme, { italic: true }).render(60);
    assert.equal(store.size, 0);
    patch.configure({ cwd: process.cwd(), showImages: false, maxWidthCells: 60 });
    new Markdown(`![hidden](${dataUrl})`, 0, 0, theme).render(60);
    assert.equal(store.size, 0);
    patch.configure({ cwd: process.cwd(), showImages: true, maxWidthCells: 60 });
    await load(store);
    capabilities("iterm2");
    const lines = new Markdown(`![plot](${dataUrl})`, 0, 0, theme).render(60);
    assert.equal(lines.filter(isImageLine).length, 1);
    assert.ok(lines.length >= 5, "caption plus image height");
    assert.ok(lines.some((line) => line.includes("\x1b]1337;File=")));
  } finally { patch.uninstall(); store.dispose(); }
});

test("uninstall restores prototype methods and invalidates rendered image lines", async () => {
  capabilities();
  const before = { ...Markdown.prototype };
  const render = Markdown.prototype.render;
  const store = new ImageStore();
  await load(store);
  const patch = installMarkdownImagePatch({ cwd: process.cwd(), store, requestRender() {} });
  const md = new Markdown(`![plot](${dataUrl})`, 0, 0, theme);
  assert.ok(md.render(60).some(isImageLine));
  patch.uninstall();
  patch.uninstall();
  store.dispose();
  assert.equal(Markdown.prototype.render, render);
  assert.deepEqual({ ...Markdown.prototype }, before);
  assert.equal(md.render(60).some(isImageLine), false);
});
