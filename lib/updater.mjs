import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { resolvePnpmCommand, runCommand } from './command.mjs'

const EXPECTED_ORIGIN = 'https://github.com/deepseek-ai/deepseek-harness.git'

function normalizedGitPath(value) {
  return resolve(value).replaceAll('\\', '/')
}

export function shortCommit(commit) {
  if (!/^[0-9a-f]{40}$/i.test(commit)) throw new Error(`Invalid Git commit: ${commit}`)
  return commit.slice(0, 12).toLowerCase()
}

export class HarnessUpdater {
  constructor({ checkoutPath, userDataPath, onStatus }) {
    this.checkoutPath = resolve(checkoutPath)
    this.userDataPath = userDataPath
    this.onStatus = onStatus
    this.statePath = join(userDataPath, 'desktop-state.json')
    this.runtimeRoot = join(userDataPath, 'runtimes')
    this.logPath = join(userDataPath, 'logs', 'desktop.log')
    mkdirSync(this.runtimeRoot, { recursive: true })
    mkdirSync(join(userDataPath, 'logs'), { recursive: true })
  }

  loadState() {
    const fallback = {
      activeRuntime: this.checkoutPath,
      activeCommit: null,
      autoUpdate: true,
    }
    try {
      const parsed = JSON.parse(readFileSync(this.statePath, 'utf8'))
      const activeRuntime = typeof parsed.activeRuntime === 'string' && existsSync(join(parsed.activeRuntime, 'package.json'))
        ? parsed.activeRuntime
        : fallback.activeRuntime
      return {
        activeRuntime,
        activeCommit: typeof parsed.activeCommit === 'string' ? parsed.activeCommit : null,
        autoUpdate: parsed.autoUpdate !== false,
      }
    } catch {
      return fallback
    }
  }

  saveState(state) {
    mkdirSync(this.userDataPath, { recursive: true })
    const temporary = `${this.statePath}.tmp`
    writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
    renameSync(temporary, this.statePath)
  }

  log(line) {
    writeFileSync(this.logPath, `[${new Date().toISOString()}] ${line}\n`, { flag: 'a' })
    this.onStatus({ log: line })
  }

  async git(cwd, args, options = {}) {
    return await runCommand('git', ['-c', `safe.directory=${normalizedGitPath(cwd)}`, ...args], {
      cwd,
      timeoutMs: options.timeoutMs ?? 60_000,
      onLine: line => this.log(line),
    })
  }

  async commitAt(runtimePath) {
    const result = await this.git(runtimePath, ['rev-parse', 'HEAD'])
    return result.stdout.trim()
  }

  async check(activeRuntime) {
    this.onStatus({ phase: 'checking', title: '正在检查官方更新', detail: 'deepseek-ai/deepseek-harness' })
    const origin = (await this.git(this.checkoutPath, ['remote', 'get-url', 'origin'])).stdout.trim()
    if (origin !== EXPECTED_ORIGIN) {
      throw new Error(`Unexpected Harness origin: ${origin}`)
    }
    await this.git(this.checkoutPath, ['fetch', '--quiet', 'origin', 'master'], { timeoutMs: 120_000 })
    const remoteCommit = (await this.git(this.checkoutPath, ['rev-parse', 'origin/master'])).stdout.trim()
    const currentCommit = await this.commitAt(activeRuntime)
    return {
      available: currentCommit !== remoteCommit,
      currentCommit,
      remoteCommit,
    }
  }

  async stage(remoteCommit) {
    const name = shortCommit(remoteCommit)
    let runtimePath = join(this.runtimeRoot, name)
    const markerPath = join(runtimePath, '.desktop-build-ok.json')
    if (existsSync(markerPath)) {
      const marker = JSON.parse(readFileSync(markerPath, 'utf8'))
      if (marker.commit === remoteCommit) return runtimePath
    }
    if (existsSync(runtimePath)) runtimePath = join(this.runtimeRoot, `${name}-${Date.now()}`)

    this.onStatus({ phase: 'updating', title: '正在拉取新版本', detail: name })
    await this.git(this.checkoutPath, ['worktree', 'add', '--detach', runtimePath, remoteCommit], { timeoutMs: 180_000 })

    const pnpm = resolvePnpmCommand()
    this.onStatus({ phase: 'installing', title: '正在安装依赖', detail: runtimePath })
    await runCommand(pnpm, ['install', '--frozen-lockfile'], {
      cwd: runtimePath,
      timeoutMs: 20 * 60_000,
      onLine: line => this.log(line),
    })

    this.onStatus({ phase: 'building', title: '正在编译新版本', detail: name })
    await runCommand(pnpm, ['run', 'build'], {
      cwd: runtimePath,
      timeoutMs: 20 * 60_000,
      onLine: line => this.log(line),
    })

    writeFileSync(markerPath, `${JSON.stringify({ commit: remoteCommit, builtAt: new Date().toISOString() }, null, 2)}\n`)
    return runtimePath
  }
}
