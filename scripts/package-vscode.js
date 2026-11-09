import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const staging = path.join(root, "dist", "vscode");
fs.mkdirSync(path.dirname(staging), { recursive: true });
fs.rmSync(staging, { recursive: true, force: true });
fs.cpSync(path.join(root, "vscode"), staging, { recursive: true });
for (const name of ["src", "ui"])
  fs.cpSync(path.join(root, name), path.join(staging, "runtime", name), {
    recursive: true,
  });
fs.copyFileSync(
  path.join(root, "package.json"),
  path.join(staging, "runtime", "package.json"),
);
for (const name of ["README.md", "LICENSE"])
  fs.copyFileSync(path.join(root, name), path.join(staging, name));
const executable = process.platform === "win32" ? "npx.cmd" : "npx";
const result = spawnSync(
  executable,
  [
    "--yes",
    "@vscode/vsce@3.7.1",
    "package",
    "--out",
    path.join(root, "dist", "pr-manager-0.1.0.vsix"),
  ],
  {
    cwd: staging,
    stdio: "inherit",
    shell: false,
  },
);
if (result.error) throw result.error;
process.exitCode = result.status || 0;
