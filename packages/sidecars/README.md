# @aether/limbo-sidecars

Python sidecars for the aether-limbo overlay adapters.

These are **not** installed via pnpm. The Node host bootstraps a venv at
`~/.local/share/aether-limbo/venv` on first run (see PLAN.md §4.6) and pip-
installs the requirements in this package on demand.

This directory exists in the workspace so the layout matches the plan and so
linting/typing tools can pick it up — but pnpm treats it as a leaf with no
JS to build.
