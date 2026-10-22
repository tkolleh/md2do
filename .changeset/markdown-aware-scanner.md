---
'@md2do/core': minor
'@md2do/cli': patch
---

Make the scanner Markdown-aware.

- Tasks inside fenced code blocks are no longer returned, and raise no warnings.
- Text inside links, images, wiki-links and embeds is no longer read as metadata. Heading fragments, exclamation marks in link titles, mailto addresses and URL fragments stop producing phantom tags, priorities and assignees, and the display text keeps the link intact.
- Numeric references such as #2920 are not tags and stay in the task text.
- Tasks gain optional description (the indented lines beneath them) and parent (the id of the enclosing task) fields.
