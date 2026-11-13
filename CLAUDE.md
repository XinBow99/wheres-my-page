# Where's My Page?

Read docs/CONSTRAINTS.md before writing code. Do not weaken it to make a change pass.
Read docs/SPEC.md for architecture, module boundaries, and the messaging contract.
Architecture diagram: docs/architecture.drawio (open with draw.io / diagrams.net).
Plan and task list: docs/tasks/plan.md, docs/tasks/todo.md (the task list target for /plan and /build).

- Load the extension from `dist/` (run `npm ci && npm run build` first), not from the repo root.
- Root-level `*.js` files are the frozen v0.5.0 PoC: behavioral reference only, do not edit (docs/CONSTRAINTS.md exception W1).
