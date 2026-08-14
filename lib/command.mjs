import { spawn } from 'node:child_process'

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
