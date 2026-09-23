# pi-markdown-images

Render Markdown `![alt](path-or-url)` as images in Pi's normal terminal transcript.
Captions remain clickable, with each image displayed below its caption. Works
alongside `@monotykamary/pi-math`.

## Load

Try it for one session:

```sh
pi -e ~/repos/pi-markdown-images
```

Or install the local package for future sessions:

```sh
pi install ~/repos/pi-markdown-images
```

No build is needed. Pi supplies the runtime dependencies. Requires Node 22.19+
and a Pi-supported image terminal, such as WezTerm, Kitty or iTerm2. Tested with
Pi **0.87.1** and pi-math **0.5.6**.

## Use

Images in rendered Markdown messages appear automatically:

```md
![Results](/absolute/path/results.png)
![Local plot](./plots/results.png)
![From home](~/Pictures/results.png)
![Remote plot](https://example.com/results.png)
```

- Local relative paths resolve against Pi's working directory, not against a
  Markdown file mentioned in the message. `file://` URLs and percent-encoded
  spaces work too.
- PNG, JPEG, GIF and WebP are supported; non-PNG images are converted through
  Pi's image decoder. Animated images are displayed as a still frame.
- HTTP(S) images are fetched automatically when their Markdown is rendered,
  without browser cookies or authorization headers. Redirects are followed.
  Base64 `data:image/...` URLs are also supported.
- Reference images, linked images, headings, lists and blockquotes work. Images
  inside table cells stay as links; code spans, fenced code and HTML `<img>` tags
  are not rendered as images. SVG is not supported.
- Images load asynchronously. Missing files, failed downloads, unsupported
  formats and terminals without image support keep their caption/link. Use
  `/markdown-images status` to see the latest load error.

The extension respects Pi's `terminal.showImages` and
`terminal.imageWidthCells` settings, and uses Pi's detected image protocol.
Settings are refreshed at turn start and when running an extension command.
Transient thinking blocks do not load images. Terminal drawing and scrolling
are handled by Pi, including its protocol limitations in fullscreen mode.

### Commands

```text
/markdown-images status
/markdown-images off
/markdown-images on
/markdown-images clear
```

`clear` cancels pending work and clears cached images/errors, allowing changed
files or failed URLs to be loaded again. These commands affect the current
session. Rendering does not change saved messages or model context.

### Limits

Up to four concurrent loads, with a 15-second timeout per load. Each source is
limited to 16 MiB and 16 million pixels; converted PNGs are limited to 24 MiB.
The cache holds up to 128 sources and 64 MiB of base64 PNG data. Once full,
additional images retain their text fallback until `clear` or a new session.
Pi's own rendered-line and terminal graphics caches are separate.

## Development

```sh
npm ci
npm run check
```

Tests exercise the real Pi Markdown renderer and extension loader, async
redraws, local and HTTP loading, image protocol output, streaming IDs, cleanup,
and the real pi-math renderer in both extension load orders. Terminal-write tests
verify that Pi prepares all image rows before drawing, including incremental
redraws in WezTerm.

### Implementation

`src/images.ts` resolves and loads images with bounded caching.
`src/markdown-patch.ts` adds reversible hooks to Markdown's token rendering.
Native Markdown parsing identifies image tokens; invisible layout markers are
replaced with Pi `Image` component rows after lists/quotes finish wrapping.
An instance-local `cachedLines` accessor removes Markdown's padding from marked
image reservation rows before rendering returns. These rows must have zero
visible width so Pi clears them before drawing the image, rather than erasing
its lower rows afterward. The accessor is restored on extension shutdown.
`src/index.ts` manages TUI lifecycle, settings and commands. A widget that emits
zero rows supplies the host's redraw callback.

Pi does not expose an image-token renderer hook, so this extension uses the
private `renderToken` and `renderInlineTokens` methods and a few Markdown cache
fields. Pi upgrades may require adjustments. It does not wrap `Markdown.render`,
so pi-math's render wrapper and `rearm()` can coexist without a delegation cycle.
Other extensions that replace token rendering may need separate compatibility
work.

## License

MIT
