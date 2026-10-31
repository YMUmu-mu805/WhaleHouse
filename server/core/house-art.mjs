// 房间平面示意图：把「一间屋 + 几件家具」画成一张 SVG 小平面图。
//
// 为什么手画而不用 emoji：家具名是随手写的中文短句（"塌了一角的旧沙发"），
// emoji 只能表达"沙发"这一层，画出来每间屋都一样。这里按关键词挑一个基本形体
// （沙发/床/屏幕/桌/水/植物/箱/灯…），再摆进房间的格子里，至少能看出"这屋长什么样"。
//
// 纯字符串生成，不依赖浏览器/画布；渲染在 house.mjs 的页面里。

const FLOOR = '#231c17'
const WALL = '#5a4b3d'
const MUTE = '#c3b29c'

const C = {
  seat: '#9c7850', seatDark: '#7d5f3f', bed: '#7f6288', pillow: '#dccfe4',
  screen: '#3f4f5a', table: '#a67f4e', water: '#4a8490', plant: '#5f8549',
  box: '#96794f', light: '#f0c07a', paper: '#cfb691', appliance: '#717981',
  metal: '#8b939e', rug: '#6c5a48', glass: '#8fb0bd'
}

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
const round = (n) => Math.round(n * 10) / 10

function labelFor(item) {
  const s = String(item || '').replace(/（[^）]*）/g, '').replace(/\([^)]*\)/g, '').trim()
  return s.length > 7 ? s.slice(0, 7) + '…' : s
}

/** 家具 → 形体（俯视图）。坐标以 cx,cy 为中心，w/h 为可用尺寸。 */
function drawItem(item, cx, cy, w, h) {
  const s = String(item || '')
  const R = (x, y, ww, hh, fill, rx = 2, extra = '') =>
    `<rect x="${round(x)}" y="${round(y)}" width="${round(max(1, ww))}" height="${round(max(1, hh))}" rx="${rx}" fill="${fill}" ${extra}/>`
  const Ci = (x, y, r, fill, extra = '') => `<circle cx="${round(x)}" cy="${round(y)}" r="${round(r)}" fill="${fill}" ${extra}/>`
  const L = (x1, y1, x2, y2, stroke, sw = 1.4, extra = '') =>
    `<line x1="${round(x1)}" y1="${round(y1)}" x2="${round(x2)}" y2="${round(y2)}" stroke="${stroke}" stroke-width="${sw}" stroke-linecap="round" ${extra}/>`
  const P = (d, fill, extra = '') => `<path d="${d}" fill="${fill}" ${extra}/>`
  const x = cx - w / 2
  const y = cy - h / 2
  const max = Math.max

  // 顺序重要：越具体的越先判（"床边的地毯" 不能被 /床/ 抓走）
  if (/地毯/.test(s)) {
    return `<ellipse cx="${round(cx)}" cy="${round(cy)}" rx="${round(w * 0.46)}" ry="${round(h * 0.32)}" fill="${C.rug}"/>`
      + L(cx - w * 0.4, cy + h * 0.3, cx + w * 0.4, cy + h * 0.3, '#8a7355', 1)
  }
  if (/泳池|浴缸/.test(s)) {
    return R(x, y, w, h, C.water, 5)
      + `<path d="M${round(x + 5)} ${round(cy + 3)} q ${round(w / 6)} -4 ${round(w / 3)} 0 q ${round(w / 6)} 4 ${round(w / 3)} 0" fill="none" stroke="#cfeaf0" stroke-width="1.2" opacity=".85"/>`
      + R(x + 3, y + 3, w - 6, h - 6, 'none', 4, 'stroke="#cfeaf0" stroke-width=".8" opacity=".45"')
  }
  if (/淋浴/.test(s)) {
    return R(x, y, w, h, C.glass, 4, 'opacity=".55"')
      + Ci(cx - w * 0.18, cy - h * 0.2, 2, '#e8f4f7')
      + Ci(cx, cy, 2, '#e8f4f7') + Ci(cx + w * 0.18, cy + h * 0.2, 2, '#e8f4f7')
  }
  if (/鱼缸/.test(s)) {
    return R(x + w * 0.1, y + h * 0.1, w * 0.8, h * 0.8, '#3f7380', 2, 'stroke="#9fc6cf" stroke-width="1"')
      + `<path d="M${round(x + w * 0.2)} ${round(cy)} q ${round(w * 0.1)} ${round(-h * 0.12)} ${round(w * 0.2)} 0" fill="none" stroke="#f0d9a0" stroke-width="1.6"/>`
      + Ci(x + w * 0.22, cy - h * 0.02, 1.6, '#f0d9a0')
  }
  if (/沙发|懒人|藤椅/.test(s)) {
    return R(x, y + h * 0.06, w, h * 0.72, C.seat, 5)
      + R(x + 2, y + h * 0.72, w - 4, h * 0.16, C.seatDark, 3)
      + R(x + 3, y + h * 0.2, w * 0.44, h * 0.4, '#b08a5e', 3)
      + R(x + w * 0.51, y + h * 0.2, w * 0.44, h * 0.4, '#b08a5e', 3)
  }
  if (/椅|凳|榻榻米/.test(s)) {
    return R(x + w * 0.12, y + h * 0.1, w * 0.76, h * 0.62, C.seat, 4)
      + R(x + w * 0.12, y + h * 0.72, w * 0.76, h * 0.1, C.seatDark, 2)
      + L(x + w * 0.18, y + h * 0.1, x + w * 0.18, y - h * 0.04, C.seatDark, 3)
      + L(x + w * 0.82, y + h * 0.1, x + w * 0.82, y - h * 0.04, C.seatDark, 3)
  }
  if (/床/.test(s)) {
    return R(x, y, w, h, C.bed, 5)
      + R(x + 4, y + 4, w * 0.34, h - 8, C.pillow, 3)
      + `<path d="M${round(x + w * 0.5)} ${round(y + 5)} h ${round(w * 0.42)} v ${round(h - 10)} h ${round(-w * 0.42)}" fill="none" stroke="#b9a5c4" stroke-width="1" opacity=".7"/>`
  }
  if (/电视|投影/.test(s)) {
    return R(x + w * 0.08, y + h * 0.06, w * 0.84, h * 0.56, '#232a30', 3)
      + R(x + w * 0.12, y + h * 0.1, w * 0.76, h * 0.48, C.screen, 2)
      + R(x + w * 0.4, y + h * 0.64, w * 0.2, h * 0.12, C.metal, 1)
      + L(x + w * 0.16, y + h * 0.82, x + w * 0.84, y + h * 0.82, C.metal, 2)
  }
  if (/冰箱/.test(s)) {
    return R(x + w * 0.18, y, w * 0.64, h, C.appliance, 3)
      + L(x + w * 0.18, y + h * 0.38, x + w * 0.82, y + h * 0.38, '#4d545c', 1.2)
      + L(x + w * 0.72, y + h * 0.14, x + w * 0.72, y + h * 0.3, '#4d545c', 2)
  }
  if (/灶台|电磁炉|咖啡机/.test(s)) {
    return R(x, y + h * 0.1, w, h * 0.7, C.appliance, 4)
      + Ci(cx - w * 0.22, cy, max(3, min(w, h) * 0.14), '#2f353b')
      + Ci(cx + w * 0.2, cy, max(2.6, min(w, h) * 0.11), '#2f353b')
  }
  if (/烧水壶/.test(s)) {
    return Ci(cx, cy + 1, min(w, h) * 0.22, C.appliance)
      + L(cx + w * 0.18, cy + 1, cx + w * 0.42, cy - h * 0.16, C.appliance, 2)
      + L(cx - w * 0.22, cy + 1, cx - w * 0.02, cy - h * 0.26, C.metal, 1.6)
  }
  if (/桌|几/.test(s)) {
    return R(x, y + h * 0.22, w, h * 0.5, C.table, 3)
      + L(x + w * 0.14, y + h * 0.72, x + w * 0.1, y + h * 0.92, '#7a5c33', 2)
      + L(x + w * 0.86, y + h * 0.72, x + w * 0.9, y + h * 0.92, '#7a5c33', 2)
  }
  if (/台灯|夜灯|灯/.test(s)) {
    return P(`M${round(cx - w * 0.24)} ${round(cy - h * 0.06)} L${round(cx + w * 0.24)} ${round(cy - h * 0.06)} L${round(cx + w * 0.14)} ${round(cy - h * 0.34)} L${round(cx - w * 0.14)} ${round(cy - h * 0.34)} Z`, C.light)
      + L(cx, cy - h * 0.06, cx, cy + h * 0.26, C.metal, 2)
      + L(cx - w * 0.2, cy + h * 0.3, cx + w * 0.2, cy + h * 0.3, C.metal, 2)
  }
  if (/电脑/.test(s)) {
    return R(x + w * 0.04, y + h * 0.08, w * 0.72, h * 0.5, '#232a30', 2)
      + R(x + w * 0.08, y + h * 0.12, w * 0.64, h * 0.42, C.screen, 1.5)
      + R(x + w * 0.04, y + h * 0.66, w * 0.92, h * 0.18, C.metal, 1.5)
      + Ci(x + w * 0.2, y + h * 0.75, 1.2, '#4d545c')
  }
  if (/书|日记|笔记本|海报/.test(s)) {
    return R(x, y + h * 0.42, w, h * 0.16, '#8c6f4a', 1)
      + R(x + w * 0.05, y + h * 0.22, w, h * 0.16, '#a58257', 1)
      + R(x + w * 0.02, y + h * 0.62, w * 0.95, h * 0.16, '#c2a06e', 1)
  }
  if (/绿植|芭蕉|花|盆栽|植物/.test(s)) {
    const r = min(w, h) * 0.2
    return P(`M${round(cx - w * 0.16)} ${round(cy + h * 0.26)} L${round(cx - w * 0.1)} ${round(cy - h * 0.02)} L${round(cx + w * 0.1)} ${round(cy - h * 0.02)} L${round(cx + w * 0.16)} ${round(cy + h * 0.26)} Z`, '#7a5a3a')
      + Ci(cx - w * 0.18, cy - h * 0.1, r, C.plant)
      + Ci(cx + w * 0.16, cy - h * 0.16, r * 0.9, C.plant)
      + Ci(cx, cy - h * 0.26, r * 0.8, '#729c5a')
  }
  if (/纸箱|箱|网/.test(s)) {
    return R(x + w * 0.06, y + h * 0.16, w * 0.88, h * 0.64, C.box, 1)
      + L(cx, y + h * 0.16, cx, y + h * 0.8, '#6b5535', 1.2)
      + L(x + w * 0.06, y + h * 0.3, x + w * 0.94, y + h * 0.3, '#6b5535', 1)
  }
  if (/镜/.test(s)) {
    return `<ellipse cx="${round(cx)}" cy="${round(cy)}" rx="${round(w * 0.26)}" ry="${round(h * 0.34)}" fill="${C.glass}"/>`
      + `<ellipse cx="${round(cx - w * 0.08)}" cy="${round(cy - h * 0.1)}" rx="${round(w * 0.06)}" ry="${round(h * 0.1)}" fill="#e6f2f6" opacity=".8"/>`
  }
  if (/晾衣|栏杆|护栏|绳/.test(s)) {
    return L(x + w * 0.08, cy - h * 0.12, x + w * 0.92, cy - h * 0.12, C.metal, 2.2)
      + L(x + w * 0.2, cy - h * 0.12, x + w * 0.2, cy + h * 0.3, C.metal, 1.6)
      + L(x + w * 0.8, cy - h * 0.12, x + w * 0.8, cy + h * 0.3, C.metal, 1.6)
      + R(x + w * 0.34, cy - h * 0.02, w * 0.14, h * 0.22, '#c9d3d8', 1, 'opacity=".7"')
      + R(x + w * 0.53, cy - h * 0.06, w * 0.12, h * 0.26, '#d8c3b0', 1, 'opacity=".7"')
  }
  if (/窗帘/.test(s)) {
    return L(x + w * 0.06, cy - h * 0.34, x + w * 0.94, cy - h * 0.34, '#a08a72', 2)
      + `<path d="M${round(x + w * 0.14)} ${round(cy - h * 0.3)} q ${round(w * 0.1)} ${round(h * 0.3)} ${round(-w * 0.02)} ${round(h * 0.62)} q ${round(w * 0.14)} ${round(-h * 0.3)} ${round(w * 0.16)} ${round(-h * 0.6)} Z" fill="#a08a72" opacity=".75"/>`
      + `<path d="M${round(x + w * 0.88)} ${round(cy - h * 0.3)} q ${round(-w * 0.1)} ${round(h * 0.3)} ${round(w * 0.02)} ${round(h * 0.62)} q ${round(-w * 0.14)} ${round(-h * 0.3)} ${round(-w * 0.16)} ${round(-h * 0.6)} Z" fill="#a08a72" opacity=".75"/>`
  }
  if (/风铃|串|灯带/.test(s)) {
    return L(x + w * 0.2, cy - h * 0.22, x + w * 0.8, cy - h * 0.22, '#7c8a92', 1)
      + Ci(x + w * 0.32, cy - h * 0.06, 2, C.light) + Ci(x + w * 0.5, cy + h * 0.08, 2, C.light) + Ci(x + w * 0.68, cy - h * 0.02, 2, C.light)
  }
  if (/钟/.test(s)) {
    const r = min(w, h) * 0.28
    return Ci(cx, cy, r, '#ded0b8') + Ci(cx, cy, r * 0.84, '#efe4cf')
      + L(cx, cy, cx, cy - r * 0.6, '#5a4a38', 1.4) + L(cx, cy, cx + r * 0.45, cy, '#5a4a38', 1.4)
  }
  if (/贝壳|罐|杯/.test(s)) {
    return R(x + w * 0.24, y + h * 0.24, w * 0.52, h * 0.52, '#c2a878', 3)
      + R(x + w * 0.32, y + h * 0.14, w * 0.36, h * 0.12, '#9c845c', 1)
      + Ci(cx - w * 0.06, cy + h * 0.02, 2, '#e9dcc2') + Ci(cx + w * 0.08, cy - h * 0.06, 1.6, '#e9dcc2')
  }
  if (/电视柜|柜/.test(s)) return R(x + w * 0.04, y + h * 0.2, w * 0.92, h * 0.55, '#8a6a4a', 2)
  return R(x + w * 0.06, y + h * 0.18, w * 0.88, h * 0.6, C.box, 2)
}

const min = Math.min
const max = Math.max

/** 单件家具的示意图（图鉴用）：透明底、只有一个物件。 */
export function itemSvg(item, { size = 84 } = {}) {
  const W = size
  const H = size * 0.78
  return `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="${esc(item)}"><g>${drawItem(item, W / 2, H / 2, W * 0.82, H * 0.66)}</g></svg>`
}

export function roomSvg(room, { width = 240, height = 186, fridgeHref = '' } = {}) {
  const items = (room?.items || []).slice(0, 9)
  const W = width
  const H = height
  const pad = 7
  const innerW = W - pad * 2
  const innerH = H - pad * 2 - 6
  const n = Math.max(1, items.length)
  const cols = n <= 2 ? n : n <= 4 ? 2 : 3
  const rows = Math.ceil(n / cols)
  const cw = innerW / cols
  const ch = innerH / rows

  const parts = []
  parts.push(`<rect x="${pad / 2}" y="${pad / 2}" width="${W - pad}" height="${H - pad}" rx="10" fill="#241d18" stroke="${WALL}" stroke-width="2.6"/>`)
  for (let i = 1; i < 4; i++) {
    parts.push(`<line x1="${pad + 3}" y1="${round(pad + (innerH * i) / 4)}" x2="${W - pad - 3}" y2="${round(pad + (innerH * i) / 4)}" stroke="#2b231d" stroke-width=".7"/>`)
  }
  // 门：底边留口
  const doorW = Math.min(38, innerW * 0.24)
  const doorX = W / 2 - doorW / 2
  const baseY = H - pad / 2
  parts.push(`<line x1="${round(doorX)}" y1="${baseY}" x2="${round(doorX + doorW)}" y2="${baseY}" stroke="#241d18" stroke-width="4"/>`)
  parts.push(`<line x1="${round(doorX)}" y1="${baseY}" x2="${round(doorX)}" y2="${round(baseY - 9)}" stroke="${WALL}" stroke-width="1.6"/>`)
  parts.push(`<line x1="${round(doorX + doorW)}" y1="${baseY}" x2="${round(doorX + doorW)}" y2="${round(baseY - 9)}" stroke="${WALL}" stroke-width="1.6"/>`)

  items.forEach((item, i) => {
    const col = i % cols
    const row = Math.floor(i / cols)
    const cx = pad + cw * (col + 0.5)
    const cy = pad + ch * (row + 0.5) - 2
    const w = min(cw * 0.78, 78)
    const h = min(ch * 0.62, 52)
    const shape = drawItem(item, cx, cy - 5, w, h)
    // 冰箱是"能点进去的家具"：整块图套一层 SVG 链接，点了进冰箱管理页
    const clickable = fridgeHref && /冰箱/.test(item)
    const body = clickable
      ? `<a href="${esc(fridgeHref)}" target="_blank" rel="noopener"><title>点开冰箱：放东西 / 拿东西</title>${shape}` +
        `<rect x="${round(cx - w / 2 - 3)}" y="${round(cy - 5 - h / 2 - 3)}" width="${round(w + 6)}" height="${round(h + 6)}" rx="4" fill="none" stroke="#e8b06a" stroke-width="1" stroke-dasharray="3 3" opacity=".55"/></a>`
      : shape
    parts.push(`<g>${body}</g>`)
    parts.push(`<text x="${round(cx)}" y="${round(cy + h / 2 + 8)}" font-size="8.4" fill="${MUTE}" text-anchor="middle" font-family="PingFang SC, Microsoft YaHei, sans-serif">${esc(labelFor(item))}</text>`)
  })
  if (items.length === 0) {
    parts.push(`<text x="${W / 2}" y="${H / 2}" font-size="10" fill="${MUTE}" text-anchor="middle">空着</text>`)
  }
  return `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="${esc(room?.name || '房间')}">${parts.join('')}</svg>`
}
