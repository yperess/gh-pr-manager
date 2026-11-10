# PR Manager

Manage parallel pull requests from one linear working branch. Git notes assign
commits to features and declare dependencies. Ready features get isolated PR
branches; dependent features wait until their prerequisites **merge**.

The source branch can contain interleaved work. For example, `A C D E F` can
contain feature1's `A E` and feature3's `C D F`. PR Manager extracts each ready
feature rather than including every earlier commit in its PR.

## Install

Requires **Node.js 22+**, Git 2.36+, and an authenticated GitHub CLI. No npm
dependencies or compilation are required for the CLI or browser UI.

Install directly from GitHub, from any directory:

```sh
gh extension install yperess/gh-pr-manager
gh alias set prm pr-manager
gh prm --help
```

GitHub CLI downloads and manages the extension; no manual clone or `npm install`
is needed. The extension's command is `gh pr-manager`; the alias makes it
`gh prm`. The normal `gh pr` commands are unaffected.

### Upgrade

Update a GitHub-installed copy with:

```sh
gh extension upgrade pr-manager
```

Use the extension name `pr-manager`, rather than the `prm` alias, for extension
management commands. See the official [installation](https://cli.github.com/manual/gh_extension_install)
and [upgrade](https://cli.github.com/manual/gh_extension_upgrade) documentation.

### Local development installation

To work on the extension itself, clone the repository and install a link to the
checkout instead:

```sh
git clone git@github.com:yperess/gh-pr-manager.git
cd gh-pr-manager
gh extension install .
gh alias set prm pr-manager
```

This installation uses the local checkout directly, including uncommitted edits.
Update that checkout with Git rather than `gh extension upgrade`.
You can also run `/path/to/gh-pr-manager/gh-prm` directly from a target repository.
To switch an existing local installation to the GitHub-managed copy, run:

```sh
gh extension remove pr-manager
gh extension install yperess/gh-pr-manager
```

The existing `prm` alias can be kept.

## Start a workflow

```sh
git switch -c work/ontology-migration origin/develop
gh prm init --base develop
# Optional overrides:
# gh prm init --base main --remote origin --repo https://HOST/OWNER/REPO

# Make normal git commits on this one working branch.
gh prm tag feature1 <A>
gh prm tag feature2 <B>
gh prm tag feature3 <C> <D>
gh prm deps feature3 feature1 feature2
gh prm status
gh prm view
```

`init` records the current branch and remote base. It refuses to manage the
trunk itself. This first version manages one integration branch per clone;
linked worktrees share its configuration and lock. It works with standard PR
APIs through `gh`, including authenticated GitHub Enterprise hosts, without
requiring GitHub's native stacked-PR APIs.

## Notes are the feature model

Assignments live in **`refs/notes/prm`**, separate from normal Git notes:

```text
prm-name: feature3
prm-deps: feature1, feature2
```

Each commit has at most one feature. A dependency list may appear on any commit
in a group; the group's dependencies are the union of these lists. `deps`
replaces that union with a canonical list on the first commit, preserving
unrelated note text. It rejects cycles, unknown features, and self-dependencies.

```sh
gh prm tag feature1             # HEAD by default
gh prm tag feature3 HEAD~2 HEAD # individual revisions, not ranges
gh prm deps feature3 feature1 feature2
gh prm deps feature3 --clear
git notes --ref=prm show HEAD
```

`init` adds this namespace to `notes.rewriteRef`, so ordinary Git amend/rebase
operations can carry the notes forward. PR Manager explicitly copies notes
during its own history rewrites. Notes on original commits are retained.

Notes aren't transferred by normal branch pushes. Share them explicitly:

```sh
gh prm notes push
gh prm notes pull
```

These are fast-forward operations. Divergent note histories require a manual
`git notes --ref=prm merge`; the tool does not overwrite someone else's notes.
PR numbers and published source-commit mappings are currently local metadata in
the Git common directory's `prm/state.json`; notes alone do not restore an
existing workflow on another clone.

## Branch names and adopting existing PRs

New branches default to `prm/FEATURE`. An optional **repository-root `.ghprm`**
can set a contributor's prefix:

```ini
BRANCH_PREFIX=yperess
```

Both `yperess` and `yperess/` produce `yperess/FEATURE`. An empty value uses
the feature name without a prefix. Blank lines and full-line `#` comments are
allowed; values can also be JSON-quoted strings. This is a literal configuration
file, never a shell script: no variable expansion, commands, or `export` syntax.
Unknown or duplicate settings and invalid Git branch names are rejected.

For personal configuration, add `/.ghprm` to `.git/info/exclude` before creating
the file. Otherwise commit it as shared repository configuration. An untracked,
unignored `.ghprm` counts as a dirty working tree and blocks push/sync.
The file is read from the managed checkout's root even when running in a subdirectory.

Override a feature's **full** branch name with a note:

```text
prm-name: struct-fixture
prm-branch-name: yperess/migrate-struct-fixture
```

Unquoted names and JSON strings are accepted. The last explicit branch override
in feature commit order wins. The CLI offers a shortcut that stores one canonical
override on the feature's first commit and removes later branch overrides:

```sh
gh prm branch struct-fixture yperess/migrate-struct-fixture
gh prm branch optional-interface-fixture yperess/migrate-optional-interface-fixture
gh prm branch struct-fixture --clear
gh prm status
gh prm push --dry-run
```

The browser and VS Code feature inspectors show the resolved branch name and
allow setting or clearing this override. Explicit names bypass `BRANCH_PREFIX`.
Once published, the branch stays fixed even if the prefix changes or its note
override is cleared. A different explicit name is rejected. Two features cannot
share a branch, and neither can target the base or managed working branch.

To adopt existing branches, first bring their commits onto your linear managed
working branch (for example, cherry-pick each independent branch's commits onto
a fresh integration branch from `origin/develop`). Tag those commits with their
feature names, then set each feature's existing full branch name as above.
To record an existing open PR without publishing anything, use:

```sh
gh prm adopt FEATURE PR_NUMBER
# Example:
gh prm adopt optional-interface-fixture 1477
```

This verifies the PR's repository, base and head branch, and the exact feature
projection at the existing branch's own base. It fetches for verification and
records the PR number, URL, remote head, and source commits in local tracking
state. It does not push, rewrite the working branch, edit the PR, or restart CI.
Dirty work is preserved. Unlike implicit adoption during push, this explicit
command can adopt a matching default branch name without a branch override.
The feature must have no unmet prerequisites. PR/head or repository changes
while verification is running stop adoption without recording the association.

Alternatively, inspect `push --dry-run`, then run `push` for the features you want
to publish; its matching-branch adoption checks still apply.

During push, an existing remote branch is adopted only with an explicit `prm-branch-name`
and a ready feature. Its history must be linear and match the feature
projection's tree, commit count, and ordered patch IDs when replayed onto the
remote branch's own merge-base with trunk. Older-base PRs can be adopted. Commit IDs may differ because of cherry-picking. The initial adoption keeps
the remote commit IDs and reuses its open PR against the configured base; if no
open PR exists, one is created. Existing PR titles and descriptions are retained.
Unrelated work or a PR against a different base stops publication.
Reconcile those branches yourself first; previews cannot adopt existing branches.

Branch checks run for the whole selected batch before any push. Exact
force-with-lease checks also protect against remote changes during publication.
Neither naming nor adoption changes local feature branch refs. Unchanged ready
features retain their published commit IDs, including after sync rewrites the
source commits with equivalent patches and messages. No remote push or pre-push
hook runs for those branches, so existing CI runs are preserved. Changed feature
commits use the normal isolated projection and leased push. Later review updates
and sync use the same workflow as newly created PRs.

## Publish ready work, or push a named preview

### PR metadata at each commit

Select a commit in the browser graph editor or VS Code view to see its PR title
and description **as of that commit**. Each field inherits the last explicit
value on an earlier commit in the same feature. Later commits and commits from
other features do not affect this historical view. The feature inspector shows
the latest effective values. Both views identify the source commit for each field.

Select a feature to edit its current title and description directly in the right
inspector. **Save feature metadata** writes changed fields to the latest commit
in that feature, even when the integration branch's HEAD belongs to a different
feature. Earlier overrides remain intact. The inspector shows the destination
commit and source of each current value.

Selecting a commit switches the same inspector to that commit's inherited values
and override controls. Click **Edit feature metadata** to return to its feature.
The patch stays visible with the graph and history in the left pane. Drag the
vertical divider to resize the inspector; when focused, Left/Right arrows resize
it, and Home/End select its minimum/maximum width. The width is remembered across
reloads. On narrow screens the inspector appears below the history.

Enable **Override title/description at this commit** to set a value. Uncheck it
to remove that commit's override and inherit again. An enabled, empty description
explicitly clears the description; it is different from an absent override.
Without any title override, the title defaults to the feature name. Without any
description override, PR creation uses the generated description.

Overrides are ordinary note fields:

```text
prm-name: feature3
prm-title: Migrate struct fixtures to ontology builder
prm-description: "Replace manual setup.\n\nAddresses PR3 of #1475"
```

The editor encodes descriptions as JSON strings to preserve multiline Markdown,
trailing newlines, and literal `prm-*` lines. Manual indented blocks are also
supported using `prm-description: |` followed by two-space-indented lines.
Duplicate title/description fields within one commit are rejected; overrides
across commits follow commit order, independently for each field.

Saving edits changes notes only and does not rewrite commit IDs. **New PRs use
the effective title and description.** Subsequent pushes don't overwrite titles
or descriptions already edited on GitHub; use `gh pr edit` for remote updates.

```sh
gh prm push --dry-run
gh prm push
gh prm push feature2 feature3 --dry-run
gh prm push feature2 feature3
```

Without names, `push` publishes **all ready groups**, independently, and reports
blocked groups. Untagged commits must be assigned before a default push.

With names, only those features are selected:

* A **ready** feature is replayed onto the remote base in a temporary worktree.
  Only its own commits go on its resolved branch (`prm/FEATURE` by default). A PR is created against the base, or
  the existing PR branch is updated with an explicit force-with-lease.
* A **blocked** feature gets a **preview branch** at the working branch's full
  current HEAD. This intentionally includes all current linear history,
  including unrelated groups and any unassigned commits. **No PR is created.**
  Once its prerequisites merge and `sync` records them, its next push replaces
  the preview with an isolated projection and creates the PR.

Independent PRs can therefore be reviewed and merged in either order. A group's
placement in the source log doesn't itself establish a dependency. If a ready
group cannot be extracted cleanly, add the actual prerequisite or make the
commits independent. All ready projections are built before publication starts.
Remote/API failures can still leave a partially published batch; successful
branch pushes are recorded before PR creation so rerunning can recover it.

PR titles default to feature names; use normal `gh pr edit` to edit the title
and description. The tool doesn't overwrite review descriptions on updates.
Closed PRs require manual reopening. It won't turn a published PR into a
full-history preview by adding unmet dependencies.

## Continuous pushes

```sh
# Snapshot every current feature, including those waiting for prerequisites:
gh prm push --wait

# Snapshot only these features; dependencies are not added automatically:
gh prm push feature2 feature3 --wait

# Inspect the fixed selection without starting a run:
gh prm push --wait --dry-run

# Inspect run membership and each feature's state:
gh prm status
gh prm status --json

# Stop from another terminal, or press Ctrl+C in the blocking command:
gh prm push --stop
```

`--wait` runs in the foreground and checks for merges every 30 seconds. It
publishes ready selected features, syncs when their prerequisites merge, and
publishes newly unblocked features. For A/B → C → D/E, it publishes A and B,
waits for both to merge, publishes C, waits for C to merge, then publishes D and
E. It finishes once the remaining selected PRs have been published; the last
PRs need not merge. It never merges PRs itself. Normal pushes without `--wait`
retain their one-shot behavior, including preview branches for named blocked
features. Continuous pushes wait to create isolated PRs instead of previews.

The feature list, commits, notes, branch names, and dependencies are fixed when
the run starts. New features are ignored. If a selected feature receives new
commits, loses commits, or has its notes changed, it is dropped from this run,
even if its previous version already has a PR. Dependents become unreachable;
independent selected features continue. A PR closed without merging is also
dropped, so its dependents do not wait forever. Only the run's own sync can remap the
snapshot's commit IDs without dropping a feature. Start a new push to include
new work. A dependency outside the selection must already be recorded as merged,
or have a tracked PR whose published commits match its current source. Such PRs
are watched for merges without pushing them again; their feature snapshots are
also frozen, so new unpublished work blocks their dependents. Unpublished
prerequisites are not implicitly added to the publication selection.
The run stops when nothing remains
pending, or all remaining pending features are unreachable.

A dirty managed checkout pauses polling mutations until it is clean; the tool never
stashes edits. Git conflicts, authentication failures, and publication errors
stop the run for inspection. Already published PRs remain published. The active
run owns push/sync operations for this repository across worktrees, but releases
Git locks while waiting, so commits and notes can still be edited. Stop it before
running a separate push or sync. The latest run is recorded locally in the Git
common directory's `prm/push-run.json`; `status --json` and the graph expose its
pending, published, merged, dropped, and unreachable features. An interrupted
process is shown as interrupted; a new push starts a fresh selection rather
than silently resuming publication.

In the browser and VS Code, select either push mode and check **Keep pushing
until done**, then preview and start the run. The preview includes waiting
features. The graph marks pending features, and the dialog and banner show live
run states and a **Stop push run** button. Stop requests work while Git is busy
and take effect between Git operations; completed pushes are preserved. Closing
the browser's streaming connection or the VS Code panel cancels its run.

### Work on another effort while a push waits

In the browser or VS Code UI, **Keep pushing until done** automatically moves the
managed branch into a separate worktree under the system temporary directory
(`/tmp` or its platform equivalent). Your original checkout must be clean. Its
files stay unchanged, but it becomes detached at its current commit so the
managed branch can be checked out in the temporary worktree. You can then switch
your original workspace to another branch and edit, stage, and commit normally.
Those changes do not pause the isolated push.

The UI stays connected to the managed worktree, even after you switch branches
in the original workspace. It shows the temporary path; push, sync, PR status,
and note editing there continue to refer to the managed effort. CLI commands
still operate in the directory where you run them. Keep the UI and its server
running: closing the browser connection or VS Code panel cancels the continuous
run. This is an isolated checkout, not a detached background service.

The temporary worktree is retained after completion, cancellation, or failure so
you can inspect the result, resume conflict recovery, or start another run from
the UI. The managed branch and PR metadata stay in the same repository. To inspect
or recover a conflict, use the displayed checkout path and the recovery commands
printed by sync. Do not delete temporary directories while a run is active.

For the equivalent CLI workflow, create a temporary worktree yourself before
starting the blocking command. For example, in `lohi-lib`:

```sh
cd ~/workspace/lohi-lib

# Keep the current files but release the managed branch.
git switch --detach
prm_dir=$(mktemp -d /tmp/lohi-prm.XXXXXX)
git worktree add "$prm_dir" yperess/prm-ontology-migrations

# Start the new effort in your original workspace.
git switch -c yperess/new-effort origin/develop

# Keep this terminal running. You can also name a subset of features here.
(cd "$prm_dir" && gh prm push --wait)
```

After the run stops and you have finished reviewing its checkout, remove it using
its displayed path. For the CLI example, in the same shell:

```sh
cd ~/workspace/lohi-lib
git worktree remove "$prm_dir"
```

For a UI-created worktree, substitute its displayed path for `$prm_dir`. Removal
refuses to discard uncommitted changes; resolve or save those first. It preserves
the managed branch, notes, and PR tracking. A later UI session can use the managed
branch again after you check it out. If you use a new terminal, use the actual
path rather than relying on the previous shell's variable. System cleanup or a
reboot may remove temporary directories; this is not durable daemon storage.

## Review updates and sync

```sh
# Commit E fixes feature1; F adds to feature3.
gh prm tag feature1 <E>
gh prm tag feature3 <F>
gh prm push feature1

# After feature2 merges:
gh prm sync --dry-run
gh prm sync
# A C D E F remain, rebased onto the base that contains B.
gh prm push
# Updates feature1 with A E. feature3 still waits.

# After feature1 merges:
gh prm sync
# C D F remain. Both prerequisites are satisfied.
gh prm push
# Creates feature3's PR with C D F.
```

`sync` fetches the base and reads the state of tracked PRs. It uses actual PR
merge status and the last published projection, rather than commit ancestry,
so **squash merges work**. Only published commits in tracked merged groups are
removed. If a merged group has unpublished local commits, sync stops: reassign
those commits to a new follow-up feature before continuing.

For untracked features with an explicit `prm-branch-name`, sync also looks for a
unique merged PR from that branch in the same repository against the configured
base. Before removing the feature, it verifies the PR's merge is in the fetched
base, its ordered commits match the feature, and replay produces the exact PR
and merge trees. This works after GitHub deletes the head branch; no push or
prior adoption is needed. Ambiguous PRs or unmatched local changes stop sync
without rewriting your branch. `sync --dry-run` previews this reconciliation.

If an earlier sync replayed an untracked merged feature as empty commits, sync
can recover the original patches from its retained backups. It requires matching
commit metadata and notes, verifies each original patch reproduces the current
commit's tree, then checks the complete feature against the merged PR. Empty
commits or matching branch names alone are insufficient to remove a feature.

Sync builds the replacement history in a separate worktree. Your working branch
stays untouched until replay finishes. A successful sync preserves the old tip
under `refs/prm/backups/...`, then advances the managed working branch. It does
**not** push anything, delete remote branches, or delete unrelated local branches.

If replay conflicts:

```sh
# The error prints the recovery worktree's path.
git -C /path/printed/by/prm status
# Resolve files there, then stage them there:
git -C /path/printed/by/prm add <resolved-files>
gh prm sync --continue
# Or discard the replay worktree, leaving the source branch unchanged:
gh prm sync --abort
```

Keep the managed source branch unchanged during recovery. The journal is stored
in the Git common directory's `prm/sync.json`. Backups can be inspected with
`git for-each-ref refs/prm/backups`; create a recovery branch at any backup ref
with `git branch recovery <backup-ref>`. Backups are retained until explicitly
deleted with Git.

## Graph editor

```sh
gh prm view                     # local browser app; Ctrl+C stops the server
gh prm view --no-open --port 8080
gh prm view --dot > graph.dot    # Graphviz DOT, including commits and groups
gh prm view --json               # full machine-readable graph
```

Commit patches use green additions, red deletions, and old/new line numbers.
Switch between **Unified** (top/down) and **Side by side** above the patch; the
choice is remembered in the browser session or VS Code webview state. Split
panes share vertical alignment and synchronize horizontal scrolling. Files and
hunks can be collapsed individually, or with **Collapse all** / **Expand all**;
layout changes preserve the current patch's collapse state. Binary and
metadata-only changes retain their Git metadata, and unsupported patch formats
are shown as plain text. Source code is displayed as text, not interpreted as
HTML. The browser and VS Code use the same viewer.

The editor shows the dependency DAG, grouped commit history, and commit patches.
Click a feature in the graph to show only its commits in the history. Click empty
canvas (including a dependency arrow), or press Escape while the graph is focused,
to show all commits again. Filtering also works when activating a feature with
Enter or Space.
Select a feature to add/remove prerequisites; select commits to assign a group.
Assignments, dependencies, and metadata edits change notes only. Refresh reads
external Git changes. The viewer binds to loopback, requires a random session
token for API calls, rejects foreign origins, and uses no external assets.

On opening the UI and each **Refresh**, a background, read-only GitHub request
finds existing open PRs by their resolved branch names, even before the first
push/adoption. For explicit branch overrides without an open PR, it also finds
merged PRs and shows **Merged · sync needed**. Matching fork branches are excluded.
Select a feature to open its
PR in a new browser tab and see current-head CI, review decision, and the number
of unresolved review threads. Failing CI, changes requested, or unresolved threads
highlight the feature as needing attention. Resolved threads do not count;
ordinary PR conversation comments are not classified as unresolved review work.
The selected feature's sidebar shows **PR #… found · Not tracked** with an
**Adopt PR** action beside its PR link. Adoption performs the same checks as
`gh prm adopt` and then shows **Tracking PR #…**. Titles/descriptions being edited
remain intact; any earlier push preview is invalidated. Verification errors stay
in the sidebar. The action is disabled during another operation, paused sync, or
while prerequisites remain unmerged. It is not a top-level toolbar action.

Pending CI is shown separately. Missing checks or API/authentication failures show
unknown/unavailable rather than passing. Status is a timestamped snapshot; click
**Refresh** for updates. Discovery does not adopt or push branches, mark dependencies
merged, or change GitHub PR metadata. Local history remains usable when GitHub is
unavailable. The browser app and VS Code webview share these behaviors.

The top-right toolbar has **Push**, **Sync**, and **Refresh** actions. Push and
Sync open their own dialogs, leaving the inspector focused on feature/commit edits.

To publish work:

1. Click **Push**. **What's ready** is selected by default and includes all ready
   features. Switch the pill toggle to **Let me choose** to select specific
   features. Selecting a waiting feature includes a full-history preview branch
   without a PR, just like `gh prm push FEATURE`.
2. Click **Preview push** to inspect the repository, base, branch names, and PR
   actions. This runs the local dry run; remote adoption and isolation checks
   happen during the actual push.
3. Click **Push N branches**. The dialog shows live command progress followed by
   PR links and preview-branch results, and refreshes the graph.

Click **Sync** to immediately start synchronization in its own dialog. Its live
command log shows fetching, PR checks, replaying remaining commits onto the base,
backup creation, and updating the managed branch. Sync uses the CLI's isolation,
notes preservation, backup, and recovery journal. Conflicts stop with the same
worktree path and `gh prm sync --continue` / `--abort` instructions as the CLI.

Operations run in background processes so commands appear while they execute.
The dialog cannot be closed and another operation cannot start until the running
operation finishes. Long Git hooks and network operations are allowed to finish
without the normal read-request timeout. Refresh reloads local state and PR status.

Push and sync use the same hooks, isolation, leases, adoption rules, and
clean-tree checks as the CLI. They never stash changes. A changed source, notes,
configuration, or publication state requires a fresh push preview. Refreshing or
changing the push selection also clears the preview.

If an operation fails, the dialog retains the error and command log and refreshes
the graph. A push batch can partially publish before a remote/API failure;
inspect the updated state and preview again before retrying.

## VS Code

```sh
npm run package:vscode
code --install-extension dist/pr-manager-0.1.0.vsix --force
```

Packaging uses the pinned `@vscode/vsce` packager through `npx` (network needed
on first use). The installed extension bundles the core and graph editor; it
doesn't require the gh extension to be installed. Git and authenticated `gh`
must be available to the VS Code extension host.

Open a trusted local workspace, initialize it using the CLI, then run
**PR Manager: Open Dependency Graph** from the Command Palette. The webview has
the same assignment, dependency editing, push/sync, and patch inspection controls as the
browser app. Git commands run in a separate process. Multi-root workspaces
prompt for the repository to view.

## Publish the VS Code extension

The GitHub repository and local VSIX are separate from the VS Code Marketplace.
Publishing to the Marketplace makes the extension discoverable in VS Code's
Extensions search. This repository does not yet configure a publishing workflow;
building the package does not publish it.

### Register a Marketplace publisher

1. Sign in with your Microsoft account at the
   [Marketplace publisher management portal](https://marketplace.visualstudio.com/manage).
2. Create a publisher. Use `yperess` if available: the current
   `vscode/package.json` declares `"publisher": "yperess"` and
   `"name": "pr-manager"`, giving the extension ID **`yperess.pr-manager`**.
   A different publisher ID requires updating the manifest and rebuilding.
3. Keep that publisher ID stable for subsequent releases and IT approval.

Publisher registration is still pending. If Microsoft blocks account creation
or a human-verification challenge blocks the session, resolve that through
Microsoft's account support before continuing. Publishing credentials and
Trusted Publishing cannot replace the initial account/publisher setup. The
local browser editor remains available with `gh prm view`, subject to your
organization's policies.

### Prepare the listing and package

Before the first Marketplace release, add an extension-focused README,
screenshots, search keywords, and ideally a PNG icon. Consider setting
`"preview": true` in the extension manifest for this initial release.
The current packaging script copies the repository README into the VSIX.

From the repository root:

```sh
npm ci
npm test
npm run check
npm run format:check
npm run package:vscode
```

The current artifact is `dist/pr-manager-0.1.0.vsix`. For later releases, update
`vscode/package.json` and the packaging script's output filename together.
Never publish a changed package under an already-published version.

### Publish and maintain releases

Use [Microsoft's publishing instructions](https://code.visualstudio.com/api/working-with-extensions/publishing-extension)
to publish the built VSIX. For repeatable releases, configure GitHub Actions
Trusted Publishing:

1. In the publisher portal, add a Trusted Publishing policy for repository owner
   `yperess`, repository `gh-pr-manager`, and the exact release workflow filename.
   If using a GitHub environment, its name must also match the policy.
2. Add a release workflow that checks out the repository, installs Node.js and
   development dependencies, runs the checks above, and builds the VSIX.
3. Give the publishing job `contents: read` and `id-token: write` permissions.
4. Use a version of `@vscode/vsce` supporting Trusted Publishing to publish with
   `--oidc` and `--packagePath dist/pr-manager-0.1.0.vsix`. The existing pinned
   packaging tool is not itself a configured release workflow; verify publishing
   support when adding that workflow.
5. After publication, verify the listing, publisher, version, and installation
   from VS Code's Extensions search before announcing the release.

Trusted Publishing avoids storing a long-lived publishing token. Follow the
linked documentation for the current authentication requirements.

## Enterprise approval and local installation

Marketplace publication does not automatically grant employer approval. Give
IT the published Marketplace listing, the exact extension ID, the version to
review, and [this source repository](https://github.com/yperess/gh-pr-manager).

VS Code administrators can allow a specific extension through their managed
`extensions.allowed` policy, including pinning it to approved versions. For
example, merge this entry into the organization's existing policy:

```json
{
  "extensions.allowed": {
    "yperess.pr-manager": ["0.1.0"]
  }
}
```

The ID above assumes the `yperess` publisher is registered and retained. IT can
instead approve all versions of this extension with `"yperess.pr-manager": true`.
Request approval for this extension specifically; approving every extension
from the publisher is broader. See
[Microsoft's enterprise extension controls](https://code.visualstudio.com/docs/enterprise/extensions)
for managed-policy configuration. Do not replace the employer's policy with
this example or assume changing a user setting will override it.

For the review, provide the MIT license, source revision, test results, and VSIX
artifact. The VS Code view reads local Git history, edits Git notes, and invokes
local Git/gh subprocesses in trusted workspaces. Push can publish branches and
create or update PRs after a preview. Sync can rewrite the managed working branch
using backups and a recovery journal. Include these behaviors in the review;
Marketplace availability does not reduce the extension's runtime permissions.

Once IT permits the installation, users can install the published extension
from Extensions search. For an approved local VSIX, open **Extensions → … →
Install from VSIX…** and select `dist/pr-manager-0.1.0.vsix`.

If `code` is unavailable in a macOS terminal, run **Shell Command: Install 'code'
command in PATH** from VS Code's Command Palette, then open a new terminal. The
Extensions UI installation path does not require the `code` command. After
installation, run **PR Manager: Open Dependency Graph** from the Command Palette.

## Development and scope

```sh
npm test
npm run check
node scripts/demo.js            # creates a disposable A–F sample repo
```

Run `npm ci` once before development checks; the DOM renderer tests use a
development-only dependency. The installed CLI and viewer remain dependency-free.

Tests use real temporary Git repositories and local bare remotes, with a fake
GitHub API; they never create real PRs. They cover the A–F scenario, named
preview branches, isolation, squash-merge sync, note preservation, conflicts,
recovery, remote collisions, and editor HTTP authorization.

This initial version supports **linear source history** and one working branch
per clone. Merge commits are rejected by push/sync. Generated commits preserve
author and committer metadata, but are unsigned; repositories requiring signed
commits need signing support before using publication. Dependencies represent
merge gates, not automatic semantic dependency detection: a cherry-pick that
applies cleanly can still need code from another feature. Run the target
repository's own tests on PR projections as appropriate.

`push --dry-run` is local and publishes nothing; readiness reflects the last
sync. `sync --dry-run` fetches and reads PR status but does not rewrite the source
branch. Git notes, published mappings, backups, and journals are local Git
metadata, not files committed into the target repository. Managed commands use
a clone-wide lock; don't run external Git mutations concurrently with them.
