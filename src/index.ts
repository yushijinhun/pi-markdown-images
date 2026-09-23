import { SettingsManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getCapabilities } from "@earendil-works/pi-tui";
import { ImageStore } from "./images.js";
import { installMarkdownImagePatch, type ImagePatch } from "./markdown-patch.js";

const WIDGET = "pi-markdown-images";

export default function markdownImages(pi: ExtensionAPI): void {
  let patch: ImagePatch | undefined;
  let store: ImageStore | undefined;
  let requestRender: (() => void) | undefined;

  function settings(ctx: ExtensionContext) {
    const manager = SettingsManager.create(ctx.cwd, undefined, { projectTrusted: ctx.isProjectTrusted() });
    return { cwd: ctx.cwd, showImages: manager.getShowImages(), maxWidthCells: manager.getImageWidthCells() };
  }

  function stop(): void {
    store?.dispose();
    patch?.uninstall();
    requestRender?.();
    patch = undefined;
    store = undefined;
    requestRender = undefined;
  }

  pi.registerMarkdownTransformer((text, context) => {
    patch?.noteSource(text, context);
    return text;
  });

  pi.on("session_start", (_event, ctx) => {
    stop();
    if (ctx.mode !== "tui") return;
    store = new ImageStore();
    try {
      patch = installMarkdownImagePatch({
        ...settings(ctx), store, requestRender: () => requestRender?.(),
      });
      // The widget renders zero rows. Its factory supplies the host TUI redraw API.
      ctx.ui.setWidget(WIDGET, (tui) => {
        const render = () => tui.requestRender();
        requestRender = render;
        return {
          render: () => [],
          invalidate() {},
          dispose() { if (requestRender === render) requestRender = undefined; },
        };
      });
    } catch (error) {
      stop();
      ctx.ui.notify(`Markdown images: ${error instanceof Error ? error.message : String(error)}`, "warning");
    }
  });

  pi.on("message_start", (event) => {
    if (event.message.role === "assistant") patch?.beginMessage();
  });
  pi.on("turn_start", (_event, ctx) => {
    if (patch && ctx.mode === "tui") patch.configure(settings(ctx));
  });
  pi.on("session_shutdown", (_event, ctx) => {
    stop();
    if (ctx.mode === "tui") ctx.ui.setWidget(WIDGET, undefined);
  });

  pi.registerCommand("markdown-images", {
    description: "Inline Markdown images: on, off, status, clear",
    handler: async (args, ctx) => {
      if (!patch || !store || ctx.mode !== "tui") {
        ctx.ui.notify("Markdown images are available in interactive TUI mode.", "info");
        return;
      }
      patch.configure(settings(ctx));
      switch (args.trim() || "status") {
        case "on": patch.setEnabled(true); break;
        case "off": patch.setEnabled(false); break;
        case "clear": store.clear(); patch.invalidate(); break;
        case "status": break;
        default:
          ctx.ui.notify("Usage: /markdown-images [on|off|status|clear]", "info");
          return;
      }
      const state = patch.isEnabled() ? "on" : "off";
      const protocol = getCapabilities().images ?? "no image protocol";
      const visibility = settings(ctx).showImages ? "" : "; terminal.showImages is off";
      ctx.ui.notify(`Markdown images: ${state}; ${protocol}${visibility}; ${store.size} cached sources, ` +
        `${(store.cacheBytes / 1024 / 1024).toFixed(1)} MiB` +
        (store.lastError ? `\nLast load error: ${store.lastError}` : ""), "info");
    },
  });
}
