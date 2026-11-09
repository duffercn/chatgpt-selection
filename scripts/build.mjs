import { cp, mkdir } from "node:fs/promises";
import { build } from "esbuild";

const root = new URL("../", import.meta.url);
const dist = new URL("../dist/", import.meta.url);

await mkdir(dist, { recursive: true });
await build({
  entryPoints: {
    content: new URL("../src/entries/content.js", import.meta.url).pathname,
    background: new URL("../src/entries/background.js", import.meta.url).pathname,
    popup: new URL("../src/entries/popup.js", import.meta.url).pathname,
    offscreen: new URL("../src/entries/offscreen.js", import.meta.url).pathname
  },
  outdir: dist.pathname,
  bundle: true,
  format: "iife",
  target: "chrome120",
  sourcemap: false
});

for (const name of ["manifest.json", "content.css", "popup.css", "popup.html", "offscreen.html"]) {
  await cp(new URL(name, root), new URL(name, dist));
}
await cp(new URL("icons", root), new URL("icons", dist), { recursive: true });
