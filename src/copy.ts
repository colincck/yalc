import crypto from 'crypto'
import fs from 'fs-extra'
import ignore from 'ignore'
// 根据 npm 发布规则获取将要打包的文件列表
import npmPacklist from 'npm-packlist'
import { dirname, join } from 'path'

import { readIgnoreFile, readPackageManifest, readSignatureFile } from '.'
import {
  getStorePackagesDir,
  PackageManifest,
  writePackageManifest,
  writeSignatureFile,
} from '.'

const shortSignatureLength = 8

// 计算文件哈希 是否发生变化
export const getFileHash = (srcPath: string, relPath: string = '') => {
  return new Promise<string>(async (resolve, reject) => {
    const stream = fs.createReadStream(srcPath)
    const md5sum = crypto.createHash('md5')
    md5sum.update(relPath.replace(/\\/g, '/'))
    stream.on('data', (data: string) => md5sum.update(data))
    stream.on('error', reject).on('close', () => {
      resolve(md5sum.digest('hex'))
    })
  })
}

// 复制文件到目标目录，并返回文件哈希
const copyFile = async (
  srcPath: string,
  destPath: string,
  relPath: string = ''
) => {
  await fs.copy(srcPath, destPath)
  return getFileHash(srcPath, relPath)
}

// 对象属性映射 用于 package.json 中的 dependencies 转换
const mapObj = <T, R, K extends string>(
  obj: Record<K, T>,
  mapValue: (value: T, key: K) => R
): Record<string, R> => {
  if (Object.keys(obj).length === 0) return {}

  return Object.keys(obj).reduce<Record<string, R>>((resObj, key) => {
    if (obj[key as K]) {
      resObj[key] = mapValue(obj[key as K], key as K)
    }
    return resObj
  }, {})
}

// 确保在 workspace 环境中，包引用的版本被正确替换为真实版本
const resolveWorkspaceDepVersion = (
  version: string,
  pkgName: string,
  workingDir: string
): string => {
  if (version !== '*' && version !== '^' && version !== '~') {
    // Regular semver specification
    return version
  }
  // Resolve workspace version aliases
  const prefix = version === '^' || version === '~' ? version : ''

  try {
    const pkgPath = require.resolve(join(pkgName, 'package.json'), {
      paths: [workingDir],
    })
    if (!pkgPath) {
    }
    const resolved = readPackageManifest(dirname(pkgPath))?.version

    return `${prefix}${resolved}` || '*'
  } catch (e) {
    console.warn('Could not resolve workspace package location for', pkgName)
    return '*'
  }
}

// 解析 workspace 依赖的真实版本号
const resolveWorkspaces = (
  pkg: PackageManifest,
  workingDir: string
): PackageManifest => {
  const resolveDeps = (deps: PackageManifest['dependencies']) => {
    return deps
      ? mapObj(deps, (val, depPkgName) => {
          if (val.startsWith('workspace:')) {
            const version = val.split(':')[1]
            const resolved = resolveWorkspaceDepVersion(
              version,
              depPkgName,
              workingDir
            )
            console.log(
              `Resolving workspace package ${depPkgName} version ==> ${resolved}`
            )
            return resolved
          }
          return val
        })
      : deps
  }

  return {
    ...pkg,
    dependencies: resolveDeps(pkg.dependencies),
    devDependencies: resolveDeps(pkg.devDependencies),
    peerDependencies: resolveDeps(pkg.peerDependencies),
  }
}

// 修改 package.json 用于发布， 移除 prepare、prepublish、devDependencies
// 保证包的干净和轻量
const modPackageDev = (pkg: PackageManifest) => {
  return {
    ...pkg,
    scripts: pkg.scripts
      ? {
          ...pkg.scripts,
          prepare: undefined,
          prepublish: undefined,
        }
      : undefined,
    devDependencies: undefined,
  }
}

// 规范化路径
const fixScopedRelativeName = (path: string) => path.replace(/^\.\//, '')

export const copyPackageToStore = async (options: {
  workingDir: string
  signature?: boolean
  changed?: boolean
  content?: boolean
  devMod?: boolean
  workspaceResolve?: boolean
}): Promise<string | false> => {
  const { workingDir, devMod = true } = options
  // 读工作路径的 package.json
  const pkg = readPackageManifest(workingDir)

  if (!pkg) {
    throw 'Error copying package to store.'
  }
  const copyFromDir = options.workingDir
  const storePackageStoreDir = join(
    getStorePackagesDir(),
    pkg.name,
    pkg.version
  )

  // 读取忽略文件
  const ignoreFileContent = readIgnoreFile(workingDir)
// 生成ignore规则
  const ignoreRule = ignore().add(ignoreFileContent)

  // 获取 npm 发布文件列表
  const npmList: string[] = await (await npmPacklist({ path: workingDir })).map(
    fixScopedRelativeName
  )
  
// 根据忽略规则过滤文件
  const filesToCopy = npmList.filter((f) => !ignoreRule.ignores(f))
  if (options.content) {
    console.info('Files included in published content:')
    filesToCopy.sort().forEach((f) => {
      console.log(`- ${f}`)
    })
    console.info(`Total ${filesToCopy.length} files.`)
  }
  // 复制文件到store
  const copyFilesToStore = async () => {
    await fs.remove(storePackageStoreDir)
    return Promise.all(
      filesToCopy
        .sort()
        .map((relPath) =>
          copyFile(
            join(copyFromDir, relPath),
            join(storePackageStoreDir, relPath),
            relPath
          )
        )
    )
  }
  
  // 计算整体文件签名  如果加了参数 changed，则计算每个文件的hash，不执行复制操作，否则直接复制并获取hash列表
  const hashes = options.changed
    ? await Promise.all(
        filesToCopy
          .sort()
          .map((relPath) => getFileHash(join(copyFromDir, relPath), relPath))
      )
    : await copyFilesToStore()

  const signature = crypto
    .createHash('md5')
    .update(hashes.join(''))
    .digest('hex')

  if (options.changed) {
    const publishedSig = readSignatureFile(storePackageStoreDir)
    if (signature === publishedSig) {
      return false
    } else {
      await copyFilesToStore()
    }
  }

  writeSignatureFile(storePackageStoreDir, signature)
  const versionPre = options.signature
    ? '+' + signature.substr(0, shortSignatureLength)
    : ''

  const resolveDeps = (pkg: PackageManifest): PackageManifest =>
    options.workspaceResolve ? resolveWorkspaces(pkg, workingDir) : pkg

  const pkgToWrite: PackageManifest = {
    ...resolveDeps(devMod ? modPackageDev(pkg) : pkg),
    yalcSig: signature,
    version: pkg.version + versionPre,
  }
  writePackageManifest(storePackageStoreDir, pkgToWrite)
  return signature
}
