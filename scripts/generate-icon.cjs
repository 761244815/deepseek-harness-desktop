const { app, BrowserWindow } = require('electron')
const { writeFileSync } = require('node:fs')
const { join } = require('node:path')

app.whenReady().then(async () => {
  const root = join(__dirname, '..')
  const window = new BrowserWindow({
    width: 512,
    height: 512,
    show: false,
    frame: false,
    backgroundColor: '#315efb',
  })
  const timeout = setTimeout(() => {
    console.error('Icon rendering timed out')
    app.exit(1)
  }, 10_000)
  await window.loadFile(join(__dirname, 'icon.html'))
  await new Promise(resolve => setTimeout(resolve, 500))
  const image = await window.webContents.capturePage({ x: 0, y: 0, width: 512, height: 512 })
  writeFileSync(join(root, 'assets', 'icon.png'), image.toPNG())
  clearTimeout(timeout)
  window.destroy()
  app.exit(0)
}).catch(error => {
  console.error(error)
  app.exit(1)
})
