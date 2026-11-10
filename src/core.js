import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

import { readPushRun, assertPushRunOwner } from "./push-run.js";

export const NOTES = "refs/notes/prm";

// Deliberately not shell syntax: never execute or expand repository config.
export function parseConfig(text) {
  let branchPrefix = "prm/";
  let seen = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^BRANCH_PREFIX\s*=\s*(.*?)\s*$/);
    if (!match || seen)
      throw new Error(
        "Invalid .ghprm: expected a single BRANCH_PREFIX=value setting.",
      );
    seen = true;
    let value = match[1];
    if (value.startsWith('"')) {
      try {
        value = JSON.parse(value);
      } catch {
        throw new Error("Invalid JSON string in .ghprm BRANCH_PREFIX.");
      }
      if (typeof value !== "string")
        throw new Error("BRANCH_PREFIX must be text.");
    }
    branchPrefix = value ? `${value.replace(/\/$/, "")}/` : "";
  }
  return { branchPrefix };
}

export function run(command, args, cwd, options = {}) {
  const { trimEnd = true, ...processOptions } = options;
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, GH_PROMPT_DISABLED: "1", GIT_TERMINAL_PROMPT: "0" },
    ...processOptions,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const output = [result.stdout, result.stderr]
      .filter(Boolean)
      .map((text) => text.trimEnd())
      .join("\n");
    const error = new Error(`${command} ${args.join(" ")}\n${output}`.trim());
    error.status = result.status;
    throw error;
  }
  return trimEnd ? result.stdout.trimEnd() : result.stdout;
}

function noteEntries(text) {
  const lines = text.split("\n");
  const entries = [];
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(
      /^prm-(name|deps|title|description|branch-name):[ \t]*(.*)$/,
    );
    const entry = {
      key: match?.[1] || null,
      value: match?.[2],
      raw: [lines[i]],
    };
    if (entry.key === "description" && entry.value === "|") {
      const body = [];
      while (i + 1 < lines.length && lines[i + 1].startsWith("  ")) {
        entry.raw.push(lines[++i]);
        body.push(lines[i].slice(2));
      }
      entry.value = body.join("\n");
    } else if (
      ["description", "branch-name"].includes(entry.key) &&
      entry.value?.startsWith('"')
    ) {
      try {
        entry.value = JSON.parse(entry.value);
      } catch {
        throw new Error(`Invalid JSON string in prm-${entry.key}.`);
      }
      if (typeof entry.value !== "string")
        throw new Error(`prm-${entry.key} must contain text.`);
    } else if (entry.key === "description" && entry.value === "") {
      // Also accept a manually written, unindented multiline description.
      const body = [];
      while (
        i + 1 < lines.length &&
        !/^prm-(name|deps|title|description|branch-name):/.test(lines[i + 1])
      ) {
        entry.raw.push(lines[++i]);
        body.push(lines[i]);
      }
      entry.value = body.join("\n");
    }
    entries.push(entry);
  }
  return entries;
}

export function parseNote(text) {
  const entries = noteEntries(text);
  const values = (key) =>
    entries.filter((e) => e.key === key).map((e) => e.value);
  const names = values("name");
  if (names.length > 1) throw new Error("A commit may have only one prm-name.");
  const deps = values("deps").flatMap((value) =>
    value
      .split(",")
      .map((d) => d.trim())
      .filter(Boolean),
  );
  for (const key of ["title", "description", "branch-name"]) {
    if (values(key).length > 1)
      throw new Error(`A commit may have only one prm-${key}.`);
  }
  return {
    name: names[0] || null,
    deps: [...new Set(deps)],
    title: values("title")[0] ?? null,
    description: values("description")[0] ?? null,
    branchName: values("branch-name")[0] ?? null,
  };
}

export function editNote(text, name, deps) {
  const other = noteEntries(text)
    .filter((e) => !["name", "deps"].includes(e.key))
    .flatMap((e) => e.raw)
    .join("\n")
    .trim();
  return [
    name && `prm-name: ${name}`,
    deps.length && `prm-deps: ${deps.join(", ")}`,
    other,
  ]
    .filter(Boolean)
    .join("\n");
}

export function editMetadataNote(text, updates) {
  const other = noteEntries(text)
    .filter((e) => !Object.hasOwn(updates, e.key))
    .flatMap((e) => e.raw)
    .join("\n")
    .trim();
  const lines = [other];
  if (typeof updates.title === "string")
    lines.push(`prm-title: ${updates.title}`);
  // A JSON string keeps multiline Markdown and literal prm-* lines lossless.
  if (typeof updates.description === "string")
    lines.push(`prm-description: ${JSON.stringify(updates.description)}`);
  if (typeof updates["branch-name"] === "string")
    lines.push(`prm-branch-name: ${JSON.stringify(updates["branch-name"])}`);
  return lines.filter(Boolean).join("\n");
}

function validName(name) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(name || "")) {
    throw new Error(
      "Feature names must be 1–80 letters, digits, dots, underscores or hyphens, starting with a letter or digit.",
    );
  }
}

export function validateGraph(groups, merged = {}) {
  const nodes = new Map(groups.map((g) => [g.name, g]));
  const visiting = new Set();
  const visited = new Set();
  function visit(name) {
    if (visiting.has(name))
      throw new Error(`Dependency cycle involving ${name}.`);
    if (visited.has(name) || Object.hasOwn(merged, name)) return;
    const group = nodes.get(name);
    if (!group)
      throw new Error(`Unknown dependency ${name}. Tag its commits first.`);
    validName(name);
    visiting.add(name);
    for (const dep of group.deps) {
      validName(dep);
      visit(dep);
    }
    visiting.delete(name);
    visited.add(name);
  }
  for (const group of groups) visit(group.name);
}

export class Manager {
  constructor(cwd = process.cwd(), gh, { onProgress } = {}) {
    this.onProgress = onProgress;
    this.ghOverride = gh;
    this.root = run("git", ["rev-parse", "--show-toplevel"], cwd);
    this.common = path.resolve(
      this.root,
      run("git", ["rev-parse", "--git-common-dir"], this.root),
    );
    this.dir = path.join(this.common, "prm");
    this.statePath = path.join(this.dir, "state.json");
    this.journalPath = path.join(this.dir, "sync.json");
    const invokeGh = gh || ((args) => run("gh", args, this.root));
    this.gh = (args) => {
      // Titles/descriptions and repository credentials never belong in the log.
      this.progress(
        `gh ${args.slice(0, args[0] === "pr" && args[1] === "view" ? 3 : 2).join(" ")}`,
      );
      return invokeGh(args);
    };
  }

  git(...args) {
    if (
      [
        "fetch",
        "push",
        "ls-remote",
        "worktree",
        "update-ref",
        "reset",
      ].includes(args[0])
    )
      this.progress(`git ${args.join(" ")}`);
    return run("git", args, this.root);
  }
  progress(command) {
    this.onProgress?.({ command });
  }
  optionalGit(...args) {
    try {
      return this.git(...args);
    } catch (e) {
      if (e.status) return null;
      throw e;
    }
  }
  head() {
    return this.git("rev-parse", "HEAD");
  }
  branch() {
    return this.git("symbolic-ref", "--quiet", "--short", "HEAD");
  }
  config() {
    const file = path.join(this.root, ".ghprm");
    const config = parseConfig(
      fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "",
    );
    this.validBranch(`${config.branchPrefix}feature`);
    return config;
  }
  validBranch(name) {
    if (
      typeof name !== "string" ||
      name === "HEAD" ||
      name.startsWith("-") ||
      this.optionalGit("check-ref-format", `refs/heads/${name}`) === null
    )
      throw new Error(`Invalid branch name: ${JSON.stringify(name)}.`);
  }
  resolveBranches(groups, state, config) {
    const owners = new Map([
      [state.base, "the base branch"],
      [state.branch, "the working branch"],
    ]);
    const claim = (branch, owner) => {
      for (const [other, otherOwner] of owners) {
        if (branch === other && owner === otherOwner) continue;
        if (
          branch === other ||
          branch.startsWith(`${other}/`) ||
          other.startsWith(`${branch}/`)
        )
          throw new Error(
            `Branch ${branch} conflicts with ${otherOwner} (${other}).`,
          );
      }
      owners.set(branch, owner);
    };
    for (const [name, feature] of Object.entries(state.features)) {
      claim(feature.branch, name);
    }
    for (const group of groups) {
      const published = Object.hasOwn(state.features, group.name)
        ? state.features[group.name]
        : null;
      if (
        published &&
        group.branchName !== null &&
        group.branchName !== published.branch
      )
        throw new Error(
          `Cannot rename published feature ${group.name} from ${published.branch}.`,
        );
      group.branch =
        group.branchName ??
        published?.branch ??
        `${config.branchPrefix}${group.name}`;
      this.validBranch(group.branch);
      claim(group.branch, group.name);
    }
  }
  state() {
    if (!fs.existsSync(this.statePath))
      throw new Error("Run gh prm init --base <branch> first.");
    return JSON.parse(fs.readFileSync(this.statePath, "utf8"));
  }
  save(state) {
    fs.mkdirSync(this.dir, { recursive: true });
    const tmp = `${this.statePath}.${randomUUID()}`;
    fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, {
      mode: 0o600,
    });
    fs.renameSync(tmp, this.statePath);
  }
  locked(fn, { recovery = false } = {}) {
    fs.mkdirSync(this.dir, { recursive: true });
    const lock = path.join(this.dir, "lock");
    try {
      fs.mkdirSync(lock);
    } catch (e) {
      if (e.code === "EEXIST")
        throw new Error(
          `Another prm operation is running. If it crashed, remove ${lock} after checking its owner.json.`,
        );
      throw e;
    }
    fs.writeFileSync(
      path.join(lock, "owner.json"),
      JSON.stringify({ pid: process.pid, started: new Date().toISOString() }),
    );
    try {
      if (!recovery && fs.existsSync(this.journalPath))
        throw new Error(
          "A sync is paused. Use gh prm sync --continue or --abort.",
        );
      return fn();
    } finally {
      fs.rmSync(lock, { recursive: true, force: true });
    }
  }
  clean() {
    if (this.git("status", "--porcelain").length)
      throw new Error(
        "Working tree must be clean. Commit or save your changes first; prm never auto-stashes.",
      );
    for (const name of [
      "CHERRY_PICK_HEAD",
      "MERGE_HEAD",
      "rebase-merge",
      "rebase-apply",
      "sequencer",
    ]) {
      if (
        fs.existsSync(
          path.resolve(this.root, this.git("rev-parse", "--git-path", name)),
        )
      ) {
        throw new Error(`Finish the existing Git operation (${name}) first.`);
      }
    }
  }
  onBranch(state) {
    if (this.branch() !== state.branch)
      throw new Error(`Switch to the managed branch ${state.branch} first.`);
  }
  baseRef(state) {
    return `refs/remotes/${state.remote}/${state.base}`;
  }
  fetch(state) {
    this.git(
      "fetch",
      "--no-tags",
      state.remote,
      `+refs/heads/${state.base}:${this.baseRef(state)}`,
    );
  }
  init({ base, remote = "origin", repo } = {}) {
    return this.locked(() => {
      if (fs.existsSync(this.statePath))
        throw new Error("This repository is already initialized.");
      this.clean();
      const branch = this.branch();
      if (!base) {
        const ref = this.optionalGit(
          "symbolic-ref",
          "--short",
          `refs/remotes/${remote}/HEAD`,
        );
        if (!ref)
          throw new Error(
            "Specify the trunk with --base main (or --base develop).",
          );
        base = ref.slice(remote.length + 1);
      }
      this.git("check-ref-format", "--branch", base);
      if (!this.git("remote").split("\n").includes(remote))
        throw new Error(`Unknown remote ${remote}.`);
      if (branch === base)
        throw new Error(
          "Create a working branch first, e.g. git switch -c work. The trunk is never rewritten.",
        );
      repo ||= this.gh(["repo", "view", "--json", "url", "--jq", ".url"]);
      if (!/^https?:\/\/[^/]+\/[^/]+\/[^/]+\/?$/.test(repo))
        throw new Error("Use --repo https://HOST/OWNER/REPO.");
      const state = {
        version: 1,
        branch,
        base,
        remote,
        repo,
        features: {},
        merged: {},
      };
      this.fetch(state);
      const mergeBase = this.git("merge-base", this.baseRef(state), "HEAD");
      const notes = (
        this.optionalGit("config", "--get-all", "notes.rewriteRef") || ""
      ).split("\n");
      if (!notes.includes(NOTES))
        this.git("config", "--add", "notes.rewriteRef", NOTES);
      this.save(state);
      return { ...state, mergeBase };
    });
  }
  note(sha) {
    return this.optionalGit("notes", "--ref", NOTES, "show", sha) || "";
  }
  writeNote(sha, text) {
    if (text.trim())
      this.git("notes", "--ref", NOTES, "add", "-f", "-m", text, sha);
    else if (this.note(sha)) this.git("notes", "--ref", NOTES, "remove", sha);
  }
  commits(state = this.state()) {
    const base = this.git("merge-base", this.baseRef(state), "HEAD");
    const shas = this.git(
      "rev-list",
      "--reverse",
      "--topo-order",
      `${base}..HEAD`,
    )
      .split("\n")
      .filter(Boolean);
    return shas.map((sha) => {
      const [parents, subject] = this.git(
        "show",
        "-s",
        "--format=%P%n%s",
        sha,
      ).split("\n");
      const note = this.note(sha);
      return {
        sha,
        parents: parents.split(" ").filter(Boolean),
        subject,
        note,
        ...parseNote(note),
      };
    });
  }
  graph() {
    const state = this.state();
    const config = this.config();
    this.onBranch(state);
    const commits = this.commits(state);
    const map = new Map();
    for (const commit of commits) {
      if (!commit.name) continue;
      validName(commit.name);
      if (!map.has(commit.name))
        map.set(commit.name, {
          name: commit.name,
          commits: [],
          deps: [],
          title: commit.name,
          description: null,
          titleSource: null,
          descriptionSource: null,
          branchName: null,
          branchNameSource: null,
        });
      const group = map.get(commit.name);
      if (commit.branchName !== null) {
        group.branchName = commit.branchName;
        group.branchNameSource = commit.sha;
      }
      group.commits.push(commit.sha);
      group.deps = [...new Set([...group.deps, ...commit.deps])];
      for (const field of ["title", "description"])
        if (commit[field] !== null) {
          group[field] = commit[field];
          group[`${field}Source`] = commit.sha;
        }
      commit.effectiveMetadata = {
        title: group.title,
        description: group.description,
        titleSource: group.titleSource,
        descriptionSource: group.descriptionSource,
      };
    }
    const groups = [...map.values()].map((group) => {
      const published = Object.hasOwn(state.features, group.name)
        ? state.features[group.name]
        : null;
      const blockedBy = group.deps.filter(
        (dep) => !Object.hasOwn(state.merged, dep),
      );
      return {
        ...group,
        blockedBy,
        ready: !blockedBy.length,
        pr: published?.pr || null,
        url: published?.url || null,
        status: published?.state || (blockedBy.length ? "BLOCKED" : "READY"),
      };
    });
    this.resolveBranches(groups, state, config);
    return {
      config,
      branch: state.branch,
      base: state.base,
      remote: state.remote,
      repo: state.repo,
      head: this.head(),
      revision: `${this.head()}:${this.optionalGit("rev-parse", "--verify", NOTES) || ""}:${config.branchPrefix}:${createHash("sha256").update(JSON.stringify(state)).digest("hex")}`,
      commits,
      groups,
      merged: state.merged,
      paused: fs.existsSync(this.journalPath),
      pushRun: readPushRun(this),
      uiWorktree: this.uiWorktree || null,
    };
  }
  tag(name, revisions = ["HEAD"]) {
    validName(name);
    return this.locked(() => {
      const graph = this.graph();
      if (Object.hasOwn(graph.merged, name))
        throw new Error(
          `${name} already merged. Use a new feature name for follow-up work.`,
        );
      const active = new Set(graph.commits.map((c) => c.sha));
      const shas = revisions.map((rev) =>
        this.git(
          "rev-parse",
          "--verify",
          "--end-of-options",
          `${rev}^{commit}`,
        ),
      );
      for (const sha of shas)
        if (!active.has(sha))
          throw new Error(`${sha} is outside the managed commit range.`);
      const edits = shas.map((sha) => {
        const note = this.note(sha);
        const old = parseNote(note);
        if (old.name && old.name !== name) {
          const features = this.state().features;
          const published = Object.hasOwn(features, old.name)
            ? features[old.name]
            : null;
          if (published?.publishedCommits.includes(sha))
            throw new Error(
              `Cannot move a published commit out of ${old.name}.`,
            );
        }
        return [sha, editNote(note, name, old.deps)];
      });
      const hypothetical = graph.commits.map((c) =>
        shas.includes(c.sha) ? { ...c, name } : c,
      );
      const groups = new Map();
      for (const c of hypothetical)
        if (c.name) {
          if (!groups.has(c.name))
            groups.set(c.name, { name: c.name, deps: [], branchName: null });
          groups.get(c.name).deps.push(...c.deps);
          if (c.branchName !== null)
            groups.get(c.name).branchName = c.branchName;
        }
      validateGraph([...groups.values()], graph.merged);
      this.resolveBranches([...groups.values()], this.state(), graph.config);
      for (const [sha, note] of edits) this.writeNote(sha, note);
      return this.graph();
    });
  }
  dependencies(name, deps) {
    validName(name);
    for (const dep of deps) validName(dep);
    return this.locked(() => {
      const graph = this.graph();
      const group = graph.groups.find((g) => g.name === name);
      if (!group) throw new Error(`Unknown feature ${name}.`);
      const features = this.state().features;
      if (
        Object.hasOwn(features, name) &&
        features[name].pr &&
        deps.some((dep) => !Object.hasOwn(graph.merged, dep))
      ) {
        throw new Error(
          "Cannot add unmet dependencies to an already published PR. Keep its review branch isolated.",
        );
      }
      const groups = graph.groups.map((g) =>
        g.name === name ? { ...g, deps: [...new Set(deps)] } : g,
      );
      validateGraph(groups, graph.merged);
      // Put the canonical dependency list on the first commit, preserving other note text.
      for (const [i, sha] of group.commits.entries())
        this.writeNote(
          sha,
          editNote(this.note(sha), name, i === 0 ? deps : []),
        );
      return this.graph();
    });
  }
  branchName(name, branchName, expectedRevision) {
    return this.locked(() => {
      const graph = this.graph();
      if (expectedRevision && expectedRevision !== graph.revision)
        throw new Error("The repository changed. Refresh before editing.");
      if (branchName !== null) this.validBranch(branchName);
      const group = graph.groups.find((g) => g.name === name);
      if (!group) throw new Error(`Unknown feature ${name}.`);
      const state = this.state();
      this.resolveBranches(
        graph.groups.map((g) =>
          g.name === name ? { ...g, branchName } : { ...g },
        ),
        state,
        graph.config,
      );
      // Keep one canonical branch override, preserving all other fields.
      for (const [i, sha] of group.commits.entries())
        this.writeNote(
          sha,
          editMetadataNote(this.note(sha), {
            "branch-name": i === 0 ? branchName : null,
          }),
        );
      return this.graph();
    });
  }
  metadata(revision, updates, expectedRevision) {
    if (
      !updates ||
      typeof updates !== "object" ||
      Array.isArray(updates) ||
      !Object.keys(updates).length ||
      Object.keys(updates).some(
        (key) => !["title", "description"].includes(key),
      )
    ) {
      throw new Error(
        "Provide title and/or description overrides; null removes an override.",
      );
    }
    for (const [field, value] of Object.entries(updates)) {
      if (value !== null && typeof value !== "string")
        throw new Error(`${field} must be text or null.`);
      if (
        field === "title" &&
        value !== null &&
        (!value.trim() || /[\r\n\0]/.test(value) || value.length > 256)
      ) {
        throw new Error(
          "Title must be a nonempty single line of at most 256 characters.",
        );
      }
      if (
        field === "description" &&
        value !== null &&
        (value.includes("\0") || Buffer.byteLength(value) > 32768)
      ) {
        throw new Error(
          "Description must be at most 32 KiB and contain no NUL characters.",
        );
      }
    }
    return this.locked(() => {
      const graph = this.graph();
      if (expectedRevision && expectedRevision !== graph.revision)
        throw new Error("The repository changed. Refresh before editing.");
      const sha = this.git(
        "rev-parse",
        "--verify",
        "--end-of-options",
        `${revision}^{commit}`,
      );
      const commit = graph.commits.find((c) => c.sha === sha);
      if (!commit)
        throw new Error("Commit is outside the managed commit range.");
      if (!commit.name)
        throw new Error(
          "Assign this commit to a feature before editing PR metadata.",
        );
      this.writeNote(sha, editMetadataNote(this.note(sha), updates));
      return this.graph();
    });
  }
  shareNotes(direction) {
    return this.locked(() => {
      const state = this.state();
      if (direction === "push") {
        this.git("push", state.remote, `${NOTES}:${NOTES}`);
      } else if (direction === "pull") {
        // Git fetch permits non-fast-forward updates outside heads/tags. Fetch
        // into a separate ref, then explicitly verify notes ancestry before CAS.
        const incoming = `refs/prm/incoming-notes/${randomUUID()}`;
        this.git("fetch", state.remote, `${NOTES}:${incoming}`);
        const next = this.git("rev-parse", incoming);
        const previous = this.optionalGit("rev-parse", "--verify", NOTES);
        if (
          previous &&
          this.optionalGit("merge-base", "--is-ancestor", previous, next) ===
            null
        ) {
          throw new Error(
            `Notes diverged. Merge explicitly with git notes --ref=prm merge ${incoming}; then remove that incoming ref.`,
          );
        }
        this.git("update-ref", NOTES, next, previous || "");
        this.git("update-ref", "-d", incoming, next);
      } else throw new Error("Use notes push or notes pull.");
      return { notes: direction };
    });
  }
  plan(expectedRevision) {
    const graph = this.graph();
    if (expectedRevision && expectedRevision !== graph.revision)
      throw new Error(
        "The repository changed. Refresh and preview the push again.",
      );
    validateGraph(graph.groups, graph.merged);
    return {
      ready: graph.groups.filter((g) => g.ready),
      blocked: graph.groups.filter((g) => !g.ready),
      unassigned: graph.commits.filter((c) => !c.name),
    };
  }
  featureDiff(name, { expectedRevision } = {}) {
    validName(name);
    // A private worktree and final snapshot check let previews coexist with push/sync.
    const graph = this.graph();
    if (expectedRevision && expectedRevision !== graph.revision)
      throw new Error(
        "The repository changed. Refresh before loading the feature diff.",
      );
    validateGraph(graph.groups, graph.merged);
    const group = graph.groups.find((g) => g.name === name);
    if (!group) throw new Error(`Unknown active feature ${name}.`);
    const prerequisites = [],
      seen = new Set();
    const visit = (dependency) => {
      if (seen.has(dependency) || Object.hasOwn(graph.merged, dependency))
        return;
      seen.add(dependency);
      const parent = graph.groups.find((g) => g.name === dependency);
      for (const dep of parent.deps) visit(dep);
      prerequisites.push(parent);
    };
    for (const dep of group.deps) visit(dep);
    const selected = new Set(
      [...prerequisites, group].flatMap((g) => g.commits),
    );
    if (graph.commits.some((c) => selected.has(c.sha) && c.parents.length > 1))
      throw new Error(
        "Merge commits are unsupported. Use a linear working branch.",
      );
    const base = this.git("rev-parse", this.baseRef(this.state()));
    const dir = this.createWorktree(base);
    try {
      const replay = (feature) => {
        try {
          for (const sha of feature.commits)
            this.replay(dir, sha, { unsigned: true });
        } catch (error) {
          throw new Error(
            `Cannot build the diff context for ${feature.name}. Check its dependencies.\n${error.message}`,
          );
        }
      };
      // Prerequisites supply context but are excluded from the net patch.
      for (const parent of prerequisites) replay(parent);
      const before = run("git", ["rev-parse", "HEAD"], dir);
      replay(group);
      const diff = run(
        "git",
        [
          "diff",
          "--no-color",
          "--no-ext-diff",
          "--no-textconv",
          "--find-renames",
          before,
          "HEAD",
          "--",
        ],
        dir,
        { trimEnd: false },
      );
      if (
        this.graph().revision !== graph.revision ||
        this.git("rev-parse", this.baseRef(this.state())) !== base
      )
        throw new Error(
          "The repository changed while building the feature diff. Refresh and retry.",
        );
      return {
        name,
        diff,
        commitCount: group.commits.length,
        revision: graph.revision,
      };
    } finally {
      this.removeWorktree(dir);
    }
  }
  createWorktree(base) {
    const dir = this.uiWorktree
      ? path.join(
          path.dirname(this.uiWorktree.path),
          `gh-prm-replay-${randomUUID()}`,
        )
      : path.join(this.dir, "worktrees", randomUUID());
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    this.git("worktree", "add", "--detach", dir, base);
    return dir;
  }
  removeWorktree(dir) {
    this.git("worktree", "remove", "--force", dir);
  }
  replay(dir, sha, { unsigned = false } = {}) {
    this.progress(`git cherry-pick ${sha}`);
    const [name, email, date] = this.git(
      "show",
      "-s",
      "--format=%cn%x00%ce%x00%cI",
      sha,
    ).split("\0");
    run(
      "git",
      [
        ...(unsigned ? ["-c", "commit.gpgsign=false"] : []),
        "cherry-pick",
        "--allow-empty",
        "--keep-redundant-commits",
        sha,
      ],
      dir,
      {
        env: {
          ...process.env,
          GIT_COMMITTER_NAME: name,
          GIT_COMMITTER_EMAIL: email,
          GIT_COMMITTER_DATE: date,
        },
      },
    );
    return run("git", ["rev-parse", "HEAD"], dir);
  }
  prStatus(state, feature) {
    return JSON.parse(
      this.gh([
        "pr",
        "view",
        String(feature.pr),
        "--repo",
        state.repo,
        "--json",
        "number,url,state,mergedAt,mergeCommit,headRefOid,baseRefName",
      ]),
    );
  }
  patchSignature(commits) {
    return JSON.stringify(
      commits.map((sha) => [
        run("git", ["patch-id", "--stable"], this.root, {
          input: this.git(
            "show",
            "--format=medium",
            "--no-ext-diff",
            "--no-textconv",
            sha,
            "--",
          ),
        }).split(" ")[0],
      ]),
    );
  }
  signingEnabled() {
    try {
      return this.git("config", "--bool", "--get", "commit.gpgsign") === "true";
    } catch (error) {
      if (error.status === 1) return false;
      throw error;
    }
  }
  reusableSignedHistory(state, head, signingRequired = this.signingEnabled()) {
    if (!signingRequired) return true;
    const base = this.git("merge-base", this.baseRef(state), head);
    const commits = this.git("rev-list", `${base}..${head}`)
      .split("\n")
      .filter(Boolean);
    return commits.every(
      (sha) => this.optionalGit("verify-commit", sha) !== null,
    );
  }
  unchangedProjection(state, group, feature, projection) {
    const previous = feature.publishedCommits;
    if (!Array.isArray(previous) || previous.length !== group.commits.length)
      return false;
    if (previous.every((sha, i) => sha === group.commits[i])) return true;
    // Sync changes source SHAs. Compare exact replayed trees, including whitespace,
    // at every commit rather than trusting patch IDs (which ignore whitespace).
    if (
      previous.some(
        (sha, i) =>
          this.git("show", "-s", "--format=%B", sha) !==
          this.git("show", "-s", "--format=%B", group.commits[i]),
      )
    )
      return false;
    const dir = this.createWorktree(this.baseRef(state));
    try {
      for (let i = 0; i < previous.length; i++) {
        try {
          this.replay(dir, previous[i], { unsigned: true });
        } catch {
          return false;
        }
        if (
          run("git", ["rev-parse", "HEAD^{tree}"], dir) !== projection.trees[i]
        )
          return false;
      }
      return true;
    } finally {
      this.removeWorktree(dir);
    }
  }
  verifyAdoption(state, group, existing, { explicit = false } = {}) {
    if ((!explicit && group.branchName === null) || !group.ready)
      throw new Error(
        `Remote branch ${group.branch} already exists. Set prm-branch-name explicitly to adopt a matching ready feature.`,
      );
    const incoming = `refs/prm/adopt/${randomUUID()}`;
    try {
      this.git(
        "fetch",
        "--no-tags",
        state.remote,
        `refs/heads/${group.branch}:${incoming}`,
      );
      if (this.git("rev-parse", incoming) !== existing)
        throw new Error(
          `Remote branch ${group.branch} changed while checking adoption. Retry.`,
        );
      // Compare the feature at the remote branch's own base. An existing PR
      // need not have rebased onto the latest trunk to be safely adopted.
      const base = this.git("merge-base", this.baseRef(state), incoming);
      const commits = this.git("rev-list", "--reverse", `${base}..${incoming}`)
        .split("\n")
        .filter(Boolean);
      let equivalent = false;
      if (
        !this.git("rev-list", "--merges", `${base}..${incoming}`) &&
        commits.length === group.commits.length &&
        this.patchSignature(commits) === this.patchSignature(group.commits)
      ) {
        const dir = this.createWorktree(base);
        try {
          for (const sha of group.commits)
            this.replay(dir, sha, { unsigned: true });
          equivalent =
            this.git("rev-parse", `${incoming}^{tree}`) ===
            run("git", ["rev-parse", "HEAD^{tree}"], dir);
        } finally {
          this.removeWorktree(dir);
        }
      }
      if (!equivalent)
        throw new Error(
          `Remote branch ${group.branch} does not match this feature's commits. Refusing to overwrite it.`,
        );
    } finally {
      this.optionalGit("update-ref", "-d", incoming);
    }
  }
  adopt(name, number, { expectedRevision, expectedHead } = {}) {
    if (
      typeof name !== "string" ||
      !Number.isSafeInteger(number) ||
      number <= 0
    )
      throw new Error("Provide a feature name and a positive PR number.");
    if (
      expectedHead !== undefined &&
      !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(expectedHead)
    )
      throw new Error("Provide the discovered PR head commit.");
    return this.locked(() => {
      const state = this.state();
      this.onBranch(state);
      const graph = this.graph();
      if (expectedRevision && graph.revision !== expectedRevision)
        throw new Error(
          "The repository changed. Refresh before adopting a PR.",
        );
      if (graph.paused)
        throw new Error(
          "Finish or abort the paused sync before adopting a PR.",
        );
      validateGraph(graph.groups, graph.merged);
      const group = graph.groups.find((g) => g.name === name);
      if (!group) throw new Error(`Unknown feature ${name}.`);
      if (!group.ready)
        throw new Error(`Merge prerequisites before adopting ${name}.`);
      const previous = Object.hasOwn(state.features, name)
        ? state.features[name]
        : null;
      if (previous?.pr) {
        if (previous.pr !== number)
          throw new Error(`${name} already tracks PR #${previous.pr}.`);
        return { name, pr: number, url: previous.url, adopted: false, graph };
      }
      const readPr = () =>
        JSON.parse(
          this.gh([
            "pr",
            "view",
            String(number),
            "--repo",
            state.repo,
            "--json",
            "number,url,state,baseRefName,headRefName,headRefOid,isCrossRepository",
          ]),
        );
      const validatePr = (pr) => {
        if (pr.number !== number || pr.state !== "OPEN")
          throw new Error("Only an existing open PR can be adopted.");
        if (
          pr.isCrossRepository !== false ||
          pr.headRefName !== group.branch ||
          pr.baseRefName !== state.base
        )
          throw new Error(
            `PR #${number} must use ${group.branch} in this repository and target ${state.base}.`,
          );
      };
      const pr = readPr();
      validatePr(pr);
      if (expectedHead && pr.headRefOid !== expectedHead)
        throw new Error(
          "PR changed since discovery. Refresh before adopting it.",
        );
      this.fetch(state);
      const remoteHead = () =>
        this.git(
          "ls-remote",
          "--heads",
          state.remote,
          `refs/heads/${group.branch}`,
        ).split(/\s/)[0];
      const head = remoteHead();
      if (!head || head !== pr.headRefOid)
        throw new Error(
          "PR head does not match the remote branch. Refresh before adopting it.",
        );
      if (previous?.publishedHead && previous.publishedHead !== head)
        throw new Error(
          `Remote branch ${group.branch} changed outside prm. Refusing to replace its tracking state.`,
        );
      // Explicit adoption authorizes the resolved branch name, including the default.
      this.verifyAdoption(state, group, head, { explicit: true });
      const latest = readPr();
      validatePr(latest);
      if (latest.headRefOid !== head || remoteHead() !== head)
        throw new Error(
          "PR or remote branch changed during adoption. Refresh and retry.",
        );
      if (this.graph().revision !== graph.revision)
        throw new Error(
          "The repository changed during adoption. Refresh and retry.",
        );
      state.features[name] = {
        branch: group.branch,
        pr: number,
        url: latest.url,
        state: "OPEN",
        publishedHead: head,
        publishedCommits: group.commits,
      };
      this.save(state);
      return {
        name,
        pr: number,
        url: latest.url,
        adopted: true,
        graph: this.graph(),
      };
    });
  }
  push({ dryRun = false, names = [], expectedRevision, beforePublish } = {}) {
    return this.locked(() => {
      assertPushRunOwner(this);
      const state = this.state();
      this.onBranch(state);
      this.clean();
      const plan = this.plan(expectedRevision);
      if (this.commits(state).some((c) => c.parents.length > 1))
        throw new Error(
          "Merge commits are unsupported. Use a linear working branch.",
        );
      const all = [...plan.ready, ...plan.blocked];
      for (const name of names)
        if (!all.some((g) => g.name === name))
          throw new Error(`Unknown feature ${name}.`);
      const selected = names.length
        ? [...new Set(names)].map((name) => all.find((g) => g.name === name))
        : plan.ready;
      for (const group of selected)
        if (
          !group.ready &&
          Object.hasOwn(state.features, group.name) &&
          state.features[group.name].pr
        ) {
          throw new Error(
            `${group.name} already has a PR and cannot become a full-history preview. Remove its unmet dependencies first.`,
          );
        }
      if (!names.length && plan.unassigned.length)
        throw new Error(
          `Tag all commits before pushing: ${plan.unassigned.map((c) => c.sha.slice(0, 8)).join(", ")}`,
        );
      const selection = {
        ready: selected.filter((g) => g.ready),
        previews: selected.filter((g) => !g.ready),
        blocked: plan.blocked,
        unassigned: plan.unassigned,
      };
      if (dryRun) return { ...selection, dryRun: true };
      this.fetch(state);
      if (
        this.git("merge-base", this.baseRef(state), "HEAD") !==
        this.git("rev-parse", this.baseRef(state))
      ) {
        throw new Error("The base advanced. Run gh prm sync before pushing.");
      }
      for (const [name, feature] of Object.entries(state.features))
        if (feature.pr && (!this.pushRunId || names.includes(name))) {
          const pr = this.prStatus(state, feature);
          if (pr.state === "MERGED")
            throw new Error(`PR #${pr.number} merged. Run gh prm sync first.`);
          if (pr.state === "CLOSED")
            throw new Error(
              `PR #${pr.number} is closed. Reopen it before pushing.`,
            );
        }
      const signingRequired = this.signingEnabled();
      const result = { pushed: [], previews: [], blocked: plan.blocked };
      // Build every ready projection before any remote writes: missing code dependencies
      // fail locally without publishing a partial batch.
      const projections = [];
      try {
        for (const group of selected) {
          const feature = Object.hasOwn(state.features, group.name)
            ? state.features[group.name]
            : null;
          // Restarting a push must not invoke the signer for an unchanged PR.
          // The remote head and PR state are still checked before publication.
          if (
            group.ready &&
            feature?.state === "OPEN" &&
            feature.pr &&
            feature.publishedHead &&
            Array.isArray(feature.publishedCommits) &&
            JSON.stringify(feature.publishedCommits) ===
              JSON.stringify(group.commits) &&
            this.reusableSignedHistory(
              state,
              feature.publishedHead,
              signingRequired,
            )
          ) {
            projections.push({ group, dir: null, head: feature.publishedHead });
            continue;
          }
          if (!group.ready && !signingRequired) {
            // Explicitly selected blocked features get the full integration history,
            // not an isolated projection. They never get a pull request.
            projections.push({ group, dir: null, head: this.head() });
            continue;
          }
          const dir = this.createWorktree(this.baseRef(state));
          const projection = { group, dir, trees: [] };
          projections.push(projection);
          try {
            const commits = group.ready
              ? group.commits
              : this.commits(state).map((c) => c.sha);
            for (const sha of commits) {
              this.replay(dir, sha);
              if (signingRequired) run("git", ["verify-commit", "HEAD"], dir);
              projection.trees.push(
                run("git", ["rev-parse", "HEAD^{tree}"], dir),
              );
            }
          } catch (e) {
            throw new Error(
              `Cannot isolate ${group.name}. Check the replay or signing error below.\n${e.message}`,
            );
          }
          projections.at(-1).head = run("git", ["rev-parse", "HEAD"], dir);
        }
        // Validate every branch and existing PR before the first remote write.
        for (const projection of projections) {
          const { group } = projection;
          const feature = Object.hasOwn(state.features, group.name)
            ? state.features[group.name]
            : { branch: group.branch };
          const remoteRef = `refs/heads/${feature.branch}`;
          const existing = this.git(
            "ls-remote",
            "--heads",
            state.remote,
            remoteRef,
          ).split(/\s/)[0];
          if (existing && existing !== feature.publishedHead) {
            if (feature.publishedHead)
              throw new Error(
                `Remote branch ${feature.branch} changed outside prm. Refusing to overwrite it.`,
              );
            this.verifyAdoption(state, group, existing);
            // Preserve verified signed heads; repair older unsigned projections.
            if (this.reusableSignedHistory(state, existing, signingRequired))
              projection.head = existing;
          }
          if (
            existing &&
            existing === feature.publishedHead &&
            group.ready &&
            feature.state === "OPEN" &&
            this.reusableSignedHistory(state, existing, signingRequired) &&
            this.unchangedProjection(state, group, feature, projection)
          ) {
            projection.head = existing;
          }
          projection.existingHead = existing;
          projection.expectedHead = feature.publishedHead || existing || "";
          projection.feature = feature;
          if (!feature.pr && group.ready) {
            const prs = JSON.parse(
              this.gh([
                "pr",
                "list",
                "--repo",
                state.repo,
                "--head",
                feature.branch,
                "--state",
                "open",
                "--json",
                "number,url,baseRefName",
              ]),
            );
            if (
              prs.length > 1 ||
              (prs.length === 1 && prs[0].baseRefName !== state.base)
            )
              throw new Error(
                `Could not identify a unique PR against ${state.base} for ${group.name}.`,
              );
            projection.existingPr = prs[0];
          }
        }
        for (const {
          group,
          head,
          feature,
          expectedHead,
          existingPr,
          existingHead,
        } of projections) {
          beforePublish?.(group);
          const remoteRef = `refs/heads/${feature.branch}`;
          const lease = `--force-with-lease=${remoteRef}:${expectedHead}`;
          if (head !== existingHead) {
            this.git("push", lease, state.remote, `${head}:${remoteRef}`);
          } else if (
            this.git("ls-remote", "--heads", state.remote, remoteRef).split(
              /\s/,
            )[0] !== head
          ) {
            throw new Error(
              `Remote branch ${feature.branch} changed after preflight. Retry.`,
            );
          }
          feature.publishedHead = head;
          feature.publishedCommits = group.commits;
          feature.state = group.ready ? "OPEN" : "PREVIEW";
          if (existingPr) {
            feature.pr = existingPr.number;
            feature.url = existingPr.url;
          }
          state.features[group.name] = feature;
          this.save(state); // Recover a pushed branch if PR creation fails.
          if (!group.ready) {
            result.previews.push({
              name: group.name,
              branch: feature.branch,
              head,
              reason: group.blockedBy,
              pr: null,
            });
            continue;
          }
          if (!feature.pr) {
            let prs = JSON.parse(
              this.gh([
                "pr",
                "list",
                "--repo",
                state.repo,
                "--head",
                feature.branch,
                "--state",
                "open",
                "--json",
                "number,url,baseRefName",
              ]),
            );
            if (!prs.length) {
              beforePublish?.(group);
              this.gh([
                "pr",
                "create",
                "--repo",
                state.repo,
                "--base",
                state.base,
                "--head",
                feature.branch,
                "--title",
                group.title,
                "--body",
                group.description ??
                  `Managed by gh-pr-manager.\n\nFeature: ${group.name}\n\nCommits:\n${group.commits.map((sha) => `- ${sha}`).join("\n")}`,
              ]);
              prs = JSON.parse(
                this.gh([
                  "pr",
                  "list",
                  "--repo",
                  state.repo,
                  "--head",
                  feature.branch,
                  "--state",
                  "open",
                  "--json",
                  "number,url,baseRefName",
                ]),
              );
            }
            if (prs.length !== 1 || prs[0].baseRefName !== state.base)
              throw new Error(
                `Could not identify a unique PR against ${state.base} for ${group.name}.`,
              );
            feature.pr = prs[0].number;
            feature.url = prs[0].url;
            this.save(state);
          }
          result.pushed.push({
            name: group.name,
            branch: feature.branch,
            pr: feature.pr,
            url: feature.url,
            commits: group.commits,
          });
        }
      } finally {
        for (const { dir } of projections) if (dir) this.removeWorktree(dir);
      }
      return result;
    });
  }
  writeJournal(journal) {
    const tmp = `${this.journalPath}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(journal, null, 2)}\n`, {
      mode: 0o600,
    });
    fs.renameSync(tmp, this.journalPath);
  }
  mergedPrForGroup(state, group) {
    // Only reconcile names the user explicitly associated with an existing branch.
    if (group.branchName === null) return null;
    const candidates = JSON.parse(
      this.gh([
        "pr",
        "list",
        "--repo",
        state.repo,
        "--head",
        group.branch,
        "--base",
        state.base,
        "--state",
        "merged",
        "--limit",
        "100",
        "--json",
        "number,headRefName,baseRefName,isCrossRepository",
      ]),
    ).filter(
      (pr) =>
        pr.isCrossRepository === false &&
        pr.headRefName === group.branch &&
        pr.baseRefName === state.base,
    );
    if (candidates.length > 1)
      throw new Error(
        `Multiple merged PRs match ${group.branch}. Refusing to guess which feature merged.`,
      );
    if (!candidates.length) return null;
    const pr = JSON.parse(
      this.gh([
        "pr",
        "view",
        String(candidates[0].number),
        "--repo",
        state.repo,
        "--json",
        "number,url,state,mergedAt,mergeCommit,headRefOid,headRefName,baseRefName,isCrossRepository",
      ]),
    );
    if (
      pr.number !== candidates[0].number ||
      pr.state !== "MERGED" ||
      pr.isCrossRepository !== false ||
      pr.headRefName !== group.branch ||
      pr.baseRefName !== state.base
    )
      throw new Error(
        `PR changed while checking ${group.name}. Refresh and retry.`,
      );
    return pr;
  }
  projectionMatches(commits, base, tree) {
    const dir = this.createWorktree(base);
    try {
      for (const sha of commits) this.replay(dir, sha, { unsigned: true });
      return run("git", ["rev-parse", "HEAD^{tree}"], dir) === tree;
    } catch {
      return false;
    } finally {
      this.removeWorktree(dir);
    }
  }
  syncBackupGroups(state, group) {
    // Older syncs could replay an untracked, already-merged feature as empty
    // commits. Recover its original patches only from our retained sync backups,
    // proving the old commits replay to each current commit's exact tree.
    const identity = (sha) =>
      `${this.git("show", "-s", "--format=%an%x00%ae%x00%aI%x00%B", sha)}\0${this.note(sha)}`;
    const identities = group.commits.map(identity);
    const backups = this.git(
      "for-each-ref",
      "--sort=-creatordate",
      "--format=%(objectname)",
      "refs/prm/backups",
    )
      .split("\n")
      .filter(Boolean);
    const groups = [];
    for (const tip of backups) {
      const base = this.git("merge-base", this.baseRef(state), tip);
      const commits = this.git("rev-list", "--reverse", `${base}..${tip}`)
        .split("\n")
        .filter((sha) => sha && parseNote(this.note(sha)).name === group.name);
      if (
        commits.length !== group.commits.length ||
        commits.some((sha, i) => identity(sha) !== identities[i])
      )
        continue;
      if (
        commits.every((sha, i) =>
          this.projectionMatches(
            [sha],
            `${group.commits[i]}^`,
            this.git("rev-parse", `${group.commits[i]}^{tree}`),
          ),
        )
      )
        groups.push(commits);
    }
    return groups;
  }
  verifyMergedGroup(state, group, pr) {
    if (
      !pr.mergeCommit?.oid ||
      this.optionalGit(
        "merge-base",
        "--is-ancestor",
        pr.mergeCommit.oid,
        this.baseRef(state),
      ) === null
    )
      throw new Error(
        `PR #${pr.number}'s merge is not in the fetched base yet. Run sync again after the base updates.`,
      );
    const incoming = `refs/prm/adopt/${randomUUID()}`;
    try {
      // Pull refs survive head-branch deletion. Never recreate or push that branch.
      this.git(
        "fetch",
        "--no-tags",
        state.remote,
        `refs/pull/${pr.number}/head:${incoming}`,
      );
      if (this.git("rev-parse", incoming) !== pr.headRefOid)
        throw new Error(
          `PR #${pr.number}'s head changed during verification. Retry.`,
        );
      const parent = this.git("rev-parse", `${pr.mergeCommit.oid}^1`);
      const base = this.git("merge-base", parent, incoming);
      const published = this.git(
        "rev-list",
        "--reverse",
        `${base}..${incoming}`,
      )
        .split("\n")
        .filter(Boolean);
      const candidates = [group.commits];
      if (
        group.commits.some(
          (sha) =>
            !this.git("diff-tree", "--no-commit-id", "--name-only", "-r", sha),
        )
      )
        candidates.push(...this.syncBackupGroups(state, group));
      const signature = this.patchSignature(published);
      const matches =
        !this.git("rev-list", "--merges", `${base}..${incoming}`) &&
        candidates.some(
          (commits) =>
            commits.length === published.length &&
            this.patchSignature(commits) === signature &&
            this.projectionMatches(
              commits,
              base,
              this.git("rev-parse", `${incoming}^{tree}`),
            ) &&
            this.projectionMatches(
              commits,
              parent,
              this.git("rev-parse", `${pr.mergeCommit.oid}^{tree}`),
            ),
        );
      if (!matches)
        throw new Error(
          `Merged PR #${pr.number} does not exactly match ${group.name}. Local work was preserved; inspect the feature before syncing.`,
        );
      const latest = this.prStatus(state, { pr: pr.number });
      if (
        latest.state !== "MERGED" ||
        latest.headRefOid !== pr.headRefOid ||
        latest.baseRefName !== state.base ||
        latest.mergeCommit?.oid !== pr.mergeCommit.oid
      )
        throw new Error(`PR #${pr.number} changed during verification. Retry.`);
    } finally {
      this.optionalGit("update-ref", "-d", incoming);
    }
  }
  sync({
    dryRun = false,
    continue: resume = false,
    abort = false,
    expectedRevision,
    featureNames,
    onPrStatus,
  } = {}) {
    return this.locked(
      () => {
        assertPushRunOwner(this);
        const state = this.state();
        this.onBranch(state);
        this.clean();
        if (expectedRevision && expectedRevision !== this.graph().revision)
          throw new Error("The repository changed. Refresh before syncing.");
        if (resume || abort) {
          if (!fs.existsSync(this.journalPath))
            throw new Error("No paused sync.");
          const journal = JSON.parse(fs.readFileSync(this.journalPath, "utf8"));
          if (
            journal.originalHead !== this.head() &&
            journal.newHead !== this.head()
          )
            throw new Error(
              "The working branch moved during sync. Restore its original HEAD before continuing or aborting.",
            );
          if (abort) {
            if (this.head() !== journal.originalHead)
              this.git("reset", "--hard", journal.originalHead);
            if (journal.originalState) this.save(journal.originalState);
            if (fs.existsSync(journal.dir)) this.removeWorktree(journal.dir);
            fs.unlinkSync(this.journalPath);
            return { aborted: true };
          }
          if (journal.newHead && this.head() === journal.newHead)
            return this.completeSync(state, journal);
          if (
            fs.existsSync(
              path.resolve(
                journal.dir,
                run(
                  "git",
                  ["rev-parse", "--git-path", "CHERRY_PICK_HEAD"],
                  journal.dir,
                ),
              ),
            )
          ) {
            run(
              "git",
              ["-c", "core.editor=true", "cherry-pick", "--continue"],
              journal.dir,
            );
          }
          if (journal.pending) {
            const actual = run("git", ["rev-parse", "HEAD"], journal.dir);
            if (actual === journal.beforePick)
              throw new Error(
                "Resolve and continue the cherry-pick; do not skip commits.",
              );
            journal.mapping[journal.pending] = actual;
            journal.pending = null;
            journal.index++;
            this.writeJournal(journal);
          }
          return this.finishSync(state, journal);
        }
        if (fs.existsSync(this.journalPath))
          throw new Error("A sync is paused. Use --continue or --abort.");
        const graph = this.graph();
        validateGraph(graph.groups, graph.merged);
        if (graph.commits.some((c) => c.parents.length > 1))
          throw new Error(
            "Merge commits are unsupported. Use a linear working branch.",
          );
        this.fetch(state);
        const merged = {};
        for (const [name, feature] of Object.entries(state.features))
          if (feature.pr && (!featureNames || featureNames.includes(name))) {
            const pr = this.prStatus(state, feature);
            onPrStatus?.(name, pr);
            if (pr.baseRefName !== state.base)
              throw new Error(`PR #${pr.number} targets a different base.`);
            if (pr.state !== "MERGED") continue;
            if (pr.headRefOid !== feature.publishedHead)
              throw new Error(
                `PR #${pr.number} merged a head different from the last published projection. Inspect it before syncing.`,
              );
            if (
              !pr.mergeCommit?.oid ||
              this.optionalGit(
                "merge-base",
                "--is-ancestor",
                pr.mergeCommit.oid,
                this.baseRef(state),
              ) === null
            ) {
              throw new Error(
                `PR #${pr.number}'s merge is not in the fetched base yet. Run sync again after the base updates.`,
              );
            }
            const unpublished = graph.commits.filter(
              (c) =>
                c.name === name && !feature.publishedCommits.includes(c.sha),
            );
            if (unpublished.length)
              throw new Error(
                `${name} merged with unpublished local commits. Tag those commits as a new follow-up feature before syncing.`,
              );
            merged[name] = {
              pr: pr.number,
              url: pr.url,
              mergedAt: pr.mergedAt,
            };
          }
        for (const group of graph.groups) {
          if (
            state.features[group.name]?.pr ||
            (featureNames && !featureNames.includes(group.name))
          )
            continue;
          const pr = this.mergedPrForGroup(state, group);
          if (!pr) continue;
          this.verifyMergedGroup(state, group, pr);
          merged[group.name] = {
            pr: pr.number,
            url: pr.url,
            mergedAt: pr.mergedAt,
          };
        }
        if (this.graph().revision !== graph.revision)
          throw new Error(
            "The repository changed during sync verification. Refresh and retry.",
          );
        const removed = graph.commits.filter(
          (c) => c.name && Object.hasOwn(merged, c.name),
        );
        const queue = graph.commits.filter((c) => !removed.includes(c));
        if (dryRun)
          return {
            dryRun: true,
            merged: Object.keys(merged),
            removed: removed.map((c) => c.sha),
            remaining: queue.map((c) => c.sha),
          };
        if (
          !removed.length &&
          this.git("merge-base", this.baseRef(state), "HEAD") ===
            this.git("rev-parse", this.baseRef(state))
        ) {
          return {
            merged: [],
            remaining: queue.map((c) => c.sha),
            unchanged: true,
          };
        }
        const journal = {
          originalHead: this.head(),
          originalState: state,
          dir: this.createWorktree(this.baseRef(state)),
          queue,
          removed: removed.map((c) => c.sha),
          merged,
          mapping: {},
          index: 0,
          pending: null,
        };
        this.writeJournal(journal);
        return this.finishSync(state, journal);
      },
      { recovery: resume || abort },
    );
  }
  finishSync(state, journal) {
    while (journal.index < journal.queue.length) {
      const commit = journal.queue[journal.index];
      journal.pending = commit.sha;
      journal.beforePick = run("git", ["rev-parse", "HEAD"], journal.dir);
      this.writeJournal(journal);
      try {
        journal.mapping[commit.sha] = this.replay(journal.dir, commit.sha);
      } catch (e) {
        throw new Error(
          `Sync paused; your working branch is unchanged.\nResolve conflicts in ${journal.dir}, git add the resolved files there, then run gh prm sync --continue.\nOr run gh prm sync --abort.\n${e.message}`,
        );
      }
      journal.pending = null;
      journal.index++;
      this.writeJournal(journal);
    }
    this.clean();
    if (this.head() !== journal.originalHead)
      throw new Error("Working branch moved; refusing to replace it.");
    for (const commit of journal.queue)
      if (commit.note) this.writeNote(journal.mapping[commit.sha], commit.note);
    const backup = `refs/prm/backups/${Date.now()}-${randomUUID().slice(0, 8)}`;
    this.git("update-ref", backup, journal.originalHead);
    const newHead = run("git", ["rev-parse", "HEAD"], journal.dir);
    // Save a recovery record before replacing the integration branch.
    journal.backup = backup;
    journal.newHead = newHead;
    this.writeJournal(journal);
    this.git("reset", "--hard", newHead);
    return this.completeSync(state, journal);
  }
  completeSync(state, journal) {
    Object.assign(state.merged, journal.merged);
    for (const name of Object.keys(journal.merged)) delete state.features[name];
    for (const feature of Object.values(state.features))
      feature.publishedCommits = feature.publishedCommits.map(
        (sha) => journal.mapping[sha] || sha,
      );
    this.save(state);
    if (fs.existsSync(journal.dir)) this.removeWorktree(journal.dir);
    fs.unlinkSync(this.journalPath);
    return {
      merged: Object.keys(journal.merged),
      remaining: journal.queue.map((c) => journal.mapping[c.sha]),
      backup: journal.backup,
    };
  }
  dot() {
    const graph = this.graph();
    const q = JSON.stringify;
    const rows = [
      "digraph prm {",
      "  rankdir=LR;",
      "  node [shape=box, style=rounded];",
    ];
    for (const group of graph.groups) {
      rows.push(
        `  ${q(`feature:${group.name}`)} [label=${q(`${group.name}${group.pr ? ` #${group.pr}` : ""}\n${group.commits.length} commits`)}];`,
      );
      for (const dep of group.deps)
        rows.push(`  ${q(`feature:${dep}`)} -> ${q(`feature:${group.name}`)};`);
    }
    for (const [name] of Object.entries(graph.merged))
      rows.push(
        `  ${q(`feature:${name}`)} [label=${q(`${name} (merged)`)}, color="green"];`,
      );
    rows.push("  subgraph commits {", "    rankdir=TB;");
    for (const c of graph.commits) {
      rows.push(
        `    ${q(c.sha)} [shape=ellipse,label=${q(`${c.sha.slice(0, 7)} ${c.subject}`)}];`,
      );
      for (const p of c.parents)
        if (graph.commits.some((c) => c.sha === p))
          rows.push(`    ${q(p)} -> ${q(c.sha)} [color="gray"];`);
      if (c.name)
        rows.push(
          `    ${q(c.sha)} -> ${q(`feature:${c.name}`)} [style=dotted, arrowhead=none];`,
        );
    }
    rows.push("  }", "}");
    return rows.join("\n");
  }
}
