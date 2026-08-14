import { spawn } from 'node:child_process'
import { createWriteStream, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { resolveHarnessLaunch } from './command.mjs'

export function extractHarnessUrl(value) {
  return value.match(/dsh web:\s+(http:\/\/127\.0\.0\.1:\d+)/)?.[1] ?? null
}

async function waitForHealth(url, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2_000) })
      if (response.ok && (await response.text()).includes('<title>DeepSeek Harness</title>')) return
    } catch {
      // The server can print its URL just before it starts accepting requests.
    }
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  throw new Error('DeepSeek Harness health check timed out')
}

function killTree(pid) {
  if (!pid) return Promise.resolve()
  return new Promise(resolve => {
    if (process.platform !== 'win32') {
      try { process.kill(pid, 'SIGTERM') } catch {}
      resolve()
      return
    }
    const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
    })
    killer.once('exit', resolve)
    killer.once('error', resolve)
  })
}

export class HarnessManager {
  constructor({ logDir, onStatus }) {
    this.logDir = logDir
    this.onStatus = onStatus
    this.child = null
    this.expectedStop = false
    mkdirSync(logDir, { recursive: true })
  }

  async start(runtimePath) {
    if (!existsSync(join(runtimePath, 'package.json'))) {
      throw new Error(`Harness runtime is missing: ${runtimePath}`)
    }
    await this.stop()

    const logPath = join(this.logDir, 'harness.log')
    const log = createWriteStream(logPath, { flags: 'a' })
    this.expectedStop = false
    this.onStatus({ phase: 'starting', title: '正在启动服务', detail: runtimePath })
    const launch = resolveHarnessLaunch(runtimePath)
    log.write(`\n[${new Date().toISOString()}] Starting ${runtimePath} (${launch.mode})\n`)
    const child = spawn(launch.command, launch.args, {
      cwd: runtimePath,
      windowsHide: true,
      shell: launch.shell,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    this.child = child

    return await new Promise((resolve, reject) => {
      let combined = ''
      let settled = false
      const timeout = setTimeout(() => finish(new Error('DeepSeek Harness startup timed out')), 90_000)

      const finish = async error => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        if (error) {
          log.write(`[${new Date().toISOString()}] ${error.stack ?? error.message}\n`)
          log.end()
          await this.stop()
          reject(error)
        }
      }

      const consume = async (chunk, source) => {
        const text = chunk.toString()
        combined = `${combined}${text}`.slice(-16_384)
        log.write(`[${source}] ${text}`)
        const url = extractHarnessUrl(combined)
        if (!url || settled) return
        try {
          await waitForHealth(url)
          if (settled) return
          settled = true
          clearTimeout(timeout)
          this.onStatus({ phase: 'ready', title: '服务已就绪', detail: url })
          resolve(url)
        } catch (error) {
          await finish(error)
        }
      }

      child.stdout.on('data', chunk => void consume(chunk, 'stdout'))
      child.stderr.on('data', chunk => void consume(chunk, 'stderr'))
      child.once('error', finish)
      child.once('exit', code => {
        log.write(`[${new Date().toISOString()}] Process exited with code ${code ?? 'unknown'}\n`)
        if (!settled) {
          void finish(new Error(`DeepSeek Harness exited with code ${code ?? 'unknown'}`))
          return
        }
        log.end()
        if (!this.expectedStop) {
          this.onStatus({ phase: 'error', title: '服务已停止', detail: `退出码 ${code ?? 'unknown'}` })
        }
        if (this.child === child) this.child = null
      })
    })
  }

  async stop() {
    const child = this.child
    if (!child) return
    this.expectedStop = true
    this.child = null
    await killTree(child.pid)
  }
}
