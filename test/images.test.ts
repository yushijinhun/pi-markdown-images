import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { ImageStore, resolveSource } from "../src/images.js";
import { dataUrl, load, png } from "./helpers.js";

test("paths, file URLs, data URLs and HTTP destinations resolve without terminal controls", () => {
  assert.equal(resolveSource("./a%20b.png", "/work")?.value, "/work/a b.png");
  assert.equal(resolveSource("~/plot.png", "/work")?.value, join(homedir(), "plot.png"));
  assert.equal(resolveSource("file:///tmp/a%20b.png", "/work")?.value, "/tmp/a b.png");
  assert.equal(resolveSource("https://example.com/a.png#hash", "/")?.value, "https://example.com/a.png");
  assert.equal(resolveSource("https://user:pass@example.com/a.png", "/"), undefined);
  assert.equal(resolveSource("javascript:alert(1)", "/"), undefined);
  assert.equal(resolveSource("bad\x1b]8;;url.png", "/"), undefined);
  assert.ok(resolveSource(dataUrl, "/")?.key.length! < 100, "data cache keys do not retain base64");
});

test("loads actual files and data; rejects missing, oversized and non-image files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-markdown-images-"));
  const store = new ImageStore({ sourceBytes: 1024 });
  try {
    await writeFile(join(dir, "plot space.png"), png());
    const raster = await load(store, "plot%20space.png", dir);
    assert.equal(raster.status, "ready");
    if (raster.status === "ready") assert.deepEqual(raster.raster.dimensions, { widthPx: 120, heightPx: 80 });
    assert.equal((await load(store, pathToFileURL(join(dir, "plot space.png")).href)).status, "ready");
    assert.equal((await load(store)).status, "ready");
    assert.equal((await load(store, "missing.png", dir)).status, "error");
    assert.equal((await load(store, dir)).status, "error");
    await writeFile(join(dir, "text.png"), "not a png");
    assert.equal((await load(store, "text.png", dir)).status, "error");
    await writeFile(join(dir, "large.png"), Buffer.alloc(1025));
    assert.equal((await load(store, "large.png", dir)).status, "error");
  } finally { store.dispose(); await rm(dir, { recursive: true, force: true }); }
});

test("converts a GIF to a real PNG for Kitty", async () => {
  const store = new ImageStore();
  try {
    const result = await load(store, "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==");
    assert.equal(result.status, "ready");
    if (result.status === "ready") {
      assert.equal(Buffer.from(result.raster.base64, "base64").toString("hex", 0, 8), "89504e470d0a1a0a");
      assert.deepEqual(result.raster.dimensions, { widthPx: 1, heightPx: 1 });
    }
  } finally { store.dispose(); }
});

test("HTTP redirects, deduplication, size limits, timeout and cancellation", async () => {
  const hits = new Map<string, number>();
  const server = createServer((req, res) => {
    hits.set(req.url!, (hits.get(req.url!) ?? 0) + 1);
    if (req.url === "/redirect") { res.writeHead(302, { location: "/ok" }); res.end(); }
    else if (req.url === "/ok") res.end(png());
    else if (req.url === "/chunked") { res.write(Buffer.alloc(600)); res.end(Buffer.alloc(600)); }
    else if (req.url === "/length") { res.writeHead(200, { "content-length": "2000" }); res.end(); }
    else if (req.url === "/slow") { /* The abort signal closes this connection. */ }
    else { res.writeHead(404); res.end(); }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}`;
  const store = new ImageStore({ sourceBytes: 1024, timeoutMs: 1000 });
  try {
    const results = await Promise.all([load(store, url + "/redirect"), load(store, url + "/redirect")]);
    assert.ok(results.every((result) => result.status === "ready"));
    assert.equal(hits.get("/redirect"), 1);
    assert.equal(hits.get("/ok"), 1);
    for (const path of ["/chunked", "/length", "/missing", "/slow"]) {
      assert.equal((await load(store, url + path)).status, "error", path);
    }
    await load(store, url + "/missing");
    assert.equal(hits.get("/missing"), 1, "negative cache avoids repeated requests");
    store.clear();
    let notified = false;
    store.request(resolveSource(url + "/slow", "/")!, () => { notified = true; });
    store.clear();
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(notified, false, "cancelled generation never notifies or repopulates cache");
    assert.equal(store.size, 0);
    assert.equal((await load(store, url + "/ok")).status, "ready");
  } finally {
    store.dispose();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("cache and pixel budgets stop further loads without an eviction/redraw loop", async () => {
  const store = new ImageStore({ entries: 1 });
  try {
    await load(store);
    assert.equal(store.request(resolveSource("missing.png", "/")!, () => {}), undefined);
    assert.equal(store.size, 1);
    store.clear();
    assert.equal(store.size, 0);
    assert.equal(store.cacheBytes, 0);
  } finally { store.dispose(); }
  for (const limits of [{ pixels: 10 }, { cacheBytes: 10 }, { pngBytes: 10 }]) {
    const limited = new ImageStore(limits);
    try { assert.equal((await load(limited)).status, "error"); }
    finally { limited.dispose(); }
  }
});
