import { exec, execSync } from 'child_process'
import { join } from 'path'

import {
  execLoudOptions,
  getPackageManager,
  getStorePackagesDir,
  PackageManifest,
  PackageScripts,
  readPackageManifest,
  updatePackages,
  values,
} from '.'
import { copyPackageToStore } from './copy'
import {
  PackageInstallation,
  readInstallationsFile,
  removeInstallations,
} from './installations'
import { pmRunScriptCmd } from './pm'

export interface PublishPackageOptions {
  workingDir: string
  signature?: boolean
  changed?: boolean
  push?: boolean
  update?: boolean
  replace?: boolean
  npm?: boolean
  content?: boolean
  private?: boolean
  scripts?: boolean
  devMod?: boolean
  workspaceResolve?: boolean
}

export const publishPackage = async (options: PublishPackageOptions) => {
  const workingDir = options.workingDir
  const pkg = readPackageManifest(workingDir)
  if (!pkg) {
    return
  }

  const pm = getPackageManager(workingDir)

  const runPmScript = (script: keyof PackageScripts) => {
    if (!options.scripts) return
    const scriptCmd = pkg.scripts?.[script]
    if (scriptCmd) {
      console.log(`Running ${script} script: ${scriptCmd}`)
      execSync(`${pmRunScriptCmd[pm]} ${script}`, {
        cwd: workingDir,
        ...execLoudOptions,
      })
    }
  }

  if (pkg.private && !options.private) {
    console.log(
      'Will not publish package with `private: true`' +
        ' use --private flag to force publishing.'
    )
    return
  }

  const preScripts: (keyof PackageScripts)[] = [
    'prepublish',
    'prepare',
    'prepublishOnly',
    'prepack',
    'preyalcpublish',
  ]
  preScripts.forEach(runPmScript)

  const copyRes = await copyPackageToStore(options)

  if (options.changed && !copyRes) {
    console.warn('Package content has not changed, skipping publishing.')
    return
  }

  const postScripts: (keyof PackageScripts)[] = [
    'postyalcpublish',
    'postpack',
    'publish',
    'postpublish',
  ]
  postScripts.forEach(runPmScript)

  const publishedPackageDir = join(getStorePackagesDir(), pkg.name, pkg.version)
  const publishedPkg = readPackageManifest(publishedPackageDir)!
  console.log(
    `${publishedPkg.name}@${publishedPkg.version} published in store.`
  )

  // 参数中有push
  if (options.push) {
    // 读取yalc存储仓库的文件
    const installationsConfig = readInstallationsFile()
    // 存储对象中找到依赖该包的项目路径
    const installationPaths = installationsConfig[pkg.name] || []
    const installationsToRemove: PackageInstallation[] = []
    for (const workingDir of installationPaths) {
      console.info(`Pushing ${pkg.name}@${pkg.version} in ${workingDir}`)
      // updatePackages 会返回已经将该依赖删除了的仓库，但表中还存在该仓库
      const installationsToRemoveForPkg = await updatePackages([pkg.name], {
        replace: options.replace,
        workingDir,
        update: options.update,
        noInstallationsRemove: true,
      })
      installationsToRemove.push(...installationsToRemoveForPkg)
    }
    await removeInstallations(installationsToRemove)
  }
}
