import { createInterface } from 'readline'
import { createReadStream } from 'fs'
import { homedir } from 'os'
import {
  join,
  resolve,
  normalize,
  dirname,
  basename,
} from 'path'
import { rm, access, readdir, stat, readFile, writeFile } from 'fs/promises'
import { promisify } from 'util'
import React from 'react'
import { render, Box, Text } from '../../ink.js'
import { Select } from '../../components/CustomSelect/index.js'
import { getClaudeConfigHomeDir } from '../../utils/envUtils.js'
import { getGlobalConfig, saveGlobalConfig } from '../../utils/config.js'
import { getGlobalClaudeFile } from '../../utils/env.js'
import { getCwd } from '../../utils/cwd.js'
import { findCanonicalGitRoot } from '../../utils/git.js'
import { normalizePathForConfigKey } from '../../utils/path.js'
import { logEvent } from '../../services/analytics/index.js'
import { getFsImplementation } from '../../utils/fsOperations.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SESSION_PREFIX_MAX_LEN = 200
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[4][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type PurgeItemKind = 'file' | 'dir' | 'config-key' | 'history-lines'

interface PurgeItem {
  path: string
  kind: PurgeItemKind
  reason: string
  matchPaths?: string[]
}

interface PurgePlan {
  items: PurgeItem[]
  warnings: string[]
}

interface PurgeOptions {
  all?: boolean
  dryRun?: boolean
  interactive?: boolean
  yes?: boolean
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function die(message: string): never {
  console.error(message)
  process.exit(1)
}

function say(message: string): void {
  console.log(message)
}

function warn(message: string): void {
  // Use stderr with yellow color via ANSI codes if available
  process.stderr.write(`\x1b[33m${message}\x1b[0m\n`)
}

function hashString(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0
  }
  return h
}

function sessionPrefix(path_: string): string {
  const sanitized = path_.replace(/[^a-zA-Z0-9]/g, '-')
  if (sanitized.length <= SESSION_PREFIX_MAX_LEN) return sanitized
  return `${sanitized.slice(0, SESSION_PREFIX_MAX_LEN)}-${Math.abs(
    hashString(path_),
  ).toString(36)}`
}

function projectsDir(): string {
  return join(getClaudeConfigHomeDir(), 'projects')
}

function projectSessionsDir(projectPath: string): string {
  return join(projectsDir(), sessionPrefix(projectPath))
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p)
    return true
  } catch {
    return false
  }
}

async function getGitRoot(dir: string): Promise<string | null> {
  try {
    return await findCanonicalGitRoot(dir)
  } catch {
    return null
  }
}

async function getRelatedDirs(projectPath: string): Promise<string[]> {
  const dirs: string[] = []
  const direct = projectSessionsDir(projectPath)
  try {
    await readdir(direct)
    dirs.push(direct)
  } catch {}

  const prefix = sessionPrefix(projectPath)
  if (prefix.length <= SESSION_PREFIX_MAX_LEN) return dirs

  const shortPrefix = prefix.slice(0, SESSION_PREFIX_MAX_LEN) + '-'
  const pd = projectsDir()
  try {
    for (const entry of await readdir(pd, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith(shortPrefix)) continue
      const full = join(pd, entry.name)
      if (full !== direct) dirs.push(full)
    }
  } catch {}
  return dirs
}

async function getSessionIdsInDir(dir: string): Promise<string[]> {
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch {
    return []
  }
  return entries
    .filter((e) => e.endsWith('.jsonl'))
    .map((e) => e.slice(0, -6))
    .filter((e) => UUID_RE.test(e))
}

async function isProjectSessionDir(
  dir: string,
  projectPaths: Set<string>,
): Promise<boolean> {
  let files: string[]
  try {
    files = (await readdir(dir))
      .filter((f) => f.endsWith('.jsonl'))
      .sort()
  } catch {
    return false
  }

  for (const file of files) {
    const stream = createReadStream(join(dir, file), { encoding: 'utf8' })
    const lines = createInterface({ input: stream, crlfDelay: Infinity })
    let count = 0
    try {
      for await (const line of lines) {
        if (++count > 50) break
        try {
          const obj = JSON.parse(line)
          if (typeof obj.cwd === 'string') {
            const cwdNorm = normalize(obj.cwd)
            for (const pp of projectPaths) {
              if (normalize(pp) === cwdNorm) {
                lines.close()
                stream.destroy()
                return true
              }
            }
          }
        } catch {
          // ignore malformed JSON lines
        }
      }
    } catch {
      // ignore read errors
    } finally {
      lines.close()
      stream.destroy()
    }
  }
  return false
}

async function countHistoryLines(
  historyPath: string,
  projectPaths: Set<string>,
  mode: 'count' | 'filter',
): Promise<number> {
  let stream: ReturnType<typeof createReadStream> | undefined
  let lines: ReturnType<typeof createInterface> | undefined

  try {
    stream = createReadStream(historyPath, { encoding: 'utf8' })
    lines = createInterface({ input: stream, crlfDelay: Infinity })
  } catch (err: any) {
    if (err.code === 'ENOENT') return 0
    throw err
  }

  const kept: string[] = []
  let matched = 0

  try {
    for await (const line of lines) {
      let isMatch = false
      try {
        const obj = JSON.parse(line)
        if (typeof obj.cwd === 'string') {
          const cwdNorm = normalize(obj.cwd)
          for (const pp of projectPaths) {
            if (normalize(pp) === cwdNorm) {
              isMatch = true
              break
            }
          }
        }
      } catch {
        // malformed line - don't count as match
      }

      if (isMatch) {
        matched++
      } else if (mode === 'filter') {
        kept.push(line)
      }
    }
  } catch (err: any) {
    if (err.code === 'ENOENT') {
      lines.close()
      stream.destroy()
      return 0
    }
    lines.close()
    stream.destroy()
    throw err
  }

  lines.close()
  stream.destroy()

  if (mode === 'filter' && matched > 0) {
    const out = kept.length ? `${kept.join('\n')}\n` : ''
    await writeFile(historyPath, out, 'utf8')
  }

  return matched
}

function normalizeDir(path_: string): string {
  return normalize(path_).replace(/\/+$/, '') || '/'
}

// ---------------------------------------------------------------------------
// Interactive UI helpers (Ink)
// ---------------------------------------------------------------------------

async function selectProject(options: {
  label: string
  value: string
  description?: string
}[]): Promise<string | null> {
  if (!process.stdin.isTTY) return null

  let resolveVal: (v: string | null) => void = () => {}
  const promise = new Promise<string | null>((r) => {
    resolveVal = r
  })

  const instance = await render(
    <Box flexDirection="column" gap={1} paddingY={1}>
      <Text bold>Select a project to purge:</Text>
      <Select
        options={options}
        visibleOptionCount={10}
        onChange={(value) => {
          resolveVal(value as string)
          instance.unmount()
        }}
        onCancel={() => {
          resolveVal(null)
          instance.unmount()
        }}
      />
    </Box>,
    { exitOnCtrlC: false },
  )

  await instance.waitUntilExit()
  return promise
}

async function interactiveConfirmItem(
  prompt: string,
  choices: { label: string; value: string }[],
): Promise<string | null> {
  if (!process.stdin.isTTY) return null

  let resolveVal: (v: string | null) => void = () => {}
  const promise = new Promise<string | null>((r) => {
    resolveVal = r
  })

  const instance = await render(
    <Box flexDirection="column" gap={1} paddingY={1}>
      <Text bold>{prompt}</Text>
      <Select
        options={choices}
        visibleOptionCount={10}
        onChange={(value) => {
          resolveVal(value as string)
          instance.unmount()
        }}
        onCancel={() => {
          resolveVal(null)
          instance.unmount()
        }}
      />
    </Box>,
    { exitOnCtrlC: false },
  )

  await instance.waitUntilExit()
  return promise
}

async function readlineConfirm(prompt: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  return new Promise((resolve) => {
    rl.question(`${prompt} [y/N] `, (answer) => {
      rl.close()
      const normalized = answer.trim().toLowerCase()
      resolve(normalized === 'y' || normalized === 'yes')
    })
  })
}

// ---------------------------------------------------------------------------
// Purge plan builders
// ---------------------------------------------------------------------------

function formatPurgeItem(item: PurgeItem): string {
  let formatted: string
  switch (item.kind) {
    case 'config-key':
      formatted = `config: projects["${item.path}"]`
      break
    case 'history-lines':
      formatted = `filter: ${item.path}`
      break
    case 'file':
    case 'dir':
      formatted = `${item.kind}:    ${item.path}`
      break
  }
  return `${formatted}\n           ${item.reason}`
}

function printPurgePlan(name: string, items: PurgeItem[], warnings: string[]) {
  say(`\nPurge plan for ${name}:`)
  for (const item of items) {
    say(`  ${formatPurgeItem(item)}`)
  }
  if (warnings.length) {
    say('')
    for (const w of warnings) warn(w)
  }
}

async function buildProjectPurgePlan(projectPath: string): Promise<PurgePlan> {
  const configDir = getClaudeConfigHomeDir()
  const resolvedPath = resolve(projectPath)
  const gitRoot = await getGitRoot(resolvedPath)
  const paths = new Set([resolvedPath, gitRoot].filter(Boolean) as string[])

  const dirsToScan = new Set<string>()
  for (const p of paths) {
    const related = await getRelatedDirs(p)
    for (const r of related) dirsToScan.add(r)
  }

  // Also scan projects/ for matching session directories
  const pd = projectsDir()
  const sessionPrefixes = [...paths].map((p) => sessionPrefix(p) + '-')
  try {
    for (const entry of await readdir(pd, { withFileTypes: true })) {
      const full = join(pd, entry.name)
      if (
        entry.isDirectory() &&
        !dirsToScan.has(full) &&
        sessionPrefixes.some((prefix) => entry.name.startsWith(prefix)) &&
        (await isProjectSessionDir(full, paths))
      ) {
        dirsToScan.add(full)
      }
    }
  } catch {}

  const items: PurgeItem[] = []
  const warnings: string[] = []
  const sessionIds = new Set<string>()

  for (const dir of dirsToScan) {
    for (const sid of await getSessionIdsInDir(dir)) {
      sessionIds.add(sid)
    }
  }

  for (const sid of sessionIds) {
    const tasksDir = join(configDir, 'tasks', sid)
    if (await pathExists(tasksDir)) {
      items.push({
        path: tasksDir,
        kind: 'dir',
        reason: `tasks for session ${sid}`,
      })
    }

    const debugFile = join(configDir, 'debug', `${sid}.txt`)
    if (await pathExists(debugFile)) {
      items.push({
        path: debugFile,
        kind: 'file',
        reason: `debug log for session ${sid}`,
      })
    }

    const historyDir = join(configDir, 'file-history', sid)
    if (await pathExists(historyDir)) {
      items.push({
        path: historyDir,
        kind: 'dir',
        reason: `file edit history for session ${sid}`,
      })
    }
  }

  for (const dir of dirsToScan) {
    items.push({
      path: dir,
      kind: 'dir',
      reason: 'project transcripts (.jsonl) and memory/',
    })
  }

  const normalizedPaths = new Set(
    [...paths].map((p) => normalizeDir(p)),
  )
  const config = getGlobalConfig()
  for (const key of Object.keys(config.projects ?? {})) {
    if (normalizedPaths.has(normalizeDir(key))) {
      items.push({
        path: key,
        kind: 'config-key',
        reason:
          'project entry in ~/.claude.json (trust, history, MCP servers)',
      })
    }
  }

  const historyFile = join(configDir, 'history.jsonl')
  const historyCount = await countHistoryLines(
    historyFile,
    paths,
    'count',
  ).catch(() => 0)
  if (historyCount > 0) {
    items.push({
      path: historyFile,
      kind: 'history-lines',
      reason: `${historyCount} prompt(s) typed in this project`,
      matchPaths: [...paths],
    })
  }

  if (await pathExists(join(configDir, 'shell-snapshots'))) {
    warnings.push(
      'shell-snapshots/ are not project-scoped and will not be touched',
    )
  }

  const backupsDir = join(configDir, 'backups')
  if (await pathExists(backupsDir)) {
    warnings.push(
      `backups/ may still contain this project entry in old .claude.json snapshots (${backupsDir}); at most 5 are kept and they rotate out automatically`,
    )
  }

  return { items, warnings }
}

async function buildAllProjectsPurgePlan(): Promise<PurgePlan> {
  const configDir = getClaudeConfigHomeDir()
  const items: PurgeItem[] = []
  const warnings: string[] = []

  const dirs: [string, string][] = [
    ['projects', 'all project transcripts (.jsonl) and memory/'],
    ['tasks', 'all session task lists'],
    ['debug', 'all session debug logs'],
    ['file-history', 'all session file edit history'],
  ]

  for (const [subdir, reason] of dirs) {
    const p = join(configDir, subdir)
    if (await pathExists(p)) {
      items.push({ path: p, kind: 'dir', reason })
    }
  }

  const historyFile = join(configDir, 'history.jsonl')
  if (await pathExists(historyFile)) {
    items.push({
      path: historyFile,
      kind: 'file',
      reason: 'prompt history across all projects',
    })
  }

  const config = getGlobalConfig()
  for (const key of Object.keys(config.projects ?? {})) {
    items.push({
      path: key,
      kind: 'config-key',
      reason: 'project entry in ~/.claude.json (trust, history, MCP servers)',
    })
  }

  if (await pathExists(join(configDir, 'shell-snapshots'))) {
    warnings.push(
      'shell-snapshots/ are not project-scoped and will not be touched',
    )
  }

  const backupsDir = join(configDir, 'backups')
  if (await pathExists(backupsDir)) {
    warnings.push(
      `backups/ may still contain project entries in old .claude.json snapshots (${backupsDir}); at most 5 are kept and they rotate out automatically`,
    )
  }

  return { items, warnings }
}

// ---------------------------------------------------------------------------
// Deletion
// ---------------------------------------------------------------------------

async function deletePurgeItem(item: PurgeItem): Promise<void> {
  switch (item.kind) {
    case 'config-key': {
      const key = item.path
      saveGlobalConfig((current) => {
        if (!current.projects?.[key]) return current
        const { [key]: _removed, ...rest } = current.projects
        return { ...current, projects: rest }
      })
      return
    }
    case 'history-lines': {
      await countHistoryLines(
        item.path,
        new Set(item.matchPaths ?? []),
        'filter',
      )
      return
    }
    case 'file':
    case 'dir': {
      await rm(item.path, { recursive: item.kind === 'dir', force: true })
      return
    }
  }
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function purgeProjectHandler(
  path_: string | undefined,
  options: PurgeOptions,
): Promise<void> {
  // --all mode
  if (options.all) {
    if (path_) die('Cannot specify both a path and --all.')
    if (options.interactive) die('Cannot use -i/--interactive with --all.')

    const { items, warnings } = await buildAllProjectsPurgePlan()
    if (items.length === 0) {
      logEvent('cli_purge_project', { detail: 'cli_purge_project_nothing_found' })
      die(
        `No Claude Code project state found under ${getClaudeConfigHomeDir()}.`,
      )
    }

    printPurgePlan('all projects', items, warnings)
    if (options.dryRun) {
      say(`Dry run: ${items.length} item(s) would be deleted.`)
      process.exit(0)
    }

    if (!options.yes) {
      const ok = await readlineConfirm(
        `Delete ${items.length} item(s) for ALL projects? This cannot be undone.`,
      )
      if (!ok) die('Aborted.')
    }

    for (const item of items) {
      await deletePurgeItem(item)
    }

    logEvent('cli_purge_project')
    say(`Purged ${items.length} item(s) across all projects.`)
    return
  }

  // Single-project mode
  let projectPath: string
  if (path_) {
    projectPath = resolve(path_)
  } else {
    const known = Object.keys(getGlobalConfig().projects ?? {})
    const cwd = getCwd()
    const choices = [
      { label: cwd, value: cwd, description: 'current directory' },
      ...known
        .filter((k) => k !== cwd)
        .map((k) => ({ label: k, value: k })),
    ]
    const selected = await selectProject(choices)
    if (selected === null) die('Aborted.')
    projectPath = selected
  }

  const { items, warnings } = await buildProjectPurgePlan(projectPath)
  if (items.length === 0) {
    logEvent('cli_purge_project', { detail: 'cli_purge_project_nothing_found' })
    die(
      `No Claude Code project state found for ${projectPath} under ${getClaudeConfigHomeDir()}.`,
    )
  }

  printPurgePlan(projectPath, items, warnings)
  if (options.dryRun) {
    say(`Dry run: ${items.length} item(s) would be deleted.`)
    process.exit(0)
  }

  if (options.interactive) {
    let deleted = 0
    let deleteAllRemaining = false

    for (let i = 0; i < items.length; i++) {
      const item = items[i]
      let action = 'delete'

      if (!deleteAllRemaining) {
        const choice = await interactiveConfirmItem(
          `[${i + 1}/${items.length}] ${formatPurgeItem(item)}`,
          [
            { label: 'Delete', value: 'delete' },
            { label: 'Skip', value: 'skip' },
            {
              label: 'Delete this and all remaining',
              value: 'all',
            },
            { label: 'Abort', value: 'abort' },
          ],
        )
        action = choice ?? 'abort'
      }

      if (action === 'abort') {
        die(`Aborted. ${deleted} item(s) deleted.`)
      }
      if (action === 'skip') continue
      if (action === 'all') deleteAllRemaining = true

      await deletePurgeItem(item)
      deleted++
    }

    logEvent('cli_purge_project')
    say(`Purged ${deleted}/${items.length} item(s) for ${projectPath}.`)
    process.exit(0)
  }

  if (!options.yes) {
    const ok = await readlineConfirm(
      `Delete ${items.length} item(s) for ${projectPath}? This cannot be undone.`,
    )
    if (!ok) die('Aborted.')
  }

  for (const item of items) {
    await deletePurgeItem(item)
  }

  logEvent('cli_purge_project')
  say(`Purged ${items.length} item(s) for ${projectPath}.`)
  process.exit(0)
}
