// Generates market/index.json (plugin market index format 1) for this bundle repo.
//
//   node scripts/gen-market-index.mjs [--commit <sha>] [--published <unix-seconds>]
//
// Defaults: the HEAD commit and its committer time, so the index always pins a
// commit that really contains the packaged files. Validate the result with
// @deepseek-ai/dsh-plugin-market-index parseMarketIndex before publishing.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const git = (...a) => execFileSync('git', a, { cwd: root, encoding: 'utf8' }).trim();

const commit = flag('--commit', git('rev-parse', 'HEAD'));
const published = Number(flag('--published', git('log', '-1', '--format=%ct', commit)));
const icon = `data:image/svg+xml;base64,${readFileSync(join(root, 'icon.svg')).toString('base64')}`;

const index = {
  format: 1,
  title: {
    en: 'XD to HTML MCP',
    zh: 'XD 转 HTML MCP',
  },
  description: {
    en: 'Adobe XD readers and exporters for DeepSeek Harness: artboard inspection, PNG rendering, and interactive DOM/PNG HTML export with XD hover and tap states.',
    zh: '面向 DeepSeek Harness 的 Adobe XD 读取与导出插件：画板检查、PNG 渲染，以及保留 XD 悬停/点按状态的交互式 DOM/PNG HTML 导出。',
  },
  metadata: {
    categories: {
      'developer-tools': { title: { en: 'Developer tools', zh: '开发者工具' } },
    },
    labels: {
      'adobe-xd': { title: { en: 'Adobe XD', zh: 'Adobe XD' } },
      html: { title: { en: 'HTML export', zh: 'HTML 导出' } },
    },
  },
  plugins: [
    {
      name: pkg.name,
      title: { en: 'XD to HTML MCP', zh: 'XD 转 HTML MCP' },
      description: {
        en: pkg.description,
        zh: '读取 Adobe XD 文件并导出可交互 HTML：普通文本层 + 透明 PNG 图形，保留悬停/点按状态与页面跳转。',
      },
      icon,
      author: 'yeyanchen',
      homepage: pkg.homepage,
      repository: { url: pkg.repository.url },
      metadata: {
        category: 'developer-tools',
        labels: ['adobe-xd', 'html'],
        keywords: ['adobe-xd', 'mcp', 'html', 'design-to-code'],
      },
      versions: [
        {
          version: pkg.version,
          publishTimestamp: published,
          source: {
            type: 'git',
            url: pkg.repository.url,
            commit,
          },
          engines: { dsh: pkg.engines.dsh },
        },
      ],
    },
  ],
};

mkdirSync(join(root, 'market'), { recursive: true });
writeFileSync(join(root, 'market', 'index.json'), `${JSON.stringify(index, null, 2)}\n`);
console.log(JSON.stringify({ name: pkg.name, version: pkg.version, commit, published, file: join(root, 'market', 'index.json') }));
