import { addPackages, parsePackageName } from '.'
import { AddPackagesOptions } from './add'
import { PackageInstallation, removeInstallations } from './installations'
import { readLockfile } from './lockfile'

export interface UpdatePackagesOptions {
  workingDir: string
  noInstallationsRemove?: boolean
  replace?: boolean
  // if need run package manager update procedure
  update?: boolean
  // if need just to restore retreated packages
  restore?: boolean
}
export const updatePackages = async (
  packages: string[], // 包名
  options: UpdatePackagesOptions
) => {
  const { workingDir } = options //执行命令的工作路径
  const lockfile = readLockfile({ workingDir })  //yalc.lock 文件
  // 更新了的依赖仓库
  let packagesToUpdate: string[] = []
  //删除了该包的仓库
  let installationsToRemove: PackageInstallation[] = [] 
  if (packages.length) {
    packages.forEach((packageName) => {
      const { name, version } = parsePackageName(packageName)
      if (lockfile.packages[name]) {
        if (version) {
          lockfile.packages[name].version = version // 更新lock里的版本
        }
        packagesToUpdate.push(name)
      } else {
        // 找不到lock，则需要将该仓库的依赖从installationFile中删除
        installationsToRemove.push({ name, path: options.workingDir })
        console.warn(
          `Did not find package ${name} in lockfile, ` +
            `please use 'add' command to add it explicitly.`
        )
      }
    })
  } else {
    packagesToUpdate = Object.keys(lockfile.packages)
  }

  const lockPackages = packagesToUpdate.map((name) => ({
    name: lockfile.packages[name].version
      ? name + '@' + lockfile.packages[name].version
      : name,
    file: lockfile.packages[name].file,
    link: lockfile.packages[name].link,
    pure: lockfile.packages[name].pure,
    workspace: lockfile.packages[name].workspace,
  }))

  // 安装普通文件的依赖（file）
  const packagesFiles = lockPackages.filter((p) => p.file).map((p) => p.name)
  const addOpts: Pick<
    AddPackagesOptions,
    'workingDir' | 'replace' | 'update' | 'restore'
  > = {
    workingDir: options.workingDir,
    replace: options.replace,
    update: options.update,
    restore: options.restore,
  }
  await addPackages(packagesFiles, {
    ...addOpts,
  })

  // 安装普通的远程依赖（既不是 file、link、pure 也不是 workspace）lodash, axios, express 等
  const packagesLinks = lockPackages
    .filter((p) => !p.file && !p.link && !p.pure && !p.workspace)
    .map((p) => p.name)
  await addPackages(packagesLinks, {
    ...addOpts,
    link: true,
    pure: false,
  })

  // 安装工作空间依赖 (如 pnpm 或 yarn workspaces 中的本地包)
  const packagesWks = lockPackages.filter((p) => p.workspace).map((p) => p.name)
  await addPackages(packagesWks, {
    ...addOpts,
    workspace: true,
    pure: false,
  })
  
  // 安装链接依赖 (link)
  const packagesLinkDep = lockPackages.filter((p) => p.link).map((p) => p.name)
  await addPackages(packagesLinkDep, {
    ...addOpts,
    linkDep: true,
    pure: false,
  })

  // 安装纯依赖（packagesPure）用于pnpm较多
  const packagesPure = lockPackages.filter((p) => p.pure).map((p) => p.name)
  await addPackages(packagesPure, {
    ...addOpts,
    pure: true,
  })
  
  if (!options.noInstallationsRemove) {
    await removeInstallations(installationsToRemove)
  }
  return installationsToRemove
}
