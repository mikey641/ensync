# Claude Code context

The canonical project context is `.ensync/project.md` plus `.ensync/architecture.md`. Load only the relevant `.ensync/features/*.md` files for the current task.

Do not duplicate durable facts here. This file is a thin provider adapter so Claude Code, Codex, and other agents use the same feature structure.
