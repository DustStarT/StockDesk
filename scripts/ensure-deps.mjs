/**
 * v1.2: 让 `npm start` / `npm run dist` 在缺少 devDependencies 时自动补装。
 * 解决全新源码目录直接启动时报 electron / electron-builder not found 的问题。
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const bin = (name) => {
  const base = join(root, "node_modules", ".bin", name);
  return existsSync(base) || existsSync(base + ".cmd") || existsSync(base + ".ps1");
};

const needElectron = !bin("electron");
const needBuilder = process.argv.includes("--builder") && !bin("electron-builder");
if (!needElectron && !needBuilder) process.exit(0);

console.log("[StockDesk] 检测到开发依赖未安装，自动执行 npm install --include=dev ...");
const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
const r = spawnSync(npmCmd, ["install", "--include=dev", "--no-audit", "--no-fund"], {
  cwd: root,
  stdio: "inherit",
  shell: process.platform === "win32",
  env: process.env,
});
if (r.status !== 0 || !bin("electron") || (process.argv.includes("--builder") && !bin("electron-builder"))) {
  console.error("\n[StockDesk] 依赖自动安装失败。若 Electron 下载受限，可先设置 npm 镜像/ELECTRON_MIRROR 后重试。\n");
  process.exit(r.status || 1);
}
console.log("[StockDesk] 依赖安装完成。\n");
