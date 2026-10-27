#!/usr/bin/env node
/**
 * Install the ST-bridge bridge into the current DSH profile.
 *
 * What it does:
 *   1. Links this directory as <profile>/node_modules/ST-bridge.
 *   2. Appends a managed block to <profile>/cordis.patch.yml containing the
 *      bridge plugin and its text-only agent preset.
 *
 * It does not restart DSH. Quit DSH Desktop completely and start it again.
 */
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PROJECT = dirname(fileURLToPath(import.meta.url))
const START = '# >>> st-bridge (managed by install.mjs)'
const END = '# <<< st-bridge'

function parseArgs(argv) {
  const args = { port: 43121, cwd: 'D:\\AIGC\\MOSS', token: '', uninstall: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--uninstall') args.uninstall = true
    else if (arg === '--port') args.port = Number(argv[++index])
    else if (arg === '--cwd') args.cwd = argv[++index]
    else if (arg === '--token') args.token = argv[++index]
    else if (arg === '--profile') args.profile = argv[++index]
    else if (arg === '--home') args.home = argv[++index]
    else if (arg === '--help' || arg === '-h') args.help = true
    else throw new Error(`未知参数: ${arg}`)
  }
  return args
}

function profileDir(args) {
  if (args.profile) return resolve(args.profile)
  if (process.env.DSH_PROFILE_DIR) return resolve(process.env.DSH_PROFILE_DIR)
  const home = args.home ?? process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(home, 'profiles', process.env.DSH_PROFILE ?? 'desktop')
}

function yamlQuote(value) {
  return `'${String(value).replaceAll("'", "''")}'`
}

function indent(text, spaces) {
  const prefix = ' '.repeat(spaces)
  return text.replace(/\r\n/g, '\n').split('\n').map(line => `${prefix}${line}`).join('\n')
}

function buildBlock({ port, cwd, token }) {
  const persona = readFileSync(join(PROJECT, 'assets', 'preset-persona.txt'), 'utf8').trimEnd()
  const lines = [
    START,
    '- insert:',
    '    - id: preset-st-bridge',
    "      name: '@deepseek-ai/dsh-agent-preset'",
    '      config:',
    '        id: st-bridge',
    '        name: ST-bridge',
    '        description: 酒馆多插件持久会话专用预设：仅文本，不加载 DSH 工具、技能、酒馆人格或运行时上下文',
    '        order: 40',
    '        plugins:',
    '          - id: persona',
    "            name: '@deepseek-ai/dsh-persona'",
    '            config:',
    '              prefix: |-',
    indent(persona, 16),
    '              includeRuntimeContext: false',
    '    - id: st-bridge',
    '      name: ST-bridge',
    '      config:',
    "        host: '127.0.0.1'",
    `        port: ${port}`,
    `        cwd: ${yamlQuote(cwd)}`,
    '        agentPreset: st-bridge',
    '        requestTimeoutMs: 1800000',
    '        maxBodyBytes: 33554432',
    ...(token ? [`        authToken: ${yamlQuote(token)}`] : []),
    END,
    '',
  ]
  return lines.join('\n')
}

function removeBlock(text) {
  const start = text.indexOf(START)
  if (start < 0) return text
  const end = text.indexOf(END, start)
  if (end < 0) return text
  return `${text.slice(0, start)}${text.slice(end + END.length).replace(/^\r?\n/, '')}`
}

function backup(file) {
  if (!existsSync(file)) return
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  copyFileSync(file, `${file}.bak-st-bridge-${stamp}`)
}

function linkPackage(profile) {
  const modules = join(profile, 'node_modules')
  const target = join(modules, 'ST-bridge')
  mkdirSync(modules, { recursive: true })
  if (existsSync(target)) {
    const stat = lstatSync(target)
    if (stat.isSymbolicLink()) {
      const real = realpathSync(target)
      if (real.toLowerCase() === realpathSync(PROJECT).toLowerCase()) return
      throw new Error(`已存在指向其他位置的链接: ${target} -> ${real}`)
    }
    throw new Error(`目标已存在且不是链接: ${target}`);
  }
  symlinkSync(PROJECT, target, process.platform === 'win32' ? 'junction' : 'dir')
  console.log(`已链接: ${target} -> ${PROJECT}`)
}

function unlinkPackage(profile) {
  const target = join(profile, 'node_modules', 'ST-bridge')
  if (!existsSync(target)) return
  const stat = lstatSync(target)
  if (!stat.isSymbolicLink()) {
    console.log(`保留非链接目录: ${target}`)
    return
  }
  const real = realpathSync(target)
  if (real.toLowerCase() !== realpathSync(PROJECT).toLowerCase()) {
    console.log(`保留指向其他位置的链接: ${target} -> ${real}`)
    return
  }
  try {
    unlinkSync(target)
  } catch {
    try { rmdirSync(target) } catch { rmSync(target, { recursive: false, force: true }) }
  }
  console.log(`已移除链接: ${target}`)
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    console.log('用法: node install.mjs [--cwd D:\\AIGC\\MOSS] [--port 43121] [--token TOKEN] [--profile DIR] [--uninstall]')
    return
  }
  const profile = profileDir(args)
  const patchFile = join(profile, 'cordis.patch.yml')
  if (!existsSync(profile)) throw new Error(`DSH profile 不存在: ${profile}`)
  if (!existsSync(patchFile)) throw new Error(`找不到 ${patchFile}`)

  const profilePackageFile = join(profile, 'package.json')
  if (existsSync(profilePackageFile)) {
    let profilePackage
    try {
      profilePackage = JSON.parse(readFileSync(profilePackageFile, 'utf8'))
    } catch {
      profilePackage = undefined
    }
    const isBundle = Boolean(
      profilePackage?.dependencies?.['ST-bridge']
      || profilePackage?.dsh?.profile?.bundles?.includes('ST-bridge'),
    )
    if (isBundle) {
      console.log('检测到 ST-bridge 已作为 profile bundle 安装。')
      console.log('不要再运行 install.mjs 的 insert 模式；请在 DSH 插件管理器或 profile package.json 中管理它。')
      return
    }
  }

  if (args.uninstall) {
    backup(patchFile)
    const next = removeBlock(readFileSync(patchFile, 'utf8'))
    writeFileSync(patchFile, next, 'utf8')
    unlinkPackage(profile)
    console.log('已卸载桥接配置。请完全退出并重启 DSH Desktop。')
    return
  }

  linkPackage(profile)
  backup(patchFile)
  const current = readFileSync(patchFile, 'utf8')
  const withoutOld = removeBlock(current)
  const block = buildBlock(args)
  const next = `${withoutOld.replace(/\s*$/, '')}\n\n${block}`
  writeFileSync(patchFile, next, 'utf8')

  console.log('')
  console.log('安装完成。')
  console.log(`配置: ${patchFile}`)
  console.log(`地址: http://127.0.0.1:${args.port}`)
  console.log('')
  console.log('请完全退出 DSH Desktop（托盘退出，而不是仅关闭窗口），再重新启动。')
  console.log('启动后验证:')
  console.log(`  curl http://127.0.0.1:${args.port}/health`)
  console.log(`  curl http://127.0.0.1:${args.port}/v1/models`)
}

try {
  main()
} catch (error) {
  console.error(`安装失败: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
}
