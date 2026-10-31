// 统一实现见 ../core/meal.mjs（桥接和服务器包共用一份）
// 这里只把环境接上，导出的东西跟以前一模一样
import './env-init.mjs'
export * from '../core/meal.mjs'
