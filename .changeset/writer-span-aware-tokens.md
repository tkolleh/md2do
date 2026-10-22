---
'@md2do/core': patch
'@md2do/cli': patch
---

Ignore id tokens inside links and wiki-links when editing note lines.

- The scanner already treats links, images, reference links, wiki-links and embeds as opaque, but the writer's id-token helpers matched tokens anywhere on the line. An id inside a link destination could be removed, or counted as already present, even though the scanner never saw it.
- The writer now passes the scanner's protected ranges for the line to mapLine as a second argument. withSource, withoutSource, addSourceIfUnchanged and removeSourceIfPresent take them as an optional argument and skip tokens inside them, and the mapLine guard rejects any edit that adds or removes such a token.
- The second argument is optional, so existing transforms keep working. Inline code is not affected.
