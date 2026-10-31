// 这个套件里"助手叫什么"只在这里定义：
// 想改名 → 改套件根目录的 config.json 的 name 字段（没有就用默认值）。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')

export const DEFAULT_NAME = '大肥鱼'

export function readConfig() {
  try {
    let raw = fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8')
    if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1)   // Windows 记事本/PowerShell 写出来会带 BOM
    const obj = JSON.parse(raw)
    return obj && typeof obj === 'object' ? obj : {}
  } catch {
    return {}
  }
}

/** 助手在这套件里的名字（config.json 的 name，缺省「大肥鱼」）。 */
export const PET_NAME = String(readConfig().name || '').trim() || DEFAULT_NAME

/** 「X的Y」（页面标题用）。 */
export function petTitle(what) {
  return `${PET_NAME}的${what}`
}

/** 页面文件名：<名字>的<Y>.html */
export function petFile(what) {
  return `${petTitle(what)}.html`
}
