---
description: "Create and enter a retained Git worktree under the calling Session file policy."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-worktree

English | [中文](README.zh.md)

## Summary

Create an isolated checkout from a local commit and continue the same Session in it. Each operation creates a new named branch and leaves the source checkout intact. The existing sandbox governs all writes. Leaving the checkout retains its files and branch.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount the service alongside `workingDirectory`, `fs`, `subprocess`, `sandbox`, and `sandboxPolicy` providers. Add the tool package when models need the operation.

```yaml
- name: '@deepseek-ai/dsh-experimental-worktree'
- name: '@deepseek-ai/dsh-experimental-tool-worktree'
```

`ctx.worktrees.create(agent, { name?, from?, setup? }, signal?, onPhase?)` creates a new branch and checkout, then makes it current. `from` defaults to `HEAD` and resolves to a local commit before allocation. `baseCommit` reports the commit object name; repository-local replacement refs can still affect the checked-out content. Checkout disables configured Git clean, smudge, and process filters. An existing branch or path fails. By default, no uncommitted source files are brought over and no setup command runs.

`ctx.worktrees.restore(agent, { path, branch, baseCommit, repositoryRoot }, signal?, onPhase?)` checks a removed worktree out again at its recorded directory. It validates the recorded repository root, full commit object name, branch, and canonical target inside the configured pool before mutation. It removes only the missing target's unlocked registration with `git worktree remove`; other worktrees and locked registrations remain unchanged. It then checks out the branch when it still exists, or creates the branch again at `baseCommit` when it does not, and reports which happened as `branchRecreated`. An existing directory is an error. The calling Session's working directory does not change, and changes that were never committed are not recovered. Checkout disables filters as creation does. `onPhase` receives `prepare` before validation, target-registration cleanup, and branch creation, and `checkout` before the files are written; it must not throw. Restoration does not recreate shares or copies or run setup.

The default checkout directory is `<current checkout root>/.agents/worktrees/<name>`. The returned `repositoryRoot` is the top-level directory of the caller’s current checkout; when it is a linked checkout, the pool is nested inside it. Omitted names join the `dsh-` prefix, the first eight hexadecimal digits of the UUID in the Session id, a hyphen, and four random hexadecimal digits, such as `dsh-6b1f02c4-9a3e`; a Session id without a UUID gets eight random hexadecimal digits after the prefix. `generatedWorktreeName` exports the same rule for callers that name a worktree before creating it. The service writes a `.gitignore` containing `*` and a trailing newline only when its allocation creates the pool; existing files and ignore rules are preserved. Relative `directory`, generated `namePrefix`, executable choices, and process limits are configurable in the [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-experimental-worktree).

### Provision after checkout

In the worktree service config, set `setupCommand` to an argv array for literal arguments, or to text for a noninteractive local shell (`sh` on POSIX, Windows PowerShell on Windows). The command runs once in the new checkout with a default `setupTimeoutMs` of `120000`. `setupEnv` applies only to this command, not to the sandbox runner. `setup: false` skips the command but not file provisioning. Configure only trusted commands and scripts; command text and output enter tool history, so do not put secrets in the command or print them.

`shareDirectories` accepts absolute directories outside the source checkout and Session workspace, but not their ancestors. It links them by basename. `copyIgnored` selects only untracked regular files that Git ignores and that match root-relative Git globs; it excludes `.git` and the worktree pool. `copyMode` defaults to `copy`; `symlink` links to the source file instead. File provisioning precedes the setup command. It does not overwrite files or follow symlink parents. A link grants no access to its target. Do not replace participating directories during provisioning, and select secret files only when required.

`maxOutputBytes` caps both setup streams together and limits the complete ignored-file listing. The `provision` result reports the command, exit facts, bounded UTF-8 output, and whether it was truncated. An identified runner failure reports `unavailable` with no target exit code or signal. The service does not spill setup output to a file. An over-limit listing is not applied. Configured file operations return counts only.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

Git, directory allocation, file provisioning, and setup use the calling Session's existing process sandbox. Creation does not grant write access to the checkout, shared Git metadata, or link targets. Service disposal cancels operations and waits for them to settle.

| Source | Responsibility |
|---|---|
| [`src/index.ts`](src/index.ts) | Resolve the source revision, create the checkout, and publish the new working directory |
| [`src/process.ts`](src/process.ts) | Confine literal argv, cap output, and await process termination |
| [`src/directory.ts`](src/directory.ts) | Claim the destination and initialize a newly created pool's ignore file |

No runtime invariant companion is published: Git owns checkout registration and the working-directory service owns the Session directory; this package retains no independent projection of either.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Worktree subsystem](../../../docs/subsystems/worktrees.md) — request, result, and service reference.
- [Working directory](../../session/working-directory/README.md) — recorded Session directory and directory changes.
- [Worktree tool](../tool-worktree/README.md) — model-facing creation.
- [Subprocess](../../subprocess/subprocess/README.md) — process ownership and execution worlds.
- [Creation decision](../../../.agents/notes/implemented/feature/2026-09-13-explicit-worktree-creation.md) — retained checkouts and existing write grants.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through the worktree tool's creation result and the working-directory service's recorded Session context.

#### KV Cache effect

This package contributes no prompt text. Its consumers own the appended tool result and recorded directory context.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Retained artifacts** — leaving keeps the branch and files. A failed setup command still enters the checkout and reports its failure. A file provisioning failure or cancellation leaves the Session in its prior directory and may retain a branch and partial files. Inspect the retained checkout before continuing; the service does not clean up or retry.
- **Local revisions only** — checkout does not fetch commits or missing partial-clone objects or initialize submodules. On Git that meets the execution requirements, missing local objects cause creation to fail.
- **Filtered representations** — checkout skips configured filters to avoid executing repository-configured programs or triggering implicit downloads. Git LFS pointers and encrypted blobs stay in their stored representation; hydration or decryption is a separate user-controlled operation.
- **Execution requirements** — the subprocess provider must offer Git and Node in the same execution world as the filesystem provider. Git must honor `GIT_NO_LAZY_FETCH`, which Git 2.45 and the 2.39.4, 2.40.2, 2.41.1, 2.42.2, 2.43.4, and 2.44.1 maintenance releases do; older releases ignore it and proceed instead of failing, so creation can fetch missing partial-clone objects from a promisor remote. The `git --no-lazy-fetch` option would reject these releases, but it exists only in Git 2.45 and later and also rejects the patched maintenance releases. The existing sandbox must permit all checkout and shared Git metadata writes.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The sandboxed Node child supplies exclusive directory creation, which the [filesystem service](../../fs/fs/src/index.ts) does not expose, and identifies whether this service created the pool. The filesystem contract permits bare providers such as [fs-local](../../fs/fs-local/src/index.ts) to ignore `sandboxPolicy` on writes; `createIfAbsent` protects a file but neither enforces permissions nor identifies who created its directory. Keeping directory allocation and ignore-file creation under the same process sandbox as Git preserves refusal of existing checkout paths and the condition for creating `.gitignore`.

</details>
