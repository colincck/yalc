#!/usr/bin/env node
import yargs from 'yargs'
import { join, resolve } from 'path'

import {
  values,
  publishPackage,
  addPackages,
  updatePackages,
  removePackages,
  getStoreMainDir,
  yalcGlobal,
} from '.'

import { showInstallations, cleanInstallations } from './installations'

import { checkManifest } from './check'
import { makeConsoleColored, disabledConsoleOutput } from './console'
import { PublishPackageOptions } from './publish'
import { readRcConfig } from './rc'

const updateFlags = ['update', 'upgrade', 'up']

const publishFlags = [
  'scripts',
  'sig',
  'dev-mod',
  'changed',
  'files',
  ...updateFlags,
]

const cliCommand = values.myNameIs

const getVersionMessage = () => {
  const pkg = require(__dirname + '/../package.json')
  return pkg.version
}

makeConsoleColored()

const rcArgs = readRcConfig()

if (process.argv.includes('--quiet') || rcArgs.quiet) {
  disabledConsoleOutput()
}

const getPublishOptions = (
  argv: any,
  override: Partial<PublishPackageOptions> = {}
): PublishPackageOptions => {
  const folder = argv._[1]
  return {
    workingDir: join(process.cwd(), folder || ''),
    push: argv.push,
    replace: argv.replace,
    signature: argv.sig,
    changed: argv.changed,
    content: argv.content,
    private: argv.private,
    scripts: argv.scripts,
    update: argv.update || argv.upgrade,
    workspaceResolve: argv.workspaceResolve,
    devMod: argv.devMod,
    ...override,
  }
}

/* tslint:disable-next-line */
yargs
  .usage(cliCommand + ' [command] [options] [package1 [package2...]]')
  .coerce('store-folder', function (folder: string) {
    if (!yalcGlobal.yalcStoreMainDir) {
      yalcGlobal.yalcStoreMainDir = resolve(folder)
      console.log('Package store folder used:', yalcGlobal.yalcStoreMainDir)
    }
  })
  .command({
    command: '*',
    builder: () => {
      return yargs.boolean(['version'])
    },
    handler: (argv) => {
      let msg = 'Use `yalc help` to see available commands.'
      if (argv._[0]) {
        msg = 'Unknown command `' + argv._[0] + '`. ' + msg
      } else {
        if (argv.version) {
          msg = getVersionMessage()
        }
      }
      console.log(msg)
    },
  })
  .command({
    command: 'publish', // 发布包到本地
    describe: 'Publish package in yalc local repo',
    builder: () => {
      return yargs
        .default('sig', false)
        .default('scripts', true)
        .default('dev-mod', true)
        .default('workspace-resolve', true)
        .default(rcArgs)
        .alias('script', 'scripts')
        .boolean(['push'].concat(publishFlags))
    },
    handler: (argv) => {
      return publishPackage(getPublishOptions(argv))
    },
  })
  .command({
    command: 'push', //发布后会把包推送到所有已安装的项目
    describe:
      'Publish package in yalc local repo and push to all installations',
    builder: () => {
      return yargs
        .default('sig', false)
        .default('scripts', false)
        .default('dev-mod', true)
        .default('workspace-resolve', true)
        .default(rcArgs)
        .alias('script', 'scripts')
        .boolean(['safe'].concat(publishFlags))
        .option('replace', { describe: 'Force package content replacement' })
    },
    handler: (argv) => {
      return publishPackage(getPublishOptions(argv, { push: true }))
    },
  })
  .command({
    command: 'installations', // 查看和清理 installations 文件
    describe: 'Work with installations file: show/clean',
    builder: () => {
      return yargs.boolean(['dry'])
    },
    handler: async (argv) => {
      const action = argv._[1]
      const packages = argv._.slice(2)
      switch (action) {
        case 'show':
          showInstallations({ packages })
          break
        case 'clean':
          await cleanInstallations({ packages, dry: argv.dry })
          break
        default:
          console.info('Need installation action: show | clean')
      }
    },
  })
  .command({
    command: 'add', // 添加yalc 包，同时修改 package.json 依赖
    describe: 'Add package from yalc repo to the project',
    builder: () => {
      return yargs
        .boolean(['file', 'dev', 'link', ...updateFlags])
        .alias('D', 'dev')
        .boolean('workspace')
        .alias('save-dev', 'dev')
        .alias('workspace', 'W')
        .default(rcArgs)
        .help(true)
    },
    handler: (argv) => {
      return addPackages(argv._.slice(1), {
        dev: argv.dev,
        linkDep: argv.link,
        restore: argv.restore,
        pure: argv.pure,
        workspace: argv.workspace,
        update: argv.update || argv.upgrade,
        workingDir: process.cwd(),
      })
    },
  })
  .command({
    command: 'link', // 用于以符号链接的方式安装包
    describe: 'Link package from yalc repo to the project',
    builder: () => {
      return yargs.default(rcArgs).help(true)
    },
    handler: (argv) => {
      return addPackages(argv._.slice(1), {
        link: true,
        pure: argv.pure,
        workingDir: process.cwd(),
      })
    },
  })
  .command({
    command: 'update', // 更新当前项目中已添加的 yalc 包
    describe: 'Update packages from yalc repo',
    builder: () => {
      return yargs
        .boolean([...updateFlags])
        .default(rcArgs)
        .help(true)
    },
    handler: (argv) => {
      return updatePackages(argv._.slice(1), {
        update: argv.update || argv.upgrade,
        restore: argv.restore,
        workingDir: process.cwd(),
      })
    },
  })
  .command({
    command: 'restore', // 用于恢复之前被“撤退”（retreat）掉的包。
    describe: 'Restore retreated packages',
    builder: () => {
      return yargs
        .boolean([...updateFlags])
        .default(rcArgs)
        .help(true)
    },
    handler: (argv) => {
      return updatePackages(argv._.slice(1), {
        update: argv.update || argv.upgrade,
        restore: true,
        workingDir: process.cwd(),
      })
    },
  })
  .command({
    command: 'remove', // 从项目中彻底移除指定包，同时更新 package.json 与锁文件 retreat 表示移除但保留在锁文件中（以便后续恢复）
    describe: 'Remove packages from the project',
    builder: () => {
      return yargs.boolean(['retreat', 'all']).default(rcArgs).help(true)
    },
    handler: (argv) => {
      return removePackages(argv._.slice(1), {
        retreat: argv.retreat,
        workingDir: process.cwd(),
        all: argv.all,
      })
    },
  })
  .command({
    command: 'retreat', // 移除yalc的依赖但保留在锁文件中（以便后续恢复）
    describe:
      'Remove packages from project, but leave in lock file (to be restored later)',
    builder: () => {
      return yargs.boolean(['all']).help(true)
    },
    handler: (argv) => {
      return removePackages(argv._.slice(1), {
        all: argv.all,
        retreat: true,
        workingDir: process.cwd(),
      })
    },
  })
  .command({
    command: 'check', //检查当前项目的 package.json 是否存在通过 yalc 添加的本地依赖（例如防止误提交）
    describe: 'Check package.json for yalc packages',
    builder: () => {
      return yargs.boolean(['commit']).usage('check usage here').help(true)
    },
    handler: (argv) => {
      const gitParams = process.env.GIT_PARAMS
      if (argv.commit) {
        console.log('gitParams', gitParams)
      }
      checkManifest({
        commit: argv.commit,
        all: argv.all,
        workingDir: process.cwd(),
      })
    },
  })
  .command({
    command: 'dir', //显示yalc的存储系统目录
    describe: 'Show yalc system directory',
    handler: () => {
      console.log(getStoreMainDir())
    },
  })
  .help('help').argv
