# Subagents in MODKH

The upstream pstack assumes Cursor: `Task`, `subagent_type`, per-role model slugs, cloud agents and `run_in_background`. MODKH exposes different tools, so this file is the binding version. Where a playbook names a model slug or a Task option that MODKH lacks, follow this file.

## Tools

- `list_subagents()` lists enabled roles. A role is data, not permission.
- `start_subagent({pluginId, task, context?, targetPaths?})` starts a role and returns a `runId` at once. The return does not mean the task is done.
- `list_subagent_runs()` shows your children, their state and the slot limit.
- `subagent_output({runId, waitMs?})` reads the result. It returns `running` unless you ask to wait. Wait only when no independent work is left; the cap is 60,000 ms.
- `cancel_subagent({runId})` stops one child and waits for its cleanup.
- `run_subagent` is the synchronous compatibility entry.

## Roles

- `modkh-explorer` reads and searches. It cannot edit, run shell commands or delegate.
- `modkh-worker` edits and runs commands, each behind the parent's approval. It owns the workspace while it writes, so only one writing child runs at a time.
- Language roles (`modkh-micro-*`) answer one observational question with one tool.
- `modkh-micro-zenki` checks a finite state model. Use it only for real state-transition claims.

`targetPaths` applies to edit-verify roles. For a general writing child, leave it out and let the child edit its own scope.

## Rules

- A child gets paths and a goal, never a pasted corpus.
- `completed` or `ok` is the end of a run, not proof of the task. Read the child's diff and output against the artifact yourself.
- The parent keeps its own independent work: different entry points, different files, running the example instead of re-reading the source a child already read.
- Never repeat the same assignment to two children. Split by files or by question.
- Cancel a child that is no longer needed. Do not leave it to finish for symmetry.
- A child has its own history and model. It does not inherit your conversation, so the task must stand alone.
- The parent reports. A child's summary is input, not the answer.

## Kickoff shape

```text
read_skill('pstack', 'references/worker.md') before anything else.
Goal: <the user's goal in one line>.
Scope: <files and symbols you may touch, or the exact question you answer>.
Bar: <the one check that decides success, and the command that runs it>.
Report: PASS, ISSUES or BLOCKED, the evidence, and what you did not verify.
```

## Models

The child model comes from the user's `subagents` setting for that plugin, or from the parent connection when none is set. A run cannot pick a child model, so treat every model-slug instruction in the upstream text as "use the configured role". When you need a second vendor's judgment and every role resolves to the parent connection, say the independent check did not run.
