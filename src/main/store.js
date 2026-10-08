'use strict';
/** 配置持久化：写在 userData/config.json，卸载时保留（nsis deleteAppDataOnUninstall=false） */
const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const wp = require('./util/winpath');
const uimapdefaults = require('./uimapdefaults');   // ★★ 出厂内置的 UI 定位表，见文件头与 withBuiltinMap()
// ★ 这里原来 require 了 './clouddefaults'（为了把内置值补进配置）—— 已删。
//   store **不需要也不许**知道内置的云地址：知道了就会有人再把它写回 config.json（＝固化）。
//   云内置值的唯一读点在 src/main/services/cloudsync.js 的 cfgOf()（读时兜底，不写回）。
// ★★ 2026-10-08 例外一处：**UI 定位表**（./uimapdefaults）确实要 store 知道 —— 但**同样只读不写回**。
//   为什么这次必须由 store 兜底：读它的地方有三个（jobs / publisher / 渲染层），
//   各改各的会出现「发布能跑、界面却显示『定位表未配』」这种自相矛盾。放一个出口才只有一份真相。
//   不写回的做法见 withBuiltinMap()：只在**内存里**返回一张补过的视图，cache 一个字节都不动。

let cache = null;
let saveTimer = null;
let migrations = [];   // 见 migrateLegacyPublishIntervals：本次启动做了哪些迁移（人话）

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
    // 真机规格：必须 JPG / ≥1764 像素²(约42×42) / 边长 **只判下限 ≥150** / **体积不判上限** / 视频 <600s；
    //   ★ 2026-10-05 用户口径：「超尺寸的图片没必要做等比缩放，只要不要低于下限就不用处理尺寸问题，
    //     除非后面我提示」（真机实测：3213×4284、12.6MB 的原图能直接发布）
    //     ⇒ 尺寸上限与体积上限**默认都不判**：`enforceMaxSide` / `enforceMaxMB`（都默认 false）。
    //     maxSide / maxImageMB / autoScale 都没删，「哪天我提示」时把对应开关置 true 即恢复老行为。
    // 视频格式：得物只收 mp4 ⇒ 非 mp4（.mov/.m4v/...）由内置 ffmpeg 自动转成 mp4（先无损转封装、不兼容再转码）
    compliance: {
      maxImageMB: 10, maxVideoSec: 600, isolateJunk: true,
      requireJpg: true, minPixels: 1764, minSide: 150, maxSide: 1500,
      enforceMaxSide: false, enforceMaxMB: false, autoScale: true, videoExtMustBeMp4: true
    },
    copy: {
      concurrency: 6,
      rotateStrategy: 'F01-F10 轮换',
      requiredTopic: '',              // 出厂留空：不预设任何品牌话题，在「设置 → 文案」里填
      extraTopics: 4,
      brand: '',                       // 【已降级为 legacy】出厂留空：不预设任何品牌；只在旧版本升级时作迁移种子
      defaultBrandId: '',              // 「设置 → 品牌管理」里选的默认品牌（brd_xxx），新建任务时预选
      promptWrite: '',                 // 文案生成提示词
      // ★ 2026-10-02：endpoint / model 出厂**留空 = 跟随内置**（src/main/llmdefaults.js，
      //   读时兜底、**不写回**；和 cloud.url 同一套规矩）—— 用户实测过「配了 key 但地址空着，
      //   于是每次都静默回退本地模板，界面还显示『已生成』」。model 留空同理：
      //   真认的 id 由 copywriter.preflight() 按 /models 清单解析（用户填的显示名会 400）。
      //   vision:false 才是真的不看图；imageCount / imageMaxSide / timeoutSec 是看图的三个旋钮；
      //   videoFrames 是第四个：只有视频、没有实拍图时抽几帧（出厂 1，见 llmdefaults.js）。
      //   （出厂值也在 llmdefaults 里，这里存的是「界面上改过的值」）。
      llm: {
        enabled: false, endpoint: '', apiKey: '', model: '', temperature: 0.9,
        vision: true, imageCount: 2, imageMaxSide: 768, timeoutSec: 90, videoFrames: 1
      },
      pool: { 品类: ['#男生穿搭', '#OOTD', '#秋冬新款', '#质感生活', '#日常搭配', '#好物分享'] },  // 出厂只给不含品牌的品类词示例（要 6 个：与「额外话题 4」才够凑出 5 种互不相同的组合）
      // ★★ 标题热词库的用户版（「热词库」页保存的）。**出厂必须是 null** —— 不许预置业务数据：
      //   null = 用 hotwords.js 里的内置基线；存了 = 用户改过的版本（按组名合并，见 currentGroups）。
      //   「恢复内置」＝置回 null。收尾组与 T01~T15 骨架**不落这里**（它们不可编辑）。
      hotwords: null
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
      intervalSec: 60,                 // 60 = 固定 1 分钟间隔，带倒计时；**0 = 连续发布**（发完一条直接发下一条）
      // ★ 2026-10-03 用户要求加「连续发布」档 ⇒ intervalSec 允许为 0。
      //   读取端一律走 publisher 的 secOr/gapSecFor（**不能**再写 `intervalSec || 60`，
      //   否则 0 被兜成 60 ⇒ 界面选了「连续」却还是等一分钟）。
      intervalMinSec: 60,
      intervalMaxSec: 60,
      // ★ 2026-10-03：0 = 跟用户在界面上设的那个间隔一致（不再偷偷放宽到 90 秒）。
      //   要单独放宽视频间隔就显式填一个 >0 的秒数。
      videoIntervalSec: 0,
      // ★ 2026-10-03：0 = 不等 MediaStore（默认）。实测得物相册不读 MediaStore（见 publisher.js），
      //   等它纯属白等。哪天得物改了实现，把这里设成正数（秒）就退回「等索引」的旧行为。
      videoIndexTimeoutSec: 0,
      // ★ 2026-10-03 用户要求：发布失败**不重试** ⇒ 出厂的 `retry: 2` 整项删除。
      //   老配置里就算还留着 retry，也没人读了（读取点已随重试循环一起删）。
      // ffmpeg 可执行文件。空 = 自动（优先内置、再退系统 PATH）。与 adbPath 同一套三段解析，
      // 实现在 src/main/services/video.js。同样只在「高级设置」里手填。
      ffmpegPath: ''
      // ★★ 2026-10-08：**定位表（uiMap）千万不要写进这里**！
      //   写进来 = 随每次 scheduleSave 落进 config.json = 固化（config.json 卸载都不删）⇒
      //   以后换新表、重发包也顶不动老机器，而界面上看不出来（§T9 踩过，有实测）。
      //   出厂内置表的唯一读点是 withBuiltinMap()：读时兜底、不写回。
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

/**
 * ★★ 2026-10-03 一次性迁移：把**旧版本的出厂默认值**从 config.json 里抹掉。
 *
 * 为什么必须做（这不是"锦上添花"，是不做就白改）：
 *   这两个键的出厂默认值在 1.0.9 从 `videoIntervalSec: 90 / videoIndexTimeoutSec: 180`
 *   改成了 `0 / 0`（0 = 视频间隔跟随用户设的那个；0 = 不等 MediaStore）。
 *   但 config.json（userData 下、**卸载都不删**）里**已经写着 90 和 180** —— 那是旧版本
 *   启动时把 defaults 写进去的。而 store 是 mergeDeep：**只会覆盖、没有删键能力**
 *   ⇒ 光把 defaults 改成 0，对**任何老用户都不生效**，他自己也没法改（设置页里根本没有
 *   这两项）。实测证据（1.0.9 源码 + 真机干跑）：视频条仍然照样「等了 182s 媒体库还没索引到」，
 *   与用户报的故障 ① 一字不差。
 *
 * 判据为什么敢这么写：值**恰好等于**旧出厂默认（90 / 180）⇒ 认定"用户从没碰过它"。
 *   理由是设置页里没有这两个旋钮，用户没有任何正常办法把值改成恰好 90 / 180；
 *   而任何**别的**值（比如 120、60）一律原样保留 —— 不替用户做决定。
 *
 * 迁移只发生一次：归 0 之后写回配置，下次启动不再匹配。
 * 返回值是"做了什么"的人话清单，由 src/main/index.js 启动时写进日志（**必须说出来**，
 * 不许静默改用户配置）。
 */
function migrateLegacyPublishIntervals(c) {
  const p = c && c.publish;
  if (!p) return [];
  const done = [];
  if (Number(p.videoIntervalSec) === 90) {
    p.videoIntervalSec = 0;
    done.push('视频间隔：旧的 90 秒出厂默认已归零 —— 现在跟随你在界面上设的间隔（要单独放宽就显式填一个秒数）');
  }
  if (Number(p.videoIndexTimeoutSec) === 180) {
    p.videoIndexTimeoutSec = 0;
    done.push('视频索引等待：旧的 180 秒出厂默认已归零 —— 实测得物相册不读 MediaStore，等它纯属白等'
      + '（哪天得物改了实现，把它显式填回正数即可退回旧行为）');
  }
  return done;
}

/** 本次启动做过的迁移（人话），读一次就清空 —— 给 src/main/index.js 打印用 */
function takeMigrations() { const m = migrations; migrations = []; return m; }

function load() {
  if (cache) return cache;
  cache = defaults();
  try {
    const raw = fs.readFileSync(wp.toLong(file()), 'utf8');
    cache = mergeDeep(cache, JSON.parse(raw));
  } catch (e) { /* 首次启动 */ }
  // ★ 这里原来有 `applyCloudDefaults(cache)`（把空的云地址补成内置值）—— 已删，见上方长注释。
  // ★★ 2026-10-03：旧出厂默认值迁移必须在这里做 —— mergeDeep 只覆盖不删键，
  //    defaults 改成 0 对老 config.json 里写死的 90/180 无效（见 migrateLegacyPublishIntervals）。
  const moved = migrateLegacyPublishIntervals(cache);
  if (moved.length) { migrations = moved; scheduleSave(); }
  return cache;
}

/**
 * ★★ 2026-10-08：出厂内置的 UI 定位表 —— **只在「本机根本没有这个键」（undefined）时兜底，绝不写回**。
 *
 * 三个必须守住的点：
 *  ① **只兜 undefined，不兜 null / ''**：显式 null 是「我就是要没有表」——tools/adbtest.js 正是用
 *     `store.set({ publish: { uiMap: null } })` 验「未配定位表 ⇒ 必须报错」。兜了它，那条断言就假绿。
 *  ② **本机有就用本机**（哪怕是自己抓的表、或导入了别人的表）⇒ 完全不兜底。
 *  ③ **不写回 config.json**：这里返回的是一张**内存视图**（浅拷贝两级），cache 不动 ⇒
 *     以后换新表重发包，各台机器升级后自动跟随（写回就是固化，config.json 卸载都不删）。
 *  返回 c 本身（不拷贝）是常态路径，只在需要补表时多分配两个小对象 —— 不值得优化。
 */
function withBuiltinMap(c) {
  if (!c || !c.publish || c.publish.uiMap !== undefined) return c;
  return Object.assign({}, c, { publish: Object.assign({}, c.publish, { uiMap: uimapdefaults }) });
}

function get(key) {
  const c = withBuiltinMap(load());
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

module.exports = { get, set, load, defaults, file, migrateLegacyPublishIntervals, takeMigrations };
