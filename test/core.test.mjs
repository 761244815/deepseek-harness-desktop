import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  resolveHarnessLaunch,
  resolveNodeCommand,
  resolveNpmCommand,
  resolvePnpmCommand,
} from '../lib/command.mjs'
import { extractHarnessUrl } from '../lib/harness-manager.mjs'
import {
  comparePackageVersions,
  HarnessUpdater,
  normalizePackageVersion,
  RUNTIME_ALLOW_SCRIPTS,
} from '../lib/updater.mjs'

test('extractHarnessUrl accepts only the local Harness startup line', () => {
  assert.equal(extractHarnessUrl('dsh web: http://127.0.0.1:43127'), 'http://127.0.0.1:43127')
  assert.equal(extractHarnessUrl('dsh web: http://0.0.0.0:3080'), null)
  assert.equal(extractHarnessUrl('http://127.0.0.1:3080'), null)
})

test('package versions follow semantic-version precedence', () => {
  assert.equal(comparePackageVersions('0.1.0-rc.5', '0.1.0-rc.4'), 1)
  assert.equal(comparePackageVersions('0.1.0', '0.1.0-rc.5'), 1)
  assert.equal(comparePackageVersions('0.1.0+build.2', '0.1.0+build.1'), 0)
  assert.equal(comparePackageVersions('0.1.0-rc.5', '0.2.0'), -1)
  assert.equal(normalizePackageVersion(' 0.1.0-rc.5\n'), '0.1.0-rc.5')
  assert.throws(() => normalizePackageVersion('latest'), /Invalid Harness package version/)
})

test('resolveNpmCommand finds npm beside Node on the Windows PATH', () => {
  const expected = 'F:\\nodejs\\npm.cmd'
  assert.equal(resolveNpmCommand({
    platform: 'win32',
    env: { Path: 'C:\\Windows\\System32;F:\\nodejs' },
    fileExists: candidate => candidate === expected,
  }), expected)
})

test('resolvePnpmCommand keeps the legacy source fallback available', () => {
  const expected = 'C:\\Users\\demo\\AppData\\Roaming\\npm\\pnpm.cmd'
  assert.equal(resolvePnpmCommand({
    platform: 'win32',
    env: { APPDATA: 'C:\\Users\\demo\\AppData\\Roaming' },
    fileExists: candidate => candidate === expected,
  }), expected)
})

test('resolveNodeCommand finds Node on the Windows PATH', () => {
  const expected = 'F:\\nodejs\\node.exe'
  assert.equal(resolveNodeCommand({
    platform: 'win32',
    env: { Path: 'C:\\Windows\\System32;F:\\nodejs' },
    fileExists: candidate => candidate === expected,
  }), expected)
})

test('resolveHarnessLaunch prefers an installed npm package', () => {
  const runtimePath = 'C:\\runtime'
  const entrypoint = `${runtimePath}\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js`
  const node = 'F:\\nodejs\\node.exe'
  const launch = resolveHarnessLaunch(runtimePath, {
    platform: 'win32',
    env: { Path: 'F:\\nodejs' },
    fileExists: candidate => candidate === entrypoint || candidate === node,
  })

  assert.deepEqual(launch, {
    command: node,
    args: [entrypoint, 'web', '--host', '127.0.0.1', '--port', '0'],
    shell: false,
    mode: 'npm',
  })
})

test('resolveHarnessLaunch keeps compiled and source checkout fallbacks', () => {
  const runtimePath = 'D:\\deepseek-harness'
  const entrypoint = `${runtimePath}\\apps\\cli\\lib\\bin.js`
  const node = 'F:\\nodejs\\node.exe'
  assert.equal(resolveHarnessLaunch(runtimePath, {
    platform: 'win32',
    env: { Path: 'F:\\nodejs' },
    fileExists: candidate => candidate === entrypoint || candidate === node,
  }).mode, 'built')

  const pnpm = 'C:\\Users\\demo\\AppData\\Roaming\\npm\\pnpm.cmd'
  assert.equal(resolveHarnessLaunch(runtimePath, {
    platform: 'win32',
    env: { APPDATA: 'C:\\Users\\demo\\AppData\\Roaming' },
    fileExists: candidate => candidate === pnpm,
  }).mode, 'source')
})

test('HarnessUpdater migrates legacy state without discarding the checkout', t => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-desktop-state-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const fallbackRuntimePath = join(root, 'checkout')
  const userDataPath = join(root, 'user-data')
  mkdirSync(fallbackRuntimePath, { recursive: true })
  mkdirSync(userDataPath, { recursive: true })
  writeFileSync(join(fallbackRuntimePath, 'package.json'), '{}\n')
  writeFileSync(join(userDataPath, 'desktop-state.json'), `${JSON.stringify({
    activeRuntime: fallbackRuntimePath,
    activeCommit: null,
    autoUpdate: false,
  })}\n`)

  const updater = new HarnessUpdater({ fallbackRuntimePath, userDataPath, onStatus: () => {} })
  assert.deepEqual(updater.loadState(), {
    activeRuntime: fallbackRuntimePath,
    activeVersion: null,
    pendingRuntime: null,
    pendingVersion: null,
    autoUpdate: false,
  })
})

test('HarnessUpdater checks and stages an isolated npm runtime', async t => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-desktop-npm-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const fallbackRuntimePath = join(root, 'checkout')
  const userDataPath = join(root, 'user-data')
  mkdirSync(fallbackRuntimePath, { recursive: true })
  writeFileSync(join(fallbackRuntimePath, 'package.json'), '{}\n')

  const commands = []
  const commandRunner = async (command, args, options) => {
    commands.push({ command, args, cwd: options.cwd })
    if (args[0] === 'view') return { code: 0, stdout: '"0.1.0-rc.5"\n', stderr: '' }

    const packageRoot = join(options.cwd, 'node_modules', '@deepseek-ai', 'dsh')
    mkdirSync(join(packageRoot, 'lib'), { recursive: true })
    writeFileSync(join(packageRoot, 'package.json'), '{"version":"0.1.0-rc.5"}\n')
    writeFileSync(join(packageRoot, 'lib', 'bin.js'), '// compiled CLI\n')
    options.onLine('installed 1 package')
    return { code: 0, stdout: '', stderr: '' }
  }
  const updater = new HarnessUpdater({
    fallbackRuntimePath,
    userDataPath,
    onStatus: () => {},
    commandRunner,
    npmCommandResolver: () => 'npm-test',
  })

  assert.deepEqual(await updater.check('0.1.0-rc.4'), {
    available: true,
    currentVersion: '0.1.0-rc.4',
    latestVersion: '0.1.0-rc.5',
  })
  const runtimePath = await updater.stage('0.1.0-rc.5')
  assert.equal(updater.runtimeReady(runtimePath, '0.1.0-rc.5'), true)
  assert.equal(commands[0].command, 'npm-test')
  assert.deepEqual(commands[0].args, ['view', '@deepseek-ai/dsh', 'dist-tags.latest', '--json'])
  assert.equal(commands[1].args.includes('--strict-allow-scripts'), true)
  assert.equal(commands[1].args.at(-1), '@deepseek-ai/dsh@0.1.0-rc.5')
  const runtimeManifest = JSON.parse(readFileSync(join(runtimePath, 'package.json'), 'utf8'))
  assert.deepEqual(runtimeManifest.allowScripts, RUNTIME_ALLOW_SCRIPTS)
})
