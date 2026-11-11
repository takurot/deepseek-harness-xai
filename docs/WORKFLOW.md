# Development workflow

English | [中文](WORKFLOW.zh.md)

The procedure for taking one Issue to a merged pull request in this repository: choose the Issue, branch, implement test-first, run the checks that cover the change, then commit, push, and open the PR. This page orders the steps and links each owner; commands, test tiers, and documentation rules live in the pages it links.

## Sources of truth

Read these in order before changing code:

1. [AGENTS.md](../AGENTS.md) — standing orders, commands, and conventions.
2. [architecture.md](architecture.md) — the composition and extension points; required reading before changing `packages/`.
3. The Issue — the task, acceptance conditions, and dependencies.
4. The owning package README and [Agent Notes](../.agents/notes/README.md) — the contract and the recorded decisions.
5. The implementation and its tests — the behavior that is currently protected.

When an Issue contradicts an Agent Note or a package README, do not choose silently. Raise the conflict in the Issue and change the owning document in the same PR as the code.

## Choose the Issue

This fork tracks its work in GitHub Issues. Pass `--repo` explicitly so `gh` does not target the upstream repository.

```sh
gh issue list --repo takurot/deepseek-harness-xai --state open --limit 200
gh issue view <number> --repo takurot/deepseek-harness-xai --json number,title,body,comments,labels,state,url
```

A list that reaches the limit is not complete; narrow the search or paginate. Use only a verified integer for `<number>` and never paste Issue text into a shell command.

Before starting, write down in the Issue or a work note:

- The acceptance conditions and the owning package or document.
- What is out of scope.
- The failing test to add first.
- Effects on public APIs, persisted Session data, configuration keys, and model-visible output.
- Conditions that cannot be verified locally, such as real-provider behavior.

Split an Issue that is too large without dropping its acceptance conditions, and record the child Issues in the parent. One branch carries one Issue.

## Start work

Synchronize the default branch without discarding anything, then branch from it.

```sh
git switch master
git pull --ff-only
git status --short --branch
git switch -c <type>/<short-description>
```

- `<type>` is a Conventional Commit type: `feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `perf`, or `ci`.
- `<short-description>` uses lowercase ASCII letters, digits, and hyphens.
- Keep unrelated untracked files and other people's changes. Do not run `git reset --hard`, a broad `git clean`, or `git checkout --` on files you did not change.

Run `pnpm install` on Node 24.9 or later; the [setup tutorial](development.md#setup-tutorial) covers prerequisites. A worktree keeps parallel branches apart when you work on several Issues.

## Implement test-first

Follow Red, Green, Refactor for every behavior change and fix:

1. **Red.** Add the smallest test that observes the acceptance condition and confirm it fails for the intended reason. For a bug, reproduce the reported behavior first.
2. **Green.** Make the smallest change that passes it.
3. **Refactor.** Tidy names and duplication, then rerun the same tests. Do not change behavior that no test pins down without adding the test.

Place each test in the tier that owns the behavior; [testing.md](testing.md) defines the tiers, the 100% per-file coverage gate, and when a keyless recorded-session snapshot is required. Tests describe behavior, so change an obsolete test together with the behavior and explain why in the PR.

While implementing:

- Keep the change minimal and every changed line traceable to the Issue.
- Update the affected README, JSDoc, and [subsystems](subsystems/README.md) page in the same change.
- Edit both languages of a paired document and re-record the pair, as [docs/AGENTS.md](AGENTS.md) and the [i18n contract](i18n/README.md) require.
- Write an Agent Note only for a durable decision; [when to write one](../.agents/notes/README.md#when-to-write-one) lists the exemptions.
- Record an externally perceptible breaking change in an upgrade guide with [dsh-create-upgrade-guide](../.agents/skills/dsh-create-upgrade-guide/SKILL.md), and acknowledge persistence-type changes as [AGENTS.md](../AGENTS.md#pre-stable-apis-and-released-session-data) directs.
- Read the [defensive patterns](defensive-patterns/README.md) before touching a package surface, remote service, client state, Session behavior, or lifecycle and teardown code.

## Run the relevant checks

Select the smallest checks that cover the changed surface and run them once; [dsh-pre-push-checks](../.agents/skills/dsh-pre-push-checks/SKILL.md) owns the selection procedure and `pnpm --silent run change-scope --base <ref>` lists the outgoing paths.

| Changed surface | Evidence |
|---|---|
| Package or script behavior | The owning Vitest file or test name |
| Documentation, Agent Notes, or doc-linked comments | `pnpm run doc-sync` |
| Model-, editor-, CLI-, or terminal-visible output | The owning snapshot scenario with `pnpm run test:snapshot` |
| Package manifests, exports, or built runtime paths | `pnpm run build` and `pnpm run hygiene` |
| TypeScript changes, before claiming completion | `pnpm run build:artifacts`, then `pnpm run build:check` |
| Provider or agent behavior | `pnpm run test:e2e` when `DEEPSEEK_API_KEY` is available |

The Git hooks in [lefthook.yml](../lefthook.yml) are a fast local checkpoint, not the check set: `pre-push` runs `pnpm run typecheck`. CI owns the exhaustive coverage and platform matrix, so do not run the full suite or repeat a passing check before pushing unless the change is repository-wide, CI needs diagnosis, or you were asked to.

State only the commands you ran. A check you could not run is not a pass; report it with the reason.

The required fork CI dependency audit runs `pnpm run dependency-audit`. It retains raw JSON, stderr, the subprocess status, and a versioned classified report under `temp/dependency-audit/`, including on failure. Every production advisory needs an exact package, version, importer, resolved chain, advisory ID, and unexpired exception in `scripts/dependency-audit-exceptions.json`; registry errors and incomplete input fail the job and required aggregate. Before delivery, verify each exception's follow-up Issue remains open and renew its recorded source review when caller options or embedded code change.

CLI, Desktop, and Python categories describe resolved dependency membership, including optional platforms. Python deployment validation checks mandatory peers for the default profiles and checks shipped presets. The audit includes the launcher opt-in bundle paths. Shared findings can appear in several categories, so their counts are non-additive. Nonmember test-support, experimental runtime, and other tooling importers remain distinct. Membership does not establish exploitability or emitted bundle contents; imported APIs, input control, limits, and embedded implementations need separate evidence.

## Security and secrets

- Never commit credentials. Real-API tests read `DEEPSEEK_API_KEY` and the root `.env`; [AGENTS.md](../AGENTS.md#secrets--env) defines the policy.
- If a command fails because the sandbox blocks credentials, network, or IPC, retry it unchanged with the narrowest host escalation, and only with evidence of the sandbox block. Never bypass a test failure or the product sandbox.
- Change `vendor/` only through the sync procedure in [vendor/README.md](../vendor/README.md).
- Change the lockfile only in an Issue that changes dependencies, and review its diff.

## Commit and open the pull request

Stage explicit files, inspect the diff, and commit with a Conventional Commit message.

```sh
git status --short --branch
git diff --check
git add <explicit-files>
git diff --cached --check
git commit -m "<type>(<scope>): <description>"
git push -u origin HEAD
```

- Do not stage `.serena/`, scratch files, build output, or secrets.
- Push only the working branch, never the default branch. Use `--force-with-lease`, never raw `--force`, and only after a deliberate history rewrite with no remote movement.
- Open the PR with an explicit repository and base so it does not target the upstream:

```sh
gh pr create --repo takurot/deepseek-harness-xai --base master --head <branch> --title "<type>(<scope>): <description>" --body-file <file>
```

Write the description with [dsh-pr-description](../.agents/skills/dsh-pr-description/SKILL.md) and the [PR template](../.github/pull_request_template.md): Motivation with an Issue reference, Changes, Testing with its test design, and AI Usage. Use `Fixes #<number>` when the merge resolves the Issue and `Refs #<number>` when it only gives context. Split independent changes into separate PRs.

## Check fork CI

[Fork CI](../.github/workflows/fork-ci.yml) runs on pull requests and master pushes. The `all checks passed` result requires every Fork CI job to succeed, including `node 24 / static`, `node 24 / typecheck and lint`, `node 24 / dependency audit`, `node 24 / coverage`, `node 24 / snapshots and artifacts`, `node 24.9 / compatibility`, and `node 26 / compatibility`. Check the separate CI Python and Node Addon System workflows when the PR triggers them.

Use the run ID from the check's Actions link. Read the failed steps before rerunning failed jobs.

```sh
gh pr checks <number> --repo takurot/deepseek-harness-xai
gh run view <run-id> --repo takurot/deepseek-harness-xai
gh run view <run-id> --log-failed --repo takurot/deepseek-harness-xai
gh run rerun <run-id> --failed --repo takurot/deepseek-harness-xai
gh workflow list --all --repo takurot/deepseek-harness-xai
```

The coverage, artifact and compatibility jobs attach resource summaries and measurement artifacts. Read elapsed time and maximum resident memory per command, disk availability at each recorded stage, and the pnpm cache result. Record runner time from job start and completion timestamps.

The fork disables these upstream workflows in Actions settings. Use `gh workflow list --all` above to verify their live state.

| Purpose | Disabled workflows |
|---|---|
| Upstream checks | [`ci.yml`](../.github/workflows/ci.yml), [`ci-master.yml`](../.github/workflows/ci-master.yml), [`ci-windows.yml`](../.github/workflows/ci-windows.yml), [`sandbox.yml`](../.github/workflows/sandbox.yml) |
| Real API tests | [`e2e.yml`](../.github/workflows/e2e.yml), [`pi-ai-provider-e2e.yml`](../.github/workflows/pi-ai-provider-e2e.yml) |
| PR and Issue policy | [`expected-filenames.yml`](../.github/workflows/expected-filenames.yml), [`issue-lifecycle.yml`](../.github/workflows/issue-lifecycle.yml), [`issue-policy.yml`](../.github/workflows/issue-policy.yml), [`pr-check-after-approve.yml`](../.github/workflows/pr-check-after-approve.yml), [`pr-check-on-base-branch.yml`](../.github/workflows/pr-check-on-base-branch.yml), [`pr-check-on-head-branch.yml`](../.github/workflows/pr-check-on-head-branch.yml), [`weighted-approval-review-event.yml`](../.github/workflows/weighted-approval-review-event.yml), [`weighted-approval.yml`](../.github/workflows/weighted-approval.yml) |
| Preview and documentation | [`build-preview-cloudflare.yml`](../.github/workflows/build-preview-cloudflare.yml), [`docs-pages.yml`](../.github/workflows/docs-pages.yml) |
| Desktop and CUA packaging | [`cua-helper-package.yml`](../.github/workflows/cua-helper-package.yml), [`desktop-publish.yml`](../.github/workflows/desktop-publish.yml), [`macos-intel-package.yml`](../.github/workflows/macos-intel-package.yml), [`macos-package.yml`](../.github/workflows/macos-package.yml), [`windows-package.yml`](../.github/workflows/windows-package.yml) |
| Release and publishing | [`node-addon-system-release.yml`](../.github/workflows/node-addon-system-release.yml), [`publish-ssh-helper.yml`](../.github/workflows/publish-ssh-helper.yml), [`python-release.yml`](../.github/workflows/python-release.yml), [`release-publish.yml`](../.github/workflows/release-publish.yml), [`release-vendor-publish.yml`](../.github/workflows/release-vendor-publish.yml), [`release-vendor.yml`](../.github/workflows/release-vendor.yml), [`release.yml`](../.github/workflows/release.yml) |

## Review and completion

Review correctness and security separately, and verify each finding by reproducing it or tracing the code rather than accepting it by severity. Fix every valid High or higher finding before merge and add a regression test.

An Issue is complete when all of these hold:

- [ ] The acceptance conditions are met and the Issue's checklist is checked.
- [ ] A test failed before the change and passes after it, in the owning tier.
- [ ] The checks selected above ran and passed, and the PR lists them with any check that could not run.
- [ ] README, JSDoc, and paired documents match the behavior.
- [ ] Breaking changes have an upgrade guide, and persistence-type changes are acknowledged.
- [ ] CI is green on the PR.
