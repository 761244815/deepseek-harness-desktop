const phase = document.querySelector('#phase')
const title = document.querySelector('#title')
const detail = document.querySelector('#detail')
const logs = document.querySelector('#logs')
const signal = document.querySelector('#signal')
const retry = document.querySelector('#retry')
const timestamp = document.querySelector('#timestamp')
const steps = [...document.querySelectorAll('[data-step]')]

const phaseOrder = ['checking', 'updating', 'installing', 'building', 'starting', 'ready']
const stepPhase = {
  checking: 'checking',
  current: 'starting',
  updating: 'updating',
  installing: 'building',
  building: 'building',
  starting: 'starting',
  ready: 'ready',
  warning: 'starting',
  fallback: 'starting',
  error: 'starting',
}

function render(status) {
  phase.textContent = status.phase.toUpperCase()
  title.textContent = status.title
  detail.textContent = status.detail || ''
  logs.textContent = status.logs?.length ? status.logs.join('\n') : '等待进程输出...'
  logs.scrollTop = logs.scrollHeight
  retry.hidden = status.phase !== 'error'
  signal.className = `signal ${status.phase === 'ready' ? 'ready' : status.phase === 'error' ? 'error' : ['warning', 'fallback'].includes(status.phase) ? 'warning' : ''}`
  timestamp.textContent = new Date(status.updatedAt || Date.now()).toLocaleString('zh-CN', { hour12: false })

  const active = stepPhase[status.phase] || 'checking'
  const activeIndex = phaseOrder.indexOf(active)
  for (const item of steps) {
    const index = phaseOrder.indexOf(item.dataset.step)
    item.classList.toggle('active', item.dataset.step === active)
    item.classList.toggle('complete', index >= 0 && activeIndex > index)
  }
}

window.desktopShell.onStatus(render)
window.desktopShell.getStatus().then(render)
document.querySelector('#openLogs').addEventListener('click', () => window.desktopShell.openLogs())
retry.addEventListener('click', () => window.desktopShell.retry())
