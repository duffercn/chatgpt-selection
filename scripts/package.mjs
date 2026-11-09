import { createWriteStream } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import archiver from "archiver";

await mkdir(new URL("../release", import.meta.url), { recursive: true });
const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const output = createWriteStream(new URL(`../release/chat-copy-all-${packageJson.version}.zip`, import.meta.url));
const archive = archiver("zip", { zlib: { level: 9 } });
archive.pipe(output);
archive.directory(new URL("../dist", import.meta.url).pathname, false);
await archive.finalize();
