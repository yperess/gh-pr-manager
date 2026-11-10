import { spawn } from "node:child_process";

// Long operations run outside the HTTP server/extension host and stream events.
export function requestBridge(
  cwd,
  bridge,
  message,
  onProgress = () => {},
  { signal } = {},
) {
  const stream =
    ["sync", "adopt", "feature-diff"].includes(message.route) ||
    (message.route === "push" && message.data?.dryRun === false);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bridge], {
      cwd,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const abort = () => child.kill("SIGTERM");
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    let output = "",
      stderr = "",
      result,
      failure;
    const timer = stream
      ? null
      : setTimeout(() => {
          child.kill();
          reject(new Error("PR Manager timed out."));
        }, 30000);
    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
      if (!stream) return;
      let newline;
      while ((newline = output.indexOf("\n")) >= 0) {
        const line = output.slice(0, newline);
        output = output.slice(newline + 1);
        if (!line) continue;
        try {
          const event = JSON.parse(line);
          if (event.type === "progress") onProgress(event);
          else if (event.type === "result") result = event.result;
          else if (event.type === "error") failure = new Error(event.error);
        } catch (error) {
          failure = error;
        }
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk).slice(-65536);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      signal?.removeEventListener("abort", abort);
      clearTimeout(timer);
      if (failure || code)
        return reject(failure || new Error(stderr || "PR Manager failed."));
      try {
        if (stream && result === undefined)
          throw new Error(
            "Operation ended without a result. Refresh before retrying.",
          );
        resolve(stream ? result : JSON.parse(output));
      } catch (error) {
        reject(error);
      }
    });
    child.stdin.on("error", () => {}); // A failed child reports through close/error.
    child.stdin.end(JSON.stringify({ ...message, stream }));
  });
}
