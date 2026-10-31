// 把 core 的逻辑接到「服务器包」这份环境上：
//   数据在包根 state/，页面在包根 exports/，名字取 config.json
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { setup } from '../core/env.mjs'
import { readConfig } from './who.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')

const NAME = String(readConfig().name || '').trim() || '大肥鱼'

function readJsonSafe(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) ?? fallback } catch { return fallback }
}

export const env = setup({
  root: ROOT,
  workspace: ROOT,
  petName: () => NAME,
  prefs() {
    // 服务器包：优先 settings.json，其次 state/house-prefs.json
    const s = readJsonSafe(path.join(ROOT, 'settings.json'), {})
    if (typeof s?.diaryVisible === 'boolean') {
      return { diaryVisible: s.diaryVisible === true, notifyScreenshot: false, interactiveFurniture: s.interactiveFurniture !== false }
    }
    const raw = readJsonSafe(path.join(ROOT, 'state', 'house-prefs.json'), {})
    return { diaryVisible: raw?.diaryVisible === true, notifyScreenshot: false, interactiveFurniture: raw?.interactiveFurniture !== false }
  },
  consoleUrl: () => ''
})

export default env
