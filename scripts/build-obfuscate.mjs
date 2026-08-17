#!/usr/bin/env node

// 混淆构建脚本：对核心商业逻辑模块（幻灯片布局引擎、PPTX 导出）做
// bundle + minify（变量名压缩、代码打平），产出难以直接阅读的产物，
// 发布打包时用产物替换源码，防止下载即用的复制党直接拿到可读实现。
//
// 用法：node scripts/build-obfuscate.mjs
// 输出：dist/obfuscated/<模块名>.mjs

import { build } from "esbuild";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(scriptDir, "..");
const outDir = path.resolve(rootDir, "dist", "obfuscated");

// 核心入口。共享基础设施（store/paths）必须保持 external：
// store.mjs 持有跨进程锁和内存状态，bundle 成两份副本会导致状态不一致。
const targets = [
  {
    name: "slides-layout-engine",
    entry: path.join(rootDir, "src", "slides-layout-engine.mjs")
  },
  {
    name: "pptx-export",
    entry: path.join(rootDir, "src", "pptx-export.mjs")
  }
];

// 本地共享模块，从 bundle 中排除，运行时继续解析 src/ 下的源码。
const sharedModules = ["./paths.mjs", "./store.mjs"];

export async function buildObfuscated() {
  await fs.mkdir(outDir, { recursive: true });

  const summary = [];
  for (const { name, entry } of targets) {
    const result = await build({
      entryPoints: { [name]: entry },
      bundle: true,
      platform: "node",
      target: "node18",
      format: "esm",
      minify: true,
      charset: "utf8",
      legalComments: "none",
      sourcemap: false,
      write: false,
      outExtension: { ".js": ".mjs" },
      external: ["node:*", ...sharedModules],
      outdir: outDir,
      logLevel: "warning"
    });
    const outputFile = result.outputFiles?.find((file) => file.path.endsWith(`${name}.mjs`));
    if (!outputFile) {
      throw new Error(`No output emitted for ${name}.`);
    }
    await fs.writeFile(outputFile.path, outputFile.contents);
    summary.push({ name, outputFile: path.relative(rootDir, outputFile.path), bytes: outputFile.contents.byteLength });
  }

  return { outputDir: outDir, targets: summary };
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  buildObfuscated()
    .then(({ targets }) => {
      console.log(JSON.stringify({ ok: true, targets }, null, 2));
    })
    .catch((error) => {
      console.error(error?.stack || error);
      process.exitCode = 1;
    });
}
