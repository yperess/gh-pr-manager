import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { execFileSync } from "node:child_process";
import { parseHTML } from "linkedom";

const context = vm.createContext({ TextEncoder, TextDecoder });
vm.runInContext(
  fs.readFileSync(new URL("../ui/diff.js", import.meta.url), "utf8"),
  context,
);
const { parsePatch, alignRows, createViewer } = context.PrmDiff;
const plain = (value) => JSON.parse(JSON.stringify(value));
const patch = `commit abc
Author: Example <test@example.com>

    Update <script> as plain text

diff --git a/demo.rs b/demo.rs
index 123..456 100644
--- a/demo.rs
+++ b/demo.rs
@@ -3,4 +3,5 @@ fn demo() {
 context
-old
+new
+extra
 tail
 end
@@ -20 +21 @@
-last
\\ No newline at end of file
+final
\\ No newline at end of file
`;

function view(text = patch, mode = "unified") {
  const { document } = parseHTML('<div id="diff"></div>');
  const container = document.getElementById("diff");
  const viewer = createViewer(document, container, { mode });
  viewer.setPatch(text);
  return { document, container, viewer };
}

test("patch parser numbers both sides across multiple hunks and attaches newline markers", () => {
  const parsed = parsePatch(patch),
    file = parsed.files[0];
  assert.equal(file.title, "demo.rs");
  assert.equal(file.unsupported, false);
  assert.equal(file.added, 3);
  assert.equal(file.deleted, 2);
  assert.deepEqual(
    plain(
      file.hunks[0].rows.map((r) => [r.kind, r.oldLine, r.newLine, r.text]),
    ),
    [
      ["context", 3, 3, "context"],
      ["deletion", 4, null, "old"],
      ["addition", null, 4, "new"],
      ["addition", null, 5, "extra"],
      ["context", 5, 6, "tail"],
      ["context", 6, 7, "end"],
    ],
  );
  assert.deepEqual(plain(file.hunks[1].rows.map((r) => r.notes)), [
    ["\\ No newline at end of file"],
    ["\\ No newline at end of file"],
  ]);
  assert.deepEqual(
    plain(
      alignRows(file.hunks[0].rows).map((pair) =>
        pair.map((row) => row?.text ?? null),
      ),
    ),
    [
      ["context", "context"],
      ["old", "new"],
      [null, "extra"],
      ["tail", "tail"],
      ["end", "end"],
    ],
  );
});

test("patch parser handles added/deleted files, zero ranges, and source text that resembles patch headers", () => {
  const parsed = parsePatch(`diff --git a/new b/new
new file mode 100644
--- /dev/null
+++ b/new
@@ -0,0 +1,2 @@
+++ looks like a header
+diff --git code, not a new file
diff --git a/old b/old
deleted file mode 100644
--- a/old
+++ /dev/null
@@ -1 +0,0 @@
-old
`);
  assert.deepEqual(plain(parsed.files.map((f) => [f.title, f.unsupported])), [
    ["new", false],
    ["old", false],
  ]);
  assert.equal(parsed.files[0].hunks[0].rows[0].text, "++ looks like a header");
  assert.deepEqual(
    plain(
      alignRows(parsed.files[0].hunks[0].rows).map((pair) =>
        pair.map((row) => row?.oldLine ?? null),
      ),
    ),
    [
      [null, null],
      [null, null],
    ],
  );
  assert.equal(parsed.files[1].hunks[0].rows[0].newLine, null);
});

test("Git quoted UTF-8 paths, renames, binary changes, and mode-only files retain metadata", () => {
  const parsed =
    parsePatch(String.raw`diff --git "a/\303\251.txt" "b/\303\251.txt"
--- "a/\303\251.txt"
+++ "b/\303\251.txt"
@@ -1 +1 @@
-old
+new
diff --git a/old name b/new name
similarity index 100%
rename from old name
rename to new name
diff --git a/image b/image
index 123..456 100644
Binary files a/image and b/image differ
diff --git a/script b/script
old mode 100644
new mode 100755
`);
  assert.deepEqual(plain(parsed.files.map((f) => f.title)), [
    "é.txt",
    "old name → new name",
    "a/image b/image",
    "a/script b/script",
  ]);
  assert.equal(parsed.files[2].binary, true);
  const { container } = view(parsed.files.map((f) => f.raw).join("\n"));
  assert.equal(container.querySelectorAll(".diff-file").length, 4);
  assert.match(container.textContent, /Binary file/);
  assert.match(container.textContent, /new mode 100755/);
});

test("malformed and combined patches fall back to complete safe text instead of partial diffs", () => {
  for (const text of [
    "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1,2 +1 @@\n-only one old row\n+new\n",
    "diff --cc x\nindex 123,456..789\n@@@ -1 -1 +1 @@@\n++combined\n",
    "diff --git a/x b/x\n@@ invalid header\n-<img src=x onerror=bad>\n",
  ]) {
    const { container } = view(text);
    assert.equal(container.querySelectorAll(".diff-fallback").length, 1);
    assert.equal(
      container.querySelector(".diff-fallback").textContent,
      text.trimEnd(),
    );
    assert.equal(container.querySelectorAll(".diff-lines").length, 0);
    assert.equal(container.querySelectorAll("img").length, 0);
  }
  for (const raw of [
    "",
    "commit abc\n\n    Empty commit\n",
    "<script>literal</script>\n",
  ]) {
    const { container } = view(raw);
    assert.equal(container.querySelectorAll(".diff-file").length, 0);
    assert.equal(container.querySelectorAll("script").length, 0);
    assert.equal(container.textContent, raw.replace(/\n$/, ""));
  }
});

test("unified and split views preserve source, align padding and newline notes, and synchronize scrolling", () => {
  const { container, viewer, document } = view();
  assert.equal(container.querySelectorAll(".diff-addition").length, 3);
  assert.equal(container.querySelectorAll(".diff-deletion").length, 2);
  assert.equal(container.querySelectorAll(".diff-hunk").length, 2);
  assert.equal(container.querySelectorAll("script").length, 0);
  const source = [...container.querySelectorAll(".diff-source")].map(
    (node) => node.textContent,
  );
  viewer.setMode("split");
  assert.equal(container.querySelectorAll(".diff-pane").length, 4);
  assert.deepEqual(
    [
      ...new Set(
        [...container.querySelectorAll(".diff-source")].map(
          (node) => node.textContent,
        ),
      ),
    ].sort(),
    [...new Set(source)].sort(),
  );
  const first = container.querySelector(".diff-split");
  const panes = first.querySelectorAll(".diff-pane");
  assert.equal(
    panes[0].querySelectorAll("tr").length,
    panes[1].querySelectorAll("tr").length,
  );
  assert.equal(panes[0].querySelectorAll(".diff-blank").length, 1);
  panes[0].scrollLeft = 120;
  panes[0].dispatchEvent(new document.defaultView.Event("scroll"));
  assert.equal(panes[1].scrollLeft, 120);
  panes[1].scrollLeft = 25;
  panes[1].dispatchEvent(new document.defaultView.Event("scroll"));
  assert.equal(panes[0].scrollLeft, 25);
  let clamped = 25;
  Object.defineProperty(panes[1], "scrollLeft", {
    get: () => clamped,
    set: (value) => {
      clamped = Math.min(value, 50);
    },
    configurable: true,
  });
  panes[0].scrollLeft = 120;
  panes[0].dispatchEvent(new document.defaultView.Event("scroll"));
  assert.equal(panes[1].scrollLeft, 50);
  panes[1].dispatchEvent(new document.defaultView.Event("scroll"));
  assert.equal(panes[0].scrollLeft, 120);

  const last = container
    .querySelectorAll(".diff-split")[1]
    .querySelectorAll(".diff-pane");
  assert.equal(last[0].querySelectorAll("tr").length, 2);
  assert.equal(last[1].querySelectorAll("tr").length, 2);
});

test("file/hunk disclosure state survives layout changes and resets for another patch", () => {
  const { container, viewer } = view();
  container.querySelector(".diff-file").removeAttribute("open");
  container.querySelectorAll(".diff-hunk")[1].removeAttribute("open");
  viewer.setMode("split");
  assert.equal(
    container.querySelector(".diff-file").hasAttribute("open"),
    false,
  );
  assert.equal(
    container.querySelectorAll(".diff-hunk")[0].hasAttribute("open"),
    true,
  );
  assert.equal(
    container.querySelectorAll(".diff-hunk")[1].hasAttribute("open"),
    false,
  );
  viewer.setExpanded(true);
  assert.ok(
    [...container.querySelectorAll("details")].every((el) =>
      el.hasAttribute("open"),
    ),
  );
  viewer.setExpanded(false);
  viewer.setMode("unified");
  assert.ok(
    [...container.querySelectorAll("details")].every(
      (el) => !el.hasAttribute("open"),
    ),
  );
  viewer.setPatch(patch);
  assert.ok(
    [...container.querySelectorAll("details")].every((el) =>
      el.hasAttribute("open"),
    ),
  );
  viewer.setMessage("Loading…");
  viewer.setMode("split");
  assert.equal(container.textContent, "Loading…");
  assert.equal(viewer.hasFiles, false);
});

test("real Git multi-file patches preserve all changed source in both layouts", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prm-diff-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const git = (...args) =>
    execFileSync(
      "git",
      ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args],
      { cwd: dir, encoding: "utf8" },
    ).trimEnd();
  git("init", "--initial-branch=main");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.com");
  fs.writeFileSync(
    path.join(dir, "space name.txt"),
    Array.from({ length: 80 }, (_, i) => `line ${i + 1}\n`).join(""),
  );
  fs.writeFileSync(path.join(dir, "é.txt"), "old\n");
  fs.writeFileSync(path.join(dir, "old name.txt"), "rename me\n");
  fs.writeFileSync(path.join(dir, "removed.txt"), "remove me\n");
  fs.writeFileSync(path.join(dir, "image.bin"), Buffer.from([0, 1, 2]));
  git("add", ".");
  git("commit", "-m", "base");
  const lines = fs
    .readFileSync(path.join(dir, "space name.txt"), "utf8")
    .split("\n");
  lines[0] = "<script>text only</script>";
  lines[60] = "new line 61";
  fs.writeFileSync(path.join(dir, "space name.txt"), lines.join("\n"));
  fs.writeFileSync(path.join(dir, "é.txt"), "new without newline");
  fs.renameSync(path.join(dir, "old name.txt"), path.join(dir, "new name.txt"));
  fs.rmSync(path.join(dir, "removed.txt"));
  fs.writeFileSync(path.join(dir, "added.txt"), "added\n");
  fs.writeFileSync(path.join(dir, "image.bin"), Buffer.from([0, 3, 4]));
  git("add", "-A");
  const raw = git(
    "diff",
    "--cached",
    "--find-renames",
    "--no-color",
    "--no-ext-diff",
    "HEAD",
  );
  const parsed = parsePatch(raw);
  assert.equal(parsed.files.length, 6);
  assert.ok(parsed.files.every((f) => !f.unsupported));
  assert.equal(
    parsed.files.find((f) => f.title === "space name.txt").hunks.length,
    2,
  );
  assert.ok(parsed.files.some((f) => f.title === "é.txt"));
  for (const mode of ["unified", "split"]) {
    const { container } = view(raw, mode);
    assert.equal(container.querySelectorAll(".diff-file").length, 6);
    assert.equal(container.querySelectorAll("script").length, 0);
    assert.match(container.textContent, /<script>text only<\/script>/);
    for (const file of parsed.files)
      for (const hunk of file.hunks)
        for (const row of hunk.rows)
          assert.ok(
            [...container.querySelectorAll(".diff-source")].some(
              (el) => el.textContent === row.text,
            ),
          );
  }
});

test("CRLF source keeps its carriage returns in the model and shows visible marks without breaking split alignment", () => {
  const raw =
    "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\r\n+new\n";
  assert.equal(parsePatch(raw).files[0].hunks[0].rows[0].text, "old\r");
  const { container } = view(raw, "split");
  const source = container.querySelector(".diff-source");
  assert.equal(source.textContent, "old␍");
  assert.match(source.title, /carriage return/);
  assert.equal(
    container.querySelector(".diff-split").textContent.includes("\r"),
    false,
  );
});
