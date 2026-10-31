// 服务器版的可选「截图 + QQ 发送」模块
//
// 只有配了包根目录的 qq-shot.json 才会真正发图；没配 / 没配齐，就静默跳过，
// 不影响小屋本身任何功能。
//
// 依赖：
//   · Edge 无头浏览器（截图，Windows 上一般都有）
//   · 一个 OneBot HTTP API 实现（SnowLuma / LLOneBot / NapCat…）
//
// qq-shot.json 长这样：
//   {
//     "ownerQQ": 123456789,                  // 主人 QQ 号（截图发到 TA 的私聊）
//     "httpUrl": "http://127.0.0.1:3000",    // OneBot HTTP API 地址
//     "accessToken": "",                     // 可选，Bearer token
//     "notifyScreenshot": false,             // 改格局（添/拿/搬家具、搬家、增删房间）后自动发截图
//     "notifyOnMove": false,                 // 移动到别的房间后自动发截图
//     "askScreenshot": false                 // 被问「小屋怎么样」时发一张当前截图
//   }
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawn } from 'node:child_process'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const CFG_FILE = path.join(ROOT, 'qq-shot.json')

const EDGE_PATHS = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe'
]

const DEFAULTS = {
  ownerQQ: 0,
  httpUrl: '',
  accessToken: '',
  notifyScreenshot: false,
  notifyOnMove: false,
  askScreenshot: false
}

/** 读配置；文件不存在就返回全默认（等于关闭）。 */
export function readQqConfig() {
  try {
    let raw = fs.readFileSync(CFG_FILE, 'utf8')
    if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1)
    const j = JSON.parse(raw) || {}
    return {
      ownerQQ: Number(j.ownerQQ) || 0,
      httpUrl: String(j.httpUrl || '').trim().replace(/\/+$/, ''),
      accessToken: String(j.accessToken || '').trim(),
      notifyScreenshot: j.notifyScreenshot === true,
      notifyOnMove: j.notifyOnMove === true,
      askScreenshot: j.askScreenshot === true
    }
  } catch {
    return { ...DEFAULTS }
  }
}

export function writeQqConfig(patch) {
  const next = { ...readQqConfig(), ...(patch || {}) }
  const clean = {
    ownerQQ: Number(next.ownerQQ) || 0,
    httpUrl: String(next.httpUrl || '').trim(),
    accessToken: String(next.accessToken || '').trim(),
    notifyScreenshot: next.notifyScreenshot === true,
    notifyOnMove: next.notifyOnMove === true,
    askScreenshot: next.askScreenshot === true
  }
  fs.mkdirSync(ROOT, { recursive: true })
  fs.writeFileSync(CFG_FILE, JSON.stringify(clean, null, 2) + '\n', 'utf8')
  return clean
}

/** 通道配齐了没有（能发图的最低条件）。 */
function channelReady() {
  const cfg = readQqConfig()
  return cfg.ownerQQ > 0 && cfg.httpUrl.length > 0
}

function latestHousePage() {
  const dir = path.join(ROOT, 'exports')
  try {
    const files = fs.readdirSync(dir)
      .filter((f) => f.endsWith('小房子.html'))
      .map((f) => ({ f, m: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.m - a.m)
    return files.length ? path.join(dir, files[0].f) : ''
  } catch {
    return ''
  }
}

/** 把房子页截成 PNG，返回图片路径；失败抛错。 */
async function renderHouseShot() {
  const page = latestHousePage()
  if (!page) throw new Error('还没有房子页')
  const edge = EDGE_PATHS.find((p) => fs.existsSync(p))
  if (!edge) throw new Error('没找到 Edge（截图需要 msedge.exe）')
  const out = path.join(ROOT, 'state', 'house-shot.png')
  try { fs.rmSync(out, { force: true }) } catch { /* 忽略 */ }
  const profile = path.join(ROOT, 'state', 'shot-profile')
  const args = [
    '--headless=new', '--disable-gpu', '--no-sandbox',
    `--user-data-dir=${profile}`, '--hide-scrollbars',
    '--virtual-time-budget=5000', '--window-size=1280,1700',
    `--screenshot=${out}`, pathToFileURL(page).href
  ]
  await new Promise((resolve, reject) => {
    const child = spawn(edge, args, { stdio: 'ignore', windowsHide: true })
    const timer = setTimeout(() => { try { child.kill() } catch { /* 忽略 */ } reject(new Error('截图超时（20 秒）')) }, 20000)
    child.once('error', (e) => { clearTimeout(timer); reject(e) })
    child.once('exit', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve()
      else reject(new Error('截图进程退出码 ' + code))
    })
  })
  if (!fs.existsSync(out)) throw new Error('截图没生成')
  return out
}

async function sendImageToQQ(kind, id, file) {
  const cfg = readQqConfig()
  if (!cfg.httpUrl) throw new Error('没配 OneBot httpUrl')
  const buffer = fs.readFileSync(file)
  const segments = [{ type: 'image', data: { file: 'base64://' + buffer.toString('base64') } }]
  const action = kind === 'private' ? 'send_private_msg' : 'send_group_msg'
  const params = kind === 'private' ? { user_id: Number(id), message: segments } : { group_id: Number(id), message: segments }
  const res = await fetch(`${cfg.httpUrl}/${action}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(cfg.accessToken ? { authorization: `Bearer ${cfg.accessToken}` } : {})
    },
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(30000)
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok || body.status !== 'ok' || body.retcode !== 0) {
    throw new Error(`发送图片失败：${body.wording || body.retcode || res.status}`)
  }
  return body.data
}

/** 核心发送：截图 → 发到主人私聊。失败静默（不打扰主流程）。 */
async function shotToOwner() {
  if (!channelReady()) return
  try {
    const shot = await renderHouseShot()
    await sendImageToQQ('private', readQqConfig().ownerQQ, shot)
  } catch { /* 截图/发送失败都静默 */ }
}

/** 改格局 / 移动后触发（fire-and-forget，不阻塞动作）。 */
export function notifyHouseChanged(reason = 'layout') {
  const cfg = readQqConfig()
  const enabled = reason === 'move' ? cfg.notifyOnMove : cfg.notifyScreenshot
  if (!enabled) return
  void shotToOwner()
}

/** 被问小屋时触发（fire-and-forget）。 */
export function notifyHouseAsk() {
  if (!readQqConfig().askScreenshot) return
  void shotToOwner()
}
