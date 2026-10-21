import { TuiMainScreen } from "@earendil-works/pi-tui";

// Pi's main-screen renderer reserves rows for a Kitty image only when it fits on screen. A taller
// image is drawn as one C=1 placement on the cursor row, and WezTerm clips C=1 placements at the
// bottom screen row, so usually only a one-row strip survives. Draw such images one row at a time
// instead: the first row transmits the image and places its top slice, and each later row places
// the next slice. Each slice needs its own placement id, because WezTerm removes every placement
// of an image when another one is drawn without an id.
interface MainScreenInternals {
  terminal: { rows: number };
  applyLineResets(lines: string[]): string[];
}

const kittyCommand = /\x1b_G([^;\x1b]*);([A-Za-z0-9+/=]{0,32})/;
const isImageLine = (line: string) => line.includes("\x1b_G") || line.includes("\x1b]1337;File=");
// Reserved image rows hold nothing but SGR and OSC 8 resets.
const isBlank = (line: string) => line.replace(/\x1b\[[\d;]*m|\x1b\]8;;[^\x07\x1b]*(?:\x07|\x1b\\)/g, "") === "";

/** Pixel height from the start of a base64 PNG payload. */
function pngHeight(base64: string): number | undefined {
  const header = Buffer.from(base64, "base64");
  return header.length >= 24 && header.readUInt32BE(0) === 0x89504e47 ? header.readUInt32BE(20) : undefined;
}

/** Replace each Kitty image block taller than `height` rows by one placement per row. */
export function splitTallKittyImages(lines: string[], height: number): string[] {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const match = kittyCommand.exec(line);
    if (!match) continue;
    const controls = match[1]!.split(",");
    const rows = Number(controls.find((control) => control.startsWith("r="))?.slice(2));
    if (!(rows > height) || !["a=T", "f=100", "C=1"].every((control) => controls.includes(control)) ||
        controls.some((control) => /^[yhp]=/.test(control))) continue;
    const heightPx = pngHeight(match[2]!);
    if (!heightPx) continue;
    let reserved = 1;
    while (reserved < rows && i + reserved < lines.length &&
      !isImageLine(lines[i + reserved]!) && isBlank(lines[i + reserved]!)) reserved++;
    // Rows covered by an overlay keep Pi's normal path until the overlay closes.
    if (reserved < rows) continue;

    const sourceY = (row: number) => Math.round((heightPx * row) / rows);
    const slice = (row: number) =>
      [`y=${sourceY(row)}`, `h=${Math.max(1, sourceY(row + 1) - sourceY(row))}`, "r=1", `p=${row + 1}`];
    const prefix = line.slice(0, match.index);
    const transmit = [...controls.filter((control) => !/^[rm]=/.test(control)), ...slice(0),
      ...controls.filter((control) => control.startsWith("m="))];
    lines[i] = `${prefix}\x1b_G${transmit.join(",")}${line.slice(match.index + 3 + match[1]!.length)}`;
    const placement = controls.filter((control) => /^[qCicxwzXY]=/.test(control));
    for (let row = 1; row < rows; row++) {
      lines[i + row] = `${prefix}\x1b_G${["a=p", ...placement, ...slice(row)].join(",")}\x1b\\`;
    }
    i += rows - 1;
  }
  return lines;
}

/**
 * Patch the main-screen renderer's last per-frame line pass. It runs after overlays are composited
 * and before lines are compared with the previous frame, so Pi diffs and redraws the slices.
 */
export function installTallImagePatch(): () => void {
  const prototype = TuiMainScreen.prototype as unknown as MainScreenInternals;
  const base = prototype.applyLineResets;
  if (typeof base !== "function") throw new Error("Unsupported pi-tui TuiMainScreen internals; tested with Pi 1.3.0");
  const own = Object.prototype.hasOwnProperty.call(prototype, "applyLineResets");
  const patched = function (this: MainScreenInternals, lines: string[]): string[] {
    return base.call(this, splitTallKittyImages(lines, this.terminal.rows));
  };
  prototype.applyLineResets = patched;
  return () => {
    if (prototype.applyLineResets !== patched) return;
    if (own) prototype.applyLineResets = base;
    else delete (prototype as Partial<MainScreenInternals>).applyLineResets;
  };
}
