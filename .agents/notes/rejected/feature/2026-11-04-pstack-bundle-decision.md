# Agent Note: Bundle pstack as a dsh skill distribution?

Status: rejected — pstack stays a user-supplied `customSkillDirs` pack; bundling would ship a third-party workflow the harness cannot keep compatible

English | [中文](2026-11-04-pstack-bundle-decision.zh.md)

## Problem

[pstack](https://github.com/cursor/plugins/tree/main/pstack) is a third-party skill pack (MIT, 58 skills, 2 Claude Code agent files) that many users already run in Claude Code. dsh loads compatible `SKILL.md` directories, so the question is whether dsh should ship pstack as a bundle: install it as an official or experimental package so a profile gets the whole pack, or leave it to each user's own skill roots.

Bundling is not just a packaging choice. The pack encodes a workflow — `poteto-mode`, `/setup-pstack`, model-route rules, and subagent delegation through Claude Code's `Task` tool — that the harness would then own: its upstream tracking, its license notices, its instruction conflicts with the shipped `dsh-*` skills and `AGENTS.md`, and its compatibility with dsh's own [`subagent`](../../../../packages/subagent/subagent/README.md) seam. Nothing in the shipped harness currently promises any of that.

## Proposal

Ship `packages/experimental/pstack-bundle` with a `dsh.bundle.patch` that mounts `skill-filesystem` over a vendored copy of pstack's `skills/` directory, plus a README, an experimental package classification, licence notices, and snapshot coverage. Under that proposal a user installing the bundle would get every pstack skill without configuring a root, and the harness would accept responsibility for keeping the pack working as pstack and dsh both change.

## Verification (what was established, 2026-11-04)

The pack was mounted through an overlay that pointed `skill-filesystem`'s `customSkillDirs` at the pstack `skills` directory, then driven with a real model through the shipped headless profile.

| Question | Result |
|---|---|
| Frontmatter compatibility | All 58 skills carry `name`/`description` with the name matching the directory; no violations. Undeclared keys (`icon`, `color`, `paths`) load without error. |
| Root composition | `--dump-config` shows `customSkillDirs` reaching `skill-filesystem`; loading and composition complete without error. |
| Slash invocation | `/poteto-help` loads the body and follows its relative `../poteto-mode/SKILL.md` reference. |
| Model invocation through the `skill` tool | Not available by design: 57 of 58 skills declare `disable-model-invocation: true`, so the model catalog exposes them as slash-only entries. |
| Subagent delegation | Not verified. The skills reference Claude Code's `Task` 26 times; dsh delegates through the separate [`tool-subagent`](../../../../packages/subagent/tool-subagent/README.md) seam with its own parameters. |
| Agent files | Not loaded: `agents/poteto-agent.md` and `comment-sicko.md` are Claude Code agent definitions, which dsh does not read. |
| Model-route mapping | Unsupported: `/setup-pstack` writes `~/.claude/rules/pstack-models.md`, which dsh does not read. |

The correction worth recording: the original investigation attributed the visible `setup-pstack` entry to dsh scanning `~/.claude/skills`. It does not. `skill-filesystem` scans the project roots, `customSkillDirs`, `$DSH_HOME/skills`, and `$DSH_AGENTS_HOME/skills` (default `~/.agents/skills`) in [rank order](../../../../packages/skill/skill-filesystem/README.md); `~/.claude/skills` is not a default root, and the entry came from the overlay's own `customSkillDirs` mount. Users who converted pstack into `~/.agents/skills` do get it through the default `user-agents` root.

## Alternatives considered

### Bundle it as an experimental package

**Given up:** upstream tracking of a fast-moving third-party workflow (the pack is 58 skills and 2 agent definitions on someone else's release cadence), `THIRD_PARTY_NOTICES` maintenance for MIT-licensed source copied into the repository, and a compatibility obligation for constructs dsh does not implement (Claude Code `Task` parameters, `~/.claude/rules` model mapping, agent-definition files). **Gained:** zero-configuration availability. Against that, the parts that make pstack a workflow — subagent delegation and model-route setup — are exactly the parts this harness cannot honour, so the bundle would ship a workflow with two broken halves and call it supported.

### Bundle a compatibility shim instead (translate `Task`, read `~/.claude/rules`)

**Given up:** the same upstream-tracking burden, plus a translation layer between two delegation vocabularies that must track both sides. **Gained:** a working pstack workflow. This is a larger product decision than pstack: it would make Claude Code's agent conventions a supported input format for dsh, which conflicts with the [`subagent`](../../../../packages/subagent/subagent/README.md) seam's single delegation contract and with keeping third-party formats out of the product surface.

### Ship nothing and let users set `customSkillDirs` (chosen)

**Given up:** no zero-configuration install, no guarantee the skill bodies keep working as dsh's tools change, and no harness-side upgrade path for the pack. **Gained:** the harness ships no third-party workflow it cannot keep compatible, pstack's release cadence stays pstack's, MIT notices stay with the user's own copy, and the slash-invocation and relative-reference behaviour that does work keeps working without harness code. Duplicate names resolve deterministically by root rank (lower rank wins), so a user can override any pstack skill from the project or DSH roots.

## Consequences

- pstack is operated, not shipped: add the pack's `skills` directory to `skill-filesystem`'s `customSkillDirs`, or convert it into a default root such as `$DSH_AGENTS_HOME/skills`. `customSkillDirs` is the narrower choice when the pack should stay replaceable and out of the user's shared agent root.
- Only the slash-invocation path is supported by the pack's own declarations; model-catalog discovery stays disabled for the 57 skills that opt out. A deployment that wants model invocation must edit the pack, and accepts that its bodies still assume Claude Code's tools.
- Subagent delegation, model-route mapping, and Claude Code agent files remain unconverted. A task that needs them fails at the tool call, not silently.
- Reconsider bundling when the workflow itself becomes portable: dsh's [`tool-subagent`](../../../../packages/subagent/tool-subagent/README.md) accepts a `Task`-shaped call, or pstack ships a dsh-compatible delegation mode, and there is a named owner for upstream tracking. A licence review of the copied source and a snapshot scenario would then be part of the same change.
