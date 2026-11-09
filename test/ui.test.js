import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { parseHTML } from "linkedom";

async function until(check) {
  for (let n = 0; n < 100; n++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("UI did not reach the expected state.");
}

async function editor(vscodeMode = false) {
  const html = fs.readFileSync(
    new URL("../ui/index.html", import.meta.url),
    "utf8",
  );
  const { window } = parseHTML(html),
    document = window.document;
  const commits = ["A", "B", "C", "D", "E", "F"].map((subject, i) => ({
    sha: String(i + 1).repeat(40),
    subject: i === 0 ? "<img src=x onerror=alert(1)>" : subject,
    name: i === 0 || i === 4 ? "feature1" : i === 1 ? "feature2" : "feature3",
    deps: [],
  }));
  commits[2].title = "Initial feature title";
  commits[2].description = "Initial feature body";
  commits[5].title = "Latest feature title";
  let graph = {
    branch: "work",
    base: "main",
    repo: "https://github.test/user/repo",
    head: commits[5].sha,
    revision: "v1",
    commits,
    groups: [
      {
        name: "feature1",
        commits: [commits[0].sha, commits[4].sha],
        deps: [],
        blockedBy: [],
        ready: true,
        status: "READY",
      },
      {
        name: "feature2",
        commits: [commits[1].sha],
        deps: [],
        blockedBy: [],
        ready: true,
        status: "READY",
      },
      {
        name: "feature3",
        title: "Latest feature title",
        titleSource: commits[5].sha,
        description: "Initial feature body",
        descriptionSource: commits[2].sha,
        commits: [commits[2].sha, commits[3].sha, commits[5].sha],
        deps: ["feature1", "feature2"],
        blockedBy: ["feature1", "feature2"],
        ready: false,
        status: "BLOCKED",
      },
    ],
    merged: {},
    paused: false,
  };
  const calls = [];
  const fetch = async (url, options) => {
    const route = url.slice("/api/".length),
      body = options.body ? JSON.parse(options.body) : null;
    calls.push({ route, body, headers: options.headers });
    let result = graph;
    if (route === "deps") {
      assert.equal(body.revision, graph.revision);
      const group = graph.groups.find((g) => g.name === body.name);
      group.deps = body.deps;
      group.blockedBy = body.deps;
      group.ready = !body.deps.length;
      graph.revision += "x";
    } else if (route === "tag") {
      assert.equal(body.revision, graph.revision);
      for (const c of graph.commits)
        if (body.commits.includes(c.sha)) c.name = body.name;
      graph.groups.push({
        name: body.name,
        commits: body.commits,
        deps: [],
        blockedBy: [],
        ready: true,
        status: "READY",
      });
      graph.revision += "x";
    } else if (route === "branch") {
      assert.equal(body.revision, graph.revision);
      const group = graph.groups.find((g) => g.name === body.name);
      group.branchName = body.branchName;
      group.branch = body.branchName ?? `prm/${group.name}`;
      graph.revision += "x";
    } else if (route === "metadata") {
      assert.equal(body.revision, graph.revision);
      Object.assign(
        graph.commits.find((c) => c.sha === body.sha),
        body.overrides,
      );
      for (const group of graph.groups) {
        Object.assign(group, {
          title: group.name,
          description: null,
          titleSource: null,
          descriptionSource: null,
        });
        for (const c of graph.commits.filter((c) => c.name === group.name)) {
          for (const field of ["title", "description"])
            if (c[field] != null) {
              group[field] = c[field];
              group[`${field}Source`] = c.sha;
            }
        }
      }
      graph.revision += "x";
    } else if (route.startsWith("diff?"))
      result = { diff: "<script>never execute this</script>\n+ changed line" };
    return { ok: true, json: async () => structuredClone(result) };
  };
  const storage = new Map();
  const context = vm.createContext({
    window,
    document,
    location: { hash: "#token=test-token", pathname: "/" },
    history: { replaceState() {} },
    sessionStorage: {
      getItem: (k) => storage.get(k),
      setItem: (k, v) => storage.set(k, v),
    },
    fetch,
    URLSearchParams,
    setTimeout,
    clearTimeout,
    console,
    ...(vscodeMode
      ? {
          acquireVsCodeApi: () => ({
            postMessage: async (message) => {
              const result = await fetch(`/api/${message.route}`, {
                headers: {},
                ...(message.data ? { body: JSON.stringify(message.data) } : {}),
              });
              const event = new window.Event("message");
              event.data = { id: message.id, result: await result.json() };
              window.dispatchEvent(event);
            },
          }),
        }
      : {}),
  });
  vm.runInContext(
    fs.readFileSync(new URL("../ui/app.js", import.meta.url), "utf8"),
    context,
  );
  await until(() => document.querySelectorAll("#commits tr").length === 6);
  return { window, document, calls };
}

test("renderer displays the parallel DAG, groups interleaved commits, and safely inspects a patch", async () => {
  const { window, document, calls } = await editor();
  assert.equal(document.querySelectorAll(".feature-card").length, 3);
  assert.equal(document.querySelectorAll(".dependency-edge").length, 2);
  assert.match(
    document.getElementById("counts").textContent,
    /2 ready · 1 waiting/,
  );
  assert.equal(document.querySelectorAll("#commits img").length, 0);
  document
    .querySelector(".commit-message")
    .dispatchEvent(new window.Event("click"));
  await until(() =>
    document.getElementById("diff").textContent.includes("never execute"),
  );
  assert.equal(document.querySelectorAll("#diff script").length, 0);
  assert.equal(calls[0].headers["X-PRM-Token"], "test-token");
});

test("graph editor saves changed prerequisites and feature assignments through the API", async () => {
  const { window, document, calls } = await editor();
  document
    .querySelectorAll(".feature-card")[2]
    .dispatchEvent(new window.Event("click"));
  assert.equal(
    document.getElementById("inspector-title").textContent,
    "feature3",
  );
  const options = document.querySelectorAll("#deps-options input");
  options[0].checked = false;
  options[0].removeAttribute("checked");
  options[1].checked = true;
  options[1].setAttribute("checked", "");
  document
    .getElementById("deps-form")
    .dispatchEvent(new window.Event("submit", { cancelable: true }));
  await until(() => calls.some((c) => c.route === "deps"));
  assert.deepEqual(calls.find((c) => c.route === "deps").body.deps, [
    "feature2",
  ]);
  await until(
    () =>
      document.getElementById("notice").textContent ===
      "Dependencies saved to commit notes.",
  );
  const check = document.querySelector("#commits input");
  check.checked = true;
  check.dispatchEvent(new window.Event("change"));
  document.getElementById("feature-name").value = "followup";
  document
    .getElementById("tag-form")
    .dispatchEvent(new window.Event("submit", { cancelable: true }));
  await until(() => calls.some((c) => c.route === "tag"));
  assert.equal(calls.find((c) => c.route === "tag").body.name, "followup");
  assert.equal(calls.find((c) => c.route === "tag").body.commits.length, 1);
  await until(() => document.querySelectorAll(".feature-card").length === 4);
  assert.equal(document.getElementById("error").hidden, true);
});

for (const vscodeMode of [false, true]) {
  test(`${vscodeMode ? "VS Code" : "Browser"} feature inspector displays and edits branch names`, async () => {
    const { window, document, calls } = await editor(vscodeMode);
    document
      .querySelectorAll(".feature-card")[0]
      .dispatchEvent(new window.Event("click"));
    assert.equal(
      document.getElementById("feature-branch").textContent,
      "prm/feature1",
    );
    for (const value of ["yperess/migrate-struct-fixture", ""]) {
      document.getElementById("branch-name").value = value;
      document
        .getElementById("branch-form")
        .dispatchEvent(new window.Event("submit", { cancelable: true }));
      await until(
        () =>
          document.getElementById("notice").textContent ===
          "Branch name saved to notes.",
      );
      assert.equal(
        calls.filter((c) => c.route === "branch").at(-1).body.branchName,
        value || null,
      );
      assert.equal(
        document.getElementById("feature-branch").textContent,
        value || "prm/feature1",
      );
    }
  });
  test(`${vscodeMode ? "VS Code" : "Browser"} editor displays metadata as of a commit and saves, removes, and clears overrides`, async () => {
    const { window, document, calls } = await editor(vscodeMode);
    const click = (node) => node.dispatchEvent(new window.Event("click"));
    const change = (id, checked) => {
      const node = document.getElementById(id);
      node.checked = checked;
      node.dispatchEvent(new window.Event("change"));
    };
    const save = async () => {
      const count = calls.filter((c) => c.route === "metadata").length;
      document
        .getElementById("metadata-form")
        .dispatchEvent(new window.Event("submit", { cancelable: true }));
      await until(
        () => calls.filter((c) => c.route === "metadata").length > count,
      );
      await until(() =>
        document
          .getElementById("notice")
          .textContent.startsWith("Commit metadata saved"),
      );
      return calls.filter((c) => c.route === "metadata").at(-1).body;
    };
    click(document.querySelectorAll(".feature-card")[2]);
    assert.equal(
      document.getElementById("feature-title").textContent,
      "Latest feature title",
    );
    click(document.querySelectorAll(".commit-message")[3]); // D has no overrides of its own.
    assert.equal(
      document.getElementById("metadata-title").value,
      "Initial feature title",
    );
    assert.equal(
      document.getElementById("metadata-description").value,
      "Initial feature body",
    );
    assert.equal(document.getElementById("title-override").checked, false);
    assert.match(
      document.getElementById("title-source").textContent,
      /3333333/,
    );
    change("title-override", true);
    document.getElementById("metadata-title").value = "Middle title";
    const saved = await save();
    assert.deepEqual(saved.overrides, {
      title: "Middle title",
      description: null,
    });
    assert.equal(
      document.getElementById("metadata-title").value,
      "Middle title",
    );
    assert.equal(
      document.getElementById("feature-title").textContent,
      "Latest feature title",
    );
    change("title-override", false);
    assert.equal(
      document.getElementById("metadata-title").value,
      "Initial feature title",
    );
    assert.equal(document.getElementById("metadata-title").disabled, true);
    change("description-override", true);
    document.getElementById("metadata-description").value = "";
    const cleared = await save();
    assert.deepEqual(cleared.overrides, { title: null, description: "" });
    click(document.querySelectorAll(".commit-message")[5]); // F inherits D's explicit empty body.
    assert.equal(
      document.getElementById("metadata-title").value,
      "Latest feature title",
    );
    assert.equal(document.getElementById("metadata-description").value, "");
    assert.equal(
      document.getElementById("description-override").checked,
      false,
    );
    assert.match(
      document.getElementById("description-source").textContent,
      /4444444/,
    );
    change("description-override", true);
    document.getElementById("metadata-description").value =
      "<script>plain text</script>\n\nMarkdown paragraph";
    await save();
    assert.match(
      document.getElementById("feature-description").textContent,
      /<script>plain text/,
    );
    assert.equal(
      document.querySelectorAll("#feature-description script").length,
      0,
    );
  });
}
