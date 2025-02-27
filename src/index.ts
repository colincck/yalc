import { ExecSyncOptions } from 'child_process'
import * as fs from 'fs-extra'
import { homedir } from 'os'
import { join } from 'path'

// 项目主目录
const userHome = homedir()

// 基本配置参数
export const values = {
  myNameIs: 'yalc',
  ignoreFileName: '.yalcignore',
  myNameIsCapitalized: 'Yalc',
  lockfileName: 'yalc.lock',
  yalcPackagesFolder: '.yalc',
  prescript: 'preyalc',
  postscript: 'postyalc',
  installationsFile: 'installations.json',
}

export interface UpdatePackagesOptions {
  safe?: boolean
  workingDir: string
}

// 发布包到公共仓库及推送相关
export { publishPackage } from './publish'
// 更新目标仓库的包依赖 及 删除无关联的仓库
export { updatePackages } from './update'
// 校验package.json中是否存在yalc依赖
export { checkManifest } from './check'
// yalc remove 操作相关
export { removePackages } from './remove'
// yalc add 操作相关 将本地包添加到目标仓库中，涉及.yalc及符号链接（symlink）
export { addPackages } from './add'
export * from './pkg'
export * from './pm'

export interface YalcGlobal {
  yalcStoreMainDir: string
}
/* 
  Not using Node.Global because in this case 
  <reference types="mocha" /> is aded in built d.ts file  
*/
export const yalcGlobal: YalcGlobal = global as any

export function getStoreMainDir(): string {
  if (yalcGlobal.yalcStoreMainDir) {
    return yalcGlobal.yalcStoreMainDir
  }
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    return join(process.env.LOCALAPPDATA, values.myNameIsCapitalized)
  }
  return join(userHome, '.' + values.myNameIs)
}

// 找到当前包的对应全局yalc的存储路径
export function getStorePackagesDir(): string {
  return join(getStoreMainDir(), 'packages')
}

// 获取当前包的存储路径
export const getPackageStoreDir = (packageName: string, version = '') =>
  join(getStorePackagesDir(), packageName, version)

export const execLoudOptions = { stdio: 'inherit' } as ExecSyncOptions

const signatureFileName = 'yalc.sig'

// 读取签名文件
export const readSignatureFile = (workingDir: string) => {
  const signatureFilePath = join(workingDir, signatureFileName)
  try {
    const fileData = fs.readFileSync(signatureFilePath, 'utf-8')
    return fileData
  } catch (e) {
    return ''
  }
}

// 读取yalcignore
export const readIgnoreFile = (workingDir: string) => {
  const filePath = join(workingDir, values.ignoreFileName)
  try {
    const fileData = fs.readFileSync(filePath, 'utf-8')
    return fileData
  } catch (e) {
    return ''
  }
}

// 写入签名文件 yalc.sig
export const writeSignatureFile = (workingDir: string, signature: string) => {
  const signatureFilePath = join(workingDir, signatureFileName)
  try {
    fs.writeFileSync(signatureFilePath, signature)
  } catch (e) {
    console.error('Could not write signature file')
    throw e
  }
}
