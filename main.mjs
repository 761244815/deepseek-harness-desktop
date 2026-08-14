import { app, BrowserWindow, Menu, Tray, dialog, ipcMain, nativeImage, shell } from 'electron'
import electronUpdater from 'electron-updater'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { HarnessManager } from './lib/harness-manager.mjs'
import { HarnessUpdater } from './lib/updater.mjs'

const { autoUpdater: desktopAutoUpdater } = electronUpdater

const appDir = fileURLToPath(new URL('.', import.meta.url))
const defaultCheckout = process.env.DEEPSEEK_HARNESS_DIR || 'D:\\deepseek-harness'
let mainWindow
let tray
let manager
let updater
let busy = false
let desktopUpdateTimer
let currentStatus = {
  phase: 'idle',
  title: '准备启动',
  detail: defaultCheckout,
  logs: [],
}

function publishStatus(patch) {
  const logs = patch.log
    ? [...currentStatus.logs, patch.log].slice(-8)
    : currentStatus.logs
  currentStatus = { ...currentStatus, ...patch, logs, log: undefined, updatedAt: Date.now() }
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('shell:status', currentStatus)
}

async function showShell() {
  if (!mainWindow || mainWindow.isDestroyed()) return
  await mainWindow.loadFile(join(appDir, 'shell', 'index.html'))
  publishStatus({})
}

async function captureForQa(phase) {
  const target = process.env.DSH_DESKTOP_CAPTURE
  if (!target || process.env.DSH_DESKTOP_CAPTURE_PHASE !== phase) return false
  await new Promise(resolve => setTimeout(resolve, 750))
  const image = await mainWindow.webContents.capturePage()
  writeFileSync(target, image.toPNG())
  if (process.env.DSH_DESKTOP_CAPTURE_ONLY === '1') {
    setImmediate(() => app.quit())
    return true
  }
  return false
}

function activeState() {
  return updater.loadState()
}

async function startRuntime(runtimePath, commit = null) {
  const url = await manager.start(runtimePath)
  const state = activeState()
  updater.saveState({ ...state, activeRuntime: runtimePath, activeCommit: commit ?? state.activeCommit })
  await mainWindow.loadURL(url)
  mainWindow.setTitle('DeepSeek Harness')
  await captureForQa('ready')
}

async function bootstrap({ forceCheck = false } = {}) {
  if (busy) return
  busy = true
  await showShell()
  if (await captureForQa('shell')) {
    busy = false
    return
  }
  const state = activeState()
  let runtimePath = state.activeRuntime
  let stagedCommit = null

  try {
    if (!existsSync(join(runtimePath, 'package.json'))) runtimePath = defaultCheckout
    if (state.autoUpdate || forceCheck) {
      try {
        const update = await updater.check(runtimePath)
        if (update.available) {
          if (state.autoUpdate || forceCheck) {
            runtimePath = await updater.stage(update.remoteCommit)
            stagedCommit = update.remoteCommit
          }
        } else {
          publishStatus({ phase: 'current', title: '已是官方最新版本', detail: update.currentCommit.slice(0, 12) })
        }
      } catch (error) {
        publishStatus({ phase: 'warning', title: '更新检查未完成', detail: error.message, log: error.message })
      }
    }

    try {
      await startRuntime(runtimePath, stagedCommit)
    } catch (error) {
      if (runtimePath !== state.activeRuntime && existsSync(join(state.activeRuntime, 'package.json'))) {
        publishStatus({ phase: 'fallback', title: '新版本启动失败，正在恢复', detail: error.message, log: error.message })
        await startRuntime(state.activeRuntime, state.activeCommit)
      } else {
        throw error
      }
    }
  } catch (error) {
    publishStatus({ phase: 'error', title: '无法启动 DeepSeek Harness', detail: error.message, log: error.stack ?? error.message })
  } finally {
    busy = false
  }
}

async function checkForUpdatesInteractively() {
  if (busy) return
  const state = activeState()
  try {
    const update = await updater.check(state.activeRuntime)
    if (!update.available) {
      await dialog.showMessageBox(mainWindow, { type: 'info', title: '检查更新', message: '当前已经是官方最新版本。' })
      return
    }
    const answer = await dialog.showMessageBox(mainWindow, {
      type: 'question',
      buttons: ['更新并重启', '稍后'],
      defaultId: 0,
      cancelId: 1,
      title: '发现 Harness 更新',
      message: `发现新版本 ${update.remoteCommit.slice(0, 12)}`,
      detail: '新版本会在独立目录中编译，成功后才切换。',
    })
    if (answer.response === 0) await bootstrap({ forceCheck: true })
  } catch (error) {
    await dialog.showErrorBox('更新检查失败', error.message)
  }
}

async function checkDesktopUpdate({ interactive = false } = {}) {
  if (!app.isPackaged) {
    if (interactive) {
      await dialog.showMessageBox(mainWindow, {
        type: 'info',
        title: '桌面程序更新',
        message: '开发模式不检查桌面程序更新。',
      })
    }
    return
  }

  try {
    const result = await desktopAutoUpdater.checkForUpdates()
    if (interactive && result?.updateInfo?.version === app.getVersion()) {
      await dialog.showMessageBox(mainWindow, {
        type: 'info',
        title: '桌面程序更新',
        message: '当前已经是桌面程序的最新版本。',
      })
    }
  } catch (error) {
    updater.log(`Desktop update check failed: ${error.message}`)
    if (interactive) await dialog.showErrorBox('桌面程序更新检查失败', error.message)
  }
}

function configureDesktopUpdates() {
  if (!app.isPackaged) return
  desktopAutoUpdater.autoDownload = true
  desktopAutoUpdater.autoInstallOnAppQuit = true
  desktopAutoUpdater.on('update-available', info => {
    updater.log(`Desktop update ${info.version} is available`)
  })
  desktopAutoUpdater.on('update-downloaded', async info => {
    updater.log(`Desktop update ${info.version} is ready to install`)
    const answer = await dialog.showMessageBox(mainWindow, {
      type: 'info',
      buttons: ['立即重启安装', '退出时安装'],
      defaultId: 0,
      cancelId: 1,
      title: '桌面程序更新已就绪',
      message: `DeepSeek Harness Desktop ${info.version} 已下载完成。`,
    })
    if (answer.response === 0) desktopAutoUpdater.quitAndInstall(false, true)
  })
  desktopAutoUpdater.on('error', error => updater.log(`Desktop updater error: ${error.message}`))

  setTimeout(() => void checkDesktopUpdate(), 30_000)
  desktopUpdateTimer = setInterval(() => void checkDesktopUpdate(), 6 * 60 * 60_000)
  desktopUpdateTimer.unref()
}

function rebuildMenu() {
  const state = activeState()
  const menu = Menu.buildFromTemplate([
    {
      label: '应用',
      submenu: [
        { label: '重新启动 Harness', click: () => void bootstrap() },
        { label: '打开日志目录', click: () => void shell.openPath(join(app.getPath('userData'), 'logs')) },
        { type: 'separator' },
        { role: 'quit', label: '退出' },
      ],
    },
    {
      label: '更新',
      submenu: [
        { label: '立即检查官方更新', click: () => void checkForUpdatesInteractively() },
        { label: '检查桌面程序更新', click: () => void checkDesktopUpdate({ interactive: true }) },
        {
          label: '启动时自动更新 Harness',
          type: 'checkbox',
          checked: state.autoUpdate,
          click: item => {
            updater.saveState({ ...activeState(), autoUpdate: item.checked })
            rebuildMenu()
          },
        },
      ],
    },
    {
      label: '查看',
      submenu: [
        { role: 'reload', label: '重新加载界面' },
        { role: 'toggleDevTools', label: '开发者工具' },
        { type: 'separator' },
        { role: 'resetZoom', label: '实际大小' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
      ],
    },
  ])
  Menu.setApplicationMenu(menu)
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1240,
    height: 820,
    minWidth: 920,
    minHeight: 640,
    show: false,
    backgroundColor: '#f4f4f0',
    icon: join(appDir, 'assets', 'icon.png'),
    webPreferences: {
      preload: join(appDir, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  mainWindow.once('ready-to-show', () => mainWindow.show())
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const allowed = url.startsWith('file:') || /^http:\/\/127\.0\.0\.1:\d+\//.test(url)
    if (allowed) return
    event.preventDefault()
    if (/^https?:/.test(url)) void shell.openExternal(url)
  })
  void bootstrap()
}

function createTray() {
  const image = nativeImage.createFromPath(join(appDir, 'assets', 'icon.png'))
  if (image.isEmpty()) return
  tray = new Tray(image.resize({ width: 18, height: 18 }))
  tray.setToolTip('DeepSeek Harness')
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开 DeepSeek Harness', click: () => { mainWindow.show(); mainWindow.focus() } },
    { label: '重新启动服务', click: () => void bootstrap() },
    { label: '检查更新', click: () => void checkForUpdatesInteractively() },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() },
  ]))
  tray.on('double-click', () => { mainWindow.show(); mainWindow.focus() })
}

if (!app.requestSingleInstanceLock()) app.quit()
else {
  app.on('second-instance', () => { mainWindow?.show(); mainWindow?.focus() })
  app.whenReady().then(() => {
    app.setAppUserModelId('ai.deepseek.harness.desktop')
    const userData = app.getPath('userData')
    updater = new HarnessUpdater({ checkoutPath: defaultCheckout, userDataPath: userData, onStatus: publishStatus })
    manager = new HarnessManager({ logDir: join(userData, 'logs'), onStatus: publishStatus })
    rebuildMenu()
    createWindow()
    createTray()
    configureDesktopUpdates()
  })
}

ipcMain.handle('shell:get-status', () => currentStatus)
ipcMain.handle('shell:retry', () => bootstrap())
ipcMain.handle('shell:open-logs', () => shell.openPath(join(app.getPath('userData'), 'logs')))

app.on('before-quit', event => {
  if (desktopUpdateTimer) clearInterval(desktopUpdateTimer)
  if (!manager?.child) return
  event.preventDefault()
  void manager.stop().finally(() => {
    manager = null
    app.quit()
  })
})
