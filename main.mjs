import { app, BrowserWindow, Menu, Tray, dialog, ipcMain, nativeImage, shell } from 'electron'
import electronUpdater from 'electron-updater'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { HarnessManager } from './lib/harness-manager.mjs'
import { HARNESS_PACKAGE, HarnessUpdater } from './lib/updater.mjs'

const { autoUpdater: desktopAutoUpdater } = electronUpdater

const appDir = fileURLToPath(new URL('.', import.meta.url))
const fallbackCheckout = process.env.DEEPSEEK_HARNESS_DIR || 'D:\\deepseek-harness'
let mainWindow
let tray
let manager
let updater
let busy = false
let harnessUpdateBusy = false
let harnessUpdateInitialTimer
let harnessUpdateTimer
let desktopUpdateTimer
let currentStatus = {
  phase: 'idle',
  title: '准备启动',
  detail: HARNESS_PACKAGE,
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

async function startRuntime(runtimePath, version = null) {
  const url = await manager.start(runtimePath)
  const state = activeState()
  updater.saveState({
    ...state,
    activeRuntime: runtimePath,
    activeVersion: version ?? updater.versionAt(runtimePath),
    pendingRuntime: null,
    pendingVersion: null,
  })
  await mainWindow.loadURL(url)
  mainWindow.setTitle('DeepSeek Harness')
  await captureForQa('ready')
}

async function bootstrap({ runtimePath: requestedRuntime = null, runtimeVersion: requestedVersion = null } = {}) {
  if (busy) return
  busy = true
  await showShell()
  if (await captureForQa('shell')) {
    busy = false
    return
  }
  const state = activeState()
  let activeRuntime = existsSync(join(state.activeRuntime, 'package.json'))
    ? state.activeRuntime
    : null
  let runtimePath = requestedRuntime ?? state.pendingRuntime ?? activeRuntime
  let runtimeVersion = requestedVersion
    ?? (runtimePath === state.pendingRuntime ? state.pendingVersion : state.activeVersion)
  let started = false

  try {
    if (runtimePath === null) {
      publishStatus({ phase: 'checking', title: '正在准备首次运行', detail: `${HARNESS_PACKAGE} (npm latest)` })
      const initial = await updater.check(null)
      runtimePath = await updater.stage(initial.latestVersion)
      runtimeVersion = initial.latestVersion
      activeRuntime = runtimePath
    }
    try {
      await startRuntime(runtimePath, runtimeVersion)
      started = true
    } catch (error) {
      if (runtimePath !== activeRuntime
        && activeRuntime !== null
        && existsSync(join(activeRuntime, 'package.json'))) {
        publishStatus({ phase: 'fallback', title: '新版本启动失败，正在恢复', detail: error.message, log: error.message })
        await startRuntime(activeRuntime, state.activeVersion)
        started = true
      } else {
        throw error
      }
    }
  } catch (error) {
    publishStatus({ phase: 'error', title: '无法启动 DeepSeek Harness', detail: error.message, log: error.stack ?? error.message })
  } finally {
    busy = false
  }
  if (started) scheduleHarnessUpdateChecks()
}

async function prepareHarnessUpdate({ interactive = false } = {}) {
  if (harnessUpdateBusy) {
    if (interactive) {
      await dialog.showMessageBox(mainWindow, { type: 'info', title: 'Harness 更新', message: '更新任务正在进行。' })
    }
    return
  }
  const state = activeState()
  if (state.pendingRuntime && state.pendingVersion) {
    if (!interactive) return
    const pendingAnswer = await dialog.showMessageBox(mainWindow, {
      type: 'question',
      buttons: ['立即重启', '稍后'],
      defaultId: 0,
      cancelId: 1,
      title: 'Harness 更新已就绪',
      message: `正式版 ${state.pendingVersion} 已准备完成。`,
    })
    if (pendingAnswer.response === 0) {
      await bootstrap({ runtimePath: state.pendingRuntime, runtimeVersion: state.pendingVersion })
    }
    return
  }

  harnessUpdateBusy = true
  try {
    const currentVersion = state.activeVersion ?? updater.versionAt(state.activeRuntime)
    const update = await updater.check(currentVersion)
    if (!update.available) {
      if (interactive) {
        await dialog.showMessageBox(mainWindow, {
          type: 'info',
          title: 'Harness 更新',
          message: `当前已经是 npm 正式版 ${update.latestVersion}。`,
        })
      }
      return
    }

    if (interactive) {
      const downloadAnswer = await dialog.showMessageBox(mainWindow, {
        type: 'question',
        buttons: ['下载并准备', '稍后'],
        defaultId: 0,
        cancelId: 1,
        title: '发现 Harness 正式版更新',
        message: `发现 npm 正式版 ${update.latestVersion}。`,
        detail: '新版本会安装到独立目录，验证成功后才切换。',
      })
      if (downloadAnswer.response !== 0) return
    }

    const runtimePath = await updater.stage(update.latestVersion)
    updater.saveState({
      ...activeState(),
      pendingRuntime: runtimePath,
      pendingVersion: update.latestVersion,
    })
    updater.log(`Harness ${update.latestVersion} is ready and will be activated on the next start`)

    if (interactive) {
      const restartAnswer = await dialog.showMessageBox(mainWindow, {
        type: 'question',
        buttons: ['立即重启', '下次启动'],
        defaultId: 0,
        cancelId: 1,
        title: 'Harness 更新已就绪',
        message: `正式版 ${update.latestVersion} 已安装并验证。`,
      })
      if (restartAnswer.response === 0) {
        await bootstrap({ runtimePath, runtimeVersion: update.latestVersion })
      }
    }
  } catch (error) {
    updater.log(`Harness update failed: ${error.message}`)
    if (interactive) dialog.showErrorBox('Harness 更新失败', error.message)
  } finally {
    harnessUpdateBusy = false
  }
}

function checkForUpdatesInteractively() {
  return prepareHarnessUpdate({ interactive: true })
}

function scheduleHarnessUpdateChecks() {
  if (harnessUpdateInitialTimer) clearTimeout(harnessUpdateInitialTimer)
  if (harnessUpdateTimer) clearInterval(harnessUpdateTimer)
  if (!activeState().autoUpdate) return

  harnessUpdateInitialTimer = setTimeout(() => void prepareHarnessUpdate(), 10_000)
  harnessUpdateInitialTimer.unref()
  harnessUpdateTimer = setInterval(() => void prepareHarnessUpdate(), 6 * 60 * 60_000)
  harnessUpdateTimer.unref()
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
        { label: '立即检查 Harness 正式版更新', click: () => void checkForUpdatesInteractively() },
        { label: '检查桌面程序更新', click: () => void checkDesktopUpdate({ interactive: true }) },
        {
          label: '后台自动更新 Harness',
          type: 'checkbox',
          checked: state.autoUpdate,
          click: item => {
            updater.saveState({ ...activeState(), autoUpdate: item.checked })
            rebuildMenu()
            scheduleHarnessUpdateChecks()
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
    updater = new HarnessUpdater({ fallbackRuntimePath: fallbackCheckout, userDataPath: userData, onStatus: publishStatus })
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
  if (harnessUpdateInitialTimer) clearTimeout(harnessUpdateInitialTimer)
  if (harnessUpdateTimer) clearInterval(harnessUpdateTimer)
  if (desktopUpdateTimer) clearInterval(desktopUpdateTimer)
  if (!manager?.child) return
  event.preventDefault()
  void manager.stop().finally(() => {
    manager = null
    app.quit()
  })
})
