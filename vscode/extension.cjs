const vscode = require("vscode");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

async function request(cwd, bridge, message, onProgress, options) {
  const { requestBridge } = await import(
    pathToFileURL(path.join(path.dirname(bridge), "operations.js")).href
  );
  return requestBridge(cwd, bridge, message, onProgress, options);
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
        .replace('src="/diff.js"', `src="${uri("diff.js")}"`)
        .replace('src="/app.js"', `src="${uri("app.js")}"`);
      const running = new Set();
      const listener = panel.webview.onDidReceiveMessage(async (message) => {
        if (!Number.isInteger(message?.id)) return;
        const controller = new AbortController();
        running.add(controller);
        try {
          if (!vscode.workspace.isTrusted)
            throw new Error("Trust this workspace before using PR Manager.");
          await panel.webview.postMessage({
            id: message.id,
            result: await request(
              folder.uri.fsPath,
              bridge,
              message,
              (event) => {
                panel.webview.postMessage({ id: message.id, progress: event });
              },
              { signal: controller.signal },
            ),
          });
        } catch (error) {
          await panel.webview.postMessage({
            id: message.id,
            error: error.message,
          });
        } finally {
          running.delete(controller);
        }
      });
      panel.onDidDispose(() => {
        listener.dispose();
        for (const controller of running) controller.abort();
      });
      panel.webview.html = html;
    }),
  );
}
module.exports = { activate };
