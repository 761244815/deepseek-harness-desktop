import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { resolveNpmCommand, runCommand } from './command.mjs'

export const HARNESS_PACKAGE = '@deepseek-ai/dsh'
export const RUNTIME_ALLOW_SCRIPTS = Object.freeze({
  '@deepseek-ai/dsh-subprocess-local': true,
  '@google/genai': true,
  koffi: true,
  'node-pty': true,
  protobufjs: true,
})

function parseVersion(value) {
  const match = String(value).trim().match(
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/,
  )
  if (!match) throw new Error(`Invalid Harness package version: ${value}`)
  return {
    raw: match[0],
    core: match.slice(1, 4).map(Number),
    prerelease: match[4]?.split('.') ?? [],
  }
}

function comparePrerelease(left, right) {
  if (left.length === 0 || right.length === 0) {
    return left.length === right.length ? 0 : left.length === 0 ? 1 : -1
  }
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    if (left[index] === undefined) return -1
    if (right[index] === undefined) return 1
    if (left[index] === right[index]) continue
    const leftNumber = /^\d+$/.test(left[index])
    const rightNumber = /^\d+$/.test(right[index])
    if (leftNumber && rightNumber) return Number(left[index]) > Number(right[index]) ? 1 : -1
    if (leftNumber !== rightNumber) return leftNumber ? -1 : 1
    return left[index] > right[index] ? 1 : -1
  }
  return 0
}

export function comparePackageVersions(left, right) {
  const parsedLeft = parseVersion(left)
  const parsedRight = parseVersion(right)
  for (let index = 0; index < parsedLeft.core.length; index += 1) {
    if (parsedLeft.core[index] !== parsedRight.core[index]) {
      return parsedLeft.core[index] > parsedRight.core[index] ? 1 : -1
    }
  }
  return comparePrerelease(parsedLeft.prerelease, parsedRight.prerelease)
}

export function normalizePackageVersion(value) {
  return parseVersion(value).raw
}

function packageManifest(runtimePath) {
  return join(runtimePath, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
}

function packageEntrypoint(runtimePath) {
  return join(runtimePath, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
}

export class HarnessUpdater {
  constructor({
    fallbackRuntimePath,
    userDataPath,
    onStatus,
    commandRunner = runCommand,
    npmCommandResolver = resolveNpmCommand,
  }) {
    this.fallbackRuntimePath = resolve(fallbackRuntimePath)
    this.userDataPath = userDataPath
    this.onStatus = onStatus
    this.commandRunner = commandRunner
    this.npmCommandResolver = npmCommandResolver
    this.statePath = join(userDataPath, 'desktop-state.json')
    this.runtimeRoot = join(userDataPath, 'runtimes')
    this.logPath = join(userDataPath, 'logs', 'desktop.log')
    mkdirSync(this.runtimeRoot, { recursive: true })
    mkdirSync(join(userDataPath, 'logs'), { recursive: true })
  }

  versionAt(runtimePath) {
    try {
      const manifest = JSON.parse(readFileSync(packageManifest(runtimePath), 'utf8'))
      return normalizePackageVersion(manifest.version)
    } catch {
      return null
    }
  }

  runtimeReady(runtimePath, expectedVersion = null) {
    if (typeof runtimePath !== 'string' || !existsSync(join(runtimePath, 'package.json'))) return false
    const version = this.versionAt(runtimePath)
    if (version === null || !existsSync(packageEntrypoint(runtimePath))) return false
    return expectedVersion === null || version === expectedVersion
  }

  loadState() {
    const fallback = {
      activeRuntime: this.fallbackRuntimePath,
      activeVersion: null,
      pendingRuntime: null,
      pendingVersion: null,
      autoUpdate: true,
    }
    try {
      const parsed = JSON.parse(readFileSync(this.statePath, 'utf8'))
      const activeRuntime = typeof parsed.activeRuntime === 'string'
        && existsSync(join(parsed.activeRuntime, 'package.json'))
        ? parsed.activeRuntime
        : fallback.activeRuntime
      const detectedActiveVersion = this.versionAt(activeRuntime)
      const activeVersion = detectedActiveVersion
        ?? (typeof parsed.activeVersion === 'string' ? normalizePackageVersion(parsed.activeVersion) : null)
      const detectedPendingVersion = this.versionAt(parsed.pendingRuntime)
      const parsedPendingVersion = detectedPendingVersion
        ?? (typeof parsed.pendingVersion === 'string' ? normalizePackageVersion(parsed.pendingVersion) : null)
      const pendingRuntime = parsedPendingVersion !== null
        && this.runtimeReady(parsed.pendingRuntime, parsedPendingVersion)
        ? parsed.pendingRuntime
        : null
      return {
        activeRuntime,
        activeVersion,
        pendingRuntime,
        pendingVersion: pendingRuntime ? parsedPendingVersion : null,
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

  async npm(args, options = {}) {
    const npm = this.npmCommandResolver()
    return await this.commandRunner(npm, args, {
      cwd: options.cwd ?? this.userDataPath,
      timeoutMs: options.timeoutMs ?? 60_000,
      onLine: line => this.log(line),
    })
  }

  async check(currentVersion) {
    this.onStatus({ phase: 'checking', title: '正在检查正式版更新', detail: `${HARNESS_PACKAGE} (npm latest)` })
    const result = await this.npm(['view', HARNESS_PACKAGE, 'dist-tags.latest', '--json'], { timeoutMs: 45_000 })
    const latestVersion = normalizePackageVersion(JSON.parse(result.stdout))
    return {
      available: currentVersion === null || comparePackageVersions(latestVersion, currentVersion) > 0,
      currentVersion,
      latestVersion,
    }
  }

  async stage(version) {
    const normalizedVersion = normalizePackageVersion(version)
    let runtimePath = join(this.runtimeRoot, `npm-${normalizedVersion}`)
    if (this.runtimeReady(runtimePath, normalizedVersion)) return runtimePath
    if (existsSync(runtimePath)) runtimePath = `${runtimePath}-${Date.now()}`

    this.onStatus({ phase: 'updating', title: '正在准备正式版', detail: normalizedVersion })
    mkdirSync(runtimePath, { recursive: true })
    writeFileSync(join(runtimePath, 'package.json'), `${JSON.stringify({
      name: 'deepseek-harness-desktop-runtime',
      private: true,
      version: '0.0.0',
      allowScripts: RUNTIME_ALLOW_SCRIPTS,
    }, null, 2)}\n`, 'utf8')

    this.onStatus({ phase: 'installing', title: '正在安装正式版', detail: `${HARNESS_PACKAGE}@${normalizedVersion}` })
    await this.npm([
      'install',
      '--omit=dev',
      '--no-audit',
      '--no-fund',
      '--strict-allow-scripts',
      '--save-exact',
      `${HARNESS_PACKAGE}@${normalizedVersion}`,
    ], { cwd: runtimePath, timeoutMs: 10 * 60_000 })

    if (!this.runtimeReady(runtimePath, normalizedVersion)) {
      throw new Error(`Installed Harness runtime failed verification: ${normalizedVersion}`)
    }
    writeFileSync(join(runtimePath, '.desktop-runtime.json'), `${JSON.stringify({
      package: HARNESS_PACKAGE,
      version: normalizedVersion,
      installedAt: new Date().toISOString(),
    }, null, 2)}\n`, 'utf8')
    return runtimePath
  }
}
