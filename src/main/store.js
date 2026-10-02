'use strict';
/** 配置持久化：写在 userData/config.json，卸载时保留（nsis deleteAppDataOnUninstall=false） */
const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const wp = require('./util/winpath');
// ★ 这里原来 require 了 './clouddefaults'（为了把内置值补进配置）—— 已删。
//   store **不需要也不许**知道内置的云地址：知道了就会有人再把它写回 config.json（＝固化）。
//   内置值的唯一读点在 src/main/services/cloudsync.js 的 cfgOf()（读时兜底，不写回）。

let cache = null;
let saveTimer = null;

function file() { return path.join(app.getPath('userData'), 'config.json'); }

function defaults() {
  const d = wp.defaultPaths();
  return {
    projectName: '蓝V 素材发布',
    // ★ 2026-10-02：素材位置不再预设（整项删除）。素材目录每次现场选，结果存 project.sourceDir。
    //   老配置里残留的那个键不再被读取，也不影响启动（mergeDeep 会原样留着，无害）。
    paths: { output: d.output, rejected: d.rejected },
    // 品牌注册表：[{ id, name, enabled, note, createdAt }]，增删改与权限判定都在 src/main/brands.js
    // 品牌是跨模块维度（文案 / 发布单 / 发布日志 / 统计 / 账号权限），所以放在顶层而不是 copy 下面
    brands: [],
    // 是否已把旧的 `copy.brand` 迁进 brands。用标记而不是「数组为空就补」——
    // 否则管理员故意把品牌删空时，会被下一次启动悄悄塞回来
    brandsSeeded: false,
    // 真机做法：扁平名用 _ 连接层级路径；原素材完全不动（不改名、不移动）
    flatten: { mode: 'auto', connector: '_', touchOriginal: false, withStamp: true },
    // 真机规格：必须 JPG / ≥1764 像素²(约42×42) / 边长 150~1500 / 超限自动等比缩放 / 视频 <600s；
    // 视频格式：得物只收 mp4 ⇒ 非 mp4（.mov/.m4v/...）由内置 ffmpeg 自动转成 mp4（先无损转封装、不兼容再转码）
    compliance: {
      maxImageMB: 10, maxVideoSec: 600, isolateJunk: true,
      requireJpg: true, minPixels: 1764, minSide: 150, maxSide: 1500,
      autoScale: true, videoExtMustBeMp4: true
    },
    copy: {
      concurrency: 6,
      rotateStrategy: 'F01-F10 轮换',
      requiredTopic: '',              // 出厂留空：不预设任何品牌话题，在「设置 → 文案」里填
      extraTopics: 4,
      brand: '',                       // 【已降级为 legacy】出厂留空：不预设任何品牌；只在旧版本升级时作迁移种子
      defaultBrandId: '',              // 「设置 → 品牌管理」里选的默认品牌（brd_xxx），新建任务时预选
      promptFilter: '',                // 筛选排序提示词
      promptWrite: '',                 // 文案生成提示词
      // ★ 2026-10-02：endpoint / model 出厂**留空 = 跟随内置**（src/main/llmdefaults.js，
      //   读时兜底、**不写回**；和 cloud.url 同一套规矩）—— 用户实测过「配了 key 但地址空着，
      //   于是每次都静默回退本地模板，界面还显示『已生成』」。model 留空同理：
      //   真认的 id 由 copywriter.preflight() 按 /models 清单解析（用户填的显示名会 400）。
      //   vision:false 才是真的不看图；imageCount / imageMaxSide / timeoutSec 是看图的三个旋钮
      //   （出厂值也在 llmdefaults 里，这里存的是「界面上改过的值」）。
      llm: {
        enabled: false, endpoint: '', apiKey: '', model: '', temperature: 0.9,
        vision: true, imageCount: 2, imageMaxSide: 768, timeoutSec: 90
      },
      pool: { 品类: ['#男生穿搭', '#OOTD', '#秋冬新款', '#质感生活', '#日常搭配', '#好物分享'] }   // 出厂只给不含品牌的品类词示例（要 6 个：与「额外话题 4」才够凑出 5 种互不相同的组合）
    },
    // 真机是调接口查得物后台（SKU APIKey），查不到仅告警不阻断
    verify: {
      useImageColor: true, autoApproveKnown: true,
      mode: 'local',
      api: { endpoint: '', apiKey: '' }
    },
    publish: {
      // adb 可执行文件。空 = 自动（优先程序内置的，再退系统 PATH）；填了就用这个完整路径。
      // ★ 2026-10-02 起主界面不再摆这个输入框（内置即用，摆着只是干扰）；要手填去
      //   「设置 → 高级设置」（仅管理员）。自检里仍会回显当前用的到底是哪一个。
      adbPath: '',
      device: '',                      // 选中的设备 serial（多设备矩阵）
      devices: [],                     // [{id, name, serial}] 一个设备 = 一个账号
      intervalSec: 60,                 // 真机是固定 1 分钟间隔，带倒计时
      intervalMinSec: 60,
      intervalMaxSec: 60,
      videoIntervalSec: 90,            // 视频单条更慢（push 抖动大 + 上传久 + 还要等媒体库索引），间隔单独放宽
      videoIndexTimeoutSec: 180,       // 视频推上去后等「相册真的能看到」的上限；超时直接失败报出来，不硬点
      retry: 2,
      // ffmpeg 可执行文件。空 = 自动（优先内置、再退系统 PATH）。与 adbPath 同一套三段解析，
      // 实现在 src/main/services/video.js。同样只在「高级设置」里手填。
      ffmpegPath: ''
    },
    window: { bounds: null, maximized: false },
    // ★ 2026-10-03 用户拍板：「app 颜色默认为浅色」。
    //   「跟随 Windows 设置」这一档**同时取消**（只有浅色 / 深色两种，点顶栏那个按钮切）——
    //   老配置里存着的 'system' 一律按浅色算（见 window.normTheme），
    //   否则会出现「界面浅色、窗口底色深色」这种半深半浅。
    ui: { theme: 'light' },
    // 自动更新的**通道偏好**。★ 只存通道名，**源地址永远编译在包里**（不许运行时改，见
    // src/main/updater.js 文件头铁律 2）；通道名只决定读源上哪个清单文件：正式版 latest.yml / 测试版 beta.yml。
    // 存 stable|beta；非法值由 updater.init() 忽略并落回 stable。
    update: { channel: 'stable' },
    // 云端协作（只上行发布结果给网页看板做聚合，**不参与发布**）。
    // ★★ 出厂这三个键**必须留空**：留空 = 跟随 `clouddefaults.js` 里的内置组织值
    //    （在 cfgOf() 读取时兜底，**不写回**）。装上就能连，各台机器不用手填。
    // ★★ **绝不能在这里写 `CD.url`** —— 那会把内置值**固化进 config.json**，而 config.json
    //    卸载都不删（见本文件第 2 行）⇒ 以后重打包换了内置值，老机器仍连旧地址，界面上还看不出来。
    //    留空之后「换项目」才有正经通道：发新包 → 各台升级（config.json 里仍是空）→ 自动跟随新内置值。
    //    ★ 实证：`D:\work\_e2e\_freeze-probe.js`。
    // ★ 内置的是 anon / publishable key（公开设计，靠 RLS 收口），**不是** service_role。
    // ★ 默认**开启**（多机协作就是要各台都推）；不想上云的机器在这一页关掉开关即可 ——
    //   enabled=false 时 cloudsync 一次都不会联网。只想改**这一台**就往这两个框里填，填了以填的为准。
    cloud: {
      enabled: true,
      url: '', anonKey: '', org: '',
      machineId: '', machineName: '', intervalSec: 30
    }
  };
}

/**
 * ★★ 2026-10-02 第六轮：这里原本有个 `applyCloudDefaults(c)`（load 与 set 都调），
 *    把空的 cloud.url/anonKey/org 补成内置值。它**已整块删除**，别再加回来。
 *
 * 为什么删：补空 = 让内置值**固化进 config.json**，于是
 *   ① 在高级设置页改**任何**一个选项都会把 cloud 整块写盘（saveCfgFromDom 是全页控件值整体提交，
 *      scheduleSave 又整个 cache 写盘），云地址就此焊死在那台机器上；
 *   ② config.json 卸载不删 ⇒ 以后重打包换了内置值也顶不动它，而**界面看不出区别**。
 *     （实测：`D:\work\_e2e\_freeze-probe.js`，见 REFERENCE §T9。）
 *
 * 那原来守的「界面骗人」怎么办？—— 换成**更直接的一条**：
 *   界面必须**如实显示「当前实际在用哪个地址、来源是跟随内置还是本机指定」**
 *   （`#cloudEff`，数据来自 cloudsync.status() 的 url/urlSource）。
 *   显示的是真值，就不存在「框里空着、后台照推」的错觉了；不需要靠把值写进配置来对齐。
 *   ★ 于是语义变干净：**留空 = 跟随内置**（升级新包自动跟随）；**填了 = 只改这一台**。
 */

function mergeDeep(base, patch) {
  if (!patch || typeof patch !== 'object') return base;
  const out = Array.isArray(base) ? base.slice() : Object.assign({}, base);
  for (const k of Object.keys(patch)) {
    const v = patch[k];
    if (v && typeof v === 'object' && !Array.isArray(v) && out[k] && typeof out[k] === 'object' && !Array.isArray(out[k])) {
      out[k] = mergeDeep(out[k], v);
    } else if (v !== undefined) {
      out[k] = v;
    }
  }
  return out;
}

function load() {
  if (cache) return cache;
  cache = defaults();
  try {
    const raw = fs.readFileSync(wp.toLong(file()), 'utf8');
    cache = mergeDeep(cache, JSON.parse(raw));
  } catch (e) { /* 首次启动 */ }
  // ★ 这里原来有 `applyCloudDefaults(cache)`（把空的云地址补成内置值）—— 已删，见上方长注释。
  return cache;
}

function get(key) {
  const c = load();
  if (!key) return c;
  return key.split('.').reduce((o, k) => (o == null ? o : o[k]), c);
}

function set(patch) {
  cache = mergeDeep(load(), patch);
  // ★ 这里原来有 `applyCloudDefaults(cache)` —— 已删（它会把内置值固化进 config.json，见上方长注释）。
  //   现在「留空 = 跟随内置」是**设计上的正常状态**，读的时候由 cloudsync.cfgOf() 兜底。
  scheduleSave();
  return cache;
}

function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      fs.mkdirSync(path.dirname(file()), { recursive: true });
      const tmp = file() + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(cache, null, 2), 'utf8');
      fs.renameSync(tmp, file());
    } catch (e) { /* 只读盘等场景静默降级 */ }
  }, 250);
}

module.exports = { get, set, load, defaults, file };
