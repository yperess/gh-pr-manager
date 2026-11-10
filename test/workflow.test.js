import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  Manager,
  NOTES,
  parseNote,
  parseConfig,
  editNote,
  editMetadataNote,
  run,
} from "../src/core.js";
import {
  continuousPush,
  planPushRun,
  readPushRun,
  stopPushRun,
} from "../src/push-run.js";
import { prepareUiWorktree, resolveUiManager } from "../src/ui-worktree.js";
import { createServer } from "../src/server.js";
import { pushRequest, operationRequest } from "../src/requests.js";
import { requestBridge } from "../src/operations.js";

test("failed commands retain hook stdout as well as Git stderr", () => {
  assert.throws(
    () =>
      run(
        process.execPath,
        [
          "-e",
          'process.stdout.write("Formatting check failed\\n"); process.stderr.write("Failed to push refs\\n"); process.exit(1);',
        ],
        os.tmpdir(),
      ),
    (error) => {
      assert.equal(error.status, 1);
      assert.ok(
        error.message.endsWith(
          "\nFormatting check failed\nFailed to push refs",
        ),
      );
      return true;
    },
  );
});

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prm-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bare = path.join(dir, "origin.git"),
    root = path.join(dir, "work");
  fs.mkdirSync(root);
  run("git", ["init", "--bare", "--initial-branch=main", bare], dir);
  run("git", ["init", "--initial-branch=main"], root);
  const git = (...args) => run("git", args, root);
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  git("config", "commit.gpgsign", "false");
  git("config", "core.hooksPath", "/dev/null");
  fs.writeFileSync(path.join(root, "base.txt"), "base\n");
  git("add", ".");
  git("commit", "-m", "base");
  git("remote", "add", "origin", bare);
  git("push", "-u", "origin", "main");
  git("switch", "-c", "work");
  const prs = new Map();
  let number = 0;
  const gh = (args) => {
    const value = (flag) => args[args.indexOf(flag) + 1];
    if (args[0] === "pr" && args[1] === "view") {
      const pr = [...prs.values()].find((p) => p.number === Number(args[2]));
      assert.ok(pr);
      return JSON.stringify(pr);
    }
    if (args[0] === "pr" && args[1] === "list") {
      const pr = prs.get(value("--head"));
      return JSON.stringify(
        pr && pr.state.toLowerCase() === value("--state") ? [pr] : [],
      );
    }
    if (args[0] === "pr" && args[1] === "create") {
      const branch = value("--head");
      const pr = {
        number: ++number,
        url: `https://github.test/user/repo/pull/${number}`,
        state: "OPEN",
        headRefName: branch,
        isCrossRepository: false,
        baseRefName: value("--base"),
        headRefOid: run("git", ["rev-parse", `refs/heads/${branch}`], bare),
        title: value("--title"),
        body: value("--body"),
      };
      prs.set(branch, pr);
      run(
        "git",
        ["update-ref", `refs/pull/${pr.number}/head`, pr.headRefOid],
        bare,
      );
      return pr.url;
    }
    throw new Error(`Unexpected fake gh invocation: ${args.join(" ")}`);
  };
  const manager = new Manager(root, gh);
  manager.init({ base: "main", repo: "https://github.test/user/repo" });
  const commit = (
    subject,
    file = `${subject}.txt`,
    content = `${subject}\n`,
  ) => {
    fs.writeFileSync(path.join(root, file), content);
    git("add", "--", file);
    git("commit", "-m", subject);
    return git("rev-parse", "HEAD");
  };
  const merge = (name) => {
    const feature = manager.state().features[name];
    const head = run(
      "git",
      ["rev-parse", `refs/heads/${feature.branch}`],
      bare,
    );
    const worktree = manager.createWorktree(manager.baseRef(manager.state()));
    run("git", ["merge", "--squash", head], worktree);
    run("git", ["commit", "-m", `Squash ${name}`], worktree);
    run("git", ["push", "origin", "HEAD:main"], worktree);
    manager.removeWorktree(worktree);
    Object.assign(prs.get(feature.branch), {
      state: "MERGED",
      mergedAt: "2026-11-09T12:00:00Z",
      headRefOid: head,
      mergeCommit: { oid: run("git", ["rev-parse", "main"], bare) },
    });
  };
  const updatePrHeads = () => {
    for (const [branch, pr] of prs)
      if (pr.state === "OPEN")
        pr.headRefOid = run("git", ["rev-parse", `refs/heads/${branch}`], bare);
  };
  const subjects = (ref) =>
    git("log", "--reverse", "--format=%s", `origin/main..${ref}`)
      .split("\n")
      .filter(Boolean);
  return {
    dir,
    root,
    bare,
    git,
    manager,
    commit,
    merge,
    prs,
    subjects,
    updatePrHeads,
  };
}

function configure(f, content) {
  fs.appendFileSync(path.join(f.root, ".git/info/exclude"), "\n.ghprm\n");
  fs.writeFileSync(path.join(f.root, ".ghprm"), content);
}

test("background sync streams actual commands, rebases onto new base, and preserves notes", async (t) => {
  const f = fixture(t),
    m = f.manager;
  m.tag("one", [f.commit("A")]);
  const before = m.head(),
    old = m.graph().revision;
  m.metadata(before, { title: "Keep this title" });
  assert.throws(
    () => operationRequest(m, "sync", { revision: old }),
    /repository changed/,
  );
  const dir = m.createWorktree("origin/main");
  fs.writeFileSync(path.join(dir, "upstream.txt"), "Upstream change\n");
  run("git", ["add", "upstream.txt"], dir);
  run("git", ["commit", "-m", "Upstream change"], dir);
  run("git", ["push", "origin", "HEAD:refs/heads/main"], dir);
  m.removeWorktree(dir);
  // The hook cannot finish until the parent receives a progress event. This
  // proves the log is delivered during the operation, rather than at its end.
  const hooks = path.join(f.dir, "hooks"),
    release = path.join(f.dir, "release-hook");
  fs.mkdirSync(hooks);
  fs.writeFileSync(
    path.join(hooks, "post-checkout"),
    `#!/usr/bin/env node
const fs = require("node:fs");
const wait = new Int32Array(new SharedArrayBuffer(4));
const deadline = Date.now() + 5000;
while (!fs.existsSync(${JSON.stringify(release)})) {
  if (Date.now() > deadline) process.exit(1);
  Atomics.wait(wait, 0, 0, 20);
}
`,
    { mode: 0o755 },
  );
  f.git("config", "core.hooksPath", hooks);
  const progress = [];
  const result = await requestBridge(
    f.root,
    new URL("../src/bridge.js", import.meta.url).pathname,
    { route: "sync", data: { revision: m.graph().revision } },
    (event) => {
      progress.push(event.command);
      if (event.command.startsWith("git worktree add"))
        fs.writeFileSync(release, "released");
    },
  );
  assert.notEqual(m.head(), before);
  assert.equal(result.remaining.length, 1);
  assert.equal(parseNote(m.note(m.head())).title, "Keep this title");
  assert.ok(progress.some((command) => command.startsWith("git fetch")));
  assert.ok(progress.some((command) => command.startsWith("git cherry-pick")));
  assert.ok(progress.some((command) => command.startsWith("git reset --hard")));
  assert.equal(f.git("status", "--porcelain"), "");
  fs.writeFileSync(path.join(f.root, "dirty.txt"), "dirty");
  await assert.rejects(
    () =>
      requestBridge(
        f.root,
        new URL("../src/bridge.js", import.meta.url).pathname,
        { route: "sync", data: { revision: m.graph().revision } },
      ),
    /Working tree must be clean/,
  );
});

test("loopback sync endpoint uses a background worker and streams its result", async (t) => {
  const f = fixture(t),
    m = f.manager;
  m.tag("one", [f.commit("A")]);
  const { server, token } = createServer(m);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}/api/sync`;
  const body = JSON.stringify({ revision: m.graph().revision });
  assert.equal((await fetch(url, { method: "POST", body })).status, 403);
  const response = await fetch(url, {
    method: "POST",
    body,
    headers: { "X-PRM-Token": token },
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /ndjson/);
  const events = (await response.text())
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.ok(
    events.some(
      (event) =>
        event.type === "progress" && event.command.startsWith("git fetch"),
    ),
  );
  assert.equal(events.at(-1).result.unchanged, true);
});

test("UI push rejects malformed, stale and dirty requests before publishing", (t) => {
  const f = fixture(t),
    m = f.manager;
  m.tag("one", [f.commit("A")]);
  const revision = m.graph().revision;
  for (const data of [
    null,
    {},
    { revision, names: [] },
    { revision, names: [], dryRun: "false" },
    { revision, names: [1], dryRun: false },
  ])
    assert.throws(() => pushRequest(m, data), /explicit dryRun/);
  assert.equal(
    pushRequest(m, { revision, names: [], dryRun: true }).ready.length,
    1,
  );
  assert.equal(f.prs.size, 0);
  fs.writeFileSync(path.join(f.root, "dirty.txt"), "dirty");
  assert.throws(
    () => pushRequest(m, { revision, names: [], dryRun: false }),
    /Working tree must be clean/,
  );
  fs.unlinkSync(path.join(f.root, "dirty.txt"));
  m.metadata(m.head(), { title: "New title" });
  assert.throws(
    () => pushRequest(m, { revision, names: [], dryRun: false }),
    /repository changed/,
  );
  const current = m.graph().revision;
  pushRequest(m, { revision: current, names: [], dryRun: false });
  assert.notEqual(m.graph().revision, current); // Publishing changes state, even with identical notes and HEAD.
  assert.throws(
    () => pushRequest(m, { revision: current, names: [], dryRun: false }),
    /repository changed/,
  );
  assert.equal(f.prs.size, 1);
});

test("root config is literal, optional and strict", () => {
  assert.equal(parseConfig("").branchPrefix, "prm/");
  for (const value of ["yperess", "yperess/", '"yperess"'])
    assert.equal(
      parseConfig(`# personal config\nBRANCH_PREFIX=${value}\n`).branchPrefix,
      "yperess/",
    );
  assert.equal(parseConfig("BRANCH_PREFIX=").branchPrefix, "");
  assert.equal(
    parseConfig("BRANCH_PREFIX=$(whoami)").branchPrefix,
    "$(whoami)/",
  );
  assert.throws(() => parseConfig("UNKNOWN=x"), /Invalid .ghprm/);
  assert.throws(
    () => parseConfig("BRANCH_PREFIX=x\nBRANCH_PREFIX=y"),
    /Invalid .ghprm/,
  );
});

test("custom prefixes apply to new branches and never rename published branches", (t) => {
  const f = fixture(t),
    m = f.manager;
  configure(f, "BRANCH_PREFIX=yperess/");
  fs.mkdirSync(path.join(f.root, "subdir"));
  m.tag("one", [f.commit("A")]);
  assert.equal(
    new Manager(path.join(f.root, "subdir"), m.gh).graph().groups[0].branch,
    "yperess/one",
  );
  assert.equal(m.push({ dryRun: true }).ready[0].branch, "yperess/one");
  m.push();
  assert.equal(m.state().features.one.branch, "yperess/one");
  const revision = m.graph().revision;
  configure(f, "BRANCH_PREFIX=someone");
  assert.notEqual(m.graph().revision, revision);
  m.tag("two", [f.commit("B")]);
  assert.deepEqual(
    m.graph().groups.map((g) => g.branch),
    ["yperess/one", "someone/two"],
  );
  m.push();
  assert.equal(f.prs.size, 2);
  assert.throws(
    () => m.branchName("one", "someone/one"),
    /Cannot rename published/,
  );
  m.branchName("one", null);
  assert.equal(m.graph().groups[0].branch, "yperess/one");
});

test("branch notes use the last override and survive other edits and sync", (t) => {
  const f = fixture(t),
    m = f.manager;
  const a = f.commit("A");
  m.tag("one", [a]);
  m.writeNote(a, `${m.note(a)}\nprm-branch-name: first/branch`);
  const b = f.commit("B");
  m.tag("one", [b]);
  m.writeNote(
    b,
    `${m.note(b)}\nprm-branch-name: "yperess/migrate-struct-fixture"`,
  );
  assert.equal(m.graph().groups[0].branch, "yperess/migrate-struct-fixture");
  m.metadata(b, { description: "Body\nprm-branch-name: literal body" });
  m.dependencies("one", []);
  assert.equal(
    parseNote(m.note(b)).branchName,
    "yperess/migrate-struct-fixture",
  );
  assert.equal(
    parseNote(m.note(b)).description,
    "Body\nprm-branch-name: literal body",
  );
  m.sync();
  assert.equal(m.graph().groups[0].branch, "yperess/migrate-struct-fixture");
  m.branchName("one", "yperess/migrate-optional-interface-fixture");
  assert.equal(
    parseNote(m.note(m.graph().groups[0].commits[1])).branchName,
    null,
  );
  m.branchName("one", null);
  assert.equal(m.graph().groups[0].branch, "prm/one");
  assert.throws(
    () => parseNote("prm-branch-name: x\nprm-branch-name: y"),
    /only one/,
  );
});

test("invalid branch names and conflicting targets fail before remote writes", (t) => {
  const f = fixture(t),
    m = f.manager;
  m.tag("one", [f.commit("A")]);
  m.tag("two", [f.commit("B")]);
  for (const branch of [
    "main",
    "work",
    "prm/two",
    "prm/two/child",
    "prm",
    "main/child",
    "bad..name",
    "bad name",
    "",
    "-option",
    "HEAD",
  ])
    assert.throws(
      () => m.branchName("one", branch),
      /conflicts|Invalid branch/,
    );
  configure(f, "BRANCH_PREFIX=bad//prefix");
  assert.throws(() => m.push(), /Invalid branch/);
  assert.equal(f.prs.size, 0);
  assert.equal(f.git("ls-remote", "--heads", "origin", "refs/heads/prm/*"), "");
});

test("explicit adoption preserves an existing branch and PR, then supports review and sync", (t) => {
  const f = fixture(t),
    m = f.manager;
  const a = f.commit("A");
  m.tag("one", [a]);
  const branch = "yperess/migrate-struct-fixture";
  f.git("push", "origin", `HEAD:refs/heads/${branch}`);
  f.prs.set(branch, {
    number: 42,
    url: "https://github.test/user/repo/pull/42",
    state: "OPEN",
    baseRefName: "main",
    headRefOid: a,
    title: "Existing review",
  });
  m.branchName("one", branch);
  const result = m.push();
  assert.equal(result.pushed[0].pr, 42);
  assert.equal(m.state().features.one.publishedHead, a);
  assert.equal(f.prs.size, 1);
  m.tag("one", [f.commit("Review")]);
  m.push();
  assert.deepEqual(f.subjects(m.state().features.one.publishedHead), [
    "A",
    "Review",
  ]);
  assert.equal(f.prs.get(branch).title, "Existing review");
  f.updatePrHeads();
  f.merge("one");
  m.sync();
  assert.equal(m.graph().commits.length, 0);
});

test("adoption accepts equivalent cherry-picks with different commit IDs", (t) => {
  const f = fixture(t),
    m = f.manager;
  m.tag("other", [f.commit("Other")]);
  const a = f.commit("A");
  m.tag("one", [a]);
  const dir = m.createWorktree("origin/main");
  const projected = m.replay(dir, a);
  run("git", ["push", "origin", "HEAD:refs/heads/yperess/existing"], dir);
  m.removeWorktree(dir);
  assert.notEqual(a, projected);
  m.branchName("one", "yperess/existing");
  m.push({ names: ["one"] });
  assert.equal(m.state().features.one.publishedHead, projected);
});

test("adoption rejects extra remote commits without publishing any of the batch", (t) => {
  const f = fixture(t),
    m = f.manager;
  m.tag("one", [f.commit("A")]);
  const extra = f.commit("Extra");
  m.tag("two", [extra]);
  f.git("push", "origin", "HEAD:yperess/existing");
  m.branchName("two", "yperess/existing");
  assert.throws(() => m.push(), /does not match/);
  assert.equal(f.prs.size, 0);
  assert.equal(f.git("ls-remote", "--heads", "origin", "prm/one"), "");
  assert.equal(run("git", ["rev-parse", "yperess/existing"], f.bare), extra);
});

test("adoption rejects a PR targeting the wrong base before modifying its branch", (t) => {
  const f = fixture(t),
    m = f.manager;
  const a = f.commit("A");
  m.tag("one", [a]);
  f.git("push", "origin", "HEAD:yperess/existing");
  f.prs.set("yperess/existing", {
    number: 1,
    state: "OPEN",
    baseRefName: "another-base",
  });
  m.branchName("one", "yperess/existing");
  assert.throws(() => m.push(), /unique PR/);
  assert.deepEqual(m.state().features, {});
});

test("unchanged adoption rechecks a remote branch after preflight", (t) => {
  const f = fixture(t),
    m = f.manager;
  const a = f.commit("A");
  m.tag("one", [a]);
  f.git("push", "origin", "HEAD:refs/heads/yperess/existing");
  const race = f.commit("Race");
  m.tag("race", [race]);
  f.git("push", "origin", "HEAD:refs/heads/race-object");
  m.branchName("one", "yperess/existing");
  const original = m.git.bind(m);
  let reads = 0;
  m.git = (...args) => {
    if (args[0] === "ls-remote" && ++reads === 2)
      run(
        "git",
        ["update-ref", "refs/heads/yperess/existing", race, a],
        f.bare,
      );
    return original(...args);
  };
  assert.throws(() => m.push({ names: ["one"] }), /changed after preflight/);
  assert.equal(run("git", ["rev-parse", "yperess/existing"], f.bare), race);
  assert.deepEqual(m.state().features, {});
});

test("A–F workflow isolates sibling PRs, handles review commits, squash merges, and notes rewrites", (t) => {
  const f = fixture(t),
    { manager: m, commit } = f;
  const A = commit("A");
  m.tag("feature1", [A]);
  const B = commit("B");
  m.tag("feature2", [B]);
  const C = commit("C", "C.txt", "C\n");
  const D = commit("D", "C.txt", "C\nD\n");
  m.tag("feature3", [C, D]);
  m.dependencies("feature3", ["feature1", "feature2"]);
  assert.deepEqual(
    m.plan().ready.map((g) => g.name),
    ["feature1", "feature2"],
  );
  assert.equal(m.push({ dryRun: true }).ready.length, 2);
  assert.equal(f.prs.size, 0);
  assert.equal(m.push().pushed.length, 2);
  const state = m.state();
  assert.deepEqual(f.subjects(state.features.feature1.publishedHead), ["A"]);
  assert.deepEqual(f.subjects(state.features.feature2.publishedHead), ["B"]);
  assert.throws(
    () =>
      run(
        "git",
        ["show", `${state.features.feature1.publishedHead}:B.txt`],
        f.bare,
      ),
    /does not exist/,
  );
});

test("complete A–F progression retains C,D,F and publishes feature3 only after both prerequisites merge", (t) => {
  const f = fixture(t),
    { manager: m, commit } = f;
  const A = commit("A");
  m.tag("feature1", [A]);
  const B = commit("B");
  m.tag("feature2", [B]);
  const C = commit("C", "C.txt", "C\n"),
    D = commit("D", "C.txt", "C\nD\n");
  m.tag("feature3", [C, D]);
  m.dependencies("feature3", ["feature1", "feature2"]);
  m.push();
  const E = commit("E", "A.txt", "A\nE\n");
  m.tag("feature1", [E]);
  const F = commit("F", "C.txt", "C\nD\nF\n");
  m.tag("feature3", [F]);
  f.merge("feature2");
  const preview = m.sync({ dryRun: true });
  assert.deepEqual(preview.merged, ["feature2"]);
  assert.equal(m.head(), F);
  const first = m.sync();
  assert.deepEqual(first.merged, ["feature2"]);
  assert.deepEqual(f.subjects("HEAD"), ["A", "C", "D", "E", "F"]);
  assert.deepEqual(m.graph().groups.find((g) => g.name === "feature3").deps, [
    "feature1",
    "feature2",
  ]);
  assert.equal(m.plan().ready.length, 1);
  const pushed = m.push();
  assert.deepEqual(
    pushed.pushed.map((p) => p.name),
    ["feature1"],
  );
  assert.equal(f.prs.size, 2);
  assert.deepEqual(f.subjects(m.state().features.feature1.publishedHead), [
    "A",
    "E",
  ]);
  f.updatePrHeads();
  f.merge("feature1");
  m.sync();
  assert.deepEqual(f.subjects("HEAD"), ["C", "D", "F"]);
  assert.equal(fs.readFileSync(path.join(f.root, "A.txt"), "utf8"), "A\nE\n");
  assert.equal(m.graph().groups[0].ready, true);
  const final = m.push();
  assert.equal(final.pushed[0].pr, 3);
  assert.deepEqual(f.subjects(m.state().features.feature3.publishedHead), [
    "C",
    "D",
    "F",
  ]);
  assert.equal(f.git("status", "--porcelain"), "");
  assert.equal(f.git("branch", "--show-current"), "work");
  assert.ok(
    f.git("for-each-ref", "--format=%(refname)", "refs/prm/backups").split("\n")
      .length >= 2,
  );
});

test("named push publishes only selected groups; blocked selections get full-history branches without PRs", (t) => {
  const f = fixture(t),
    m = f.manager;
  const A = f.commit("A");
  m.tag("feature1", [A]);
  const B = f.commit("B");
  m.tag("feature2", [B]);
  const C = f.commit("C");
  m.tag("feature3", [C]);
  m.dependencies("feature3", ["feature2"]);
  const D = f.commit("D");
  m.tag("feature3", [D]);
  const preview = m.push({ dryRun: true, names: ["feature2", "feature3"] });
  assert.equal(preview.ready.length, 1);
  assert.equal(preview.previews.length, 1);
  assert.equal(f.prs.size, 0);
  const pushed = m.push({ names: ["feature2", "feature3"] });
  assert.deepEqual(
    pushed.pushed.map((g) => g.name),
    ["feature2"],
  );
  assert.equal(pushed.previews[0].name, "feature3");
  assert.equal(f.prs.size, 1);
  assert.equal(run("git", ["rev-parse", "refs/heads/prm/feature3"], f.bare), D);
  assert.deepEqual(f.subjects(D), ["A", "B", "C", "D"]);
  assert.equal(m.state().features.feature3.pr, undefined);
  assert.equal(m.state().features.feature1, undefined);
  f.merge("feature2");
  m.sync();
  const now = m.push({ names: ["feature3"] });
  assert.equal(now.pushed[0].name, "feature3");
  assert.equal(f.prs.size, 2);
  assert.deepEqual(f.subjects(m.state().features.feature3.publishedHead), [
    "C",
    "D",
  ]);
});

test("cycle and unknown dependencies are rejected without changing notes", (t) => {
  const f = fixture(t),
    m = f.manager;
  const A = f.commit("A");
  m.tag("one", [A]);
  const B = f.commit("B");
  m.tag("two", [B]);
  m.dependencies("two", ["one"]);
  const before = f.git("rev-parse", NOTES);
  assert.throws(() => m.dependencies("one", ["two"]), /cycle/);
  assert.equal(f.git("rev-parse", NOTES), before);
  assert.throws(() => m.dependencies("one", ["missing"]), /Unknown dependency/);
  assert.throws(() => m.tag("../unsafe", [A]), /Feature names/);
  m.dependencies("two", []);
  assert.deepEqual(m.graph().groups.find((g) => g.name === "two").deps, []);
});

test("notes preserve unrelated text and work through git commit --amend", (t) => {
  const f = fixture(t),
    m = f.manager;
  const A = f.commit("A");
  f.git("notes", "--ref", NOTES, "add", "-m", "A human note", A);
  m.tag("one", [A]);
  assert.match(m.note(A), /A human note/);
  assert.equal(parseNote(m.note(A)).name, "one");
  f.git("commit", "--amend", "-m", "A amended");
  assert.equal(parseNote(m.note(m.head())).name, "one");
});

test("notes pull fast-forwards safely and refuses to overwrite divergent local notes", (t) => {
  const f = fixture(t),
    m = f.manager;
  const A = f.commit("A");
  m.tag("one", [A]);
  m.shareNotes("push");
  const peer = path.join(f.dir, "peer");
  run("git", ["clone", f.bare, peer], f.dir);
  run("git", ["config", "user.name", "Peer"], peer);
  run("git", ["config", "user.email", "peer@example.com"], peer);
  run("git", ["config", "commit.gpgsign", "false"], peer);
  run("git", ["fetch", "origin", `${NOTES}:${NOTES}`], peer);
  const base = run("git", ["rev-parse", "HEAD"], peer);
  run("git", ["notes", "--ref", NOTES, "add", "-m", "peer note", base], peer);
  run("git", ["push", "origin", `${NOTES}:${NOTES}`], peer);
  m.shareNotes("pull");
  assert.equal(m.note(base), "peer note");
  const B = f.commit("B");
  m.tag("two", [B]);
  const local = f.git("rev-parse", NOTES);
  run(
    "git",
    ["notes", "--ref", NOTES, "add", "-f", "-m", "peer changed note", base],
    peer,
  );
  run("git", ["push", "origin", `${NOTES}:${NOTES}`], peer);
  assert.throws(() => m.shareNotes("pull"), /Notes diverged/);
  assert.equal(f.git("rev-parse", NOTES), local);
  assert.equal(m.note(B), "prm-name: two");
});

test("dirty and untagged work cannot be published; no automatic stash", (t) => {
  const f = fixture(t),
    m = f.manager;
  f.commit("A");
  assert.throws(() => m.push(), /Tag all commits/);
  m.tag("one");
  fs.writeFileSync(path.join(f.root, "dirty.txt"), "dirty");
  const head = m.head();
  assert.throws(() => m.push(), /clean/);
  assert.throws(() => m.sync(), /clean/);
  assert.equal(m.head(), head);
  assert.equal(f.git("stash", "list"), "");
});

test("isolation conflicts stop all publication and leave source history untouched", (t) => {
  const f = fixture(t),
    m = f.manager;
  const A = f.commit("A", "shared.txt", "A\n");
  m.tag("one", [A]);
  const B = f.commit("B", "shared.txt", "B\n");
  m.tag("two", [B]);
  const head = m.head();
  assert.throws(() => m.push(), /Cannot isolate two/);
  assert.equal(f.prs.size, 0);
  assert.equal(m.head(), head);
  assert.equal(
    f.git("worktree", "list", "--porcelain").split("worktree ").length,
    2,
  );
  m.dependencies("two", ["one"]);
  assert.equal(m.push().pushed.length, 1);
});

test("unpublished review commits are never discarded after a PR merges", (t) => {
  const f = fixture(t),
    m = f.manager;
  const A = f.commit("A");
  m.tag("one", [A]);
  m.push();
  const E = f.commit("E");
  m.tag("one", [E]);
  f.merge("one");
  assert.throws(() => m.sync(), /unpublished local commits/);
  assert.equal(m.head(), E);
  m.tag("one-followup", [E]);
  m.dependencies("one-followup", ["one"]);
  m.sync();
  assert.deepEqual(f.subjects("HEAD"), ["E"]);
});

test("remote branch collisions are never overwritten", (t) => {
  const f = fixture(t),
    m = f.manager;
  const A = f.commit("A");
  m.tag("one", [A]);
  f.git("push", "origin", "HEAD:refs/heads/prm/one");
  assert.throws(() => m.push(), /already exists/);
  assert.equal(f.prs.size, 0);
});

test("a reported merge must exist in the fetched base before local commits are pruned", (t) => {
  const f = fixture(t),
    m = f.manager;
  const A = f.commit("A");
  m.tag("one", [A]);
  m.push();
  const feature = m.state().features.one;
  Object.assign(f.prs.get(feature.branch), {
    state: "MERGED",
    mergedAt: "2026-11-09T12:00:00Z",
    mergeCommit: { oid: feature.publishedHead },
  });
  assert.throws(() => m.sync(), /not in the fetched base/);
  assert.equal(m.head(), A);
});

test("sync can finish after interruption between branch replacement and metadata finalization", (t) => {
  const f = fixture(t),
    m = f.manager;
  const A = f.commit("A");
  m.tag("one", [A]);
  m.push();
  f.commit("B");
  m.tag("two");
  f.merge("one");
  const original = m.completeSync.bind(m);
  m.completeSync = () => {
    throw new Error("simulated process interruption");
  };
  assert.throws(() => m.sync(), /simulated/);
  assert.equal(fs.existsSync(m.journalPath), true);
  m.completeSync = original;
  const result = m.sync({ continue: true });
  assert.deepEqual(result.merged, ["one"]);
  assert.deepEqual(f.subjects("HEAD"), ["B"]);
  assert.equal(m.graph().groups[0].name, "two");
});

test("sync conflict recovery leaves original branch intact and supports abort", (t) => {
  const f = fixture(t),
    m = f.manager;
  const A = f.commit("local", "base.txt", "local\n");
  m.tag("one", [A]);
  const dir = m.createWorktree("origin/main");
  fs.writeFileSync(path.join(dir, "base.txt"), "remote\n");
  run("git", ["add", "."], dir);
  run("git", ["commit", "-m", "remote"], dir);
  run("git", ["push", "origin", "HEAD:main"], dir);
  m.removeWorktree(dir);
  assert.throws(() => m.sync(), /Sync paused/);
  assert.equal(m.head(), A);
  assert.equal(
    fs.readFileSync(path.join(f.root, "base.txt"), "utf8"),
    "local\n",
  );
  assert.throws(() => m.tag("other", [A]), /paused/);
  assert.deepEqual(m.sync({ abort: true }), { aborted: true });
  assert.equal(m.head(), A);
});

test("sync --continue replays remaining commits and carries their notes", (t) => {
  const f = fixture(t),
    m = f.manager;
  const A = f.commit("local", "base.txt", "local\n");
  m.tag("one", [A]);
  const B = f.commit("next");
  m.tag("two", [B]);
  const dir = m.createWorktree("origin/main");
  fs.writeFileSync(path.join(dir, "base.txt"), "remote\n");
  run("git", ["add", "."], dir);
  run("git", ["commit", "-m", "remote"], dir);
  run("git", ["push", "origin", "HEAD:main"], dir);
  m.removeWorktree(dir);
  assert.throws(() => m.sync(), /Sync paused/);
  const journal = JSON.parse(fs.readFileSync(m.journalPath));
  fs.writeFileSync(path.join(journal.dir, "base.txt"), "resolved\n");
  run("git", ["add", "base.txt"], journal.dir);
  const synced = m.sync({ continue: true });
  assert.equal(synced.remaining.length, 2);
  assert.equal(
    fs.readFileSync(path.join(f.root, "base.txt"), "utf8"),
    "resolved\n",
  );
  assert.deepEqual(
    m.graph().commits.map((c) => c.name),
    ["one", "two"],
  );
  assert.ok(!fs.existsSync(m.journalPath));
});

test("loopback UI requires a session token and validates edits and stale revisions", async (t) => {
  const f = fixture(t),
    m = f.manager;
  const A = f.commit("<script>A</script>", "A.txt");
  m.tag("one", [A]);
  const B = f.commit("B");
  m.tag("two", [B]);
  const { server, token } = createServer(m, undefined, {
    operation: async (route, data, emit) => {
      m.onProgress = (event) => emit({ type: "progress", ...event });
      try {
        return operationRequest(m, route, data);
      } finally {
        m.onProgress = null;
      }
    },
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(`${base}/api/graph`)).status, 403);
  const headers = { "X-PRM-Token": token, "Content-Type": "application/json" };
  const response = await fetch(`${base}/api/graph`, { headers });
  assert.equal(response.status, 200);
  const graph = await response.json();
  assert.equal(
    (
      await fetch(`${base}/api/graph`, {
        headers: { ...headers, Origin: "https://evil.test" },
      })
    ).status,
    403,
  );
  const edit = await fetch(`${base}/api/deps`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      revision: graph.revision,
      name: "two",
      deps: ["one"],
    }),
  });
  assert.equal(edit.status, 200);
  const stale = await fetch(`${base}/api/deps`, {
    method: "POST",
    headers,
    body: JSON.stringify({ revision: graph.revision, name: "two", deps: [] }),
  });
  assert.equal(stale.status, 409);
  const updated = await edit.json();
  const metadata = await fetch(`${base}/api/metadata`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      revision: updated.revision,
      sha: B,
      overrides: {
        title: "HTTP title",
        description: "Body\n\nSecond paragraph",
      },
    }),
  });
  assert.equal(metadata.status, 200);
  const afterMetadata = await metadata.json();
  assert.equal(
    afterMetadata.commits.find((c) => c.sha === B).effectiveMetadata.title,
    "HTTP title",
  );
  const staleMetadata = await fetch(`${base}/api/metadata`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      revision: updated.revision,
      sha: B,
      overrides: { title: "stale" },
    }),
  });
  assert.equal(staleMetadata.status, 409);
  const branchEdit = await fetch(`${base}/api/branch`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      revision: afterMetadata.revision,
      name: "two",
      branchName: "yperess/two",
    }),
  });
  assert.equal(branchEdit.status, 200);
  assert.equal(
    (await branchEdit.json()).groups.find((g) => g.name === "two").branch,
    "yperess/two",
  );
  const page = await fetch(base);
  assert.match(
    page.headers.get("content-security-policy"),
    /default-src 'none'/,
  );
  assert.equal(page.status, 200);
  assert.match(m.dot(), /feature:one.*->.*feature:two/);
  const revision = m.graph().revision;
  const push = (body, extraHeaders = headers) =>
    fetch(`${base}/api/push`, {
      method: "POST",
      headers: extraHeaders,
      body: JSON.stringify(body),
    });
  assert.equal(
    (await push({ revision, names: [], dryRun: false }, {})).status,
    403,
  );
  assert.equal(
    (
      await push(
        { revision, names: [], dryRun: false },
        { ...headers, Origin: "https://evil.test" },
      )
    ).status,
    403,
  );
  assert.equal((await push({ revision, names: [] })).status, 400);
  const plan = await push({ revision, names: ["two"], dryRun: true });
  assert.equal(plan.status, 200);
  assert.equal((await plan.json()).previews[0].name, "two");
  assert.equal(f.prs.size, 0);
  const published = await push({ revision, names: [], dryRun: false });
  assert.equal(published.status, 200);
  const events = (await published.text())
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.ok(
    events.some(
      (event) =>
        event.type === "progress" && event.command.startsWith("git push"),
    ),
  );
  assert.equal(
    events.find((event) => event.type === "result").result.pushed[0].name,
    "one",
  );
  assert.equal(f.prs.size, 1);
  assert.equal(
    (await push({ revision, names: [], dryRun: false })).status,
    409,
  );
});

test("VS Code process bridge reads the graph and applies validated dependency edits", (t) => {
  const f = fixture(t);
  const a = f.commit("A");
  f.manager.tag("one", [a]);
  const b = f.commit("B");
  f.manager.tag("two", [b]);
  const bridge = new URL("../src/bridge.js", import.meta.url).pathname;
  const request = (message) =>
    JSON.parse(
      run(process.execPath, [bridge], f.root, {
        input: JSON.stringify(message),
      }),
    );
  const graph = request({ route: "graph" });
  assert.equal(graph.groups.length, 2);
  const changed = request({
    route: "deps",
    data: { revision: graph.revision, name: "two", deps: ["one"] },
  });
  assert.deepEqual(changed.groups.find((g) => g.name === "two").deps, ["one"]);
  const metadata = request({
    route: "metadata",
    data: {
      revision: changed.revision,
      sha: a,
      overrides: {
        title: "VS Code title",
        description: "VS Code body\n\nMore text",
      },
    },
  });
  assert.equal(
    metadata.commits.find((c) => c.sha === a).effectiveMetadata.title,
    "VS Code title",
  );
  assert.equal(
    metadata.commits.find((c) => c.sha === a).effectiveMetadata.description,
    "VS Code body\n\nMore text",
  );
  const renamed = request({
    route: "branch",
    data: {
      revision: metadata.revision,
      name: "one",
      branchName: "yperess/one",
    },
  });
  assert.equal(
    renamed.groups.find((g) => g.name === "one").branch,
    "yperess/one",
  );
  assert.throws(
    () =>
      request({
        route: "deps",
        data: { revision: graph.revision, name: "two", deps: [] },
      }),
    /repository changed/,
  );
  const patch = request({ route: `diff?sha=${a}` });
  assert.match(patch.diff, /A.txt/);
  const preview = request({
    route: "push",
    data: { revision: renamed.revision, names: ["one", "two"], dryRun: true },
  });
  assert.equal(preview.ready[0].branch, "yperess/one");
  assert.equal(preview.previews[0].name, "two");
  assert.equal(f.prs.size, 0);
  fs.writeFileSync(path.join(f.root, "dirty.txt"), "dirty");
  assert.throws(
    () =>
      request({
        route: "push",
        data: { revision: renamed.revision, names: [], dryRun: false },
      }),
    /Working tree must be clean/,
  );
});

test("metadata notes preserve multiline text, empty overrides, and unrelated notes during edits", () => {
  const body =
    "# Summary\n\nprm-name: literal text, not a feature\nprm-title: literal heading\n  indented\n\n";
  let note = editMetadataNote(
    "Human annotation\nprm-name: one\nprm-deps: two",
    { title: "First title", description: body },
  );
  assert.equal(parseNote(note).description, body);
  assert.equal(parseNote(note).name, "one");
  note = editNote(note, "one", ["three"]);
  assert.equal(parseNote(note).description, body);
  assert.match(note, /Human annotation/);
  note = editMetadataNote(note, { description: "" });
  assert.equal(parseNote(note).description, "");
  assert.equal(parseNote(note).title, "First title");
  note = editMetadataNote(note, { description: null });
  assert.equal(parseNote(note).description, null);
  assert.equal(parseNote(note).title, "First title");
  assert.equal(
    parseNote(
      "prm-name: one\nprm-description: |\n  First paragraph\n  \n  prm-title: part of the body\nprm-title: Real title",
    ).description,
    "First paragraph\n\nprm-title: part of the body",
  );
  assert.equal(
    parseNote(
      "prm-description:\nFirst paragraph\n\nSecond paragraph\nprm-name: one",
    ).description,
    "First paragraph\n\nSecond paragraph",
  );
});

test("per-commit metadata is inherited independently in feature commit order, with sources and removal", (t) => {
  const f = fixture(t),
    m = f.manager;
  const c = f.commit("C");
  m.tag("feature3", [c]);
  const unrelated = f.commit("Other feature");
  m.tag("feature2", [unrelated]);
  const d = f.commit("D");
  m.tag("feature3", [d]);
  const last = f.commit("F");
  m.tag("feature3", [last]);
  m.metadata(c, { title: "Initial title", description: "Initial body" });
  m.metadata(unrelated, {
    title: "Unrelated title",
    description: "Other body",
  });
  m.metadata(last, { title: "Final title" });
  // Editing an older commit last must still follow history order, not note edit time.
  m.metadata(d, { description: "Middle body" });
  let graph = m.graph();
  const at = (sha) =>
    graph.commits.find((commit) => commit.sha === sha).effectiveMetadata;
  assert.deepEqual(at(d), {
    title: "Initial title",
    description: "Middle body",
    titleSource: c,
    descriptionSource: d,
  });
  assert.deepEqual(at(last), {
    title: "Final title",
    description: "Middle body",
    titleSource: last,
    descriptionSource: d,
  });
  assert.equal(at(c).title, "Initial title");
  assert.equal(
    graph.groups.find((g) => g.name === "feature3").title,
    "Final title",
  );
  m.metadata(last, { title: null, description: "" });
  graph = m.graph();
  assert.equal(at(last).title, "Initial title");
  assert.equal(at(last).titleSource, c);
  assert.equal(at(last).description, "");
  assert.equal(at(last).descriptionSource, last);
  m.metadata(last, { description: null });
  graph = m.graph();
  assert.equal(at(last).description, "Middle body");
  const head = m.head();
  const notes = f.git("rev-parse", NOTES);
  assert.throws(
    () => m.metadata(d, { title: "invalid\nmultiline" }),
    /single line/,
  );
  assert.throws(() => m.metadata(d, { description: false }), /text or null/);
  assert.throws(
    () => m.metadata(d, { title: "stale" }, "old revision"),
    /repository changed/,
  );
  assert.throws(
    () => m.metadata("origin/main", { title: "outside" }),
    /outside/,
  );
  assert.equal(f.git("rev-parse", NOTES), notes);
  assert.equal(m.head(), head);
  m.dependencies("feature3", ["feature2"]);
  assert.equal(
    m.graph().groups.find((g) => g.name === "feature3").description,
    "Middle body",
  );
});

test("new PRs use effective metadata; subsequent pushes preserve remote descriptions and sync retains notes", (t) => {
  const f = fixture(t),
    m = f.manager;
  const a = f.commit("A");
  m.tag("one", [a]);
  const b = f.commit("B");
  m.tag("two", [b]);
  m.metadata(a, {
    title: "Review this title",
    description: "First paragraph\n\nSecond paragraph",
  });
  m.metadata(b, { title: "Second title", description: "" });
  m.push();
  assert.equal(f.prs.get("prm/one").title, "Review this title");
  assert.equal(
    f.prs.get("prm/one").body,
    "First paragraph\n\nSecond paragraph",
  );
  assert.equal(f.prs.get("prm/two").body, "");
  m.metadata(a, { title: "Changed locally", description: "New local body" });
  m.push({ names: ["one"] });
  assert.equal(f.prs.get("prm/one").title, "Review this title");
  f.merge("two");
  m.sync();
  const graph = m.graph();
  assert.equal(graph.commits[0].effectiveMetadata.title, "Changed locally");
  assert.equal(
    graph.commits[0].effectiveMetadata.description,
    "New local body",
  );
  assert.equal(
    graph.commits[0].effectiveMetadata.titleSource,
    graph.commits[0].sha,
  );
});

test("adopts an older-base PR and skips unchanged pushes even after sync rewrites source commits", (t) => {
  const f = fixture(t),
    m = f.manager;
  const a = f.commit("A");
  m.tag("one", [a]);
  m.branchName("one", "user/existing");
  f.git("push", "origin", "HEAD:refs/heads/user/existing");
  f.prs.set("user/existing", {
    number: 42,
    url: "https://github.test/user/repo/pull/42",
    state: "OPEN",
    baseRefName: "main",
    headRefOid: a,
  });
  const advance = (name) => {
    const dir = m.createWorktree("origin/main");
    fs.writeFileSync(path.join(dir, `${name}.txt`), name);
    run("git", ["add", "."], dir);
    run("git", ["commit", "-m", name], dir);
    run("git", ["push", "origin", "HEAD:main"], dir);
    m.removeWorktree(dir);
    m.sync();
  };
  advance("Upstream");
  assert.notEqual(m.graph().commits[0].sha, a);
  const original = m.git.bind(m),
    writes = [];
  m.git = (...args) => {
    if (args[0] === "push") writes.push(args);
    return original(...args);
  };
  m.push();
  m.push();
  assert.equal(m.state().features.one.publishedHead, a);
  assert.equal(writes.length, 0);
  advance("Another-upstream");
  m.push();
  assert.equal(m.state().features.one.publishedHead, a);
  assert.equal(writes.length, 0);
  m.tag("one", [f.commit("Review")]);
  m.push();
  assert.equal(writes.length, 1);
  assert.notEqual(m.state().features.one.publishedHead, a);
  assert.deepEqual(f.subjects(m.state().features.one.publishedHead), [
    "A",
    "Review",
  ]);
});

test("changed published branches retain exact force-with-lease protection", (t) => {
  const f = fixture(t),
    m = f.manager;
  m.tag("one", [f.commit("A")]);
  m.push();
  const before = m.state().features.one.publishedHead;
  const review = f.commit("Review");
  m.tag("one", [review]);
  // Make a competing commit available to the bare server without touching its PR head.
  const race = f.commit("Race");
  m.tag("race", [race]);
  f.git("push", "origin", "HEAD:refs/heads/race-object");
  const git = m.git.bind(m);
  m.git = (...args) => {
    if (args[0] === "push")
      run("git", ["update-ref", "refs/heads/prm/one", race, before], f.bare);
    return git(...args);
  };
  assert.throws(() => m.push({ names: ["one"] }), /stale info/);
  assert.equal(m.state().features.one.publishedHead, before);
  assert.equal(run("git", ["rev-parse", "prm/one"], f.bare), race);
});

test("PR status HTTP requests are authenticated and do not block local graph reads", async (t) => {
  const f = fixture(t),
    m = f.manager;
  m.tag("one", [f.commit("A")]);
  let release,
    started = false;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const { server, token } = createServer(m, undefined, {
    operation: async (route) => {
      assert.equal(route, "pr-status");
      started = true;
      return pending;
    },
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}/api/`;
  assert.equal((await fetch(`${url}pr-status`)).status, 403);
  const headers = { "X-PRM-Token": token };
  const status = fetch(`${url}pr-status`, { headers });
  while (!started) await new Promise((resolve) => setTimeout(resolve, 5));
  try {
    const graph = await (await fetch(`${url}graph`, { headers })).json();
    assert.equal(graph.groups[0].name, "one");
  } finally {
    release({
      revision: m.graph().revision,
      features: [],
      checkedAt: new Date().toISOString(),
    });
  }
  assert.equal((await (await status).json()).revision, m.graph().revision);
  assert.deepEqual(m.state().features, {});
});

test("whitespace-only amendments with the same patch ID still update the PR", (t) => {
  const f = fixture(t),
    m = f.manager;
  const a = f.commit("A", "A.txt", "A B\n");
  m.tag("one", [a]);
  m.push();
  const oldHead = m.state().features.one.publishedHead;
  fs.writeFileSync(path.join(f.root, "A.txt"), "A  B\n");
  f.git("add", "A.txt");
  f.git("commit", "--amend", "--no-edit");
  const amended = m.head();
  m.tag("one", [amended]);
  assert.equal(m.patchSignature([a]), m.patchSignature([amended]));
  m.push();
  const head = m.state().features.one.publishedHead;
  assert.notEqual(head, oldHead);
  assert.equal(f.git("show", `${head}:A.txt`), "A  B");
});

function adoptable(t) {
  const f = fixture(t),
    m = f.manager;
  const head = f.commit("A");
  m.tag("one", [head]);
  const branch = m.graph().groups[0].branch;
  f.git("push", "origin", `HEAD:refs/heads/${branch}`);
  const pr = {
    number: 42,
    url: "https://github.test/user/repo/pull/42",
    state: "OPEN",
    headRefName: branch,
    baseRefName: "main",
    headRefOid: head,
    isCrossRepository: false,
  };
  f.prs.set(branch, pr);
  run("git", ["update-ref", "refs/pull/42/head", head], f.bare);
  return { ...f, pr, branch, head };
}

test("no-push adoption records a matching PR on a default branch while preserving dirty work and notes", (t) => {
  const f = adoptable(t),
    m = f.manager;
  m.tag("other", [f.commit("B")]);
  fs.writeFileSync(path.join(f.root, "base.txt"), "unsaved work\n");
  fs.writeFileSync(path.join(f.root, "staged.txt"), "staged work\n");
  f.git("add", "staged.txt");
  const before = {
    head: m.head(),
    notes: f.git("rev-parse", NOTES),
    status: f.git("status", "--porcelain"),
  };
  const git = m.git.bind(m),
    gh = m.gh.bind(m);
  m.git = (...args) => {
    assert.ok(!["push", "reset", "rebase", "stash"].includes(args[0]));
    return git(...args);
  };
  m.gh = (args) => {
    assert.deepEqual(args.slice(0, 2), ["pr", "view"]);
    return gh(args);
  };
  const result = operationRequest(m, "adopt", {
    name: "one",
    pr: 42,
    head: f.head,
    revision: m.graph().revision,
  });
  assert.equal(result.adopted, true);
  assert.equal(result.graph.groups.find((g) => g.name === "one").pr, 42);
  assert.deepEqual(m.state().features.one, {
    branch: f.branch,
    pr: 42,
    url: f.pr.url,
    state: "OPEN",
    publishedHead: f.head,
    publishedCommits: [f.head],
  });
  assert.deepEqual(
    {
      head: m.head(),
      notes: f.git("rev-parse", NOTES),
      status: f.git("status", "--porcelain"),
    },
    before,
  );
  assert.equal(run("git", ["rev-parse", f.branch], f.bare), f.head);
  assert.deepEqual(fs.readdirSync(path.join(m.dir, "worktrees")), []);
});

test("no-push adoption supports older-base PRs, unchanged pushes, and merged-PR sync", (t) => {
  const f = adoptable(t),
    m = f.manager;
  const dir = m.createWorktree("origin/main");
  fs.writeFileSync(path.join(dir, "upstream.txt"), "Upstream\n");
  run("git", ["add", "."], dir);
  run("git", ["commit", "-m", "Upstream"], dir);
  run("git", ["push", "origin", "HEAD:main"], dir);
  m.removeWorktree(dir);
  m.sync();
  assert.notEqual(m.head(), f.head);
  m.adopt("one", 42);
  const git = m.git.bind(m);
  m.git = (...args) => {
    assert.notEqual(args[0], "push");
    return git(...args);
  };
  const pushed = m.push({ names: ["one"] });
  assert.equal(pushed.pushed[0].pr, 42);
  assert.equal(m.state().features.one.publishedHead, f.head);
  assert.equal(m.adopt("one", 42).adopted, false);
  f.merge("one");
  m.sync();
  assert.equal(m.graph().commits.length, 0);
  assert.equal(m.state().merged.one.pr, 42);
});

test("no-push adoption rejects invalid requests, stale graphs, blocked features, mismatched PRs and snapshots", (t) => {
  const f = adoptable(t),
    m = f.manager,
    revision = m.graph().revision;
  for (const data of [
    null,
    {},
    { revision, name: "one", pr: "42", head: f.head },
    { revision, name: "one", pr: 42, head: "bad" },
  ])
    assert.throws(() => operationRequest(m, "adopt", data), /Provide/);
  assert.throws(
    () => m.adopt("one", 42, { expectedRevision: "old" }),
    /repository changed/,
  );
  assert.throws(
    () => m.adopt("one", 42, { expectedHead: "b".repeat(40) }),
    /changed since discovery/,
  );
  for (const [field, value] of [
    ["baseRefName", "other"],
    ["headRefName", "other"],
    ["isCrossRepository", true],
    ["state", "MERGED"],
    ["headRefOid", "b".repeat(40)],
  ]) {
    const before = f.pr[field];
    f.pr[field] = value;
    assert.throws(
      () => m.adopt("one", 42),
      /must use|Only an existing open|does not match/,
    );
    f.pr[field] = before;
  }
  m.tag("other", [f.commit("B")]);
  m.dependencies("one", ["other"]);
  assert.throws(() => m.adopt("one", 42), /Merge prerequisites/);
  assert.deepEqual(m.state().features, {});
});

test("no-push adoption rejects extra remote work and branch changes during verification", (t) => {
  const f = adoptable(t),
    m = f.manager;
  const extra = f.commit("Extra");
  m.tag("other", [extra]);
  f.git("push", "origin", `HEAD:refs/heads/${f.branch}`);
  f.pr.headRefOid = extra;
  assert.throws(() => m.adopt("one", 42), /does not match/);
  assert.deepEqual(m.state().features, {});
  run("git", ["update-ref", `refs/heads/${f.branch}`, f.head, extra], f.bare);
  f.pr.headRefOid = f.head;
  const verify = m.verifyAdoption.bind(m);
  m.verifyAdoption = (...args) => {
    verify(...args);
    run("git", ["update-ref", `refs/heads/${f.branch}`, extra, f.head], f.bare);
  };
  assert.throws(() => m.adopt("one", 42), /changed during adoption/);
  assert.deepEqual(m.state().features, {});
});

test("no-push adoption refuses to save if commit notes change during verification", (t) => {
  const f = adoptable(t),
    m = f.manager,
    verify = m.verifyAdoption.bind(m);
  m.verifyAdoption = (...args) => {
    verify(...args);
    f.git(
      "notes",
      `--ref=${NOTES}`,
      "append",
      "-m",
      "Human annotation",
      "HEAD",
    );
  };
  assert.throws(() => m.adopt("one", 42), /repository changed during adoption/);
  assert.deepEqual(m.state().features, {});
});

test("adopt CLI and streaming browser/VS Code transports use the same validated workflow", async (t) => {
  const f = adoptable(t),
    m = f.manager;
  const bin = path.join(f.dir, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(
    path.join(bin, "gh"),
    `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(JSON.stringify(f.pr))});\n`,
    { mode: 0o755 },
  );
  const originalPath = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${originalPath}`;
  t.after(() => {
    process.env.PATH = originalPath;
  });
  const result = JSON.parse(
    run(
      process.execPath,
      [
        new URL("../src/cli.js", import.meta.url).pathname,
        "adopt",
        "one",
        "42",
      ],
      f.root,
    ),
  );
  assert.equal(result.adopted, true);
  assert.equal(m.state().features.one.pr, 42);
  const data = {
    revision: m.graph().revision,
    name: "one",
    pr: 42,
    head: f.head,
  };
  const repeated = await requestBridge(
    f.root,
    new URL("../src/bridge.js", import.meta.url).pathname,
    { route: "adopt", data },
  );
  assert.equal(repeated.adopted, false);
  await assert.rejects(
    () =>
      requestBridge(
        f.root,
        new URL("../src/bridge.js", import.meta.url).pathname,
        { route: "adopt", data: { revision: data.revision } },
      ),
    /Provide/,
  );
  const { server, token } = createServer(m);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}/api/adopt`;
  assert.equal(
    (await fetch(url, { method: "POST", body: JSON.stringify(data) })).status,
    403,
  );
  const response = await fetch(url, {
    method: "POST",
    headers: { "X-PRM-Token": token },
    body: JSON.stringify(data),
  });
  assert.match(response.headers.get("content-type"), /ndjson/);
  const frames = (await response.text()).trim().split("\n").map(JSON.parse);
  assert.equal(frames.at(-1).result.graph.groups[0].pr, 42);
});

function untrackedMerged(t) {
  const f = adoptable(t),
    m = f.manager;
  m.branchName("one", f.branch);
  m.adopt("one", 42);
  f.merge("one");
  const state = m.state();
  state.features = {};
  m.save(state);
  run("git", ["update-ref", "-d", `refs/heads/${f.branch}`], f.bare);
  return f;
}

test("sync discovers an untracked squash-merged PR after its head branch is deleted", (t) => {
  const f = untrackedMerged(t),
    m = f.manager;
  m.tag("two", [f.commit("B")]);
  m.dependencies("two", ["one"]);
  const before = m.head(),
    notes = f.git("rev-parse", NOTES);
  const preview = m.sync({ dryRun: true });
  assert.deepEqual(preview.merged, ["one"]);
  assert.deepEqual(preview.removed, [f.head]);
  assert.equal(m.head(), before);
  assert.deepEqual(m.state().merged, {});
  assert.equal(f.git("rev-parse", NOTES), notes);
  const result = m.sync();
  assert.deepEqual(result.merged, ["one"]);
  assert.equal(m.state().merged.one.pr, 42);
  assert.deepEqual(
    m.graph().groups.map((g) => g.name),
    ["two"],
  );
  assert.equal(m.graph().groups[0].ready, true);
  assert.equal(f.git("show", "HEAD:A.txt"), "A");
  assert.equal(f.git("show", "HEAD:B.txt"), "B");
  assert.equal(f.git("rev-parse", result.backup), before);
  assert.equal(
    run("git", ["show-ref", "--heads"], f.bare).includes(f.branch),
    false,
  );
});

test("sync recovers empty commits left by an earlier sync using verified backup patches", (t) => {
  const f = untrackedMerged(t),
    m = f.manager,
    gh = m.gh;
  m.gh = (args) =>
    args[1] === "list" && args.includes("merged") ? "[]" : gh(args);
  m.sync(); // Reproduce the old behavior: replay onto a base containing the PR.
  assert.equal(m.graph().commits.length, 1);
  assert.equal(f.git("diff", "HEAD^", "HEAD"), "");
  m.gh = gh;
  const beforeTree = f.git("rev-parse", "HEAD^{tree}");
  assert.deepEqual(m.sync().merged, ["one"]);
  assert.equal(m.graph().commits.length, 0);
  assert.equal(f.git("rev-parse", "HEAD^{tree}"), beforeTree);
  assert.equal(m.state().merged.one.pr, 42);
});

test("sync preserves unpublished work and refuses mismatched or ambiguous merged PRs", (t) => {
  const f = untrackedMerged(t),
    m = f.manager;
  m.tag("one", [f.commit("Follow-up")]);
  const before = m.head(),
    state = m.state();
  assert.throws(() => m.sync(), /does not exactly match/);
  assert.equal(m.head(), before);
  assert.deepEqual(m.state(), state);
  const gh = m.gh;
  m.gh = (args) =>
    args[1] === "list" && args.includes("merged")
      ? JSON.stringify([f.pr, { ...f.pr, number: 43 }])
      : gh(args);
  assert.throws(() => m.sync(), /Multiple merged PRs/);
  assert.equal(m.head(), before);
});

test("sync does not discard an empty feature based only on a branch-name match", (t) => {
  const f = untrackedMerged(t),
    m = f.manager;
  f.git("reset", "--hard", f.pr.mergeCommit.oid);
  f.git("commit", "--allow-empty", "-m", "A");
  m.tag("one", [m.head()]);
  m.branchName("one", f.branch);
  const before = m.head();
  assert.throws(() => m.sync(), /does not exactly match/);
  assert.equal(m.head(), before);
  assert.deepEqual(m.state().merged, {});
});

test("merged discovery rejects forks, other targets, and whitespace-only differences", (t) => {
  const f = untrackedMerged(t),
    m = f.manager,
    gh = m.gh;
  m.gh = (args) =>
    args[1] === "list" && args.includes("merged")
      ? JSON.stringify([
          { ...f.pr, isCrossRepository: true },
          { ...f.pr, baseRefName: "other" },
        ])
      : gh(args);
  assert.deepEqual(m.sync({ dryRun: true }).merged, []);
  m.gh = gh;
  // Same patch ID, different exact content must not pass verification.
  f.git("reset", "--hard", f.head);
  fs.writeFileSync(path.join(f.root, "A.txt"), "A  \n");
  f.git("add", "A.txt");
  f.git("commit", "--amend", "--no-edit");
  m.tag("one", [m.head()]);
  m.branchName("one", f.branch);
  assert.throws(() => m.sync(), /does not exactly match/);
  assert.deepEqual(m.state().merged, {});
});

test("untracked merged reconciliation rejects an unavailable merge and PR head races", (t) => {
  const f = untrackedMerged(t),
    m = f.manager;
  const before = m.head(),
    mergeCommit = f.pr.mergeCommit;
  f.pr.mergeCommit = { oid: f.head };
  assert.throws(() => m.sync(), /not in the fetched base/);
  f.pr.mergeCommit = mergeCommit;
  const read = m.prStatus.bind(m);
  m.prStatus = (...args) => ({ ...read(...args), headRefOid: "0".repeat(40) });
  assert.throws(() => m.sync(), /changed during verification/);
  assert.equal(m.head(), before);
  assert.deepEqual(m.state().merged, {});
  assert.equal(fs.existsSync(m.journalPath), false);
  assert.deepEqual(fs.readdirSync(path.join(m.dir, "worktrees")), []);
});

test("untracked merged reconciliation rejects notes changing during verification", (t) => {
  const f = untrackedMerged(t),
    m = f.manager;
  const before = m.head(),
    read = m.prStatus.bind(m);
  m.prStatus = (...args) => {
    m.writeNote(f.head, `${m.note(f.head)}\nExternal edit`);
    return read(...args);
  };
  assert.throws(() => m.sync(), /repository changed during sync verification/);
  assert.equal(m.head(), before);
  assert.match(m.note(f.head), /External edit/);
  assert.deepEqual(m.state().merged, {});
});

function fiveFeatures(t) {
  const f = fixture(t),
    m = f.manager;
  for (const name of ["A", "B", "C", "D", "E"]) m.tag(name, [f.commit(name)]);
  m.dependencies("C", ["A", "B"]);
  m.dependencies("D", ["C"]);
  m.dependencies("E", ["C"]);
  return f;
}

test("continuous push publishes A/B, then C, then D/E as merges unlock the fixed snapshot", async (t) => {
  const f = fiveFeatures(t),
    m = f.manager;
  let polls = 0;
  const events = [];
  m.onProgress = (event) => {
    if (event.run) events.push(event.run);
  };
  const outcome = await continuousPush(
    m,
    {},
    {
      interval: 1,
      sleep: async () => {
        polls++;
        assert.ok(polls <= 2);
        if (polls === 1) {
          assert.deepEqual([...f.prs.keys()], ["prm/A", "prm/B"]);
          f.merge("A");
          m.fetch(m.state());
          f.merge("B");
        } else {
          assert.deepEqual([...f.prs.keys()], ["prm/A", "prm/B", "prm/C"]);
          f.merge("C");
        }
      },
    },
  );
  assert.equal(outcome.run.status, "completed");
  assert.equal(polls, 2);
  assert.deepEqual(
    outcome.run.features.map((f) => [f.name, f.status]),
    [
      ["A", "merged"],
      ["B", "merged"],
      ["C", "merged"],
      ["D", "published"],
      ["E", "published"],
    ],
  );
  assert.deepEqual(
    [...f.prs.keys()],
    ["prm/A", "prm/B", "prm/C", "prm/D", "prm/E"],
  );
  assert.ok(
    events.some(
      (run) => run.features.filter((f) => f.status === "pending").length === 3,
    ),
  );
  assert.equal(m.graph().groups.length, 2);
  assert.equal(readPushRun(m).status, "completed");
  assert.equal(f.git("status", "--porcelain"), "");
});

test("continuous selected pushes stop unreachable features but still publish independent selections", async (t) => {
  const f = fiveFeatures(t),
    m = f.manager;
  const plan = planPushRun(m, { names: ["A", "C", "D"] });
  assert.deepEqual(
    plan.features.map((f) => f.name),
    ["A", "C", "D"],
  );
  assert.equal(fs.existsSync(path.join(m.dir, "push-run.json")), false);
  const outcome = await continuousPush(
    m,
    { names: ["A", "C", "D"] },
    { sleep: async () => assert.fail("Unreachable run should not poll") },
  );
  assert.equal(outcome.run.status, "blocked");
  assert.deepEqual(
    outcome.run.features.map((f) => [f.name, f.status]),
    [
      ["A", "published"],
      ["C", "unreachable"],
      ["D", "unreachable"],
    ],
  );
  assert.deepEqual([...f.prs.keys()], ["prm/A"]);
});

test("continuous push drops changed published features, ignores new features, and continues reachable siblings", async (t) => {
  const f = fiveFeatures(t),
    m = f.manager;
  // D can still proceed through A after B changes and blocks C/E.
  m.dependencies("D", ["A"]);
  let polls = 0;
  const outcome = await continuousPush(
    m,
    {},
    {
      interval: 1,
      sleep: async () => {
        assert.equal(++polls, 1);
        m.tag("B", [f.commit("B-fix")]);
        m.tag("New", [f.commit("New")]);
        f.merge("A");
        m.fetch(m.state());
        f.merge("B");
      },
    },
  );
  assert.equal(outcome.run.status, "blocked");
  assert.equal(
    outcome.run.features.find((f) => f.name === "B").status,
    "dropped",
  );
  assert.equal(
    outcome.run.features.find((f) => f.name === "C").status,
    "unreachable",
  );
  assert.equal(
    outcome.run.features.find((f) => f.name === "E").status,
    "unreachable",
  );
  assert.equal(
    outcome.run.features.find((f) => f.name === "D").status,
    "published",
  );
  assert.deepEqual([...f.prs.keys()], ["prm/A", "prm/B", "prm/D"]);
  assert.ok(!outcome.run.features.some((f) => f.name === "New"));
  assert.ok(!Object.hasOwn(m.state().merged, "B"));
  assert.ok(m.graph().commits.some((c) => c.subject === "B-fix"));
});

test("continuous push can be stopped and blocks overlapping publication without holding the Git lock while waiting", async (t) => {
  const f = fiveFeatures(t),
    m = f.manager;
  const other = new Manager(f.root);
  let checks = 0;
  const outcome = await continuousPush(
    m,
    {},
    {
      interval: 1,
      sleep: async () => {
        checks++;
        assert.equal(fs.existsSync(path.join(m.dir, "lock")), false);
        assert.throws(() => other.push(), /continuous push is running/);
        assert.throws(() => other.sync(), /continuous push is running/);
        await assert.rejects(
          () => continuousPush(other),
          /continuous push is running/,
        );
        const run = readPushRun(other);
        stopPushRun(other, run.id);
      },
    },
  );
  assert.equal(checks, 1);
  assert.equal(outcome.run.status, "cancelled");
  assert.deepEqual([...f.prs.keys()], ["prm/A", "prm/B"]);
  assert.equal(readPushRun(m).status, "cancelled");
});

test("continuous push waits for dirty edits and drops new commits without auto-stashing", async (t) => {
  const f = fiveFeatures(t),
    m = f.manager;
  let polls = 0,
    dirtyMessage = false;
  const controller = new AbortController();
  m.onProgress = (event) => {
    if (event.run?.message?.includes("dirty")) dirtyMessage = true;
  };
  const outcome = await continuousPush(
    m,
    {},
    {
      signal: controller.signal,
      interval: 1,
      sleep: async () => {
        polls++;
        if (polls === 1)
          fs.writeFileSync(path.join(f.root, "unsaved.txt"), "user work");
        else {
          assert.equal(
            fs.readFileSync(path.join(f.root, "unsaved.txt"), "utf8"),
            "user work",
          );
          assert.ok(dirtyMessage);
          controller.abort();
        }
      },
    },
  );
  assert.equal(outcome.run.status, "cancelled");
  assert.equal(f.git("status", "--porcelain"), "?? unsaved.txt");
});

test("continuous push stops safely on conflicts and preserves its failed run status", async (t) => {
  const f = fiveFeatures(t),
    m = f.manager;
  const sync = m.sync.bind(m);
  m.sync = () => {
    throw new Error("Sync paused; resolve the conflict");
  };
  await assert.rejects(() => continuousPush(m), /Sync paused/);
  assert.equal(readPushRun(m).status, "failed");
  assert.match(readPushRun(m).error, /resolve the conflict/);
  assert.equal(f.prs.size, 0);
  m.sync = sync;
});

test("continuous push detects feature changes during preflight before any remote publication", async (t) => {
  const f = fiveFeatures(t),
    m = f.manager,
    git = m.git.bind(m);
  let changed = false;
  m.git = (...args) => {
    if (args[0] === "ls-remote" && !changed) {
      changed = true;
      // Simulate another process changing notes while projection preflight runs.
      m.writeNote(
        m.graph().groups.find((g) => g.name === "A").commits[0],
        "prm-name: A\nprm-title: changed",
      );
    }
    return git(...args);
  };
  const outcome = await continuousPush(
    m,
    {},
    {
      interval: 1,
      sleep: async () => {
        stopPushRun(m, readPushRun(m).id);
      },
    },
  );
  assert.equal(
    outcome.run.features.find((f) => f.name === "A").status,
    "dropped",
  );
  assert.equal(f.prs.has("prm/A"), false);
  assert.equal(f.prs.has("prm/B"), true);
});

test("continuous CLI and streamed worker complete one-feature runs and cancel on disconnect", async (t) => {
  const f = adoptable(t),
    m = f.manager;
  m.adopt("one", 42);
  const bin = path.join(f.dir, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(
    path.join(bin, "gh"),
    `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(JSON.stringify(f.pr))});\n`,
    { mode: 0o755 },
  );
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${oldPath}`;
  t.after(() => {
    process.env.PATH = oldPath;
  });
  const cli = new URL("../src/cli.js", import.meta.url).pathname;
  const preview = JSON.parse(
    run(process.execPath, [cli, "push", "--wait", "--dry-run"], f.root),
  );
  assert.equal(preview.features.length, 1);
  assert.equal(fs.existsSync(path.join(m.dir, "push-run.json")), false);
  const outcome = JSON.parse(
    run(process.execPath, [cli, "push", "--wait"], f.root),
  );
  assert.equal(outcome.run.status, "completed");
  assert.equal(outcome.pushed[0].pr, 42);
  m.tag("two", [f.commit("B")]);
  m.dependencies("two", ["one"]);
  const controller = new AbortController();
  const result = await requestBridge(
    f.root,
    new URL("../src/bridge.js", import.meta.url).pathname,
    {
      route: "push",
      data: {
        revision: m.graph().revision,
        names: [],
        dryRun: false,
        wait: true,
      },
    },
    (event) => {
      if (event.run?.features.some((f) => f.status === "published"))
        controller.abort();
    },
    { signal: controller.signal },
  );
  assert.equal(result.run.status, "cancelled");
  assert.equal(readPushRun(m).status, "cancelled");
  assert.ok(!m.state().features.two);
});

test("continuous push stop HTTP requests require authentication but not a stale graph revision", async (t) => {
  const f = fixture(t),
    m = f.manager;
  m.tag("one", [f.commit("A")]);
  const { server, token } = createServer(m);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}/api/push-stop`;
  const before = m.head();
  // Starting with an already-aborted signal still records a cancelled run.
  const controller = new AbortController();
  controller.abort();
  await continuousPush(m, {}, { signal: controller.signal });
  const run = readPushRun(m);
  assert.equal(run.status, "cancelled");
  const body = JSON.stringify({ id: run.id, revision: "obsolete" });
  assert.equal((await fetch(url, { method: "POST", body })).status, 403);
  const response = await fetch(url, {
    method: "POST",
    headers: { "X-PRM-Token": token },
    body,
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).id, run.id);
  assert.equal(
    (
      await fetch(url, {
        method: "POST",
        headers: { "X-PRM-Token": token },
        body: JSON.stringify({ id: "wrong" }),
      })
    ).status,
    400,
  );
  assert.equal(m.head(), before);
  assert.equal(f.prs.size, 0);
});

test("continuous selected pushes watch already-published prerequisites without republishing them", async (t) => {
  const f = fixture(t),
    m = f.manager;
  for (const name of ["A", "B", "C"]) m.tag(name, [f.commit(name)]);
  m.dependencies("B", ["A"]);
  m.dependencies("C", ["B"]);
  m.push({ names: ["A"] });
  const oldHead = m.state().features.A.publishedHead;
  const plan = planPushRun(m, { names: ["B", "C"] });
  assert.deepEqual(
    plan.prerequisites.map((f) => f.name),
    ["A"],
  );
  const git = m.git.bind(m);
  m.git = (...args) => {
    if (args[0] === "push")
      assert.ok(!args.some((arg) => arg.endsWith(":refs/heads/prm/A")));
    return git(...args);
  };
  let polls = 0;
  const result = await continuousPush(
    m,
    { names: ["B", "C"] },
    {
      interval: 1,
      sleep: async () => {
        assert.ok(++polls <= 2);
        if (polls === 1) {
          assert.equal(m.state().features.A.publishedHead, oldHead);
          f.merge("A");
        } else f.merge("B");
      },
    },
  );
  assert.equal(result.run.status, "completed");
  assert.deepEqual(
    result.run.features.map((f) => f.name),
    ["B", "C"],
  );
  assert.equal(result.run.prerequisites[0].status, "merged");
  assert.equal(
    result.run.features.find((f) => f.name === "C").status,
    "published",
  );
});

test("continuous push stops when a prerequisite PR closes without merging", async (t) => {
  const f = fixture(t),
    m = f.manager;
  m.tag("A", [f.commit("A")]);
  m.tag("B", [f.commit("B")]);
  m.dependencies("B", ["A"]);
  let polls = 0;
  const result = await continuousPush(
    m,
    {},
    {
      interval: 1,
      sleep: async () => {
        assert.equal(++polls, 1);
        f.prs.get("prm/A").state = "CLOSED";
      },
    },
  );
  assert.equal(result.run.status, "blocked");
  assert.equal(
    result.run.features.find((f) => f.name === "A").status,
    "dropped",
  );
  assert.match(
    result.run.features.find((f) => f.name === "A").reason,
    /closed/,
  );
  assert.equal(
    result.run.features.find((f) => f.name === "B").status,
    "unreachable",
  );
  assert.equal(f.prs.size, 1);
});

test("diff transports load the shared viewer and preserve whitespace without Git ANSI colors", async (t) => {
  const f = fixture(t),
    m = f.manager;
  const sha = f.commit("A", "A.txt", "A  \n");
  m.tag("one", [sha]);
  f.git("config", "color.ui", "always");
  const { server, token } = createServer(m);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}`;
  const html = await (await fetch(url)).text();
  assert.ok(html.indexOf('src="/diff.js"') < html.indexOf('src="/app.js"'));
  const asset = await fetch(`${url}/diff.js`);
  assert.equal(asset.status, 200);
  assert.match(asset.headers.get("content-type"), /javascript/);
  assert.match(await asset.text(), /globalThis.PrmDiff/);
  const response = await fetch(`${url}/api/diff?sha=${sha}`, {
    headers: { "X-PRM-Token": token },
  });
  assert.equal(response.status, 200);
  const browser = await response.json();
  const bridge = await requestBridge(
    f.root,
    new URL("../src/bridge.js", import.meta.url).pathname,
    { route: `diff?sha=${sha}` },
  );
  assert.equal(browser.diff, bridge.diff);
  assert.ok(browser.diff.endsWith("+A  \n"));
  assert.equal(browser.diff.includes("\u001b["), false);
});

test("isolated UI push syncs and publishes dependencies while the original workspace changes branches and stays dirty", async (t) => {
  const f = fiveFeatures(t),
    m = f.manager;
  const originalHead = m.head();
  let polls = 0,
    otherHead,
    indexTree,
    workspace;
  t.after(() => {
    if (workspace) fs.rmSync(workspace, { recursive: true, force: true });
  });
  const result = await continuousPush(
    m,
    {},
    {
      prepare: prepareUiWorktree,
      interval: 1,
      sleep: async () => {
        const worker = resolveUiManager(m);
        workspace = worker.root;
        assert.ok(
          workspace.startsWith(
            path.join(fs.realpathSync(os.tmpdir()), "gh-prm-"),
          ),
        );
        assert.equal(worker.branch(), "work");
        assert.equal(fs.existsSync(path.join(m.dir, "lock")), false);
        if (++polls === 1) {
          assert.equal(f.git("rev-parse", "HEAD"), originalHead);
          assert.equal(m.optionalGit("symbolic-ref", "--quiet", "HEAD"), null);
          f.git("switch", "-c", "unrelated", "origin/main");
          otherHead = f.commit("unrelated");
          fs.writeFileSync(path.join(f.root, "base.txt"), "staged change\n");
          f.git("add", "base.txt");
          indexTree = f.git("write-tree");
          fs.writeFileSync(path.join(f.root, "base.txt"), "unstaged change\n");
          fs.writeFileSync(
            path.join(f.root, "untracked.txt"),
            "private work\n",
          );
          f.merge("A");
          m.fetch(m.state());
          f.merge("B");
        } else {
          assert.equal(polls, 2);
          assert.deepEqual([...f.prs.keys()], ["prm/A", "prm/B", "prm/C"]);
          f.merge("C");
        }
      },
    },
  );
  assert.equal(result.run.status, "completed");
  assert.equal(result.run.worktree, workspace);
  assert.equal(f.git("branch", "--show-current"), "unrelated");
  assert.equal(f.git("rev-parse", "HEAD"), otherHead);
  assert.equal(f.git("write-tree"), indexTree);
  assert.equal(
    fs.readFileSync(path.join(f.root, "base.txt"), "utf8"),
    "unstaged change\n",
  );
  assert.equal(
    fs.readFileSync(path.join(f.root, "untracked.txt"), "utf8"),
    "private work\n",
  );
  const worker = resolveUiManager(m);
  assert.deepEqual(
    worker.graph().groups.map((g) => g.name),
    ["D", "E"],
  );
  assert.equal(worker.graph().uiWorktree.originalRoot, fs.realpathSync(f.root));
  assert.equal(prepareUiWorktree(worker), worker);
  const replay = worker.createWorktree(worker.baseRef(worker.state()));
  assert.equal(path.dirname(replay), path.dirname(workspace));
  worker.removeWorktree(replay);
  // Fresh browser/extension requests still reach the worker after completion.
  const bridge = new URL("../src/bridge.js", import.meta.url).pathname;
  const graph = await requestBridge(f.root, bridge, { route: "graph" });
  assert.equal(graph.uiWorktree.path, workspace);
  assert.deepEqual(
    graph.groups.map((g) => g.name),
    ["D", "E"],
  );
  const { server, token } = createServer(m);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const response = await fetch(
    `http://127.0.0.1:${server.address().port}/api/graph`,
    {
      headers: { "X-PRM-Token": token },
    },
  );
  assert.equal(response.status, 200);
  assert.equal((await response.json()).uiWorktree.path, workspace);
});

test("UI continuous push prepares its temporary checkout automatically and reuses it", async (t) => {
  const f = fixture(t),
    m = f.manager;
  configure(f, "BRANCH_PREFIX=alice\n");
  m.tag("A", [f.commit("A")]);
  const head = m.head(),
    revision = m.graph().revision;
  const preview = pushRequest(m, {
    names: [],
    revision,
    wait: true,
    dryRun: true,
  });
  assert.equal(preview.continuous, true);
  assert.equal(m.branch(), "work");
  assert.equal(fs.existsSync(path.join(m.dir, "ui-worktree.json")), false);
  const result = await pushRequest(m, {
    names: [],
    revision,
    wait: true,
    dryRun: false,
  });
  const worker = resolveUiManager(m);
  t.after(() => fs.rmSync(worker.root, { recursive: true, force: true }));
  assert.equal(result.run.status, "completed");
  assert.equal(result.run.worktree, worker.root);
  assert.equal(m.head(), head);
  assert.equal(m.optionalGit("symbolic-ref", "--quiet", "HEAD"), null);
  assert.equal(f.git("status", "--porcelain"), "");
  assert.equal(worker.branch(), "work");
  assert.equal(worker.graph().groups[0].branch, "alice/A");
  const again = await pushRequest(worker, {
    names: [],
    revision: worker.graph().revision,
    wait: true,
    dryRun: false,
  });
  assert.equal(again.run.worktree, worker.root);
  assert.equal(f.prs.size, 1);
});

test("UI isolation rejects dirty and stale starts without detaching or creating a checkout", async (t) => {
  const f = fixture(t),
    m = f.manager;
  m.tag("A", [f.commit("A")]);
  const revision = m.graph().revision;
  fs.writeFileSync(path.join(f.root, "dirty.txt"), "unfinished\n");
  await assert.rejects(
    () => pushRequest(m, { names: [], revision, wait: true, dryRun: false }),
    /must be clean/,
  );
  fs.unlinkSync(path.join(f.root, "dirty.txt"));
  m.metadata(m.head(), { title: "changed" }, revision);
  await assert.rejects(
    () => pushRequest(m, { names: [], revision, wait: true, dryRun: false }),
    /repository changed/i,
  );
  assert.equal(m.branch(), "work");
  assert.equal(fs.existsSync(path.join(m.dir, "ui-worktree.json")), false);
  assert.equal(fs.existsSync(path.join(m.dir, "push-run.json")), false);
  assert.equal(
    f.git("worktree", "list", "--porcelain").match(/^worktree /gm).length,
    1,
  );
});

test("failed UI checkout handoff restores the original branch without forcing away edits", (t) => {
  const f = fixture(t),
    m = f.manager;
  m.tag("A", [f.commit("A")]);
  const git = m.git.bind(m);
  m.git = (...args) => {
    if (args[0] === "switch" && args[1] === "--detach") {
      git(...args);
      throw new Error("simulated checkout failure");
    }
    return git(...args);
  };
  assert.throws(
    () => m.locked(() => prepareUiWorktree(m)),
    /simulated checkout failure/,
  );
  assert.equal(m.branch(), "work");
  assert.equal(f.git("status", "--porcelain"), "");
  assert.equal(fs.existsSync(path.join(m.dir, "ui-worktree.json")), false);
  assert.equal(
    f.git("worktree", "list", "--porcelain").match(/^worktree /gm).length,
    1,
  );
});

test("feature net diff excludes interleaved siblings and reverted changes while preserving a dirty checkout", (t) => {
  const f = fixture(t),
    m = f.manager;
  m.tag("one", [f.commit("A", "base.txt", "first version\n")]);
  m.tag("sibling", [f.commit("B", "sibling.txt", "unrelated\n")]);
  m.tag("one", [f.commit("C", "base.txt", "final version  \n")]);
  m.tag("one", [f.commit("temporary", "temporary.txt", "discard me\n")]);
  f.git("rm", "temporary.txt");
  f.git("commit", "-m", "Undo temporary file");
  m.tag("one", [m.head()]);
  f.git("config", "color.ui", "always");
  fs.writeFileSync(path.join(f.root, "base.txt"), "staged work\n");
  f.git("add", "base.txt");
  const index = f.git("write-tree");
  fs.writeFileSync(path.join(f.root, "base.txt"), "unstaged work\n");
  fs.writeFileSync(path.join(f.root, "untracked.txt"), "keep me\n");
  const head = m.head(),
    notes = f.git("rev-parse", NOTES),
    state = fs.readFileSync(m.statePath, "utf8"),
    status = f.git("status", "--porcelain");
  const result = m.featureDiff("one", { expectedRevision: m.graph().revision });
  assert.equal(result.commitCount, 4);
  assert.match(result.diff, /-base\n\+final version  \n/);
  assert.ok(!result.diff.includes("sibling.txt"));
  assert.ok(!result.diff.includes("temporary.txt"));
  assert.ok(!result.diff.includes("\u001b["));
  assert.equal(m.head(), head);
  assert.equal(m.branch(), "work");
  assert.equal(f.git("write-tree"), index);
  assert.equal(f.git("status", "--porcelain"), status);
  assert.equal(
    fs.readFileSync(path.join(f.root, "base.txt"), "utf8"),
    "unstaged work\n",
  );
  assert.equal(
    fs.readFileSync(path.join(f.root, "untracked.txt"), "utf8"),
    "keep me\n",
  );
  assert.equal(f.git("rev-parse", NOTES), notes);
  assert.equal(fs.readFileSync(m.statePath, "utf8"), state);
  assert.equal(
    f.git("worktree", "list", "--porcelain").match(/^worktree /gm).length,
    1,
  );
});

test("feature net diff applies a shared transitive dependency once and excludes prerequisites before and after merging", (t) => {
  const f = fixture(t),
    m = f.manager;
  m.tag("foundation", [f.commit("Foundation", "context.txt", "foundation\n")]);
  m.tag("left", [f.commit("Left", "context.txt", "foundation\nleft\n")]);
  m.dependencies("left", ["foundation"]);
  m.tag("right", [f.commit("Right", "right.txt", "right prerequisite\n")]);
  m.dependencies("right", ["foundation"]);
  m.tag("sibling", [f.commit("Unrelated")]);
  m.tag("target", [
    f.commit("Feature1", "context.txt", "foundation\nleft\nfeature\n"),
  ]);
  m.tag("target", [
    f.commit("Feature2", "right.txt", "right prerequisite\nfeature right\n"),
  ]);
  m.dependencies("target", ["left", "right"]);
  const before = m.featureDiff("target");
  assert.deepEqual(
    before.diff
      .split("\n")
      .filter((line) => line.startsWith("+") && !line.startsWith("+++")),
    ["+feature", "+feature right"],
  );
  assert.ok(!before.diff.includes("Unrelated.txt"));
  m.push({ names: ["foundation"] });
  f.merge("foundation");
  m.sync();
  assert.ok(Object.hasOwn(m.graph().merged, "foundation"));
  assert.equal(m.featureDiff("target").diff, before.diff);
});

test("feature net diffs report empty changes, stale requests, missing dependencies, and repository races without retaining worktrees", (t) => {
  const f = fixture(t),
    m = f.manager;
  m.tag("empty", [f.commit("Temporary", "temporary.txt", "discard\n")]);
  f.git("rm", "temporary.txt");
  f.git("commit", "-m", "Revert temporary");
  m.tag("empty", [m.head()]);
  assert.equal(m.featureDiff("empty").diff, "");
  m.tag("parent", [f.commit("Parent", "required.txt", "prerequisite\n")]);
  m.tag("child", [f.commit("Child", "required.txt", "prerequisite\nchild\n")]);
  const head = m.head();
  assert.throws(() => m.featureDiff("child"), /Check its dependencies/);
  assert.throws(
    () => m.featureDiff("child", { expectedRevision: "stale" }),
    /repository changed/i,
  );
  assert.throws(() => m.featureDiff("unknown"), /Unknown active feature/);
  m.dependencies("child", ["parent"]);
  const replay = m.replay.bind(m);
  let changed = false;
  m.replay = (...args) => {
    const result = replay(...args);
    if (!changed) {
      changed = true;
      m.writeNote(head, `${m.note(head)}\nExternal edit`);
    }
    return result;
  };
  assert.throws(
    () => m.featureDiff("child"),
    /repository changed while building/i,
  );
  assert.equal(m.head(), head);
  assert.equal(f.git("status", "--porcelain"), "");
  assert.equal(
    f.git("worktree", "list", "--porcelain").match(/^worktree /gm).length,
    1,
  );
});

test("feature net diff browser and VS Code transports validate revisions and stream the same read-only projection", async (t) => {
  const f = fixture(t),
    m = f.manager;
  m.tag("one", [f.commit("A")]);
  const data = { name: "one", revision: m.graph().revision };
  const bridge = new URL("../src/bridge.js", import.meta.url).pathname;
  const progress = [];
  const projected = await requestBridge(
    f.root,
    bridge,
    { route: "feature-diff", data },
    (event) => progress.push(event.command),
  );
  assert.match(projected.diff, /\+A\n/);
  assert.ok(progress.some((command) => command.startsWith("git cherry-pick")));
  const { server, token } = createServer(m);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}/api/feature-diff`;
  const request = (body, authenticated = true) =>
    fetch(url, {
      method: "POST",
      headers: authenticated ? { "X-PRM-Token": token } : {},
      body: JSON.stringify(body),
    });
  assert.equal((await request(data, false)).status, 403);
  assert.equal((await request({ ...data, revision: "stale" })).status, 409);
  const response = await request(data);
  assert.match(response.headers.get("content-type"), /ndjson/);
  const events = (await response.text()).trim().split("\n").map(JSON.parse);
  assert.equal(events.at(-1).result.diff, projected.diff);
  await assert.rejects(
    () =>
      requestBridge(f.root, bridge, {
        route: "feature-diff",
        data: { ...data, name: 42 },
      }),
    /Provide a feature name/,
  );
  assert.equal(
    f.git("worktree", "list", "--porcelain").match(/^worktree /gm).length,
    1,
  );
});

test("feature net diff disconnects leave no projection worktrees and keep graph reads responsive", async (t) => {
  const f = fixture(t),
    m = f.manager;
  m.tag("one", [f.commit("A")]);
  const head = m.head(),
    hooks = path.join(f.dir, "preview-hooks"),
    started = path.join(f.dir, "preview-started"),
    release = path.join(f.dir, "preview-release");
  fs.mkdirSync(hooks);
  fs.writeFileSync(
    path.join(hooks, "post-checkout"),
    `#!/usr/bin/env node
const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(started)}, 'started');
const wait = new Int32Array(new SharedArrayBuffer(4)), deadline = Date.now() + 10000;
while (!fs.existsSync(${JSON.stringify(release)})) {
  if (Date.now() > deadline) process.exit(1);
  Atomics.wait(wait, 0, 0, 20);
}
`,
    { mode: 0o755 },
  );
  f.git("config", "core.hooksPath", hooks);
  const { server, token } = createServer(m);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}/api/`,
    headers = { "X-PRM-Token": token };
  const response = await fetch(`${url}feature-diff`, {
    method: "POST",
    headers,
    body: JSON.stringify({ name: "one", revision: m.graph().revision }),
  });
  for (let i = 0; !fs.existsSync(started) && i < 300; i++)
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(fs.existsSync(started), "Projection checkout hook started");
  assert.equal(
    (await (await fetch(`${url}graph`, { headers })).json()).head,
    head,
  );
  await response.body.cancel();
  await new Promise((resolve) => setTimeout(resolve, 50));
  fs.writeFileSync(release, "continue");
  for (let i = 0; i < 300; i++) {
    if (
      f.git("worktree", "list", "--porcelain").match(/^worktree /gm).length ===
      1
    )
      break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(
    f.git("worktree", "list", "--porcelain").match(/^worktree /gm).length,
    1,
  );
  assert.equal(m.head(), head);
  assert.equal(f.git("status", "--porcelain"), "");
});

function enableTestSigning(t, f) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "prm-gpg-"));
  fs.chmodSync(home, 0o700);
  const previous = process.env.GNUPGHOME;
  process.env.GNUPGHOME = home;
  t.after(() => {
    try {
      run("gpgconf", ["--homedir", home, "--kill", "gpg-agent"], os.tmpdir());
    } catch {}
    if (previous === undefined) delete process.env.GNUPGHOME;
    else process.env.GNUPGHOME = previous;
    fs.rmSync(home, { recursive: true, force: true });
  });
  const identity = "PR Manager Signing Test <prm-signing@example.test>";
  run(
    "gpg",
    [
      "--batch",
      "--pinentry-mode",
      "loopback",
      "--passphrase",
      "",
      "--quick-generate-key",
      identity,
      "ed25519",
      "sign",
      "0",
    ],
    home,
  );
  const fingerprint = run(
    "gpg",
    ["--with-colons", "--list-secret-keys", identity],
    home,
  )
    .split("\n")
    .find((line) => line.startsWith("fpr:"))
    .split(":")[9];
  f.git("config", "user.signingkey", fingerprint);
  f.git("config", "gpg.format", "openpgp");
  f.git("config", "commit.gpgsign", "true");
}

test("signing repairs unsigned PR commits, preserves signed unchanged heads, and signs synced source history", (t) => {
  const f = fixture(t),
    m = f.manager;
  const a = f.commit("A");
  m.tag("one", [a]);
  m.tag("two", [f.commit("B")]);
  m.dependencies("two", ["one"]);
  m.push({ names: ["one"] });
  const unsigned = m.state().features.one.publishedHead;
  assert.equal(
    run("git", ["show", "-s", "--format=%G?", unsigned], f.root),
    "N",
  );
  const pr = m.state().features.one.pr;
  enableTestSigning(t, f);
  m.push({ names: ["one"] });
  const signed = m.state().features.one.publishedHead;
  assert.notEqual(signed, unsigned);
  run("git", ["verify-commit", signed], f.bare);
  assert.equal(m.state().features.one.pr, pr);
  f.updatePrHeads();
  const replay = m.replay.bind(m);
  const git = m.git.bind(m);
  m.replay = () => assert.fail("Unchanged signed PRs must not be replayed");
  m.git = (...args) => {
    assert.notEqual(args[0], "push", "Unchanged PRs must not be pushed");
    return git(...args);
  };
  m.push({ names: ["one"] });
  assert.equal(m.state().features.one.publishedHead, signed);
  m.replay = replay;
  m.git = git;
  f.merge("one");
  m.sync();
  run("git", ["verify-commit", m.head()], f.root);
  assert.equal(parseNote(m.note(m.head())).name, "two");
});

test("signing covers every commit in explicitly selected blocked preview histories", (t) => {
  const f = fixture(t),
    m = f.manager;
  m.tag("one", [f.commit("A")]);
  m.tag("two", [f.commit("B")]);
  m.dependencies("two", ["one"]);
  enableTestSigning(t, f);
  const result = m.push({ names: ["two"] });
  assert.equal(result.pushed.length, 0);
  assert.equal(result.previews.length, 1);
  const commits = run(
    "git",
    ["rev-list", "main..refs/heads/prm/two"],
    f.bare,
  ).split("\n");
  assert.equal(commits.length, 2);
  for (const sha of commits) run("git", ["verify-commit", sha], f.bare);
});

test("signing failures stop publication while disposable diffs and adoption checks stay unsigned", (t) => {
  const f = fixture(t),
    m = f.manager;
  m.tag("one", [f.commit("A")]);
  m.push({ names: ["one"] });
  const published = m.state().features.one.publishedHead,
    head = m.head();
  const signer = path.join(f.dir, "unavailable-gpg");
  fs.writeFileSync(
    signer,
    "#!/bin/sh\necho 'Signing agent unavailable' >&2\nexit 1\n",
    { mode: 0o755 },
  );
  f.git("config", "gpg.program", signer);
  f.git("config", "commit.gpgsign", "true");
  assert.match(m.featureDiff("one").diff, /\+A\n/);
  m.verifyAdoption(m.state(), m.graph().groups[0], published, {
    explicit: true,
  });
  assert.throws(
    () => m.push({ names: ["one"] }),
    /Signing agent unavailable|gpg failed to sign/,
  );
  assert.equal(m.state().features.one.publishedHead, published);
  assert.equal(
    run("git", ["rev-parse", "refs/heads/prm/one"], f.bare),
    published,
  );
  assert.equal(m.head(), head);
  assert.equal(
    f.git("worktree", "list", "--porcelain").match(/^worktree /gm).length,
    1,
  );
});

test("sync continue honors signing configuration after resolving a conflict", (t) => {
  const f = fixture(t),
    m = f.manager;
  m.tag("one", [f.commit("Local", "base.txt", "local\n")]);
  const dir = m.createWorktree("origin/main");
  fs.writeFileSync(path.join(dir, "base.txt"), "remote\n");
  run("git", ["add", "base.txt"], dir);
  run("git", ["commit", "-m", "Remote"], dir);
  run("git", ["push", "origin", "HEAD:main"], dir);
  m.removeWorktree(dir);
  enableTestSigning(t, f);
  assert.throws(() => m.sync(), /Sync paused/);
  const journal = JSON.parse(fs.readFileSync(m.journalPath, "utf8"));
  fs.writeFileSync(path.join(journal.dir, "base.txt"), "resolved\n");
  run("git", ["add", "base.txt"], journal.dir);
  m.sync({ continue: true });
  run("git", ["verify-commit", m.head()], f.root);
  assert.equal(parseNote(m.note(m.head())).name, "one");
});

test("restarting a continuous signed push watches unchanged PRs without replaying or pushing", async (t) => {
  const f = fixture(t),
    m = f.manager;
  m.tag("one", [f.commit("A")]);
  m.tag("two", [f.commit("B")]);
  m.dependencies("two", ["one"]);
  enableTestSigning(t, f);
  m.push({ names: ["one"] });
  f.updatePrHeads();
  const published = m.state().features.one.publishedHead;
  const git = m.git.bind(m);
  m.git = (...args) => {
    assert.notEqual(args[0], "push", "Restart must not invoke git push");
    return git(...args);
  };
  m.replay = () => assert.fail("Restart must not cherry-pick or sign");
  let polls = 0;
  const result = await continuousPush(
    m,
    {},
    {
      interval: 1,
      sleep: async () => {
        assert.equal(++polls, 1);
        const run = readPushRun(m);
        assert.equal(
          run.features.find((f) => f.name === "one").status,
          "published",
        );
        assert.equal(
          run.features.find((f) => f.name === "two").status,
          "pending",
        );
        stopPushRun(m, run.id);
      },
    },
  );
  assert.equal(result.run.status, "cancelled");
  assert.equal(m.state().features.one.publishedHead, published);
});
