const vscode = require("vscode");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

function request(cwd, bridge, message) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bridge], {
      cwd,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "",
      err = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("PR Manager timed out."));
    }, 30000);
    child.stdout.on("data", (b) => {
      out += b;
    });
    child.stderr.on("data", (b) => {
      err += b;
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code) return reject(new Error(err || "PR Manager failed."));
      try {
        resolve(JSON.parse(out));
      } catch (e) {
        reject(e);
      }
    });
    child.stdin.end(JSON.stringify(message));
  });
}

function activate(context) {
  context.subscriptions.push(
    vscode.commands.registerCommand("prm.view", async () => {
      if (!vscode.workspace.isTrusted)
        return vscode.window.showErrorMessage(
          "Trust this workspace before using PR Manager.",
        );
      const folders = vscode.workspace.workspaceFolders || [];
      const folder =
        folders.length === 1
          ? folders[0]
          : await vscode.window.showWorkspaceFolderPick();
      if (!folder)
        return vscode.window.showErrorMessage(
          "Open a local Git repository first.",
        );
      const root = path.join(context.extensionPath, "runtime");
      const bridge = path.join(root, "src", "bridge.js");
      try {
        await request(folder.uri.fsPath, bridge, { route: "graph" });
      } catch (e) {
        return vscode.window.showErrorMessage(e.message);
      }
      const panel = vscode.window.createWebviewPanel(
        "prm.graph",
        "PR Manager",
        vscode.ViewColumn.One,
        {
          enableScripts: true,
          localResourceRoots: [vscode.Uri.file(path.join(root, "ui"))],
          retainContextWhenHidden: true,
        },
      );
      const uri = (file) =>
        panel.webview
          .asWebviewUri(vscode.Uri.file(path.join(root, "ui", file)))
          .toString();
      let html = fs.readFileSync(path.join(root, "ui", "index.html"), "utf8");
      const source = panel.webview.cspSource;
      html = html
        .replace(
          '<meta charset="utf-8">',
          `<meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src ${source}; style-src ${source}; img-src ${source}; base-uri 'none'; form-action 'none';">`,
        )
        .replace('href="/style.css"', `href="${uri("style.css")}"`)
        .replace('src="/app.js"', `src="${uri("app.js")}"`);
      const listener = panel.webview.onDidReceiveMessage(async (message) => {
        if (!Number.isInteger(message?.id)) return;
        try {
          await panel.webview.postMessage({
            id: message.id,
            result: await request(folder.uri.fsPath, bridge, message),
          });
        } catch (error) {
          await panel.webview.postMessage({
            id: message.id,
            error: error.message,
          });
        }
      });
      panel.onDidDispose(() => listener.dispose());
      panel.webview.html = html;
    }),
  );
}
module.exports = { activate };
