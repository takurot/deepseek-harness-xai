# Agent Note: Bundle pstack as a dsh skill distribution?

Status: rejected — pstack stays a user-supplied `customSkillDirs` pack; bundling would ship a third-party workflow the harness cannot keep compatible

English | [中文](2026-11-04-pstack-bundle-decision.zh.md)

## Problem

[pstack](https://github.com/cursor/plugins/tree/c742dd6170/pstack) v0.15.36 (commit `c742dd6170`) is a third-party skill pack (MIT, 58 skills, 2 Claude Code agent files) that many users already run in Claude Code. dsh loads compatible `SKILL.md` directories, so the question is whether dsh should ship pstack as a bundle: install it as an official or experimental package so a profile gets the whole pack, or leave it to each user's own skill roots.

Bundling is not just a packaging choice. The pack encodes a workflow — `poteto-mode`, `/setup-pstack`, model-route rules, and subagent delegation through pstack's `Task` tool — that the harness would then own: its upstream tracking, its license notices, its instruction conflicts with the shipped `dsh-*` skills and `AGENTS.md`, and its compatibility with dsh's own [`subagent`](../../../../packages/subagent/subagent/README.md) seam. Nothing in the shipped harness currently promises any of that.

## Proposal

Ship `packages/experimental/pstack-bundle` with a `dsh.bundle.patch` that mounts `skill-filesystem` over a vendored copy of pstack's `skills/` directory, plus a README, an experimental package classification, licence notices, and snapshot coverage. Under that proposal a user installing the bundle would get every pstack skill without configuring a root, and the harness would accept responsibility for keeping the pack working as pstack and dsh both change.

## Verification

The pack was mounted through an overlay that pointed `skill-filesystem`'s `customSkillDirs` at the pstack `skills` directory, then driven with a real model through the shipped headless profile.

| Question | Result |
|---|---|
| Frontmatter compatibility | All 58 skills carry `name`/`description` with the name matching the directory; no violations. Undeclared keys (`icon`, `color`, `paths`) load without error. |
| Root composition | `--dump-config` shows `customSkillDirs` reaching `skill-filesystem`; loading and composition complete without error. |
| Slash invocation | `/poteto-help` loads the body and follows its relative `../poteto-mode/SKILL.md` reference. |
| Model invocation through the `skill` tool | Not available by design: 57 of 58 skills declare `disable-model-invocation: true`, which removes them from the model catalog and the `skill` tool; the `/name` gesture is their only entry point. |
| Subagent delegation | Not verified. The skills reference pstack's `Task` throughout, which its Claude Code adapter maps to that harness's `Agent` tool; dsh delegates through the separate [`tool-subagent`](../../../../packages/subagent/tool-subagent/README.md) seam with its own parameters. |
| Agent files | Not loaded: `agents/poteto-agent.md` and `comment-sicko.md` are Claude Code agent definitions, which dsh does not read. |
| Model-route mapping | Unsupported: `/setup-pstack` writes `~/.claude/rules/pstack-models.md` through its Claude Code adapter and `~/.cursor/rules/pstack-models.mdc` natively; dsh reads neither. |
| Workflow execution | Not verified: `/poteto-mode` was never run on a real task, and `/why` (MCP) was never exercised. |

`skill-filesystem` scans the project roots, `customSkillDirs`, `$DSH_HOME/skills`, and `$DSH_AGENTS_HOME/skills` (default `~/.agents/skills`) in [rank order](../../../../packages/skill/skill-filesystem/README.md), plus an optional bundled root at rank 600; `~/.claude/skills` is not a default root (pointing `customSkillDirs` at it is a user choice). The `setup-pstack` entry observed on 2026-11-04 therefore came from the overlay's own `customSkillDirs` mount. Users who converted pstack into `~/.agents/skills` do get it through the default `user-agents` root.

## Alternatives considered

### Bundle it as an experimental package

**Given up:** upstream tracking of a fast-moving third-party workflow (the pack is 58 skills and 2 agent definitions on someone else's release cadence), `THIRD_PARTY_NOTICES` maintenance for MIT-licensed source copied into the repository, and a compatibility obligation for constructs dsh does not implement (pstack's `Task` parameters, its `~/.claude`/`~/.cursor` model-route files, agent-definition files). **Gained:** zero-configuration availability. Against that, the parts that make pstack a workflow — subagent delegation and model-route setup — are exactly the parts this harness cannot honour, so the bundle would ship a workflow whose delegation and model-route steps still assume another harness. The [experimental](../../../../packages/experimental/README.md) and [official on-demand bundle](../../../../.agents/notes/implemented/architecture/2026-10-05-official-on-demand-bundles.md) decisions define the classification the proposal would have had to satisfy.

### Bundle a compatibility shim instead (translate `Task`, read `~/.claude/rules`)

**Given up:** the same upstream-tracking burden, plus a translation layer between two delegation vocabularies that must track both sides. **Gained:** a working pstack workflow. This is a larger product decision than pstack: it would make Claude Code's agent conventions a supported input format for dsh, which conflicts with the [`subagent`](../../../../packages/subagent/subagent/README.md) seam's single delegation contract and with keeping third-party formats out of the product surface.

### Ship nothing and let users set `customSkillDirs` (chosen)

**Given up:** no zero-configuration install, no guarantee the skill bodies keep working as dsh's tools change, and no harness-side upgrade path for the pack. **Gained:** the harness ships no third-party workflow it cannot keep compatible, pstack's release cadence stays pstack's, MIT notices stay with the user's own copy, and the slash-invocation and relative-reference behaviour that does work keeps working without harness code. Duplicate names resolve by root [rank](../../../../packages/skill/skill-filesystem/README.md) (lower wins): the project roots at 100 and 200 outrank `customSkillDirs` at 300, so a project-local skill overrides the pack; `$DSH_HOME/skills` (400) and `$DSH_AGENTS_HOME/skills` (500) rank below it.

## Consequences

- pstack is operated, not shipped: add the pack's `skills` directory to `skill-filesystem`'s `customSkillDirs` (the narrowest option), or place (or symlink) each of its skill directories directly under a default root such as `$DSH_AGENTS_HOME/skills`, because discovery is one level deep. `customSkillDirs` is the narrower choice when the pack should stay replaceable and out of the user's shared agent root.
- Only the slash-invocation path is supported for the 57 workflow skills that declare `disable-model-invocation: true`; the remaining skill (`setup-pstack`) stays model-invocable. A deployment that wants model invocation must edit the pack, and accepts that its bodies still assume another harness's tools.
- Subagent delegation, model-route mapping, and Claude Code agent files remain unconverted. A `Task` call has no matching dsh tool and fails as an unknown tool; the model-route mapping is never applied, and agent-definition files are never loaded, so neither produces a diagnostic.
- Reconsider bundling when the workflow itself becomes portable: dsh's [`tool-subagent`](../../../../packages/subagent/tool-subagent/README.md) accepts a `Task`-shaped call, or pstack ships a dsh-compatible delegation mode, and there is a named owner for upstream tracking. A licence review of the copied source and a snapshot scenario would then be part of the same change.
