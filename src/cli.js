import { parseArgs } from "node:util";
import {
  continuousPush,
  planPushRun,
  readPushRun,
  stopPushRun,
} from "./push-run.js";
import { Manager } from "./core.js";
import { serve } from "./server.js";

const help = `gh prm — parallel PRs from a single working branch

  init --base BRANCH [--remote origin] [--repo https://HOST/OWNER/REPO]
  tag FEATURE [COMMIT ...]         Assign commits (defaults to HEAD)
  deps FEATURE [DEPENDENCY ...]    Replace dependencies; --clear removes all
  branch FEATURE NAME             Set full branch name; --clear uses the default
  adopt FEATURE PR_NUMBER        Track a matching existing PR without pushing
  status [--json]                  Show groups and readiness (local snapshot)
  push [FEATURE ...] [--dry-run]   Publish ready groups; named blocked groups get
                                  full-history preview branches, without PRs
  push [FEATURE ...] --wait       Publish a fixed feature list as prerequisites merge
  push --wait --dry-run           Preview the continuous run without starting it
  push --stop                     Stop the current continuous run
  sync [--dry-run]                 Fetch base; remove merged groups; replay work
  sync --continue | --abort       Resolve/abort a paused sync
  view [--port 0] [--no-open]      Open the interactive local graph editor
  view --json | --dot              Export the graph without a server
  notes push | pull                Explicitly share refs/notes/prm (fast-forward)

Requires Git, gh authentication, and Node.js 22+. Dependencies must MERGE before
a group is published. Mutations never auto-stash. push publishes; sync is local.
`;

export async function main(argv = process.argv.slice(2)) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      help: { type: "boolean", short: "h" },
      version: { type: "boolean" },
      base: { type: "string" },
      remote: { type: "string" },
      repo: { type: "string" },
      json: { type: "boolean" },
      dot: { type: "boolean" },
      clear: { type: "boolean" },
      "dry-run": { type: "boolean" },
      wait: { type: "boolean" },
      stop: { type: "boolean" },
      continue: { type: "boolean" },
      abort: { type: "boolean" },
      "no-open": { type: "boolean" },
      port: { type: "string" },
    },
  });
  const [command, ...args] = positionals;
  if ((values.wait || values.stop) && command !== "push")
    throw new Error("--wait and --stop are push options.");
  if (values.version) {
    console.log("0.1.0");
    return;
  }
  if (!command || values.help) {
    console.log(help);
    return;
  }
  const manager = new Manager();
  let result;
  switch (command) {
    case "init":
      result = manager.init(values);
      break;
    case "tag": {
      const [name, ...revs] = args;
      result = manager.tag(name, revs.length ? revs : ["HEAD"]);
      break;
    }
    case "deps": {
      if (!args.length || (args.length === 1 && !values.clear))
        throw new Error(
          "Use deps FEATURE DEPENDENCY ... or deps FEATURE --clear.",
        );
      if (values.clear && args.length > 1)
        throw new Error("--clear cannot be combined with dependencies.");
      result = manager.dependencies(args[0], args.slice(1));
      break;
    }
    case "status":
      result = manager.graph();
      break;
    case "branch":
      if (args.length !== (values.clear ? 1 : 2))
        throw new Error("Use branch FEATURE NAME or branch FEATURE --clear.");
      result = manager.branchName(args[0], values.clear ? null : args[1]);
      break;
    case "adopt":
      if (args.length !== 2 || !/^[1-9][0-9]*$/.test(args[1]))
        throw new Error("Use adopt FEATURE PR_NUMBER.");
      result = manager.adopt(args[0], Number(args[1]));
      break;
    case "push": {
      if (values.stop) {
        if (args.length || values.wait || values["dry-run"])
          throw new Error("Use push --stop on its own.");
        const current = readPushRun(manager);
        if (!current) throw new Error("No continuous push run exists.");
        result = stopPushRun(manager, current.id);
      } else if (values.wait) {
        if (values["dry-run"])
          result = {
            ...planPushRun(manager, { names: args }),
            dryRun: true,
            continuous: true,
          };
        else {
          const controller = new AbortController();
          const stop = () => controller.abort();
          process.on("SIGINT", stop);
          process.on("SIGTERM", stop);
          manager.onProgress = (event) =>
            console.error(
              event.run
                ? `${event.run.status}: ${event.run.features.map((f) => `${f.name}=${f.status}`).join(", ")}`
                : `$ ${event.command}`,
            );
          try {
            result = await continuousPush(
              manager,
              { names: args },
              { signal: controller.signal },
            );
          } finally {
            process.off("SIGINT", stop);
            process.off("SIGTERM", stop);
          }
        }
      } else result = manager.push({ dryRun: values["dry-run"], names: args });
      break;
    }
    case "sync": {
      if (
        [values.continue, values.abort, values["dry-run"]].filter(Boolean)
          .length > 1
      )
        throw new Error("Use only one of --continue, --abort or --dry-run.");
      result = manager.sync({
        dryRun: values["dry-run"],
        continue: values.continue,
        abort: values.abort,
      });
      break;
    }
    case "view":
      if (values.dot) {
        console.log(manager.dot());
        return;
      }
      if (values.json) {
        result = manager.graph();
        break;
      }
      await serve(manager, {
        port: Number(values.port || 0),
        open: !values["no-open"],
      });
      return;
    case "notes":
      result = manager.shareNotes(args[0]);
      break;
    default:
      throw new Error(`Unknown command ${command}.\n${help}`);
  }
  if (values.json || !result?.groups)
    console.log(JSON.stringify(result, null, 2));
  else {
    console.log(`${result.branch} → ${result.base}\n`);
    for (const g of result.groups)
      console.log(
        `${g.ready ? "●" : "○"} ${g.name}  → ${g.branch}  ${g.commits.length} commit(s)  ${g.pr ? `PR #${g.pr}` : g.status}${result.pushRun?.features.find((f) => f.name === g.name) ? ` · push ${result.pushRun.features.find((f) => f.name === g.name).status}` : ""}${g.blockedBy.length ? `  waits for ${g.blockedBy.join(", ")}` : ""}`,
      );
    const unassigned = result.commits.filter((c) => !c.name);
    if (unassigned.length)
      console.log(
        `\n${unassigned.length} unassigned commit(s); use gh prm tag.`,
      );
    if (result.paused)
      console.log("\nSync paused; use gh prm sync --continue or --abort.");
  }
}

main().catch((error) => {
  console.error(`prm: ${error.message}`);
  process.exitCode = 1;
});
