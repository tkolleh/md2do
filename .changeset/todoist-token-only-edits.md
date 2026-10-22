---
'@md2do/core': patch
'@md2do/cli': patch
---

Stop Todoist push and sync from deleting note content.

- Pushing a task to Todoist appended its id by rewriting the line from the stripped task text, which dropped the priority, assignee, tags, due date and link fragments. It now appends only the id token, and refuses to write if the line changed since it was scanned.
- Sync used the same rewrite when a task was deleted in Todoist. It now removes only that task's id token.
- The writer gains a mapLine option that rejects any edit other than adding or removing one id token, plus withSource and withoutSource helpers.
- The completion toggle now changes only the checkbox at the start of the line, so text such as "see - [x] foo" is never touched, and a task written with extra spaces after the dash can be toggled.
- Adding a task to a file that ends with a newline keeps that newline, and an empty file no longer starts with a blank line.
