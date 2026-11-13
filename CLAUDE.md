# Where's My Page?

Read CONSTRAINTS.md before writing code. Do not weaken it to make a change pass.
Read SPEC.md for architecture, module boundaries, and the messaging contract.

- Load the extension from `dist/` (run `npm ci && npm run build` first), not from the repo root.
- Root-level `*.js` files are the frozen v0.5.0 PoC: behavioral reference only, do not edit (CONSTRAINTS.md exception W1).
