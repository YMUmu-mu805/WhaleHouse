// 环境注入：同一份逻辑，桥接和服务器包各自提供路径与名字
//
//   root      : 放 state/ 的根目录（桥接是 qq-bridge，服务器包是包根）
//   workspace : 放 exports/ 的根目录（桥接在上一级，服务器包就是 root）
//   petName   : () => 名字（桥接读 house.owner，服务器包读 config.json）
//   prefs     : () => ({ diaryVisible, notifyScreenshot, ... })
//   consoleUrl: (page) => 页面地址（桥接带端口，服务器包返回空串）
let ENV = null

export function setup(next) {
  if (!next || !next.root) throw new Error('env.setup 需要 root')
  const name = typeof next.petName === 'function' ? next.petName : () => String(next.petName || '')
  ENV = {
    root: next.root,
    workspace: next.workspace || next.root,
    petName: name,
    petTitle: (what) => `${name()}的${what}`,
    petFile: (what) => `${name()}的${what}.html`,
    prefs: typeof next.prefs === 'function' ? next.prefs : () => ({ diaryVisible: false, notifyScreenshot: false }),
    consoleUrl: typeof next.consoleUrl === 'function' ? next.consoleUrl : () => ''
  }
  return ENV
}

export function env() {
  if (!ENV) throw new Error('env 还没 setup（先 import env-init.mjs）')
  return ENV
}

export function isSetup() {
  return Boolean(ENV)
}
