import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Manager, run } from "../src/core.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prm-demo-"));
const root = path.join(dir, "workspace");
fs.mkdirSync(root);
const git = (...args) => run("git", args, root);
run(
  "git",
  ["init", "--bare", "--initial-branch=main", path.join(dir, "origin.git")],
  dir,
);
git("init", "--initial-branch=main");
git("config", "user.name", "PR Manager Demo");
git("config", "user.email", "demo@example.com");
git("config", "commit.gpgsign", "false");
fs.writeFileSync(
  path.join(root, "README.txt"),
  "A disposable PR Manager demo.\n",
);
git("add", ".");
git("commit", "-m", "Initial project");
git("remote", "add", "origin", path.join(dir, "origin.git"));
git("push", "-u", "origin", "main");
git("switch", "-c", "work/demo");
const manager = new Manager(root);
manager.init({
  base: "main",
  repo: "https://github.com/yperess/gh-pr-manager",
});
const subjects = [
  "A: Add ontology builder",
  "B: Add optional interfaces",
  "C: Define struct fixture",
  "D: Cover array fields",
  "E: Address builder review",
  "F: Test optional struct arguments",
];
for (const [i, subject] of subjects.entries()) {
  fs.writeFileSync(path.join(root, `${"ABCDEF"[i]}.txt`), `${subject}\n`);
  git("add", ".");
  git("commit", "-m", subject);
  manager.tag(
    i === 0 || i === 4 ? "feature1" : i === 1 ? "feature2" : "feature3",
  );
}
manager.dependencies("feature3", ["feature1", "feature2"]);
console.log(root);
console.log("Disposable demo created. Run gh prm view from this directory.");
