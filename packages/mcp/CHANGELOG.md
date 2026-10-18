# Changelog

## 0.2.4

### Added

- **Japanese printing.** Values with kana, kanji, CJK punctuation or symbols such as ⑪ and 〈〉
  now print, in Noto Sans JP. The font (about 5.8 MB) is not in the package: the first value that
  needs it downloads `https://fenfill.com/fonts/NotoSansJP-Regular.ttf` once (a plain GET with a
  `fenfill-mcp/<version>` User-Agent, no auth, no form data), checks it against a pinned sha256
  and keeps it in `<cache>/fonts/`, where it is never aged out. After that it works offline;
  to pre-seed an offline machine, copy the file there. Latin-only fills never touch the network.
  If the font cannot be loaded, `unsupported_script` is returned with `details.reason`
  (`network`, `http_status`, `hash_mismatch`, `timeout`, `too_large`) instead of printing
  empty boxes. Line breaking follows Japanese rules (no spaces needed, basic kinsoku).
- **Hebrew and Arabic printing**, right to left (Arabic joined), including the headers of
  `preview_page` check copies, which now read right to left with "…" where a header is cut.

### Fixed

- `edit_template`: `set_options` follows the ids of a group op made earlier in the same call and
  echoes the resulting `[{id, label}]` mapping; plain labels no longer swap silently
  (warning `options_order_differs_from_reading_order`). The fallback stays reading order after
  an `add_option` in the same batch.
- `edit_template`: a table op is refused only for problems it adds itself, so a stored table
  with mixed column types can be fixed one column at a time; a column insert or delete no longer
  makes the stored mixed lines look new (matched by their cells, not their index).
- Glyphs only the Japanese face draws (⑪, ⑴, ⓐ, 〈…) are routed to it; padding fixes for the
  subset; an ideographic space and ％ ℃ ° ￥ ＄ wrap correctly.
