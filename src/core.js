import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

export const NOTES = "refs/notes/prm";

export function run(command, args, cwd, options = {}) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, GH_PROMPT_DISABLED: "1", GIT_TERMINAL_PROMPT: "0" },
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const error = new Error(
      `${command} ${args.join(" ")}\n${result.stderr || result.stdout}`.trim(),
    );
    error.status = result.status;
    throw error;
  }
  return result.stdout.trimEnd();
}

function noteEntries(text) {
  const lines = text.split("\n");
  const entries = [];
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(
      /^prm-(name|deps|title|description):[ \t]*(.*)$/,
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
    } else if (entry.key === "description" && entry.value?.startsWith('"')) {
      try {
        entry.value = JSON.parse(entry.value);
      } catch {
        throw new Error("Invalid JSON string in prm-description.");
      }
      if (typeof entry.value !== "string")
        throw new Error("prm-description must contain text.");
    } else if (entry.key === "description" && entry.value === "") {
      // Also accept a manually written, unindented multiline description.
      const body = [];
      while (
        i + 1 < lines.length &&
        !/^prm-(name|deps|title|description):/.test(lines[i + 1])
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
  for (const key of ["title", "description"]) {
    if (values(key).length > 1)
      throw new Error(`A commit may have only one prm-${key}.`);
  }
  return {
    name: names[0] || null,
    deps: [...new Set(deps)],
    title: values("title")[0] ?? null,
    description: values("description")[0] ?? null,
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
  constructor(cwd = process.cwd(), gh) {
    this.root = run("git", ["rev-parse", "--show-toplevel"], cwd);
    this.common = path.resolve(
      this.root,
      run("git", ["rev-parse", "--git-common-dir"], this.root),
    );
    this.dir = path.join(this.common, "prm");
    this.statePath = path.join(this.dir, "state.json");
    this.journalPath = path.join(this.dir, "sync.json");
    this.gh = gh || ((args) => run("gh", args, this.root));
  }

  git(...args) {
    return run("git", args, this.root);
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
        });
      const group = map.get(commit.name);
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
    return {
      branch: state.branch,
      base: state.base,
      remote: state.remote,
      repo: state.repo,
      head: this.head(),
      revision: `${this.head()}:${this.optionalGit("rev-parse", "--verify", NOTES) || ""}`,
      commits,
      groups,
      merged: state.merged,
      paused: fs.existsSync(this.journalPath),
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
            groups.set(c.name, { name: c.name, deps: [] });
          groups.get(c.name).deps.push(...c.deps);
        }
      validateGraph([...groups.values()], graph.merged);
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
  plan() {
    const graph = this.graph();
    validateGraph(graph.groups, graph.merged);
    return {
      ready: graph.groups.filter((g) => g.ready),
      blocked: graph.groups.filter((g) => !g.ready),
      unassigned: graph.commits.filter((c) => !c.name),
    };
  }
  createWorktree(base) {
    const dir = path.join(this.dir, "worktrees", randomUUID());
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    this.git("worktree", "add", "--detach", dir, base);
    return dir;
  }
  removeWorktree(dir) {
    this.git("worktree", "remove", "--force", dir);
  }
  replay(dir, sha) {
    const [name, email, date] = this.git(
      "show",
      "-s",
      "--format=%cn%x00%ce%x00%cI",
      sha,
    ).split("\0");
    run(
      "git",
      [
        "-c",
        "commit.gpgsign=false",
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
  push({ dryRun = false, names = [] } = {}) {
    return this.locked(() => {
      const state = this.state();
      this.onBranch(state);
      this.clean();
      const plan = this.plan();
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
      for (const feature of Object.values(state.features))
        if (feature.pr) {
          const pr = this.prStatus(state, feature);
          if (pr.state === "MERGED")
            throw new Error(`PR #${pr.number} merged. Run gh prm sync first.`);
          if (pr.state === "CLOSED")
            throw new Error(
              `PR #${pr.number} is closed. Reopen it before pushing.`,
            );
        }
      const result = { pushed: [], previews: [], blocked: plan.blocked };
      // Build every ready projection before any remote writes: missing code dependencies
      // fail locally without publishing a partial batch.
      const projections = [];
      try {
        for (const group of selected) {
          if (!group.ready) {
            // Explicitly selected blocked features get the full integration history,
            // not an isolated projection. They never get a pull request.
            projections.push({ group, dir: null, head: this.head() });
            continue;
          }
          const dir = this.createWorktree(this.baseRef(state));
          projections.push({ group, dir });
          try {
            for (const sha of group.commits) this.replay(dir, sha);
          } catch (e) {
            throw new Error(
              `Cannot isolate ${group.name}. Add the missing dependency or make its commits independent.\n${e.message}`,
            );
          }
          projections.at(-1).head = run("git", ["rev-parse", "HEAD"], dir);
        }
        for (const { group, head } of projections) {
          const feature = Object.hasOwn(state.features, group.name)
            ? state.features[group.name]
            : { branch: `prm/${group.name}` };
          const remoteRef = `refs/heads/${feature.branch}`;
          const existing = this.git(
            "ls-remote",
            "--heads",
            state.remote,
            remoteRef,
          ).split(/\s/)[0];
          if (existing && existing !== feature.publishedHead)
            throw new Error(
              `Remote branch ${feature.branch} changed outside prm. Refusing to overwrite it.`,
            );
          const lease = `--force-with-lease=${remoteRef}:${feature.publishedHead || ""}`;
          this.git("push", lease, state.remote, `${head}:${remoteRef}`);
          feature.publishedHead = head;
          feature.publishedCommits = group.commits;
          feature.state = group.ready ? "OPEN" : "PREVIEW";
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
  sync({ dryRun = false, continue: resume = false, abort = false } = {}) {
    return this.locked(
      () => {
        const state = this.state();
        this.onBranch(state);
        this.clean();
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
              [
                "-c",
                "core.editor=true",
                "-c",
                "commit.gpgsign=false",
                "cherry-pick",
                "--continue",
              ],
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
          if (feature.pr) {
            const pr = this.prStatus(state, feature);
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
