import { execSync } from 'child_process'
import * as fs from 'fs-extra'
import { join, relative } from 'path'

import {
  execLoudOptions,
  getPackageStoreDir,
  parsePackageName,
  readPackageManifest,
  readSignatureFile,
  runPmUpdate,
  values,
  writePackageManifest,
} from '.'
import { addInstallations, removeInstallations } from './installations'
import { addPackageToLockfile } from './lockfile'
import { PackageScripts } from './pkg'
import { getPackageManager, pmRunScriptCmd } from './pm'
import { copyDirSafe } from './sync-dir'

const ensureSymlinkSync = fs.ensureSymlinkSync as typeof fs.symlinkSync

export interface AddPackagesOptions {
  dev?: boolean
  link?: boolean
  linkDep?: boolean
  replace?: boolean
  update?: boolean
  safe?: boolean
  pure?: boolean
  restore?: boolean
  workspace?: boolean
  workingDir: string
}

const getLatestPackageVersion = (packageName: string) => {
  const dir = getPackageStoreDir(packageName)
  const versions = fs.readdirSync(dir)
  const latest = versions
    .map((version) => ({
      version,
      created: fs.statSync(join(dir, version)).ctime.getTime(),
    }))
    .sort((a, b) => b.created - a.created)
    .map((x) => x.version)[0]
  return latest || ''
}

const isSymlink = (path: string) => {
  try {
    return !!fs.readlinkSync(path)
  } catch (e) {
    return false
  }
}

const checkPnpmWorkspace = (workingDir: string) => {
  return fs.existsSync(join(workingDir, 'pnpm-workspace.yaml'))
}

// 目标仓库关联yalc的包
export const addPackages = async (
  packages: string[], //yalc的包
  options: AddPackagesOptions // 对应配置项
) => {
  if (!packages.length) return
  const workingDir = options.workingDir
  const localPkg = readPackageManifest(workingDir) // 读取当前目录下的package.json
  let localPkgUpdated = false
  if (!localPkg) {
    return
  }
  const pm = getPackageManager(workingDir) //获取当前项目的包管理工具

  const runPmScript = (script: string) => {
    const scriptCmd = localPkg.scripts?.[script as keyof PackageScripts]
    if (scriptCmd) {
      console.log(`Running ${script} script: ${scriptCmd}`)
      execSync(`${pmRunScriptCmd[pm]} ${script}`, {
        cwd: workingDir,
        ...execLoudOptions,
      })
    }
  }

  let pnpmWorkspace = false

  const doPure =
    options.pure === false
      ? false
      : options.pure ||
        !!localPkg.workspaces ||
        (pnpmWorkspace = checkPnpmWorkspace(workingDir))

  // 运行前置脚本
  runPmScript('preyalc')

  // 处理所有需要安装的yalc包
  const addedInstallsP = packages.map(async (packageName) => {
    runPmScript('preyalc.' + packageName)
    const { name, version = '' } = parsePackageName(packageName)

    if (!name) {
      console.warn('Could not parse package name', packageName)
    }
    //  .yalc 存储路径
    const destYalcCopyDir = join(workingDir, values.yalcPackagesFolder, name)
    
    // 非还原的情况 也就是 本身有 yalc.lock 但没有 .yalc 文件夹情况
    if (!options.restore) {
      const storedPackagePath = getPackageStoreDir(name) // 获取yalc包位置
      if (!fs.existsSync(storedPackagePath)) {
        console.warn(
          `Could not find package \`${name}\` in store (${storedPackagePath}), skipping.`
        )
        return null
      }

      //指定版本 或者 获取yalc中最新版本
      const versionToInstall = version || getLatestPackageVersion(name) 

      const storedPackageDir = getPackageStoreDir(name, versionToInstall)

      if (!fs.existsSync(storedPackageDir)) {
        console.warn(
          `Could not find package \`${packageName}\` ` + storedPackageDir,
          ', skipping.'
        )
        return null
      }
      // 复制yalc包到项目中
      await copyDirSafe(storedPackageDir, destYalcCopyDir, !options.replace)
    } else {
      console.log(`Restoring package \`${packageName}\` from .yalc directory`)
      if (!fs.existsSync(destYalcCopyDir)) {
        console.warn(
          `Could not find package \`${packageName}\` ` + destYalcCopyDir,
          ', skipping.'
        )
        return null
      }
    }

    const pkg = readPackageManifest(destYalcCopyDir) // 获取当前项目的package.json
    if (!pkg) {
      return null
    }

    let replacedVersion = ''
    if (doPure) {
      if (!options.pure) {
        const defaultPureMsg =
          '--pure option will be used by default, to override use --no-pure.'
        if (localPkg.workspaces) {
          console.warn(
            'Because of `workspaces` enabled in this package ' + defaultPureMsg
          )
        } else if (pnpmWorkspace) {
          console.warn(
            'Because of `pnpm-workspace.yaml` exists in this package ' +
              defaultPureMsg
          )
        }
      }
      console.log(
        `${pkg.name}@${pkg.version} added to ${join(
          values.yalcPackagesFolder,
          name
        )} purely`
      )
    }
    if (!doPure) {
      const destModulesDir = join(workingDir, 'node_modules', name) //node_modules里包的位置
      // 如果之前该依赖是符号链接，则直接删除
      if (options.link || options.linkDep || isSymlink(destModulesDir)) {
        fs.removeSync(destModulesDir)
      }
      // 如果link为true，则在node_modules中创建符号链接
      if (options.link || options.linkDep) {
        ensureSymlinkSync(destYalcCopyDir, destModulesDir, 'junction')
      } else { // 否则将 yalc 缓存中的包复制到 node_modules 目录中
        await copyDirSafe(destYalcCopyDir, destModulesDir, !options.replace)
      }
    
      if (!options.link) {
        const protocol = options.linkDep ? 'link:' : 'file:'
        const localAddress = options.workspace
          ? 'workspace:*'
          : protocol + values.yalcPackagesFolder + '/' + pkg.name

        const dependencies = localPkg.dependencies || {}
        const devDependencies = localPkg.devDependencies || {}
        let depsObj = options.dev ? devDependencies : dependencies
        
        // 开发时依赖 --dev
        if (options.dev) {
          if (dependencies[pkg.name]) {
            replacedVersion = dependencies[pkg.name] // 记录之前版本
            delete dependencies[pkg.name]
          }
        } else {
          if (!dependencies[pkg.name]) {
            if (devDependencies[pkg.name]) {
              depsObj = devDependencies
            }
          }
        }

        // 替换依赖
        if (depsObj[pkg.name] !== localAddress) {
          replacedVersion = replacedVersion || depsObj[pkg.name]
          depsObj[pkg.name] = localAddress
          localPkg.dependencies =
            depsObj === dependencies ? dependencies : localPkg.dependencies
          localPkg.devDependencies =
            depsObj === devDependencies
              ? devDependencies
              : localPkg.devDependencies
          localPkgUpdated = true
        }
        replacedVersion = replacedVersion == localAddress ? '' : replacedVersion
      }
      // 处理 node_modeules bin 脚本
      if (pkg.bin && (options.link || options.linkDep)) {
        const binDir = join(workingDir, 'node_modules', '.bin')
        const addBinScript = (src: string, dest: string) => {
          const srcPath = join(destYalcCopyDir, src)
          const destPath = join(binDir, dest)
          console.log(
            'Linking bin script:',
            relative(workingDir, destYalcCopyDir),
            '->',
            relative(workingDir, destPath)
          )
          try {
            ensureSymlinkSync(srcPath, destPath)
            fs.chmodSync(srcPath, 0o755)
          } catch (e) {
            console.warn('Could not create bin symlink.')
            console.error(e)
          }
        }
        if (typeof pkg.bin === 'string') {
          fs.ensureDirSync(binDir)
          addBinScript(pkg.bin, pkg.name)
        } else if (typeof pkg.bin === 'object') {
          fs.ensureDirSync(binDir)
          for (const name in pkg.bin) {
            addBinScript(pkg.bin[name], name)
          }
        }
      }
      
      // 添加依赖 的类型
      const addedAction = options.link ? 'linked' : 'added'
      console.log(
        `Package ${pkg.name}@${pkg.version} ${addedAction} ==> ${destModulesDir}`
      )
    }

    // 读.yalc里包的 yalc.sig 文件 
    const signature = readSignatureFile(destYalcCopyDir) // form index.ts
    runPmScript('postyalc.' + packageName)
    return {
      signature,
      name,
      version,
      replaced: replacedVersion,
      path: options.workingDir,
    }
  })

  const addedInstalls = (await Promise.all(addedInstallsP))
    .filter((_) => !!_)
    .map((_) => _!)

  // 如果 package.json 发生变更，写入更新
  if (localPkgUpdated) {
    writePackageManifest(workingDir, localPkg)
  }
  
  addPackageToLockfile(
    addedInstalls.map((i) => ({
      name: i.name,
      version: i.version,
      replaced: i.replaced,
      pure: doPure,
      workspace: options.workspace,
      file: options.workspace
        ? undefined
        : !options.link && !options.linkDep && !doPure,
      link: options.linkDep && !doPure,
      signature: i.signature,
    })),
    { workingDir: options.workingDir }
  )

  runPmScript('postyalc')

  await addInstallations(addedInstalls)
  if (options.update) {
    runPmUpdate(options.workingDir, packages)
  }
}
