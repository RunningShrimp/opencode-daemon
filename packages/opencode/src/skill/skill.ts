/**
 * Skill Module - 主入口
 * 
 * 本模块提供技能(Skill)管理功能，包括：
 * - 从多种来源扫描技能（本地、远程、配置路径）
 * - 技能缓存和按实例隔离
 * - 并发控制和超时处理
 * 
 * @example
 * import { Skill } from "./skill"
 * 
 * // 获取所有技能
 * const skills = await Skill.all()
 * 
 * // 获取单个技能
 * const skill = await Skill.get("my-skill")
 * 
 * // 刷新缓存
 * await Skill.refresh()
 */

// 从 router 重新导出所有内容
export * from "./router"
