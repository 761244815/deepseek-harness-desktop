import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RUNTIME_ALLOW_SCRIPTS } from '../lib/updater.mjs'

const packageSpec = process.env.DSH_SMOKE_PACKAGE_SPEC || '@deepseek-ai/dsh@latest'
const runtimePath = mkdtempSync(join(tmpdir(), 'dsh-npm-smoke-'))
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm'

function killTree(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  if (process.platform !== 'win32') {
    child.kill('SIGTERM')
    return Promise.resolve()
  }
  return new Promise(resolve => {
    const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
    })
    killer.once('exit', resolve)
    killer.once('error', resolve)
  })
}

function run(command, args, { cwd, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      windowsHide: true,
      shell: process.platform === 'win32' && /\.cmd$/i.test(command),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    const consume = chunk => {
      const value = chunk.toString()
      output += value
      process.stdout.write(value)
    }
    child.stdout.on('data', consume)
    child.stderr.on('data', consume)
    const timeout = setTimeout(() => {
      void killTree(child)
      reject(new Error(`${command} timed out after ${timeoutMs}ms`))
    }, timeoutMs)
    child.once('error', error => {
      clearTimeout(timeout)
      reject(error)
    })
    child.once('exit', code => {
      clearTimeout(timeout)
      if (code === 0) resolve(output)
      else reject(new Error(`${command} exited with code ${code ?? 'unknown'}\n${output}`))
    })
  })
}

function startHarness(entrypoint) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entrypoint, 'web', '--host', '127.0.0.1', '--port', '0'], {
      cwd: runtimePath,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    let settled = false
    const finish = (error, url) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      if (error) reject(error)
      else resolve({ child, url })
    }
    const consume = chunk => {
      const value = chunk.toString()
      output = `${output}${value}`.slice(-16_384)
      process.stdout.write(value)
      const url = output.match(/dsh web:\s+(http:\/\/127\.0\.0\.1:\d+)/)?.[1]
      if (url) finish(null, url)
    }
    child.stdout.on('data', consume)
    child.stderr.on('data', consume)
    child.once('error', finish)
    child.once('exit', code => finish(new Error(`Harness exited with code ${code ?? 'unknown'}\n${output}`)))
    const timeout = setTimeout(() => {
      void killTree(child)
      finish(new Error(`Harness did not publish a URL within 120 seconds\n${output}`))
    }, 120_000)
  })
}

function verifyTerminalRuntime() {
  const require = createRequire(join(runtimePath, 'package.json'))
  const pty = require('node-pty')
  const token = `dsh-terminal-smoke-${Date.now()}`
  const command = process.platform === 'win32' ? (process.env.ComSpec || 'cmd.exe') : '/bin/sh'
  const args = process.platform === 'win32'
    ? ['/d', '/s', '/c', `echo ${token}`]
    : ['-c', `printf ${token}`]

  return new Promise((resolve, reject) => {
    const terminal = pty.spawn(command, args, {
      cols: 80,
      rows: 24,
      cwd: runtimePath,
      env: process.env,
    })
    let output = ''
    const timeout = setTimeout(() => {
      terminal.kill()
      reject(new Error(`node-pty smoke test timed out\n${output}`))
    }, 15_000)
    const dataSubscription = terminal.onData(data => {
      output += data
    })
    const exitSubscription = terminal.onExit(({ exitCode }) => {
      clearTimeout(timeout)
      dataSubscription.dispose()
      exitSubscription.dispose()
      if (exitCode === 0 && output.includes(token)) resolve()
      else reject(new Error(`node-pty smoke test failed with code ${exitCode}\n${output}`))
    })
  })
}

async function waitForHealth(url) {
  const deadline = Date.now() + 45_000
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2_000) })
      if (response.ok && (await response.text()).includes('<title>DeepSeek Harness</title>')) return
    } catch {
      // The URL can be printed just before the listener accepts requests.
    }
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  throw new Error(`Harness health check timed out: ${url}`)
}

let harness
let smokeError
try {
  writeFileSync(join(runtimePath, 'package.json'), `${JSON.stringify({
    name: 'dsh-npm-smoke',
    private: true,
    allowScripts: RUNTIME_ALLOW_SCRIPTS,
  }, null, 2)}\n`)
  await run(npmCommand, [
    'install',
    '--omit=dev',
    '--no-audit',
    '--no-fund',
    '--strict-allow-scripts',
    '--save-exact',
    packageSpec,
  ], { cwd: runtimePath, timeoutMs: 10 * 60_000 })

  const packageRoot = join(runtimePath, 'node_modules', '@deepseek-ai', 'dsh')
  const entrypoint = join(packageRoot, 'lib', 'bin.js')
  if (!existsSync(entrypoint)) throw new Error(`Published CLI entrypoint is missing: ${entrypoint}`)
  const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'))
  process.stdout.write(`Testing @deepseek-ai/dsh ${manifest.version}\n`)
  await verifyTerminalRuntime()
  process.stdout.write('Harness terminal runtime is healthy\n')

  harness = await startHarness(entrypoint)
  await waitForHealth(harness.url)
  process.stdout.write(`Harness npm runtime is healthy: ${harness.url}\n`)
} catch (error) {
  smokeError = error
} finally {
  await killTree(harness?.child)
  try {
    rmSync(runtimePath, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 })
  } catch (error) {
    process.stderr.write(`Warning: could not remove smoke runtime ${runtimePath}: ${error.message}\n`)
  }
}

if (smokeError) {
  process.stderr.write(`${smokeError.stack ?? smokeError.message}\n`)
  process.exit(1)
}
process.exit(0)
