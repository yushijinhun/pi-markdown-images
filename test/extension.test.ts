import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { discoverAndLoadExtensions } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { isImageLine } from "../src/markdown-patch.js";
import { dataUrl, theme } from "./helpers.js";

// The host's shrinkwrap installs a nested pi-tui. The loader aliases extensions
// to that instance, not to the top-level dev dependency used by the unit tests.
const hostRequire = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
const hostTui: typeof import("@earendil-works/pi-tui") = await import(
  pathToFileURL(hostRequire.resolve("@earendil-works/pi-tui")).href
);
const { Markdown, setCapabilities } = hostTui;

test("Pi's loader discovers the package; TUI startup, command, shutdown and reload work", { timeout: 10_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-markdown-images-loader-"));
  const root = fileURLToPath(new URL("../", import.meta.url));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  const loaded = await discoverAndLoadExtensions([root], dir, dir);
  assert.deepEqual(loaded.errors, []);
  assert.equal(loaded.extensions.length, 1);
  const extension = loaded.extensions[0]!;
  assert.ok(extension.commands.has("markdown-images"));
  let widget: Component | undefined;
  const getWidget = () => widget;
  let renderRequested: (() => void) | undefined;
  const notifications: string[] = [];
  const context = {
    cwd: dir,
    mode: "rpc",
    isProjectTrusted: () => false,
    ui: {
      notify: (text: string) => notifications.push(text),
      setWidget: (_name: string, factory?: (tui: TUI) => Component) => {
        widget = factory?.({ requestRender: () => renderRequested?.() } as TUI);
      },
    },
  };
  async function emit(name: string) {
    for (const handler of extension.handlers.get(name) ?? []) await handler({ type: name }, context);
  }
  try {
    setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
    await emit("session_start");
    assert.equal(getWidget(), undefined, "RPC mode stays inactive");
    context.mode = "tui";
    for (let i = 0; i < 2; i++) {
      await emit("session_start");
      assert.deepEqual(getWidget()?.render(60), []);
      const md = new Markdown(`![loaded](${dataUrl})`, 0, 0, theme, undefined, {
        transform: (text, availableWidth) => extension.markdownTransformer!(text, {
          messageType: "assistant", isStreaming: false, availableWidth,
        }),
      });
      const redraw = new Promise<void>((resolve) => { renderRequested = resolve; });
      md.render(60);
      await redraw;
      assert.ok(md.render(60).some(isImageLine), "loader aliases host Markdown correctly");
      await extension.commands.get("markdown-images")!.handler("off", context as never);
      assert.equal(md.render(60).some(isImageLine), false);
      assert.ok(notifications.at(-1)?.includes("off"));
      await emit("session_shutdown");
      assert.equal(widget, undefined);
      assert.equal(md.render(60).some(isImageLine), false);
    }
  } finally {
    await emit("session_shutdown");
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(dir, { recursive: true, force: true });
  }
});
