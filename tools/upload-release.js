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
 *   node tools/upload-release.js --channel stable --force      # 允许覆盖 / 回退同一条通道的版本
 *
 * ★ 两条通道的文件**放在同一个目录**（= 源地址那一层），只有清单文件名不同：
 *   正式版 → `latest.yml`、测试版 → `beta.yml`。
 *   客户端那边靠运行时改 channel 来选读哪个（见 src/main/updater.js 的 setChannel）——
 *   所以**源地址永远不变**，不用出两个包、也不用重装。
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
 * 极简 semver 比较（带预发布段）：`1.0.0-beta.2` < `1.0.0`，`1.0.2` > `1.0.1`。
 * 返回 -1 / 0 / 1；解析不出来时退化成字符串比较（不抛异常）。
 * 为什么值得自己写：只要引一个 semver 依赖就多一棵树，而我们只需要这一个判断。
 */
function compareVersion(a, b) {
  const parse = v => {
    const m = /^\s*(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(String(v == null ? '' : v));
    return m ? { n: [+m[1], +m[2], +m[3]], pre: m[4] ? m[4].split('.') : [] } : null;
  };
  const A = parse(a), B = parse(b);
  if (!A || !B) {
    const x = String(a == null ? '' : a), y = String(b == null ? '' : b);
    return x === y ? 0 : (x < y ? -1 : 1);
  }
  for (let i = 0; i < 3; i++) if (A.n[i] !== B.n[i]) return A.n[i] < B.n[i] ? -1 : 1;
  if (!A.pre.length && !B.pre.length) return 0;
  if (!A.pre.length) return 1;    // 正式版 > 预发布版
  if (!B.pre.length) return -1;
  for (let i = 0; i < Math.max(A.pre.length, B.pre.length); i++) {
    const x = A.pre[i], y = B.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const nx = /^\d+$/.test(x), ny = /^\d+$/.test(y);
    if (nx && ny) { if (+x !== +y) return +x < +y ? -1 : 1; }
    else if (nx !== ny) return nx ? -1 : 1;
    else if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/**
 * 版本闸门。拦两种「传了等于出事」的情况：
 *   ① 源上已是**同一个**版本号 —— electron-builder 按版本号比较，不涨版本号就覆盖
 *      ⇒ 客户端判「没有新版本」；而且新旧文件同名，事后完全查不出来。
 *   ② 传的版本号**比源上还低**（往回发）—— 已经升上去的客户端同样收不到；更要命的是
 *      正式版通道允许降级（用户从测试版切回来时要用），会把用户**真的降下去**。
 * 返回 { block, reason } 决定要不要中止，{ forced } 表示用户明确要覆盖/回退。
 */
function versionGate(remoteVersion, localVersion, force) {
  if (!remoteVersion || !localVersion) return { block: false, remoteVersion, localVersion };
  const c = compareVersion(localVersion, remoteVersion);
  if (c > 0) return { block: false, remoteVersion, localVersion };
  if (c === 0) {
    if (force) return { block: false, forced: true, remoteVersion, localVersion };
    return { block: true, reason: 'same', remoteVersion, localVersion };
  }
  if (force) return { block: false, forced: true, backwards: true, remoteVersion, localVersion };
  return { block: true, reason: 'backwards', remoteVersion, localVersion };
}

/** 通道 → 源上那个清单文件的名字。正式版 latest.yml、测试版 beta.yml（和 electron-updater 的规则一致） */
function channelFile(channel) {
  return channel === 'beta' ? 'beta.yml' : 'latest.yml';
}

/**
 * 通道闸门：拦「版本后缀和通道对不上」。这是**最容易手滑、后果最大**的一种误传 ——
 * 比 versionGate 拦的两种还危险，因为它不报错、也不只是收不到，而是**推错了人**：
 *
 *   ① 预发布版本（`1.0.1-beta.1`）发到**正式通道** ⇒ `latest.yml` 里写上测试版号，
 *      所有正式版用户都会看到「有新版本 1.0.1-beta.1」。等于把**没验收过的包**推给所有人。
 *   ② 正式版本号（`1.0.1`，没有 `-` 段）发到**测试通道** ⇒ 通常只是「忘了带后缀」，
 *      会让测试版用户拿到和正式版同号的包，两条通道失去区分意义。
 *
 * 两种情况都可以用 `--force` 明确放行（比如确实要拿正式版本号先走测试通道试）。
 * ★ 这条检查必须**独立于 versionGate**：versionGate 只在源上已有清单时才比较，
 *   而这条在**任何**上传前都该成立（尤其 Beta 通道第一次发、源上还是空的时候）。
 */
function channelMismatch(channel, version) {
  const v = String(version == null ? '' : version).trim();
  if (!v) return { block: false };
  const isPre = /^\d+\.\d+\.\d+-/.test(v);
  if (channel === 'stable' && isPre) return { block: true, reason: 'pre-to-stable', version: v };
  if (channel === 'beta' && !isPre) return { block: true, reason: 'release-to-beta', version: v };
  return { block: false };
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
  // ★ 两条通道的文件**放在同一个目录**（就是源地址那一层），只有清单文件的名字不同：
  //   正式版 latest.yml、测试版 beta.yml。这正是「一个安装包 + 运行时切通道」能成立的前提 ——
  //   源地址永远不变，切换只是换个文件名去读。
  const manKey = channelFile(channel);
  const jobs = [{ local: path.join(DIST, exeName), key: exeName, what: '安装包' }];
  jobs.push({ local: ymlFile, key: manKey, what: '版本清单' });
  if (fs.existsSync(path.join(DIST, blk))) {
    jobs.push({ local: path.join(DIST, blk), key: blk, what: '增量块图' });
  }

  const DOMAIN = (process.env.COS_DOMAIN ||
    (process.env.COS_BUCKET ? `https://${process.env.COS_BUCKET}.cos.${process.env.COS_REGION}.myqcloud.com` : '')).replace(/\/+$/, '');

  console.log(`通道      ${channel}`);
  console.log(`版本      ${mani.version}（package.json ${pkg.version}）`);
  console.log(`目标      ${DOMAIN || '(未配置 COS_BUCKET / COS_DOMAIN)'}`);
  console.log('要传的文件：');
  for (const j of jobs) console.log(`  ${padTo(j.what, 10)}${j.key}   ${humanSize(fs.statSync(j.local).size)}`);
  // ★ 通道闸门：版本后缀和通道对不上（见 channelMismatch 注释）。故意放在 dry-run 之前 ——
  //   手滑最常发生在「顺手复制了另一条通道的命令」的那一刻，那正是还没传任何东西的时候。
  const mism = channelMismatch(channel, mani.version);
  if (mism.block) {
    console.error('');
    if (mism.reason === 'pre-to-stable') {
      console.error(`拦下了：${mism.version} 是**预发布版本**，却要发到**正式通道**。`);
      console.error('这会把 latest.yml 写成这个测试版号 —— 所有正式版用户都会看到「有新版本」。');
      console.error('要发测试版请用：npm run dist:release:beta');
    } else {
      console.error(`拦下了：${mism.version} 是**正式版本号**（没有 -beta 之类的预发布段），却要发到**测试通道**。`);
      console.error('测试通道建议用带后缀的版本号（例如 1.0.1-beta.1），');
      console.error('否则测试版用户拿到的包和正式版同号，两条通道就没有区分意义了。');
    }
    console.error('确认要这么传就加 --force。');
    if (!dryRun) process.exit(1);
    console.error('（--dry-run：只提示，不中止）');
  }

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
    // ★ 先看源上这条通道现在是什么版本。两种情况下必须停下（除非明确 --force）：
    //   ① 一样的版本号 ⇒ 客户端判「没有新版本」+ 新旧文件同名，事后查不出来
    //   ② 比源上还低（往回发）⇒ 已升级的客户端同样收不到，而且正式版通道允许降级，
    //      会把用户真的降下去
    const remote = await head(manKey);
    if (remote) {
      const body = await new Promise((res, rej) => cos.getObject({ Bucket: B, Region: R, Key: manKey, DataType: 'text' },
        (e, d) => e ? rej(e) : res(d.Body)));
      const rv = parseManifest(String(body)).version;
      console.log(`\n源上现有版本（${manKey}）：${rv || '(读不出)'}`);
      const gate = versionGate(rv, mani.version, force);
      if (gate.block) {
        if (gate.reason === 'backwards') {
          console.error(`要传的 ${mani.version} **比源上的 ${rv} 低**，这是「往回发」。`);
          console.error('已经升上去的客户端收不到（electron-updater 按版本号比较）；');
          console.error('更要命的是正式版通道允许降级（用户从测试版切回来时要用），会把人**降下去**。');
          console.error('确认要回退就加 --force。');
        } else {
          console.error('源上已经是这个版本号了。electron-builder 按版本号比较，');
          console.error('不涨版本号就覆盖 ⇒ 客户端会认为「没有新版本」。');
          console.error('先改 package.json 的 version，或者确实要覆盖就加 --force。');
        }
        process.exit(1);
      }
      if (gate.forced) {
        console.log(gate.backwards
          ? '（--force：明确要往回发，客户端可能收不到这次更新）'
          : '（--force：明确要覆盖同版本号，客户端将收不到这次更新）');
      }
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

module.exports = { parseManifest, humanSize, padTo, pickInstaller, versionGate, compareVersion, channelFile, channelMismatch };
if (require.main === module) main();
