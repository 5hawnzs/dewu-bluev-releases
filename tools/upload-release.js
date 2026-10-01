'use strict';
/**
 * 把 dist/ 里打好的包 + latest.yml + .blockmap 传到腾讯云 COS（发布通道）。
 *
 * ★ 为什么必须有它：electron-builder 的 **generic provider 不会替你上传**
 *   （官方明确：generic 需要你把文件自己放上去）。没有这一步，
 *   「打了包」和「客户端能收到更新」之间就断了一截，而且**失败是静默的** ——
 *   源上还是旧 latest.yml，应用永远显示「已是最新」。
 *
 * 用法：
 *   node tools/upload-release.js --channel stable
 *   node tools/upload-release.js --channel beta --dry-run
 *   node tools/upload-release.js --channel stable --force      # 允许覆盖同版本号
 *
 * 凭据（**绝不进仓库**）：环境变量，或仓库根 / tools/ 下的 `.env`（已在 .gitignore）
 *   COS_SECRET_ID / COS_SECRET_KEY
 *   COS_BUCKET   形如 dewu-bluev-release-1499238579
 *   COS_REGION   形如 ap-guangzhou
 *   COS_DOMAIN   可选，默认 https://<bucket>.cos.<region>.myqcloud.com
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');

function loadEnv() {
  for (const f of [path.join(ROOT, '.env'), path.join(__dirname, '.env')]) {
    if (!fs.existsSync(f)) continue;
    for (const line of fs.readFileSync(f, 'utf8').split(/\r?\n/)) {
      const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
      if (!m) continue;
      let v = m[2].trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      if (!(m[1] in process.env)) process.env[m[1]] = v;
    }
  }
}

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  if (i < 0) return def;
  const nxt = process.argv[i + 1];
  return (!nxt || nxt.startsWith('--')) ? true : nxt;
}
const has = name => process.argv.includes('--' + name);

/** latest.yml 是 electron-builder 生成的简单 YAML，只取我们需要的两个字段，不引 YAML 依赖 */
function parseManifest(text) {
  const out = { version: '', path: '', files: [] };
  const v = /^version:\s*(.+)$/m.exec(text);
  if (v) out.version = v[1].trim();
  const p = /^path:\s*(.+)$/m.exec(text);
  if (p) out.path = p[1].trim();
  const re = /^\s*-\s*url:\s*(.+)$/gm;
  let m;
  while ((m = re.exec(text))) out.files.push(m[1].trim());
  return out;
}

/** 人类可读的文件大小（388 B 不能写成 "0.0 MB" —— 那看着像空文件） */
function humanSize(n) {
  if (!Number.isFinite(n) || n < 0) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** 按**显示宽度**补空格（中文占 2 格），否则 --dry-run 的清单会歪 */
function padTo(s, width) {
  let w = 0;
  for (const ch of String(s)) {
    w += /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]/.test(ch) ? 2 : 1;
  }
  return String(s) + ' '.repeat(Math.max(1, width - w));
}

/** 挑出该上传的安装包：**便携版不支持自动更新**，传上去只会让人下错 */
function pickInstaller(names) {
  return names.filter(f => f.endsWith('.exe') && !f.includes('便携版'));
}

/**
 * 版本闸门。源上已有同版本号时必须拦住 —— electron-builder 按版本号比较，
 * 不涨版本号就覆盖会同时踩两个坑：客户端判「没有新版本」+ 新旧文件同名（事后查不出来）。
 * 返回 { block } 决定要不要中止，{ forced } 表示用户明确要覆盖。
 */
function versionGate(remoteVersion, localVersion, force) {
  if (!remoteVersion || !localVersion) return { block: false, remoteVersion, localVersion };
  if (remoteVersion !== localVersion) return { block: false, remoteVersion, localVersion };
  if (force) return { block: false, forced: true, remoteVersion, localVersion };
  return { block: true, remoteVersion, localVersion };
}

function main() {
  loadEnv();

  const channel = String(arg('channel', 'stable'));
  const dryRun = !!has('dry-run');
  const force = !!has('force');

  if (!['stable', 'beta'].includes(channel)) {
    console.error(`--channel 只能是 stable 或 beta，收到：${channel}`);
    process.exit(2);
  }

  const ymlFile = path.join(DIST, 'latest.yml');
  if (!fs.existsSync(ymlFile)) {
    console.error(`找不到 ${ymlFile}\n先在仓库里跑 npm run dist:win 打包。`);
    process.exit(2);
  }
  const mani = parseManifest(fs.readFileSync(ymlFile, 'utf8'));
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

  // ★ 版本号必须和 package.json 一致，否则就是「打了包但版本没涨」——
  //   electron-builder 按版本号比较，不涨客户端会直接判「没有新版本」，而且同名文件会被覆盖
  if (mani.version && pkg.version && mani.version !== pkg.version) {
    console.error(`dist 里的包是 ${mani.version}，package.json 是 ${pkg.version}`);
    console.error('说明 dist 是旧版本打的，先 npm run dist:win 重打，别把旧包传上去。');
    process.exit(2);
  }

  // 只传安装版：portable 不支持自动更新，传上去只会让人下错
  const exes = pickInstaller(fs.readdirSync(DIST));
  if (exes.length !== 1) {
    console.error(`dist/ 里应当只有 1 个安装版 exe，实际找到 ${exes.length} 个：${exes.join(', ')}`);
    process.exit(2);
  }
  const exeName = exes[0];
  if (mani.path && mani.path !== exeName) {
    console.error(`latest.yml 里写的 path=${mani.path}，与 dist 里的 ${exeName} 对不上。`);
    console.error('客户端会按 yml 里的名字去下载，对不上就是 404。先重打一次。');
    process.exit(2);
  }

  const blk = exeName + '.blockmap';
  const jobs = [{ local: path.join(DIST, exeName), key: channel + '/' + exeName, what: '安装包' }];
  jobs.push({ local: ymlFile, key: channel + '/' + (channel === 'beta' ? 'beta.yml' : 'latest.yml'), what: '版本清单' });
  if (fs.existsSync(path.join(DIST, blk))) {
    jobs.push({ local: path.join(DIST, blk), key: channel + '/' + blk, what: '增量块图' });
  }

  const DOMAIN = (process.env.COS_DOMAIN ||
    (process.env.COS_BUCKET ? `https://${process.env.COS_BUCKET}.cos.${process.env.COS_REGION}.myqcloud.com` : '')).replace(/\/+$/, '');

  console.log(`通道      ${channel}`);
  console.log(`版本      ${mani.version}（package.json ${pkg.version}）`);
  console.log(`目标      ${DOMAIN || '(未配置 COS_BUCKET / COS_DOMAIN)'}`);
  console.log('要传的文件：');
  for (const j of jobs) console.log(`  ${padTo(j.what, 10)}${j.key}   ${humanSize(fs.statSync(j.local).size)}`);
  if (dryRun) { console.log('\n--dry-run：什么都没传。'); return; }

  if (!process.env.COS_SECRET_ID || !process.env.COS_SECRET_KEY || !process.env.COS_BUCKET || !process.env.COS_REGION) {
    console.error('\n缺少凭据。需要 COS_SECRET_ID / COS_SECRET_KEY / COS_BUCKET / COS_REGION（环境变量或 .env）。');
    process.exit(2);
  }

  let COS;
  try { COS = require('cos-nodejs-sdk-v5'); }
  catch (e) { console.error('缺 cos-nodejs-sdk-v5，先 npm i -D cos-nodejs-sdk-v5'); process.exit(2); }
  const cos = new COS({ SecretId: process.env.COS_SECRET_ID, SecretKey: process.env.COS_SECRET_KEY, Timeout: 600000 });

  const B = process.env.COS_BUCKET, R = process.env.COS_REGION;
  const head = Key => new Promise(res => cos.headObject({ Bucket: B, Region: R, Key }, (e, d) => res(e ? null : d)));
  const put = (Key, File) => new Promise((res, rej) => cos.uploadFile({
    Bucket: B, Region: R, Key, FilePath: File, SliceSize: 5 * 1024 * 1024
  }, (e, d) => e ? rej(e) : res(d)));

  (async () => {
    // ★ 同版本号覆盖 = 客户端判「没有新版本」+ 新旧文件同名，事后完全查不出来。
    //   所以先看源上是什么版本，一样就停下来，除非明确 --force
    const manKey = channel + '/' + (channel === 'beta' ? 'beta.yml' : 'latest.yml');
    const remote = await head(manKey);
    if (remote) {
      const body = await new Promise((res, rej) => cos.getObject({ Bucket: B, Region: R, Key: manKey, DataType: 'text' },
        (e, d) => e ? rej(e) : res(d.Body)));
      const rv = parseManifest(String(body)).version;
      console.log(`\n源上现有版本：${rv || '(读不出)'}`);
      const gate = versionGate(rv, mani.version, force);
      if (gate.block) {
        console.error('源上已经是这个版本号了。electron-builder 按版本号比较，');
        console.error('不涨版本号就覆盖 ⇒ 客户端会认为「没有新版本」。');
        console.error('先改 package.json 的 version，或者确实要覆盖就加 --force。');
        process.exit(1);
      }
      if (gate.forced) console.log('（--force：明确要覆盖同版本号，客户端将收不到这次更新）');
    }

    for (const j of jobs) {
      process.stdout.write(`上传 ${j.key} … `);
      await put(j.key, j.local);
      const h = await head(j.key);
      console.log('ok' + (h ? `（源上 ${h.headers['content-length']} B）` : ''));
    }

    console.log('\n完成。公网地址：');
    for (const j of jobs) console.log('  ' + DOMAIN + '/' + encodeURI(j.key));
    console.log('\n提醒：自动更新只对**安装版**生效 —— 本机若还在跑开发版（npm start）或早先的便携版，收不到这次更新。');
  })().catch(e => {
    console.error('\n上传失败：' + ((e && (e.code || e.message)) || e));
    process.exit(1);
  });
}

module.exports = { parseManifest, humanSize, padTo, pickInstaller, versionGate };
if (require.main === module) main();
