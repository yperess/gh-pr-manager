import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Manager, run } from "./core.js";

const recordPath = (manager) => path.join(manager.dir, "ui-worktree.json");

// UI sessions follow the managed checkout even after the user's workspace switches
// branches. CLI commands remain explicitly tied to their current directory.
export function resolveUiManager(manager) {
  const file = recordPath(manager);
  if (!fs.existsSync(file)) return manager;
  const record = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!fs.existsSync(record.path)) return manager;
  const worker = new Manager(record.path, manager.ghOverride, {
    onProgress: manager.onProgress,
  });
  if (
    fs.realpathSync(worker.common) !== fs.realpathSync(manager.common) ||
    worker.branch() !== manager.state().branch ||
    worker.branch() !== record.branch
  )
    throw new Error(
      `The isolated checkout changed. Inspect ${record.path} before continuing.`,
    );
  worker.uiWorktree = record;
  return worker;
}

// Called inside continuousPush's startup lock, after revision/cleanliness checks.
export function prepareUiWorktree(manager) {
  if (manager.uiWorktree) return manager;
  const state = manager.state(),
    head = manager.head(),
    revision = manager.graph().revision,
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "gh-prm-")));
  let added = false;
  try {
    manager.git("worktree", "add", "--detach", dir, head);
    added = true;
    // Local .ghprm files may be ignored rather than committed. Carry their
    // configuration over so isolation never silently changes branch names.
    const config = path.join(manager.root, ".ghprm");
    if (fs.existsSync(config))
      fs.copyFileSync(config, path.join(dir, ".ghprm"));
    manager.onBranch(state);
    manager.clean();
    if (manager.graph().revision !== revision)
      throw new Error("The source changed while preparing the checkout.");
    // Release the branch without changing any files in the user's checkout.
    manager.git("switch", "--detach", head);
    run("git", ["switch", state.branch], dir);
    const worker = new Manager(dir, manager.ghOverride, {
      onProgress: manager.onProgress,
    });
    worker.onBranch(state);
    worker.clean();
    if (worker.head() !== head)
      throw new Error("The managed branch moved during checkout handoff.");
    const record = {
      path: dir,
      originalRoot: manager.root,
      branch: state.branch,
    };
    const temp = `${recordPath(manager)}.${randomUUID()}`;
    fs.writeFileSync(temp, `${JSON.stringify(record, null, 2)}\n`, {
      mode: 0o600,
    });
    fs.renameSync(temp, recordPath(manager));
    worker.uiWorktree = record;
    worker.progress(`Isolated push checkout: ${dir}`);
    return worker;
  } catch (error) {
    // Never force removal or overwrite edits made concurrently or by Git hooks.
    try {
      if (added) manager.git("worktree", "remove", dir);
      else fs.rmSync(dir, { recursive: true });
      if (
        manager.optionalGit("symbolic-ref", "--quiet", "HEAD") === null &&
        manager.head() === head
      ) {
        manager.clean();
        manager.git("switch", state.branch);
      }
    } catch (cleanup) {
      throw new Error(
        `${error.message}\nCheckout recovery may be needed in ${dir} and ${manager.root}: ${cleanup.message}`,
      );
    }
    throw error;
  }
}
