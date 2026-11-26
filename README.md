# pstack for Dim

Loads [pstack](https://github.com/cursor/plugins/tree/main/pstack) into Dim as
skills and keeps them on the latest version of `cursor/plugins`.

pstack's skills are operator-invoked (`disable-model-invocation: true`), so Dim
lists `setup-pstack` and the plugin's own `pstack` entry skill to the model and
leaves the rest to `/skill:<name>` — the same `/poteto-mode` workflow pstack
documents for Cursor. A skill the operator starts reads the other skill files
from the cache by their relative paths. The three vendored `cursor-team-kit`
skills keep their upstream frontmatter, so `deslop`, `control-ui` and
`control-cli` also reach the model directly.

## Install

```bash
npm install                                   # @arcships/rutis, the SDK Dim runs
plugin install /absolute/path/to/dim-pstack   # or plugin install <git-url>
```

Dim loads the directory in place. `plugin list` shows `pstack`; the
`pstack_status` and `pstack_update` tools appear from the next model request,
and the skills from the next Session.

## The Dim adapter

The plugin writes an adapted copy of each installed version at
`<sha>/dim/` and registers that, not the upstream tree:

- `DIM-ADAPTER.md` maps the names pstack's skills use to Dim's tools, agents,
  models and paths — `Task` → the `agent` tool, `AskQuestion` → `ask_user`,
  `Read`/`Grep`/`Bash` → `read`/`grep`/`exec`, Cursor model slugs →
  `agent({ action: 'models' })` pairs, and Cursor-only steps (Automations,
  Bugbot, cloud agents) → skipped with one line.
- The `deslop`, `control-ui` and `control-cli` skills from Cursor's
  `cursor-team-kit` plugin are vendored into the adapted copy, and the adapter
  maps each to Dim's own tools: `exec` and `edit` for `deslop`,
  `agent-browser` for `control-ui`, and `exec` with tmux or a PTY for
  `control-cli`. poteto-mode's references to `/deslop` and the control skills
  therefore run in Dim; they are no longer skipped.
- Every upstream `SKILL.md` gets one pointer line after its frontmatter: read
  `DIM-ADAPTER.md` once per session first.
- A model-invocable `pstack` skill is added as the entry point; it names the
  adapted root, `poteto-mode` and the adapter.
- `setup-pstack`'s model choices go to `~/.cache/dim-pstack/models.md` instead
  of a Cursor rule file.

The adapter runs on every load and after every install, so it follows upstream
updates; raise `ADAPTER` in `index.ts` to rebuild copies that already exist.

## Vendored cursor-team-kit skills

pstack's poteto-mode names `deslop`, `control-ui` and `control-cli` from the
`cursor-team-kit` plugin, which Dim does not load. All three are Markdown with
no Cursor tool of their own, so the plugin fetches that directory too and
copies the three skills into the adapted copy at `skills/<name>/`. They load
like pstack's skills, and their MIT license travels with them as
`CURSOR-TEAM-KIT-LICENSE`.

The adapter still maps each step to the Dim tool that does the job better:

| Step | Dim |
| --- | --- |
| `/deslop` | `exec` for `git diff`, `edit` for the hunks; `no-comments` for the comment pass. |
| `control-ui` | the `agent-browser` CLI over CDP, including its Electron mode. |
| `control-cli` | `exec` with tmux or a PTY script; `kero` when running inside Kero. |

A repository without `cursor-team-kit` still installs pstack. The adapter then
falls back to plain-word instructions for the same outcomes.

## How it works

- On load the plugin serves the cached copy at once (offline starts keep their
  skills), then checks `cursor/plugins` at the configured ref with
  `git ls-remote`.
- When the ref moved, it sparse-clones the `pstack/` directory and the
  `cursor-team-kit/` directory (`git clone --blob:none --sparse`) into
  `${XDG_CACHE_HOME:-~/.cache}/dim-pstack/versions/<sha>/`, builds the adapted
  copy, and registers `<sha>/dim/skills` through Dim's `skillsCatalog`; older
  versions are pruned.
- On a first install there is no cache, so the install runs before the first
  Session starts. Later checks run in the background every `intervalHours`.
- A failed check keeps the installed copy and reports the error through
  `pstack_status`; a failed adapter keeps the upstream skills usable.

Requirements: `git` on `PATH`, network access to GitHub, and Dim 0.23-era
`skillsCatalog`/`partRegistry` services.

## Settings

`plugin config pstack` shows the document and `plugin config pstack set <key>
<value>` changes one. Changes apply on the next reload.

| key | default | meaning |
| --- | --- | --- |
| `repo` | `https://github.com/cursor/plugins` | repository to track |
| `ref` | `main` | branch, tag or full commit sha; a sha pins until changed |
| `subdir` | `pstack` | the plugin directory inside the repository |
| `intervalHours` | `6` | hours between checks; `0` turns the periodic check off (startup still checks) |

## Tools

- `pstack_status` — version, commit, cache root, the adapted skills root,
  adapter version, registered skill count and catalog issues, last check, next
  check, last error.
- `pstack_update` — check and install now; returns the same report.

## Layout

```
dim-plugin.json     manifest (code plugin)
index.ts            sync, registration and the two tools
package.json        @arcships/rutis 0.23.0
```