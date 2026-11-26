// Loads pstack (https://github.com/cursor/plugins) into Dim as skills.
//
// Dim registers skills from a root directory through the process
// `skillsCatalog` service. pstack ships 60+ skills plus the scripts, playbooks
// and references they read, so this plugin keeps a copy of the repository's
// `pstack/` directory in a cache, sparse-cloned from cursor/plugins, and
// re-registers it whenever the tracked ref moves. The cached copy is served at
// once on load, so an offline start still has the skills.

import { definePlugin } from '@arcships/rutis'
import { execFile } from 'node:child_process'
import { access, cp, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'

const NAME = 'pstack'
const KEY = 'pstack'
const ADAPTER = 1

const DEFAULTS = {
  repo: 'https://github.com/cursor/plugins',
  ref: 'main',
  subdir: 'pstack',
  intervalHours: 6,
}

type Options = {
  repo: string
  ref: string
  subdir: string
  intervalHours: number
}

type Installed = {
  sha: string
  version: string
  root: string
  at: string
}

const state = {
  installed: undefined as Installed | undefined,
  adapted: undefined as string | undefined,
  adapter: 0,
  registered: false,
  registeredRoot: undefined as string | undefined,
  checkedAt: '',
  nextCheckAt: '',
  lastError: '',
  update: undefined as Promise<Installed | undefined> | undefined,
  timer: undefined as ReturnType<typeof setTimeout> | undefined,
  cache: cacheRoot(),
  ctx: undefined as unknown,
}

function cacheRoot(): string {
  const base = process.env.XDG_CACHE_HOME?.trim() || path.join(homedir(), '.cache')
  return path.join(base, 'dim-pstack')
}

function stateFile(): string {
  return path.join(state.cache, 'state.json')
}

function versionDir(sha: string): string {
  return path.join(state.cache, 'versions', sha)
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function git(args: string[], timeout: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      {
        timeout,
        maxBuffer: 64 * 1024 * 1024,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      },
      (error, stdout, stderr) => {
        if (error) {
          const detail = (stderr || error.message).trim()
          reject(new Error(`git ${args[0]} failed: ${detail}`))
        } else {
          resolve(stdout)
        }
      },
    )
  })
}

async function exists(target: string): Promise<boolean> {
  try {
    await access(target)
    return true
  } catch {
    return false
  }
}

async function optionsOf(ctx: any): Promise<Options> {
  const read = await ctx.use('settings').read({ source: NAME, scope: 'user' })
  const document = read?.ok ? read.value.document : {}
  const text = (name: string, fallback: string) =>
    typeof document?.[name] === 'string' && document[name].trim() ? document[name].trim() : fallback
  const hours = document?.intervalHours
  return {
    repo: text('repo', DEFAULTS.repo),
    ref: text('ref', DEFAULTS.ref),
    subdir: text('subdir', DEFAULTS.subdir),
    intervalHours: typeof hours === 'number' && hours >= 0 ? hours : DEFAULTS.intervalHours,
  }
}

const SHA = /^[0-9a-f]{40}$/i

async function remoteSha(options: Options): Promise<string> {
  if (SHA.test(options.ref)) return options.ref
  const out = await git(
    ['ls-remote', options.repo, `refs/heads/${options.ref}`, `refs/tags/${options.ref}^{}`],
    60_000,
  )
  const lines = out.split('\n').filter(Boolean)
  const head = lines.find((line) => line.endsWith(`refs/heads/${options.ref}`))
  const tag = lines.find((line) => line.endsWith(`refs/tags/${options.ref}^{}`))
  const sha = (head ?? tag ?? '').split('\t')[0]
  if (!sha) throw new Error(`no ref ${options.ref} in ${options.repo}`)
  return sha
}

async function pluginVersion(root: string): Promise<string> {
  try {
    const text = await readFile(path.join(root, 'plugin.json'), 'utf8')
    const document = JSON.parse(text)
    return typeof document.version === 'string' ? document.version : 'unknown'
  } catch {
    return 'unknown'
  }
}

async function install(options: Options): Promise<Installed> {
  await mkdir(path.join(state.cache, 'versions'), { recursive: true })
  const tmp = path.join(state.cache, `tmp-${process.pid}-${Date.now()}`)
  try {
    if (SHA.test(options.ref)) {
      // A pinned commit: the default branch is shallow, then the commit fetched.
      await git(
        ['clone', '--depth=1', '--filter=blob:none', '--sparse', '--no-checkout', options.repo, tmp],
        300_000,
      )
      await git(['-C', tmp, 'fetch', '--depth=1', 'origin', options.ref], 300_000)
      await git(['-C', tmp, 'sparse-checkout', 'set', '--cone', options.subdir], 120_000)
      await git(['-C', tmp, 'checkout', '--detach', options.ref], 120_000)
    } else {
      await git(
        [
          'clone',
          '--depth=1',
          '--filter=blob:none',
          '--sparse',
          '--branch',
          options.ref,
          options.repo,
          tmp,
        ],
        300_000,
      )
      await git(['-C', tmp, 'sparse-checkout', 'set', '--cone', options.subdir], 120_000)
    }
    const sha = (await git(['-C', tmp, 'rev-parse', 'HEAD'], 30_000)).trim()
    const source = path.join(tmp, options.subdir)
    if (!(await exists(source))) throw new Error(`${options.subdir} is not in ${options.repo}@${options.ref}`)

    const target = path.join(versionDir(sha), options.subdir)
    await rm(versionDir(sha), { recursive: true, force: true })
    await mkdir(path.dirname(target), { recursive: true })
    await rename(source, target)

    return {
      sha,
      version: await pluginVersion(target),
      root: path.join(target, 'skills'),
      at: new Date().toISOString(),
    }
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => {})
  }
}

function adapterText(root: string): string {
  const models = path.join(state.cache, 'models.md')
  return `# pstack in Dim

Read this file once per session before following any pstack skill. \`<pstack>\`
means \`${root}\`, the adapted copy this plugin registers; \`${path.join(state.cache, 'versions')}/<sha>/\`
is the repository as cloned. Map every Cursor name in a skill with the tables
below; when a Cursor field has no row, drop it and say so. Never pass a field
or value a Dim tool schema rejects.

## Tools

| Cursor | Dim |
| --- | --- |
| \`Task\` | the \`agent\` tool, action \`request\` |
| \`AskQuestion\` | \`ask_user\`, whose questions offer options and accept a custom answer |
| A todolist, or copying steps into one | no todo tool: keep the list in your reply and update it at each phase |
| \`Read\`, \`Write\`, \`Edit\` | \`read\`, \`write\`, \`edit\` |
| \`Grep\`, \`Glob\` | \`grep\`, \`glob\` |
| \`Bash\` | \`exec\` |
| Run another pstack skill (\`/name\` or "the **name** skill") | \`read\` \`<pstack>/skills/<name>/SKILL.md\` and follow it. Dim's \`skill\` tool refuses skills marked \`disable-model-invocation: true\`, and pstack marks every skill but \`setup-pstack\` that way. When the operator should start one, tell them to type \`/skill:<name>\`. |
| A plan tool or plan mode | none: write the plan in your reply |
| A Cursor rule file, \`~/.cursor/rules/*.mdc\` | no always-applied rules file: see Models for where pstack keeps its own choices; put anything else in the workspace \`AGENTS.md\` when the operator wants it in every session |

## Subagents

- \`Task(subagent_type: general-purpose)\` becomes
  \`agent({ action: 'request', profile: { name, description, systemPrompt, tools, model }, prompt, title })\`.
  The profile is created for that member, so name it \`poteto-agent\` or
  \`comment-sicko\` and paste the role file's instructions into \`systemPrompt\`
  (\`<pstack>/agents/\`).
- A profile's \`tools\` picks the member's tools: read-only work gets
  \`['read', 'grep', 'glob', 'recall', 'skill']\`, editing work adds
  \`'write'\`, \`'edit'\` and \`'exec'\`.
- \`run_in_background: true\` is the default in Dim: a member works in the
  background and its result arrives as an input; \`agent\` actions \`read\`,
  \`wait\` and \`message\` see and steer it. There is no resume: with a closed
  member, spawn a new one and paste the earlier result into the brief.
- \`readonly: true/false\` have no field; they pick the \`tools\` above, and a
  read-only brief also says "do not edit files".
- \`environment: "cloud"\` has no equivalent (no cloud agents): use a worktree
  with the \`branch\` tool, or run locally and say which you did.
- Keep the kickoff's first line \`Read <path>/worker.md before anything else.\`,
  with \`<path>\` the absolute \`<pstack>/skills/poteto-mode\`.

## Models

- Cursor slugs (\`claude-opus-5-5-xhigh\`, \`gemini-4-neon-xhigh\`, ...) do not
  exist in Dim. \`agent({ action: 'models' })\` lists this session's
  \`providerId\`/\`modelId\` pairs.
- A role's value is \`<providerId>/<modelId>\`; drop the effort token, which Dim
  profiles do not take. When a role's model is missing, omit \`model\` and the
  member runs on the session model.
- \`setup-pstack\` writes its choices to \`${models}\` instead of a Cursor rule.
  Read that file before spawning a role and pass the chosen
  \`model: { providerId, modelId }\` on the profile.

## Paths

| Cursor | Dim |
| --- | --- |
| \`.cursor/skills/\`, \`~/.cursor/skills/\` | \`<pstack>/skills/<name>/\` |
| \`~/.cursor/rules/pstack-models.mdc\` | \`${models}\` |
| \`~/.cursor/plugins/\` | \`${path.join(state.cache, 'versions')}/<sha>/\` |
| Transcripts in \`~/.cursor/projects/<slug>/agent-transcripts/\` | Dim's own session history: \`recall\`, or \`dimcode session export\` |
| \`https://github.com/cursor/plugins/blob/main/pstack/<path>\` | \`<pstack>/<path>\` when the file is there; read the local copy and never fetch it |

## Cursor-only features

Dim has no Cursor Automations, Bugbot, cloud agents, Cursor's built-in PR tool
or the \`cursor-team-kit\` plugin. When a step needs one, write one line in your
reply, \`Skipped in Dim: <step>. <reason>.\`, then go on to the next step. Do not
stop, ask or retry. A PR step that only needs a command is not a skip: run
\`gh\` through \`exec\`.

## Differences to respect

- Dim's tools are lower-case: \`read\`, \`grep\`, \`glob\`, \`exec\`, \`agent\`,
  \`ask_user\`, \`skill\`.
- Only model-invocable skills appear in the skill list; pstack's are
  operator-invoked, so the operator starts one with \`/skill:<name>\`, and the
  model follows one by reading its \`SKILL.md\`.
- \`exec\` and writes can need approval; keep commands batched and say what a
  command is for before running it.
`
}

function entrySkill(root: string): string {
  const skills = path.join(root, 'skills')
  return `---
name: pstack
description: pstack's engineering workflow (poteto-mode, principles, verification, review) installed from cursor/plugins. Use when the user asks for pstack, poteto mode, or a rigorous plan/build/verify workflow, or names a pstack skill.
---

# pstack in Dim

This adapted copy lives at \`${root}\`. Its skills are at \`${skills}/<name>/SKILL.md\`
and the main one is \`${skills}/poteto-mode/SKILL.md\`.

Before following a pstack skill, read \`${path.join(root, 'DIM-ADAPTER.md')}\` once
this session: it maps Cursor tool, model and path names to Dim's, and says which
Cursor-only steps to skip.

- The operator starts a skill with \`/skill:<name>\` (for example
  \`/skill:poteto-mode\`); only \`setup-pstack\` and this skill are
  model-invocable upstream.
- \`setup-pstack\` picks the model per role; its choices live in
  \`${path.join(state.cache, 'models.md')}\`.
- \`pstack_status\` and \`pstack_update\` report and refresh this copy.
`
}

/** Inserts the adapter pointer after a skill's frontmatter. */
function withAdapterLine(text: string, root: string): string {
  const line = `> Dim: read \`${path.join(root, 'DIM-ADAPTER.md')}\` once per session before following this file; it maps the Cursor tool, model and path names below to Dim's.\n`
  if (text.startsWith('---')) {
    const end = text.indexOf('\n---', 3)
    if (end !== -1) {
      const cut = text.indexOf('\n', end + 1) + 1
      if (cut > 0) return `${text.slice(0, cut)}\n${line}\n${text.slice(cut)}`
    }
  }
  return `${line}\n${text}`
}

/** Builds the adapted tree for one installed copy: the whole pstack directory,
 * with the adapter document, a pointer at the top of every skill and a
 * model-invocable entry skill. Returns the root to register. */
async function ensureAdapter(installed: Installed): Promise<string> {
  state.adapted = undefined
  state.adapter = 0
  const base = path.dirname(installed.root)
  const target = path.join(path.dirname(base), 'dim')
  const skills = path.join(target, 'skills')
  const marker = path.join(target, '.adapted.json')

  try {
    const document = JSON.parse(await readFile(marker, 'utf8'))
    if (document.adapter === ADAPTER && (await exists(skills))) {
      state.adapted = skills
      state.adapter = ADAPTER
      return skills
    }
  } catch {
    // Not adapted yet, or by another version: rebuild below.
  }

  await rm(target, { recursive: true, force: true })
  await cp(base, target, { recursive: true })
  await writeFile(path.join(target, 'DIM-ADAPTER.md'), adapterText(target), 'utf8')
  for (const entry of await readdir(skills, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const file = path.join(skills, entry.name, 'SKILL.md')
    if (!(await exists(file))) continue
    const text = await readFile(file, 'utf8')
    await writeFile(file, withAdapterLine(text, target), 'utf8')
  }
  await mkdir(path.join(skills, 'pstack'), { recursive: true })
  await writeFile(path.join(skills, 'pstack', 'SKILL.md'), entrySkill(target), 'utf8')
  await writeFile(marker, `${JSON.stringify({ adapter: ADAPTER, at: new Date().toISOString() })}\n`, 'utf8')

  state.adapted = skills
  state.adapter = ADAPTER
  return skills
}

async function register(ctx: any, installed: Installed): Promise<void> {
  const root = state.adapted ?? installed.root
  if (!(await exists(root))) throw new Error(`skills root is missing: ${root}`)
  const catalog = ctx.use('skillsCatalog')
  if (state.registered && state.registeredRoot !== root) {
    await catalog.withdraw({ plugin: KEY })
    state.registered = false
  }
  const issues = await catalog.register({ plugin: KEY, root })
  state.registered = true
  state.registeredRoot = root
  const broken = (issues ?? []).filter((issue: any) => issue.kind !== 'scanLimitReached')
  if (issues?.length) console.warn(`[pstack] skills: ${JSON.stringify(issues)}`)
  if (broken.length) console.warn(`[pstack] some skills did not load; the rest are registered`)
}

async function loadState(): Promise<Installed | undefined> {
  try {
    const document = JSON.parse(await readFile(stateFile(), 'utf8'))
    if (typeof document.sha !== 'string' || typeof document.root !== 'string') return undefined
    const installed: Installed = {
      sha: document.sha,
      version: typeof document.version === 'string' ? document.version : 'unknown',
      root: document.root,
      at: typeof document.at === 'string' ? document.at : '',
    }
    return (await exists(installed.root)) ? installed : undefined
  } catch {
    return undefined
  }
}

async function saveState(installed: Installed): Promise<void> {
  await mkdir(state.cache, { recursive: true })
  await writeFile(stateFile(), `${JSON.stringify(installed, null, 2)}\n`, 'utf8')
}

async function prune(keep: string): Promise<void> {
  const versions = path.join(state.cache, 'versions')
  let entries: string[] = []
  try {
    entries = await readdir(versions)
  } catch {
    return
  }
  for (const entry of entries) {
    if (entry === keep) continue
    await rm(path.join(versions, entry), { recursive: true, force: true }).catch(() => {})
  }
}

async function sync(ctx: any, why: string): Promise<Installed | undefined> {
  if (state.update) return state.update
  state.update = (async () => {
    const options = await optionsOf(ctx)
    state.checkedAt = new Date().toISOString()
    try {
      const sha = await remoteSha(options)
      if (state.installed?.sha === sha && (await exists(state.installed.root))) {
        if (!state.adapted) await adaptedRoot(state.installed)
        if (!state.registered) await register(ctx, state.installed)
        state.lastError = ''
        return state.installed
      }
      console.log(`[pstack] ${why}: installing ${sha.slice(0, 7)}`)
      const installed = await install(options)
      await adaptedRoot(installed)
      await register(ctx, installed)
      state.installed = installed
      state.lastError = ''
      await saveState(installed)
      await prune(installed.sha)
      console.log(`[pstack] loaded ${installed.version} (${installed.sha.slice(0, 7)})`)
      return installed
    } catch (error) {
      state.lastError = message(error)
      console.error(`[pstack] update failed: ${state.lastError}`)
      if (state.installed && (await exists(state.installed.root))) {
        if (!state.adapted) await adaptedRoot(state.installed)
        if (!state.registered) await register(ctx, state.installed)
        return state.installed
      }
      return undefined
    }
  })().finally(() => {
    state.update = undefined
  })
  return state.update
}

/** Adapts a copy, or keeps the raw skills when that fails: an adapter bug must
 * not cost the skills. */
async function adaptedRoot(installed: Installed): Promise<string | undefined> {
  try {
    return await ensureAdapter(installed)
  } catch (error) {
    console.warn(`[pstack] adapter failed, using the upstream skills: ${message(error)}`)
    return undefined
  }
}

function schedule(ctx: any, hours: number): void {
  if (state.timer) clearTimeout(state.timer)
  state.timer = undefined
  if (!(hours > 0)) {
    state.nextCheckAt = ''
    return
  }
  const delay = hours * 60 * 60 * 1000
  state.nextCheckAt = new Date(Date.now() + delay).toISOString()
  state.timer = setTimeout(() => {
    sync(ctx, 'scheduled update').finally(async () => {
      try {
        const options = await optionsOf(ctx)
        schedule(ctx, options.intervalHours)
      } catch {
        schedule(ctx, hours)
      }
    })
  }, delay)
  state.timer.unref?.()
}

async function summary(): Promise<Record<string, unknown>> {
  const root = state.adapted ?? state.installed?.root
  let skills = 0
  try {
    skills = (await readdir(root ?? '')).filter((entry) => entry).length
  } catch {
    skills = 0
  }
  let issues: unknown[] = []
  if (state.registered) {
    try {
      issues = await state.ctx.use('skillsCatalog').issues({ plugin: KEY })
    } catch {
      issues = []
    }
  }
  return {
    version: state.installed?.version ?? null,
    sha: state.installed?.sha ?? null,
    root: state.installed?.root ?? null,
    skillsRoot: root ?? null,
    adapter: state.adapter || null,
    skills,
    issues,
    installedAt: state.installed?.at ?? null,
    checkedAt: state.checkedAt || null,
    nextCheckAt: state.nextCheckAt || null,
    lastError: state.lastError || null,
  }
}

const declaration = {
  source: NAME,
  userFile: `${NAME}.json`,
  schema: {
    type: 'object',
    properties: {
      repo: { type: 'string', default: DEFAULTS.repo },
      ref: { type: 'string', default: DEFAULTS.ref },
      subdir: { type: 'string', default: DEFAULTS.subdir },
      intervalHours: {
        type: 'number',
        default: DEFAULTS.intervalHours,
        description: 'Hours between update checks; 0 turns the periodic check off.',
      },
    },
    additionalProperties: false,
  },
}

const tools = definePlugin({
  name: 'PstackTools',
  inject: ['toolRegistry'],
  async apply(ctx: any) {
    const registry = ctx.use('toolRegistry')

    await registry.register(
      {
        name: 'pstack_status',
        description:
          'Report the pstack copy this Dim plugin serves: the pstack version and commit, where its skills load from, how many skills are registered, when it last checked cursor/plugins and when it checks next.',
        source: 'extension',
        risk: 'read_filesystem',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      },
      async () => ({ content: JSON.stringify(await summary(), null, 2) }),
    )

    await registry.register(
      {
        name: 'pstack_update',
        description:
          'Check cursor/plugins for a newer pstack now, install it and register its skills. Reports the same fields as pstack_status. A failed check keeps the installed copy.',
        source: 'extension',
        risk: 'network',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      },
      async () => {
        const installed = await sync(state.ctx, 'manual update')
        const report = await summary()
        return {
          content: JSON.stringify(report, null, 2),
          isError: installed === undefined,
        }
      },
    )
  },
})

export default definePlugin({
  name: 'PstackPlugin',
  inject: ['skillsCatalog', 'settings', 'partRegistry'],
  async apply(ctx: any) {
    await ctx.use('settings').register(declaration)
    state.ctx = ctx

    state.installed = await loadState()
    if (state.installed) {
      try {
        await adaptedRoot(state.installed)
        await register(ctx, state.installed)
      } catch (error) {
        console.error(`[pstack] cached skills did not load: ${message(error)}`)
      }
    }

    const options = await optionsOf(ctx)
    if (!state.installed) {
      // Nothing cached yet: install before the first Session so its skills
      // are there from the start.
      await sync(ctx, 'first load')
    } else {
      sync(ctx, 'startup update').catch(() => {})
    }
    schedule(ctx, options.intervalHours)

    await ctx.use('partRegistry').registerDefinition('session', 'PstackTools', tools)

    // The previous row's teardown can land after this row registered when Dim
    // reloads or re-enables the plugin, and it withdraws the plugin's skills
    // by key. Register once more after it has settled so the skills survive.
    const reassert = setTimeout(() => {
      const installed = state.installed
      if (!installed) return
      register(ctx, installed).catch((error) =>
        console.warn(`[pstack] re-register failed: ${message(error)}`),
      )
    }, 2500)
    reassert.unref?.()

    return async () => {
      if (state.timer) clearTimeout(state.timer)
      state.timer = undefined
      clearTimeout(reassert)
      // The skills registration belongs to this row and goes away with it;
      // withdrawing here would race the next row's registration on reload.
      state.registered = false
      state.registeredRoot = undefined
    }
  },
})