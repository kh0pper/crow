# echo-bot templates

echo-bot is text-only by design — it echoes inbound emails as Gmail drafts
without rendering any PDFs. This directory exists to establish the
`~/crow/templates/<bot_id>/` convention from plan §7.5; it is intentionally
empty of template files.

When a bot needs Typst templates, drop them here as `*.typ` files and the
bot's tick handler invokes `typst compile ~/crow/templates/<bot_id>/foo.typ`.
