# @fenfill/mcp

An [MCP](https://modelcontextprotocol.io) server that lets an AI agent turn a blank PDF form into a
filled one with [fenfill](https://fenfill.com).

**Fills happen on your machine; only blank forms and templates go to fenfill.** The agent's answers
are stamped into the PDF locally and are never sent to fenfill or anywhere else.

## How it works

1. **`analyze_form`** uploads the **blank** PDF to fenfill once. fenfill finds the fillable
   fields (text boxes, checkboxes, dates, character boxes, tables, signatures) and returns them
   with ids, types and labels. The result is cached on your machine, so asking again is free.
2. **`fill_form`** takes the agent's answers (`field id → value`), checks them against the
   fields, and stamps them into a new, flattened PDF. This step runs entirely on your machine,
   with no network at all.
3. Saved fenfill templates work the same way: `list_templates` → `get_template` → `fill_template`.
4. **`preview_page`** shows a page as an image with every field box outlined and tagged, rendered
   on your machine. If a box is misplaced, missing or mislabeled, **`edit_template`** fixes it in a
   local working copy that filling uses at once, and **`save_template`** keeps the fix in a saved
   template.
5. **`reanalyze_template`** re-runs fenfill on some pages of a saved template (a page that was
   never analyzed, or one that came out badly), from the blank PDF already stored with it.

### What is sent where

| Data                                               | Sent to fenfill?                                                             |
| -------------------------------------------------- | ---------------------------------------------------------------------------- |
| The blank PDF you analyze                          | Yes, once (then cached locally)                                              |
| Your API key                                       | Yes, as `Authorization: Bearer`                                              |
| The agent's answers, signatures and the filled PDF | **No, never**                                                                |
| Saved templates (blank PDF, fields, your logo)     | Downloaded from fenfill to fill locally                                      |
| Page previews (`preview_page`)                     | **No**: rendered on your machine                                             |
| Layout corrections (`edit_template`)               | Only on `save_template`, and then only the layout and the form's own wording |
| Re-analysis (`reanalyze_template`)                 | Only the template id, pages, kind and version: nothing is uploaded           |

`analyze_form` refuses PDFs whose form fields already hold answers, and PDFs this server wrote
itself, so a filled-in form isn't uploaded by mistake.

On fenfill's side, uploads are encrypted on arrival. Unless you save the form as a template, the
blank PDF is deleted when the analysis finishes. The analysis result is kept for at most 24 hours
after it completes, or 1 hour after it is first fetched, whichever comes first.

## Requirements

- Node.js 22 or newer (`npx` comes with it).
- A fenfill API key (`ff_live_…`): fenfill → Settings → API keys. The API is available on paid
  plans (Pro and up).
- Analyzing a form uses one page scan per analyzed page from your plan. Forms that already have
  native PDF form fields are read directly, with no AI, and use none. Repeat analyses of the same
  file come from the local cache. Filling never uses scans. `get_account` shows what's left.

## Setup

### Claude Code

```sh
claude mcp add fenfill --scope user -e FENFILL_API_KEY=ff_live_… -- npx -y @fenfill/mcp
```

### Claude Desktop

Edit `claude_desktop_config.json` (macOS:
`~/Library/Application Support/Claude/claude_desktop_config.json`, Windows:
`%APPDATA%\Claude\claude_desktop_config.json`), then restart Claude Desktop:

```json
{
  "mcpServers": {
    "fenfill": {
      "command": "npx",
      "args": ["-y", "@fenfill/mcp"],
      "env": { "FENFILL_API_KEY": "ff_live_…" }
    }
  }
}
```

### Cursor

Add the same `mcpServers` block to `~/.cursor/mcp.json` (all projects) or `.cursor/mcp.json` (one
project).

### Other MCP clients

Any client that can launch a stdio server works: run `npx -y @fenfill/mcp` with
`FENFILL_API_KEY` in its environment. The installed command is `fenfill-mcp`.

On native Windows, if the client can't find `npx`, use `"command": "cmd"` with
`"args": ["/c", "npx", "-y", "@fenfill/mcp"]`.

## Tools

| Tool                    | What it does                                                                    |
| ----------------------- | ------------------------------------------------------------------------------- |
| `analyze_form`          | Uploads a **blank** PDF once and returns its fields. Cached locally afterwards. |
| `fill_form`             | Fills an analyzed PDF locally, offline, and writes a new flattened PDF.         |
| `fill_template`         | Fills a saved fenfill template locally.                                         |
| `list_templates`        | Lists the workspace's saved templates, newest first.                            |
| `get_template`          | Shows a template's fields (use `pages` to narrow a large form).                 |
| `create_recipient_link` | Creates a personal fill link for one recipient of a restricted template.        |
| `get_recipient_status`  | Shows those links' status: `pending`, `opened` or `completed`.                  |
| `get_account`           | Shows the plan, page scans left and limits.                                     |
| `preview_page`          | Renders one page (PNG) with every field box outlined and tagged, locally.       |
| `edit_template`         | Moves, resizes, relabels, retypes, adds, deletes or regroups fields, locally.   |
| `save_template`         | Saves `edit_template`'s working copy to a saved template.                       |
| `reanalyze_template`    | Re-analyzes some pages of a saved template, with no upload, and shows the diff. |

`analyze_form` options: `pages` (e.g. `"1-3,5"`; long PDFs can be analyzed in chunks, and
`fill_form` merges them), `save_as_template` (also keep it as a fenfill template), `access`
(with `save_as_template`: `"public"`, the default, or `"restricted"`, which recipient links
need), `estimate` (price the request first: counts the pages and spots native form fields on
your machine, uploads nothing, and returns `page_count`, `likely_mode`, `estimated_scans` and
`scans_remaining`), `detect_extra_blanks` (for PDFs with native form fields: also find blanks
that have no native field, such as a signature or date line, at 1 page scan per analyzed page;
a free analysis answers `extra_blanks_available: true` when that is likely worth it), and `force`
(analyze again even if cached; uses scans again). If it answers `"running"`, call it again with
the same arguments. To correct the layout and keep the corrections, analyze with
`save_as_template: true` (edits on an unsaved analysis can be used for filling and previews but
can't be saved); a result without a template says so in `save_note`.

When fenfill refuses an upload for capacity (`rate_limited`, `too_many_active_jobs`,
`queue_full`), `analyze_form` waits the server's `retry_after` (plus a little jitter) and
uploads again by itself, up to about 60 s of waiting per call, then reports the error with
`waited_s`. These refusals happen before fenfill creates a job, so the retry never pays twice;
cancelling the call ends the wait. `too_many_active_jobs` counts every running analysis of the
workspace, free native-field (AcroForm) ones included.

`fill_form` and `fill_template` take `values`, `output_path` (a new `.pdf`) and optional
`overwrite`. They never overwrite the input PDF.

### Previews and corrections

`preview_page` takes `path` (an analyzed PDF) or `template_id`, a 1-based `page`, optional
`values` (to see them stamped; the same shapes as `fill_form`, e.g. `table_rows` =
`[{columnId: value}, …]`, `multiselect` = an array of option ids or labels) and `dpi` (default
110, max 200). It returns a PNG image plus a legend: each box's tag, id, type, label and `box`;
a text/date field's stored `format` and `font_pt` (the size its value starts at; `font_auto`
when that follows the box height); a choice's options with their own boxes; a table's cells by
`(row, col)`, its `orientation` and headers (also printed on the image inside, or beside, the
first cell of each line as `R: …` / `C: …`); a `table_rows` table's columns and printed cells
with their boxes (fill values still go by column id). `warnings` and `placement_warnings` are
always present (`[]` = checked and clean): placement covers every box shown, so a plain preview
is a read-only placement audit (see the checks under `edit_template`). `crop`
(`{x, y, w, h}`, fractions) with `zoom` (default 2, max 8) renders just a region, magnified, and
lists only what it shows; `legend: "changed"` returns only the rows that changed since your last
preview of that page (the first time: since fenfill's version), each with only its changed
options/cells/columns (`members_changed` counts them, so a header edit doesn't list the whole
grid), plus `removed` ids and `moved_into` (ids that now sit inside a table or group), and
`legend: "none"` omits the legend. It renders the local working copy (`edit_template`) when there is one, otherwise the saved
template or analyzed version; `edited: true` / `false` in the result says which. The page is rendered on your machine by
PDFium (WebAssembly, shipped in the package; nothing native is installed), nothing is written to
disk, and the image goes only to the calling client.

`edit_template` takes `path` or `template_id` and up to 200 `ops`:

- fields: `set_box` (absolute `{id, x, y, w, h}` in one step), `move`, `resize`, `relabel`,
  `retype`, `add`, `delete`, `set_format` (`date_format` is one of `DD/MM/YYYY`, `MM/DD/YYYY`,
  `YYYY-MM-DD`, `DD.MM.YYYY`, `DD-MM-YYYY`), `set_required`, `set_description`,
  `set_placeholder`, `set_autofill` (a browser autofill token such as `name` or `postal-code`,
  or `null` to clear it);
- choices and combs: `group` (`kind: "choice" | "comb"`), `ungroup`, `set_options`, and
  `add_option` / `remove_option`, which keep the group's id;
- tables: `group` with `kind: "table"` (a `cells` grid of field ids, rows × columns with `null`
  for a gap, or `ids` laid out from their boxes; `header_cols`, `header_rows`, `orientation`,
  `format`), `table_insert` / `table_delete` (a row or column; a new line's geometry is
  interpolated from its neighbours unless you pass it), `table_add_cell` (fill an empty slot),
  `table_adopt` (move a loose field into an empty slot), `set_column_type`, `set_orientation`
  and `set_header` / `set_headers` (`{id, axis, texts: [...], start?}`, several in one op). Every cell of one column (or row, for `orientation: "row"`) has one type,
  as in the web editor; `set_format` on a table cell applies to its whole column or row;
- order: `reorder {page, ids}` moves those top-level entries together, in that order, to where
  the first of them sat, and stamps an explicit `order` on every entry of the page (the web
  editor's layer-panel convention), so a later sub-pixel move no longer reshuffles questions.

Any id can be shortened to an unambiguous prefix of 6+ characters (the length of the preview
tags); an ambiguous prefix is rejected with the candidates. `add`, `move` and `set_box` take an
optional `snap`: `"underline"` fits the box onto the printed rule under it, `"cell"` into the
ruled box around it, `"answer"` into that cell's blank part (below a caption printed at its top,
or after one at its left), read from the page render on your machine; when nothing fits near the
box, the box is kept and a warning says so. Snap finds printed rules with its own simple line
finder (one ink threshold per page, not the web editor's wand): a very faint rule on a tinted
scan can be missed, and an underline box is one line of handwriting tall (as tall as the clear
space above the rule, within about 11–16 pt). `diff_summary.ops` lists every applied op with
`snapped: true/false` (when it asked for a snap) and `noop: true` when it changed nothing. After
each edit, the boxes you touched are checked for three placement problems: a value that would
print much larger than the page's other fields (an Auto box's text size follows its height), a
box over printed text (text layer only, so not on scans), and a box that runs a little past the
ruled cell it sits in (from the page render, so scans too). `set_format` merges into the stored
format (a date field keeps its date format when you only set `font_size`).
Coordinates are fractions of the page (0–1) with a top-left origin, the same as the legend's
`box`. Each op is checked against the rules fenfill applies when saving and is rejected with a
reason if it breaks them; ops apply in order, all-or-nothing each, except that a box only has to
lie on the page after the whole batch (so `move` then `resize` works even if the moved box
overhangs the page in between). `discard: true` drops the working copy. Labels, descriptions,
placeholders, options, date formats and checkbox symbols are the form's wording, never answers:
an op whose new wording matches an answer given to `fill_form`, `fill_template` or
`preview_page` in the same session is rejected before the working copy is written (wording that
contains an answer of 6+ characters, or equals one of 4–5; equal to a shorter one only warns).
Once a PDF is saved as a template, `fill_form` and `preview_page` on it use only that template's
working copy; an older copy of its unsaved analysis is dropped.

`save_template` sends the working copy of a saved template, together with the version it started
from: if the template changed in fenfill meanwhile, it answers `template_conflict` and keeps your
local edits. Before anything is sent, it refuses wording that matches an answer given to
`fill_form`, `fill_template` or `preview_page` in the same session (that list lives only in
memory). A working copy edited in an earlier session can't be checked against that session's
answers: `save_template` then answers `confirm_wording_needed` with the changed ids and
properties (never their text); review them and call again with `confirm_wording: true`. An
unsaved analysis can be edited for filling but not saved: to keep corrections,
analyze with `save_as_template: true` and edit that template. With nothing to save, it succeeds
with `saved: false, nothing_to_save: true`. `get_template` says `has_local_edits` (its fields
are fenfill's saved version; `preview_page` shows the working copy) and gives `field_count`
(entries listed) and `field_count_total` (the whole form); `save_template`'s `field_count` is
the whole saved template.

### Re-analyzing pages of a saved template

A template saved from only some pages (`analyze_form` with `pages` and `save_as_template`) has
pages fenfill never looked at: `get_template` lists them as `unanalyzed_pages`, and
`list_templates` shows `analyzed_pages` next to `page_count`. `reanalyze_template` takes
`template_id`, `pages` and a `kind`:

| `kind`          | Use it to                                                                         |
| --------------- | --------------------------------------------------------------------------------- |
| `scratch`       | analyze a never-analyzed page, or replace a badly analyzed page's fields entirely |
| `find`          | add blanks the first pass missed, keeping everything already there                |
| `relabel`       | re-derive labels, types, groups and sections, keeping the boxes                   |
| `label_missing` | fill in only the labels that are missing                                          |

`kind` can be left out only when the pages have no fields (it then means `scratch`). Each page
costs one page scan; `label_missing` is free within the workspace's monthly free-label
allowance. `estimate: true` prices the run and starts nothing. `relabel` may reset table column
types and orientation, so check the template with `get_template` afterwards.

It uses the PDF already stored with the template, so nothing is uploaded. It refuses while the
template has unsaved `edit_template` edits (`local_edits_pending`): save them with
`save_template` first, or pass `discard: true` to drop them when the run finishes. The result
lists, per changed page, the fields `added`, `removed` and `changed` (label, type, box, or a
group's cells), then the new fields of those pages; review them with `preview_page` and correct
them with `edit_template` + `save_template`. Like `analyze_form`, it waits out capacity
refusals, and if it answers `"running"`, calling it again with the same arguments follows the
same run at no extra charge.

### Value shapes

| Field type          | Value                                                                       |
| ------------------- | --------------------------------------------------------------------------- |
| `text`, `multiline` | string, stamped exactly as given                                            |
| `comb`              | string, one character per cell                                              |
| `date`              | `"YYYY-MM-DD"`, printed in the field's `date_format` (e.g. `DD/MM/YYYY`)    |
| `checkbox`          | `true` / `false`                                                            |
| `radio`             | option id, option label, or the bare option text (`"No"` for `"Smoke? No"`) |
| `multiselect`       | array of those                                                              |
| `table`             | `{ "<cellId>": value, … }`                                                  |
| `table_rows`        | `[{ "<columnId>": value, … }, …]`                                           |
| `signature`         | `{ "image_path": "/abs/path/signature.png" }` (PNG or JPG)                  |

A date the form asks for in a plain `text` field is not reformatted: write it the way the field's
label or placeholder asks (for example `10042026` for "mmddyyyy"). A `signature` whose
`signing_requirement` is `"external"` is signed outside fenfill (on paper, or with an e-signature
service), so it is left blank.

Unknown field ids (with did-you-mean suggestions), invalid options, comb values that don't fit
and malformed dates are reported back, so the agent can correct itself. Required fields left empty are listed as
warnings.

### Branding

`fill_form` output is never branded. `fill_template` applies the same branding as a fill in the
fenfill web app for that workspace (for example, your logo if you have set one up).

## Configuration

| Variable                       | Default                   | Notes                                                                        |
| ------------------------------ | ------------------------- | ---------------------------------------------------------------------------- |
| `FENFILL_API_KEY`              | (none)                    | `ff_live_…` from fenfill → Settings → API keys.                              |
| `FENFILL_API_URL`              | `https://api.fenfill.com` | https only (http allowed for localhost).                                     |
| `FENFILL_CACHE_DIR`            | the OS cache folder       | Holds schemas and blank forms only, never answers.                           |
| `FENFILL_ANALYZE_WAIT_SECONDS` | `50`                      | How long `analyze_form` / `reanalyze_template` wait before saying "running". |

`fill_form` works without an API key once a form has been analyzed.

## Files and privacy

- **The cache** (`FENFILL_CACHE_DIR`, by default `~/Library/Caches/fenfill-mcp` on macOS,
  `~/.cache/fenfill-mcp` on Linux, `%LOCALAPPDATA%\fenfill-mcp\Cache` on Windows; private to
  your user) holds form schemas, blank template PDFs, the workspace logo, sha256 hashes of the
  PDFs it produced and `edit_template`'s working copies, **never the answers you fill in**. A
  working copy holds the layout plus the wording the agent wrote with `edit_template`; the echo
  guard refuses wording that repeats an answer seen in the same session before it is written.
- **Cache cleanup:** at startup and at most once a day it deletes blank PDFs and the logo after
  1 hour, analyses and working copies unused for 90 days, stale job records after 48 hours, and
  output hashes after a year.
- **Filled PDFs** are written only where you ask, readable by your user only (mode 0600).
- **`overwrite: true`** replaces the target file with a new one: the old file's permissions and
  ACL are not kept, and other hard links to it keep the old content.
- **Recipient links** from `create_recipient_link` are working access links to the form: treat
  them as secrets and share them only with that recipient.
- **Logs** go to stderr and contain tool names, timings and error codes, never field values.

## Troubleshooting

| Error                                 | What to do                                                                                                                                                     |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `missing_api_key` / `invalid_api_key` | Set `FENFILL_API_KEY` in the client's config and restart the client.                                                                                           |
| `plan_required`                       | The workspace needs a paid plan (Pro and up).                                                                                                                  |
| `insufficient_scans`                  | Not enough page scans left; analyze fewer `pages` or check `get_account`.                                                                                      |
| `prefilled_form` / `filled_output`    | Only blank forms can be analyzed; use the original, empty PDF. If it is the blank form (some ship with default text in their fields), use the fenfill web app. |
| `pdf_password_required`               | Remove the open password first; owner-password PDFs work as they are.                                                                                          |
| `pdf_fill_forbidden`                  | The PDF's author forbids form filling; fenfill won't fill it. Use a copy that allows filling.                                                                  |
| `not_analyzed`                        | Run `analyze_form` on the same file (and pages) before `fill_form`.                                                                                            |
| `output_exists`                       | Pick a new `output_path` or pass `overwrite: true`.                                                                                                            |
| `rate_limited` / `queue_full`         | `analyze_form` already waited about a minute (`waited_s`); try again later.                                                                                    |
| `too_many_active_jobs`                | Other analyses in the workspace (free native-field ones too) are still running; try again in a minute, or analyze fewer at once.                               |
| `template_conflict`                   | The template changed in fenfill since your edits began. Your local edits are kept: `edit_template` with `discard: true`, re-apply the ops, save again.         |
| `invalid_schema`                      | fenfill (or the local check before it) refused the edited layout; `details` lists each item and reason. Fix them with `edit_template`.                         |
| `request_too_large`                   | The edited template is too large to save in one request.                                                                                                       |
| `answer_in_template`                  | Edited wording matches an answer from this session, so nothing was sent. Put the form's own wording back with `edit_template`.                                 |
| `confirm_wording_needed`              | The working copy has wording edited in an earlier session. Review the ids and properties in `changed`, then `save_template` with `confirm_wording: true`.      |
| `local_edits_pending`                 | `reanalyze_template` won't run over unsaved edits: `save_template` them first, or pass `discard: true`.                                                        |
| `kind_required`                       | The pages already have fields: pass `kind` (`find`, `relabel`, `label_missing`, or `scratch` to replace them).                                                 |
| `job_in_progress`                     | A job is already running on the template; wait and retry (call `reanalyze_template` again with the same arguments if you started it).                          |
| `upload_outcome_unknown`              | An earlier upload was interrupted. To avoid charging twice, the same file isn't re-uploaded for about 10 minutes; check `get_account` meanwhile.               |

## API

The server wraps fenfill's REST API: reference at
[api.fenfill.com/v1/docs](https://api.fenfill.com/v1/docs), OpenAPI spec at
[api.fenfill.com/v1/openapi.json](https://api.fenfill.com/v1/openapi.json). Fill values are never
sent to any endpoint; the API has no field for them.

## Verify this package

- Releases are built and published by GitHub Actions from
  [github.com/fenfill/mcp](https://github.com/fenfill/mcp) with
  [npm provenance](https://docs.npmjs.com/generating-provenance-statements): the npm page links
  each version to the exact commit and workflow run that built it.
- `npm audit signatures` in a project that installs `@fenfill/mcp` checks the registry signature
  and the provenance attestation.
- The bundle (`dist/index.js`) is not minified, so what runs on your machine can be read.
  `dist/pdfium.wasm` is the unmodified PDFium build from `@embedpdf/pdfium` (see
  `THIRD_PARTY_NOTICES`), loaded only by `preview_page`.

## Security

Report vulnerabilities to [security@fenfill.com](mailto:security@fenfill.com) (or through GitHub
private vulnerability reporting on the repository), not in public issues.

## License

MIT: see `LICENSE`. Bundled third-party software: see `THIRD_PARTY_NOTICES` and `licenses/`.
