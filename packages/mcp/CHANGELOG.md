# Changelog

## 0.2.7

### Added

- `make_fillable`: turns one of your saved templates into a blank fillable PDF, the original form
  with a real form field on every blank, so it fills in any PDF reader. Only the template id is
  sent and the fields stay empty: it takes no values. Needs the Team plan or above.
- `make_fillable`: when fenfill couldn't place some of the template's fields (a page outside the
  PDF or a broken box), the result says so with `skipped_fields` (the count) and a `skipped_note`
  on how to fix them. It reads the new `X-Fenfill-Skipped-Fields` response header of
  `POST /v1/forms/acroform`.

### Changed

- `fill_template`: number and currency fields now default to middle-right alignment, as in the web
  app. A field with its own alignment keeps it.
- `fill_template`: neighbouring Auto-size boxes of nearly one height (a stack, a row, or two cells
  of a table) now start at one shared size, so their text matches instead of each box picking its
  own.

### Fixed

- Tables whose rows put two cells into one column (a narrow No. or tick column beside wide ones)
  no longer lose a cell when their grid is rebuilt; the grid now matches the one fenfill builds.

## 0.2.6

### Security

- Dependency updates for published advisories: `@modelcontextprotocol/sdk` 1.32.2, `zod` 4.6.7,
  and through them `body-parser` 2.4.0 and `qs` 6.17.1. fenfill-mcp talks to your agent over
  stdio only, so the SDK's HTTP-transport and server-auth advisories did not reach it; the zod
  fix (memory exhaustion on oversized collections) does apply to its in-process validation.

### Fixed

- Templates whose stored tables claim absurd row or column counts are clamped on load (to 1000),
  so a malformed template can no longer stall filling, previewing or editing.

## 0.2.5

### Added

- `analyze_form`: `confirm_blank: true`, for annotations or XFA form data that belong to the blank
  form itself (printed notes, sample text, default values). Pass it only after a `prefilled_form`
  refusal about them and once the user confirms they are not answers; it never lifts the check on
  filled-in form fields.
- Every PDF fenfill fills now carries a `FenfillOutput` tag, including the web app's flattened
  downloads, so a filled copy is recognised wherever it ends up.

### Fixed

- `analyze_form` refuses PDFs fenfill already filled (in the web app or by `fill_form`) with
  `filled_output`, instead of treating a flattened web download as a blank form.
- `analyze_form` refuses PDFs with answers added outside the form fields (text, ink or stamps
  from Preview or Acrobat Fill & Sign) or filled-in XFA form data, with `prefilled_form`; the
  refusal says what it found (`details.found`). Markup and XFA defaults that ship with the blank
  form are not counted.
- `edit_template`: concurrent calls no longer lose edits. Calls on one form in the same process run
  one after another (as do `save_template` calls); when another fenfill-mcp process changes the
  form's edits mid-call, nothing is applied and `edit_conflict` asks you to call again with the
  same ops.
- `fill_form` and `preview_page` on rotated pages (`/Rotate` 90/180/270) or pages whose crop box
  does not start at the corner: values, check-copy outlines and id tags land where they belong
  and print upright, instead of transposed, shifted or sideways.

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
