/**
 * Markdown 多平台同步 CLI
 *
 * 命令行同步 / 直接发布文章到多个内容平台（通过 Chrome 扩展执行）
 *
 * 使用方式:
 *   wechatsync sync article.md -p juejin,csdn            # 保存草稿
 *   wechatsync sync article.md -p juejin,csdn --publish  # 直接发布
 *   wechatsync platforms --auth
 *   wechatsync auth zhihu
 */
import { Command } from 'commander'
import chalk from 'chalk'
import ora from 'ora'
import fs from 'fs'
import path from 'path'
import juice from 'juice'
import { parseMarkdownDocument } from '@wechatsync/core/markdown'
import { ExtensionBridge, loadArticleFile, imageFileToDataUri } from '@wechatsync/mcp-server/bridge'
import type { PlatformInfo, SyncResult } from '@wechatsync/mcp-server/bridge'

const WS_PORT = parseInt(process.env.SYNC_WS_PORT || '9527', 10)

const GITHUB_URL = 'https://github.com/chenwenbo/dzj-sync'

const program = new Command()

// 默认超时时间
let connectionTimeout = 30000

program
  .name('wechatsync')
  .description('同步 Markdown 文章到多个内容平台，支持保存草稿或直接发布')
  .version('2.0.0')
  .option('--timeout <ms>', '等待 Extension 连接超时（毫秒）', '30000')
  .hook('preAction', (thisCommand) => {
    const opts = thisCommand.opts()
    if (opts.timeout) {
      connectionTimeout = parseInt(opts.timeout)
    }
  })

/**
 * 显示 Extension 安装引导
 */
function showInstallGuide(): void {
  console.log()
  console.log(chalk.bgYellow.black(' 未连接到 Chrome 扩展 '))
  console.log()
  console.log('CLI 需要配合「Markdown 多平台同步」Chrome 扩展使用，扩展负责登录状态和平台 API 调用。')
  console.log()
  console.log(chalk.bold('步骤:'))
  console.log(`  1. 构建并安装扩展（见 ${chalk.cyan(GITHUB_URL)}）`)
  console.log(`  2. 点击扩展图标，在页面右侧「AI 连接」中开启，复制 Token`)
  console.log(`  3. 配置环境变量: ${chalk.cyan('export WECHATSYNC_TOKEN="你的token"')}`)
  console.log(`  4. 在浏览器中登录目标平台（掘金、CSDN、知乎等）`)
  console.log(`  5. 重新运行此命令`)
  console.log()
}

// ============ HTML 处理 ============

/**
 * 解析 HTML 文件
 * 1. 提取标题（title > h1）、meta 信息（封面、摘要）
 * 2. 解析本地 <link rel="stylesheet"> 引用
 * 3. 将 <style> CSS 内联到元素的 style 属性上（juice）
 */
interface ParsedHtml {
  title: string | null
  content: string
  cover?: string
  summary?: string
}

function parseHtml(content: string, filePath?: string): ParsedHtml {
  let title: string | null = null

  // 从 <title> 标签提取
  const titleMatch = content.match(/<title[^>]*>([^<]+)<\/title>/i)
  if (titleMatch) {
    title = titleMatch[1].trim()
  }

  // 从 <h1> 标签提取
  if (!title) {
    const h1Match = content.match(/<h1[^>]*>([^<]+)<\/h1>/i)
    if (h1Match) {
      title = h1Match[1].trim()
    }
  }

  // 从 <meta> 标签提取封面和摘要
  let cover: string | undefined
  let summary: string | undefined
  const ogImageMatch = content.match(/<meta\s[^>]*property=["']og:image["'][^>]*content=["']([^"']+)["'][^>]*>/i)
    || content.match(/<meta\s[^>]*content=["']([^"']+)["'][^>]*property=["']og:image["'][^>]*>/i)
  if (ogImageMatch) {
    cover = ogImageMatch[1]
  }
  const descMatch = content.match(/<meta\s[^>]*name=["']description["'][^>]*content=["']([^"']+)["'][^>]*>/i)
    || content.match(/<meta\s[^>]*content=["']([^"']+)["'][^>]*name=["']description["'][^>]*>/i)
    || content.match(/<meta\s[^>]*property=["']og:description["'][^>]*content=["']([^"']+)["'][^>]*>/i)
  if (descMatch) {
    summary = (descMatch[1] || descMatch[2] || '').trim() || undefined
  }

  // 解析本地 <link rel="stylesheet"> 引用，读取并内联
  const fileDir = filePath ? path.dirname(filePath) : undefined
  if (fileDir) {
    content = content.replace(
      /<link\s[^>]*rel=["']stylesheet["'][^>]*href=["']([^"']+)["'][^>]*\/?>/gi,
      (_match, href: string) => {
        // 只处理本地文件，跳过 http(s) 链接
        if (href.startsWith('http://') || href.startsWith('https://')) return _match
        const cssPath = path.resolve(fileDir, href)
        if (fs.existsSync(cssPath)) {
          const css = fs.readFileSync(cssPath, 'utf-8')
          return `<style>${css}</style>`
        }
        return _match
      }
    )
  }

  // 提取 <style> 标签（可能在 <head> 中），合并到 body
  const styles: string[] = []
  const styleRegex = /<style[^>]*>([\s\S]*?)<\/style>/gi
  let styleMatch
  while ((styleMatch = styleRegex.exec(content)) !== null) {
    styles.push(styleMatch[0])
  }

  // 提取 body 内容
  let body = content
  const bodyMatch = content.match(/<body[^>]*>([\s\S]*?)<\/body>/i)
  if (bodyMatch) {
    body = bodyMatch[1].trim()
  }

  // 将 <head> 中的 <style> 合并到 body
  const bodyStyles = new Set<string>()
  const bodyStyleRegex = /<style[^>]*>([\s\S]*?)<\/style>/gi
  let bs
  while ((bs = bodyStyleRegex.exec(body)) !== null) {
    bodyStyles.add(bs[0])
  }
  const extraStyles = styles.filter(s => !bodyStyles.has(s))
  if (extraStyles.length > 0) {
    body = extraStyles.join('\n') + '\n' + body
  }

  // 用 juice 将 <style> CSS 内联到元素的 style 属性
  // 这样即使平台删除 <style> 标签，样式也能保留
  try {
    body = juice(body, {
      removeStyleTags: true,
      preserveImportant: true,
      preserveMediaQueries: false,
      preserveFontFaces: false,
    })
  } catch (e) {
    // juice 失败不阻塞，保留原始 HTML
  }

  return {
    title,
    content: body,
    cover,
    summary,
  }
}

// ============ Bridge 连接 ============

/**
 * 检测占用端口的进程信息
 */
async function detectPortProcess(port: number): Promise<string | null> {
  const { execSync } = await import('child_process')
  try {
    if (process.platform === 'win32') {
      const output = execSync(`netstat -ano | findstr :${port} | findstr LISTENING`, { encoding: 'utf-8' })
      const pid = output.trim().split(/\s+/).pop()
      if (pid) {
        const info = execSync(`tasklist /FI "PID eq ${pid}" /FO CSV /NH`, { encoding: 'utf-8' }).trim()
        return `PID ${pid} (${info.split(',')[0]?.replace(/"/g, '') || 'unknown'})`
      }
    } else {
      const output = execSync(`lsof -i :${port} -t 2>/dev/null`, { encoding: 'utf-8' }).trim()
      if (output) {
        const pid = output.split('\n')[0]
        const cmdline = execSync(`ps -p ${pid} -o command= 2>/dev/null`, { encoding: 'utf-8' }).trim()
        return `PID ${pid} (${cmdline.slice(0, 60)})`
      }
    }
  } catch {
    // 检测失败也没关系
  }
  return null
}

/**
 * 创建并连接 Bridge
 */
async function createBridge(): Promise<ExtensionBridge | null> {
  const bridge = new ExtensionBridge(WS_PORT, { silent: true })
  const timeout = connectionTimeout

  // 注册信号处理，确保进程退出时释放端口
  const cleanup = () => {
    bridge.stop()
    process.exit(0)
  }
  process.on('SIGINT', cleanup)
  process.on('SIGTERM', cleanup)

  const spinner = ora('启动服务...').start()

  await bridge.start()

  if (bridge.getMode() === 'secondary') {
    spinner.text = '检测到已有实例，等待其完成或接管端口...'
  } else {
    spinner.text = '等待 Chrome Extension 连接...'
  }

  try {
    await bridge.waitForConnection(timeout)
    spinner.succeed(
      bridge.getMode() === 'secondary'
        ? 'Chrome Extension 已连接 (通过 PRIMARY 转发)'
        : 'Chrome Extension 已连接'
    )
    return bridge
  } catch (error) {
    spinner.stop()
    const errMsg = (error as Error).message || ''

    if (bridge.getMode() === 'secondary') {
      if (errMsg.includes('timeout:unreachable')) {
        // PRIMARY HTTP API 不可达 — 僵尸进程占了 WS 端口但没有 HTTP API
        console.log()
        console.log(chalk.red('连接超时: 端口被占用但无法与已有实例通讯'))
        console.log(chalk.gray('可能是旧的 wechatsync 进程未正常退出'))
        console.log()

        const processInfo = await detectPortProcess(WS_PORT)
        if (processInfo) {
          console.log(chalk.yellow(`  端口 ${WS_PORT} 占用进程: ${processInfo}`))
          console.log()
        }

        console.log(chalk.bold('解决方法:'))
        if (process.platform === 'win32') {
          console.log(`  1. 终止旧进程: ${chalk.cyan(`taskkill /F /PID <pid>`)}`)
        } else {
          console.log(`  1. 终止旧进程: ${chalk.cyan(`kill $(lsof -i :${WS_PORT} -t)`)}`)
        }
        console.log(`  2. 使用其他端口: ${chalk.cyan(`SYNC_WS_PORT=9600 wechatsync ...`)}`)
      } else {
        // PRIMARY 可达但 Extension 没连上
        console.log()
        console.log(chalk.red('连接超时: 已有实例正在运行但 Chrome Extension 未连接'))
        console.log(chalk.gray('请确保 Chrome 扩展已启用「同步桥接」并且 Token 正确'))
      }
    } else {
      // PRIMARY 模式超时：Extension 没连上来
      showInstallGuide()
    }

    console.log()
    bridge.stop()
    return null
  }
}

// ============ sync 命令 ============

const splitList = (value?: string): string[] | undefined =>
  value ? value.split(/[,，]/).map(v => v.trim()).filter(Boolean) : undefined

program
  .command('sync <file>')
  .description('同步 Markdown / HTML 文件到平台（默认保存草稿，--publish 直接发布）')
  .option('-p, --platforms <platforms>', '目标平台，逗号分隔（自建站使用 platforms 命令显示的 id）', 'juejin,zhihu')
  .option('--publish', '直接发布（不支持发布的平台会保存为草稿）')
  .option('-t, --title <title>', '文章标题（默认取 frontmatter title 或第一个一级标题）')
  .option('--tags <tags>', '标签，逗号分隔（掘金、CSDN 直接发布必填）')
  .option('--category <category>', '分类，如掘金的 前端 / 后端')
  .option('--summary <summary>', '摘要（掘金直接发布要求不少于 50 字）')
  .option('--cover <url>', '封面图 URL 或本地路径')
  .option('-y, --yes', '直接发布时跳过确认')
  .option('--dry-run', '仅显示将要执行的操作，不实际同步')
  .action(async (file: string, options) => {
    const filePath = path.resolve(file)
    let loaded
    try {
      loaded = loadArticleFile(filePath)
    } catch (error) {
      console.error(chalk.red((error as Error).message))
      process.exit(1)
    }

    const platforms: string[] = splitList(options.platforms) || []
    const publish = !!options.publish

    // Markdown 交给扩展解析 frontmatter；这里解析一次用于展示和校验
    let markdown: string | undefined
    let html: string | undefined
    let title: string | undefined = options.title
    let tags = splitList(options.tags)
    let category: string | undefined = options.category
    let summary: string | undefined = options.summary
    let cover: string | undefined = options.cover

    if (loaded.format === 'markdown') {
      markdown = loaded.content
      const doc = parseMarkdownDocument(loaded.content, path.basename(filePath))
      title ||= doc.title
      tags ||= doc.tags.length ? doc.tags : undefined
      category ||= doc.category
      summary ||= doc.summary
      cover ||= doc.cover
    } else {
      const parsed = parseHtml(loaded.content, filePath)
      html = parsed.content
      title ||= parsed.title || path.basename(filePath, path.extname(filePath))
      summary ||= parsed.summary
      cover ||= parsed.cover
    }

    // 命令行传入的本地封面图
    if (options.cover && !/^(https?:|data:)/.test(options.cover)) {
      const dataUri = imageFileToDataUri(options.cover, process.cwd())
      if (!dataUri) {
        console.error(chalk.red(`封面图文件不存在或格式不支持: ${options.cover}`))
        process.exit(1)
      }
      cover = dataUri
    }

    console.log()
    console.log(chalk.bold('同步信息:'))
    console.log(`  文件: ${chalk.cyan(path.basename(filePath))}`)
    console.log(`  标题: ${chalk.cyan(title)}`)
    console.log(`  方式: ${publish ? chalk.yellow('直接发布') : chalk.cyan('保存草稿')}`)
    console.log(`  平台: ${chalk.cyan(platforms.join(', '))}`)
    if (tags?.length) console.log(`  标签: ${chalk.cyan(tags.join(', '))}`)
    if (category) console.log(`  分类: ${chalk.cyan(category)}`)
    if (cover) console.log(`  封面: ${chalk.cyan(cover.startsWith('data:') ? '(本地图片)' : cover)}`)
    if (loaded.inlined.length) console.log(`  本地图片: ${chalk.green(loaded.inlined.length + ' 张')}（将上传到各平台图床）`)
    if (loaded.missing.length) console.log(`  ${chalk.yellow('⚠ 找不到的图片: ' + loaded.missing.join(', '))}`)
    console.log()

    if (options.dryRun) {
      console.log(chalk.yellow('(dry-run 模式，不实际同步)'))
      process.exit(0)
    }

    if (publish && !options.yes && process.stdin.isTTY) {
      const readline = await import('readline')
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
      const answer = await new Promise<string>(resolve =>
        rl.question(chalk.yellow(`将直接公开发布到 ${platforms.length} 个平台，确定吗? (y/N) `), resolve)
      )
      rl.close()
      if (answer.trim().toLowerCase() !== 'y') {
        console.log('已取消')
        process.exit(0)
      }
    }

    const bridge = await createBridge()
    if (!bridge) {
      process.exit(1)
    }

    const syncSpinner = ora(publish ? '正在发布...' : '正在同步...').start()

    try {
      const response = await bridge.request<{ results: SyncResult[] }>('syncArticle', {
        platforms,
        draftOnly: !publish,
        article: {
          title: options.title || (loaded.format === 'html' ? title : undefined),
          markdown,
          content: html,
          tags,
          category,
          summary,
          cover,
        },
      })

      const results = response.results || []

      syncSpinner.stop()
      console.log()
      console.log(chalk.bold('同步结果:'))
      console.log()

      for (const result of results) {
        const name = result.platformName || result.platform
        if (result.success) {
          console.log(
            chalk.green('  ✓'),
            chalk.bold(name),
            result.draftOnly ? chalk.gray('(草稿)') : chalk.green('(已发布)')
          )
          if (result.postUrl) console.log(`    ${chalk.cyan(result.postUrl)}`)
          if (result.message) console.log(`    ${chalk.yellow(result.message)}`)
        } else {
          console.log(chalk.red('  ✗'), chalk.bold(name))
          console.log(`    ${chalk.red(result.error || '未知错误')}`)
        }
      }

      const successCount = results.filter((r) => r.success).length
      console.log()
      console.log(
        `同步完成: ${chalk.green(successCount + ' 成功')}, ${chalk.red((results.length - successCount) + ' 失败')}`
      )
      process.exitCode = successCount === results.length ? 0 : 1
    } catch (error) {
      syncSpinner.fail('同步失败')
      console.error(chalk.red((error as Error).message))
      process.exitCode = 1
    } finally {
      bridge.stop()
      process.exit()
    }
  })

// ============ platforms 命令 ============

program
  .command('platforms')
  .alias('ls')
  .description('列出所有支持的平台')
  .option('-a, --auth', '同时显示登录状态')
  .action(async (options) => {
    const bridge = await createBridge()
    if (!bridge) {
      process.exit(1)
    }

    const spinner = ora('获取平台列表...').start()

    try {
      const platforms = await bridge.request<PlatformInfo[]>('listPlatforms')

      spinner.stop()
      console.log()
      console.log(chalk.bold(`支持的平台 (${platforms.length}):`))
      console.log()

      for (const p of platforms) {
        const status = options.auth
          ? p.isAuthenticated
            ? chalk.green('✓ 已登录')
            : chalk.red('✗ 未登录')
          : ''
        const username = p.username ? chalk.gray(`(${p.username})`) : ''
        const mode = p.canPublish ? chalk.green('可发布') : chalk.gray('仅草稿')

        console.log(`  ${chalk.cyan(p.id.padEnd(15))} ${p.name.padEnd(10)} ${mode} ${status} ${username}`)
      }
      console.log()
    } catch (error) {
      spinner.fail('获取失败')
      console.error(chalk.red((error as Error).message))
    } finally {
      bridge.stop()
      process.exit(0)
    }
  })

// ============ auth 命令 ============

program
  .command('auth [platform]')
  .description('检查平台登录状态')
  .action(async (platform: string | undefined) => {
    const bridge = await createBridge()
    if (!bridge) {
      process.exit(1)
    }

    const spinner = ora('检查登录状态...').start()

    try {
      if (platform) {
        const result = await bridge.request<PlatformInfo>('checkAuth', {
          platform,
        })

        spinner.stop()
        console.log()

        if (result.isAuthenticated) {
          console.log(chalk.green(`✓ ${platform} 已登录`))
          if (result.username) {
            console.log(`  用户: ${chalk.cyan(result.username)}`)
          }
        } else {
          console.log(chalk.red(`✗ ${platform} 未登录`))
          if (result.error) {
            console.log(`  错误: ${chalk.gray(result.error)}`)
          }
        }
      } else {
        const platforms = await bridge.request<PlatformInfo[]>('listPlatforms')

        spinner.stop()

        const authenticated = platforms.filter((p) => p.isAuthenticated)
        const unauthenticated = platforms.filter((p) => !p.isAuthenticated)

        console.log()
        console.log(chalk.bold('登录状态:'))
        console.log()

        if (authenticated.length > 0) {
          console.log(chalk.green(`已登录 (${authenticated.length}):`))
          for (const p of authenticated) {
            const username = p.username ? chalk.gray(`(${p.username})`) : ''
            console.log(`  ${chalk.cyan(p.id.padEnd(15))} ${p.name} ${username}`)
          }
          console.log()
        }

        if (unauthenticated.length > 0) {
          console.log(chalk.red(`未登录 (${unauthenticated.length}):`))
          for (const p of unauthenticated) {
            console.log(`  ${chalk.gray(p.id.padEnd(15))} ${p.name}`)
          }
          console.log()
        }
      }
    } catch (error) {
      spinner.fail('检查失败')
      console.error(chalk.red((error as Error).message))
    } finally {
      bridge.stop()
      process.exit(0)
    }
  })

// ============ 默认行为 ============

if (process.argv.length <= 2) {
  console.log()
  console.log(chalk.bold('Markdown 多平台同步 CLI') + ' - 同步 / 直接发布文章到多个内容平台')
  console.log()
  console.log(chalk.bold('快速开始:'))
  console.log(`  ${chalk.cyan('wechatsync sync post.md -p juejin,csdn')}            保存为草稿`)
  console.log(`  ${chalk.cyan('wechatsync sync post.md -p juejin,csdn --publish')}  直接发布`)
  console.log(`  ${chalk.cyan('wechatsync platforms --auth')}                        查看登录状态`)
  console.log()
  program.outputHelp()
  process.exit(0)
}

program.parse()
