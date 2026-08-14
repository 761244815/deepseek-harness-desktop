import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { delimiter, join } from 'node:path'

export function resolvePnpmCommand({
  env = process.env,
  platform = process.platform,
  fileExists = existsSync,
} = {}) {
  if (platform !== 'win32') return 'pnpm'

  const pathValue = env.Path ?? env.PATH ?? ''
  const candidates = [
    env.PNPM_HOME && join(env.PNPM_HOME, 'pnpm.cmd'),
    env.APPDATA && join(env.APPDATA, 'npm', 'pnpm.cmd'),
    ...pathValue.split(delimiter).filter(Boolean).map(directory => join(directory, 'pnpm.cmd')),
  ].filter(Boolean)
  const command = candidates.find(candidate => fileExists(candidate))
  if (command) return command

  throw new Error('pnpm is required. Install pnpm 11.7.0 or newer, then restart DeepSeek Harness Desktop.')
}

function terminateProcess(child) {
  if (child.exitCode !== null || child.signalCode !== null) return
  if (process.platform === 'win32' && child.pid) {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
    })
    return
  }
  child.kill('SIGTERM')
}

export function runCommand(command, args, options = {}) {
  const {
    cwd,
    env = process.env,
    onLine = () => {},
    timeoutMs = 60_000,
    allowFailure = false,
  } = options

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      windowsHide: true,
      shell: process.platform === 'win32' && /\.cmd$/i.test(command),
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''
    let settled = false

    const consume = (source, chunk) => {
      const value = chunk.toString()
      if (source === 'stdout') stdout += value
      else stderr += value
      for (const line of value.split(/\r?\n/)) {
        if (line.trim()) onLine(line, source)
      }
    }

    child.stdout.on('data', chunk => consume('stdout', chunk))
    child.stderr.on('data', chunk => consume('stderr', chunk))

    const timeout = setTimeout(() => {
      if (settled) return
      settled = true
      terminateProcess(child)
      reject(new Error(`${command} timed out after ${timeoutMs}ms`))
    }, timeoutMs)

    child.once('error', error => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      reject(error)
    })

    child.once('exit', code => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      const result = { code: code ?? 1, stdout, stderr }
      if (result.code === 0 || allowFailure) resolve(result)
      else reject(new Error(`${command} exited with code ${result.code}\n${stderr || stdout}`))
    })
  })
}
