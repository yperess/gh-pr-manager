import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  Manager,
  NOTES,
  parseNote,
  editNote,
  editMetadataNote,
  run,
} from "../src/core.js";
import { createServer } from "../src/server.js";

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
      return JSON.stringify(pr && pr.state === "OPEN" ? [pr] : []);
    }
    if (args[0] === "pr" && args[1] === "create") {
      const branch = value("--head");
      const pr = {
        number: ++number,
        url: `https://github.test/user/repo/pull/${number}`,
        state: "OPEN",
        baseRefName: value("--base"),
        headRefOid: run("git", ["rev-parse", `refs/heads/${branch}`], bare),
        title: value("--title"),
        body: value("--body"),
      };
      prs.set(branch, pr);
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
  assert.throws(() => m.push(), /changed outside prm/);
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
  const { server, token } = createServer(m);
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
  const page = await fetch(base);
  assert.match(
    page.headers.get("content-security-policy"),
    /default-src 'none'/,
  );
  assert.equal(page.status, 200);
  assert.match(m.dot(), /feature:one.*->.*feature:two/);
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
