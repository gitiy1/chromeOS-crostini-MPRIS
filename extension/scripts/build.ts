import { cpSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const srcDir = join(root, "src");
const publicDir = join(root, "public");
const distDir = join(root, "dist");

const watch = process.argv.includes("--watch");

async function buildOnce() {
  rmSync(distDir, { force: true, recursive: true });
  mkdirSync(distDir, { recursive: true });
  cpSync(publicDir, distDir, { recursive: true });

  await Bun.build({
    entrypoints: [join(srcDir, "background.ts"), join(srcDir, "offscreen.ts"), join(srcDir, "popup.ts")],
    outdir: distDir,
    target: "browser",
    format: "esm",
    sourcemap: "inline",
    minify: false,
  });

  console.log("build complete");
}

await buildOnce();

if (watch) {
  const watcher = Bun.watch({
    paths: [srcDir, publicDir],
    async onChange() {
      await buildOnce();
    },
  });
  console.log("watching...", watcher);
}
