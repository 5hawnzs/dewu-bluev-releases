/* 文案生成：看图写 + 带时间戳的 AI 内容报告 + 一致性核对
   真机口径（用户 2026-10-02）：
     「点击文案生成后，你应该在该文件夹生成一个全新的带时间戳的 ai 报告，以便后续校验文案、货号、颜色是否一致」
     「你现在的文案都是根据货号和颜色生成的标题，一看就是 ai 做的，不真实」
   要钉住的事：
     ① 开模型时**真的把素材图发出去了**（这不是「源码里有 image_url 这行字」，而是真起一个假服务收请求、
        把收到的 base64 解开、确认它是一张 JPEG）；
     ② 模型名对不上接口清单时要**换成真认的 id**（实测 `deepseek v4.1 flash` 直接 400）；
     ③ 模型连不上时**不许静默出模板货**（要么报错，要么如实标注来源为「本地模板」）；
     ④ 跑完在**素材文件夹**里落一份 `<品牌>_AI内容报告_<时间戳>.xlsx`；
     ⑤ 报告能被自己的 report.readReport **反向导入**（列名对齐上游那份 KIDS_AI内容报告）；
     ⑥ 报告里「文案核对」列真能查出「混进货号 / 用了套话 / 颜色对不上」；
     ⑦ ★ 标题写成「产品词 + 热门词」的词包（用户 2026-10-03：「你这个标题就是纯描述产品是什么，
        我要的是产品+热门词」），并且**每行的标题句式真的发给了模型**（不是只写在源码里）。
     ⑧ ★★ 标题必须是**一句念得通的话**，不是两串词硬贴（用户 2026-10-03 第八次：
        「我的 + 号是为了让你知道什么类型和什么类型合并，**不是让你直接加进标题里**，
         而且目前你的标题有明显的语病，如你生成的『少年感灰针织毛衣』，
         如果能变成『少年感灰针织毛衣太帅了』」）——
        ⇒ ① 标题里**不许出现「+」**；② 句式骨架自带连接字/收尾；③ 示例里不许写死颜色与单品。
*/
const Module = require('module');
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bluev-copy-'));
const fake = {
  app: { getPath: () => TMP, getVersion: () => '1.0.0', requestSingleInstanceLock: () => true, on() {}, whenReady: () => Promise.resolve(), quit() {}, setAppUserModelId() {} },
  BrowserWindow: { getAllWindows: () => [], getFocusedWindow: () => null },
  ipcMain: { handle() {}, on() {} }, dialog: {}, shell: {},
  nativeTheme: { shouldUseDarkColors: false, themeSource: 'system', on() {} },
  Notification: { isSupported: () => false }, screen: {},
  contextBridge: { exposeInMainWorld() {} }, ipcRenderer: {}
};
const origLoad = Module._load;
Module._load = function (r) { if (r === 'electron') return fake; return origLoad.apply(this, arguments); };

const base = path.resolve(__dirname, '..');
const jpeg = require(path.join(base, 'node_modules', 'jpeg-js'));
const store = require(path.join(base, 'src/main/store.js'));
const jobs = require(path.join(base, 'src/main/jobs.js'));
const copywriter = require(path.join(base, 'src/main/services/copywriter.js'));
const copycheck = require(path.join(base, 'src/main/services/copycheck.js'));
const hotwords = require(path.join(base, 'src/main/services/hotwords.js'));
const aireport = require(path.join(base, 'src/main/services/aireport.js'));
const report = require(path.join(base, 'src/main/services/report.js'));
const imaging = require(path.join(base, 'src/main/services/imaging.js'));
const wp = require(path.join(base, 'src/main/util/winpath.js'));

const ok = (label, cond, extra) => {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + label + (extra ? '  → ' + extra : ''));
  if (!cond) process.exitCode = 1;
};

/**
 * 一条**符合新正文格式**的正文样本。
 * ★★ 2026-10-03 起：正文 = 「4~5 行短句 + 少量 emoji」（用户拿官号实发笔记定死）。
 *   以前这里是一整行 90 个 x —— 新口径下那正好是「又写成一整段」，
 *   会额外触发「行数 / 单行过长」两条，把那些**本来只想测标题**的断言一起染黄
 *   （19 处都换成了它，就是为了这个）。
 */
const BODY4 = '面料软滑透气不闷，\n宽松版型上身不挑人，\n颜色低调但很显气色，\n日常通勤随手一穿就对🌿';

function jpgBuf(size, rgba) {
  const d = Buffer.alloc(size * size * 4);
  const [r, g, b] = rgba || [200, 200, 200];
  for (let i = 0; i < d.length; i += 4) { d[i] = r; d[i + 1] = g; d[i + 2] = b; d[i + 3] = 255; }
  return jpeg.encode({ data: d, width: size, height: size }, 90).data;
}

/** 造一批素材：3 个叶子，每个 2 张图（叶子名 = 货号+颜色+序号，真机的命名） */
function makeBatch(name, leaves) {
  const root = path.join(TMP, name);
  const specs = [
    { dir: '26FW-YB160+冠军白+1', rgba: [230, 230, 232] },
    { dir: '26FWT75+蓝调蓝+1', rgba: [120, 140, 190] },
    { dir: '26FW-CB122+燕麦色+1', rgba: [214, 198, 170] }
  ].slice(0, leaves);
  for (const s of specs) {
    const dir = path.join(root, s.dir);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '1.jpg'), jpgBuf(160, s.rgba));
    fs.writeFileSync(path.join(dir, '2.jpg'), jpgBuf(160, s.rgba));
  }
  return root;
}

/* ---------------- 假模型服务 ---------------- */
const seen = [];          // 每一次收到的请求体
let srvRef = null;        // ★ 出错路径要能把它关掉，见文件末尾的 catch
let mode = 'ok';          // ok | rejectImageOnce | modelNames
let reply = { title: '燕麦色圆领毛衣小熊刺绣休闲风', body: '燕麦色针织毛衣，圆领设计，胸前一枚小熊刺绣，袖口和下摆是竖条罗纹收口，面料看着挺软，配浅蓝牛仔就是干净舒服的日常感。' };

function startServer() {
  return new Promise(resolve => {
    const srv = http.createServer((req, res) => {
      let raw = '';
      req.on('data', c => { raw += c; });
      req.on('end', () => {
        const send = (code, obj) => {
          res.writeHead(code, { 'content-type': 'application/json' });
          res.end(JSON.stringify(obj));
        };
        if (/\/models$/.test(req.url)) {
          return send(200, {
            object: 'list',
            data: [
              { id: 'deepseek-flash', name: 'DeepSeek-V4.1-Flash', input_modalities: ['text', 'image'] },
              { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro', input_modalities: ['text'] }
            ]
          });
        }
        let body = {};
        try { body = JSON.parse(raw); } catch (e) { /* 记空 */ }
        const content = body && body.messages && body.messages[1] && body.messages[1].content;
        const images = Array.isArray(content) ? content.filter(p => p && p.type === 'image_url') : [];
        seen.push({ url: req.url, model: body.model, messages: body.messages, images, hasImage: images.length > 0 });
        // 「网关不收图」：第一次带图的请求回 400，逼程序退回纯文字
        if (mode === 'rejectImageOnce' && images.length && seen.filter(s => s.hasImage).length === 1) {
          return send(400, { error: { message: 'this model does not support image content' } });
        }
        return send(200, {
          choices: [{ message: { content: JSON.stringify(reply) } }],
          usage: { prompt_tokens: 100, completion_tokens: 50 }
        });
      });
    });
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port }));
  });
}

(async () => {
  const { srv, port } = await startServer();
  srvRef = srv;
  const ENDPOINT = `http://127.0.0.1:${port}/v1`;

  store.set({
    paths: { output: path.join(TMP, '输出'), rejected: path.join(TMP, '_rejected') },
    copy: { concurrency: 3, requiredTopic: '#品牌甲', extraTopics: 4, llm: { enabled: false } },
    publish: { intervalSec: 5, videoIntervalSec: 5, retry: 1 }
  });

  /* ---- ⓪ 时间戳：报告文件名要能一眼看出哪一天哪一刻（而且不能有 Windows 非法字符） ---- */
  const iso = wp.stampISO(new Date(2026, 7, 26, 10, 41, 2));
  ok('⓪ 时间戳形如 2026-08-26T10-41-02（对齐上游报告的命名）', iso === '2026-08-26T10-41-02', iso);
  ok('⓪ 秒级（同一分钟内跑两批不会撞名）', wp.stampISO(new Date(2026, 7, 26, 10, 41, 2)) !== wp.stampISO(new Date(2026, 7, 26, 10, 41, 3)));
  ok('⓪ 文件名里不含冒号等 Windows 非法字符', !/[<>:"|?*]/.test(aireport.fileNameOf('TW男装', new Date(2026, 7, 26, 10, 41, 2))),
    aireport.fileNameOf('TW男装', new Date(2026, 7, 26, 10, 41, 2)));
  ok('⓪ 品牌名里的非法字符被洗掉（真机品牌名带过 /）',
    !/[<>:"|?*]/.test(aireport.fileNameOf('A/B:品牌', new Date(2026, 7, 26, 10, 41, 2))),
    aireport.fileNameOf('A/B:品牌', new Date(2026, 7, 26, 10, 41, 2)));

  /* ---- ① 文案核对（纯函数，双向：好文案要判「一致」，坏文案要被抓出来） ---- */
  const GOOD = copycheck.check(
    {
      title: '燕麦色圆领毛衣小熊刺绣休闲风🧸',
      body: '燕麦色针织毛衣，圆领设计，\n胸前一枚黑色小熊刺绣，\n袖口和下摆是竖条罗纹收口，\n绒面看着挺软，搭牛仔裤很干净✨'
    },
    { goods: [{ sku: '26FW-CB122', color: '燕麦色' }], imageColor: '米' });
  ok('① 正常文案判「一致」', GOOD.level === 'ok' && GOOD.text === '一致', GOOD.text);
  const SKU = copycheck.check({ title: '26FW-CB122 燕麦色毛衣', body: BODY4 }, { goods: [{ sku: '26FW-CB122', color: '燕麦色' }] });
  ok('① 标题里混进货号 → 判 bad 并写清是哪个货号', SKU.level === 'bad' && /26FW-CB122/.test(SKU.text), SKU.text);
  const CLICHE = copycheck.check({ title: '燕麦色毛衣的细节，真的顶✅', body: BODY4 }, { goods: [{ sku: 'S1', color: '燕麦色' }] });
  ok('① 用了本地模板套话 → 判 bad（这就是「一看就是 AI 做的」的痕迹）', CLICHE.level === 'bad' && /套话/.test(CLICHE.text), CLICHE.text);
  const COL = copycheck.check({ title: '军绿色工装夹克通勤搭配🧥', body: BODY4 }, { goods: [{ sku: 'S2', color: '卡其' }] });
  ok('① 文案写「军绿」但货号声明「卡其」→ 判 warn 并说清两边', COL.level === 'warn' && /军绿/.test(COL.text) && /卡其/.test(COL.text), COL.text);
  const ICOL = copycheck.check({ title: '浅蓝牛仔外套休闲穿搭💙', body: BODY4 }, { goods: [{ sku: 'S3', color: '浅蓝' }], imageColor: '黑' });
  ok('① 图里实取主色与声明颜色不是同一色系 → 判 warn', ICOL.level === 'warn' && /图里实取主色/.test(ICOL.text), ICOL.text);
  const ECOM = copycheck.check({ title: '冠军白圆领卫衣简约百搭🤍', body: BODY4 }, { goods: [{ sku: 'S4', color: '冠军白' }], imageColor: '白' });
  ok('① 电商叫法「冠军白」能认成白系（词表里没有这个词，别一律判「只能人工看」）', ECOM.level === 'ok', ECOM.text);
  ok('① 标题超 15 字 / 没 emoji 都会被点出来',
    /超过 15 字/.test(copycheck.check({ title: '这是一个特别特别特别长的标题没有任何缩写', body: BODY4 }, {}).text)
    && /没有 emoji/.test(copycheck.check({ title: '燕麦色毛衣通勤搭配', body: BODY4 }, {}).text));
  ok('① 正文长度离谱会被点出来',
    /正文/.test(copycheck.check({ title: '燕麦色毛衣通勤搭配✨', body: '太短了' }, {}).text));
  // ★★ 2026-10-03 修一个**潜伏**的判错：`EMOJI_RE` 带 `g`，带 `g` 的正则 `.test()` 会推进
  //   `lastIndex` ⇒ **同一条标题连判两次一真一假**。真机实测的证据：10 条标题全都带 emoji，
  //   连着判一遍却报出「4 条没有 emoji」。正反两条都钉，防止修成「恒 true」。
  const emojiSeq = [1, 2, 3, 4].map(() => copycheck.hasEmoji('燕麦色毛衣才是入秋的答案🍂'));
  ok('① ★ 带 emoji 的标题连判 4 次必须都 true（带 g 的 .test() 会推进 lastIndex，实测一真一假）',
    emojiSeq.every(Boolean), emojiSeq.join(' '));
  const noEmojiSeq = [1, 2, 3, 4].map(() => copycheck.hasEmoji('燕麦色毛衣通勤搭配'));
  ok('① ★ 真没 emoji 的标题连判 4 次必须都 false（别修成「恒 true」）',
    noEmojiSeq.every(v => v === false), noEmojiSeq.join(' '));
  ok('① ★ 一串带 emoji 的标题逐条连判，一条都不许被漏成「没有 emoji」',
    ['少年感灰针织毛衣太帅了🔥', '军绿调穿搭夹克 松弛感拉满🧥', '通勤就穿军绿夹克🧥', '驼色针织毛衣自带少年感✨']
      .every(t => copycheck.hasEmoji(t) === true));
  ok('① 同一批标题逐条过 check()，「没有 emoji」这条告警一条都不该冒出来',
    ['少年感灰针织毛衣太帅了🔥', '军绿调穿搭夹克 松弛感拉满🧥', '通勤就穿军绿夹克🧥', '驼色针织毛衣自带少年感✨']
      .every(t => !/没有 emoji/.test(copycheck.check({ title: t, body: BODY4 },
        { goods: [{ sku: 'S14', color: '灰' }] }).text)));
  // ★ 2026-10-03：货号 / 颜色空着也要说 —— 文案再好看，这一行也发不出去（关联不到商品），
  //   或者多色货号只会选到第一件。这两件事不该被写成「一致」。
  const NOGOODS = copycheck.check({ title: '燕麦色毛衣通勤搭配✨', body: BODY4 }, { goods: [] });
  ok('① 没填货号 ⇒ 判 bad（这一条发布时关联不到商品）',
    NOGOODS.level === 'bad' && /没填货号/.test(NOGOODS.text), NOGOODS.text);
  const NOCOLOR = copycheck.check({ title: '燕麦色毛衣通勤搭配✨', body: BODY4 }, { goods: [{ sku: 'S9', color: '' }] });
  ok('① 有货号没颜色 ⇒ 判 warn（多色货号只会选第一件商品）',
    NOCOLOR.level === 'warn' && /没填颜色/.test(NOCOLOR.text) && /S9/.test(NOCOLOR.text), NOCOLOR.text);

  // ★ 2026-10-03：标题写法改成「产品词 + 热门词」后，颜色判据必须收紧 ——
  //   不然「羽绒服+简约百搭」这种**好**标题会全部被标黄，那一列就没人看了（＝误杀）。
  const PACK = copycheck.check({ title: '简约百搭的羽绒服🔥', body: BODY4 },
    { goods: [{ sku: 'S5', color: '灰' }], imageColor: '灰' });
  ok('① ★ 词包标题「简约百搭的羽绒服」判「一致」—— 标题不带颜色不该被标黄',
    PACK.level === 'ok' && PACK.text === '一致', PACK.text);
  ok('① 「蓝调穿搭」里的「蓝」是氛围词，不算在说衣服是蓝的',
    copycheck.declaredColorsIn('蓝调穿搭的羽绒服').length === 0,
    JSON.stringify(copycheck.declaredColorsIn('蓝调穿搭的羽绒服')));
  // ★ 上面那条只测了工具函数 —— 把 check() 里的调用点换回旧函数它也照样绿。
  //   所以再钉一条**行为级**的：货号声明「灰」而标题写「蓝调穿搭」，
  //   旧判据会判 warn（把「蓝」当成衣服颜色），新判据必须判 ok。
  const ATMOS = copycheck.check({ title: '蓝调穿搭的羽绒服🔥', body: BODY4 },
    { goods: [{ sku: 'S6', color: '灰' }], imageColor: '灰' });
  ok('① ★ 「蓝调穿搭」配灰货号 ⇒ 判「一致」（氛围词不是颜色声明；旧判据这里会误判 warn）',
    ATMOS.level === 'ok' && ATMOS.text === '一致', ATMOS.text);
  ok('① 但「灰色羽绒服」确实在说颜色（颜色词紧挨着单品词）',
    JSON.stringify(copycheck.declaredColorsIn('灰色羽绒服慵懒风')) === JSON.stringify(['灰']),
    JSON.stringify(copycheck.declaredColorsIn('灰色羽绒服慵懒风')));
  const PACKCOL = copycheck.check({ title: '灰色羽绒服，松弛感拉满🔥', body: BODY4 },
    { goods: [{ sku: 'S7', color: '蓝' }] });
  ok('① ★ 真写错颜色仍要判 warn（收紧判据不等于放弃这一条）',
    PACKCOL.level === 'warn' && /灰/.test(PACKCOL.text) && /蓝/.test(PACKCOL.text), PACKCOL.text);
  const DESCP = copycheck.check({ title: '蓝灰横向绗缝立领羽绒，左胸刺绣🐻', body: BODY4 },
    { goods: [{ sku: 'S8', color: '灰' }], imageColor: '灰' });
  ok('① ★ 被打回的那种「商品描述」标题会被点名（用户原话：纯描述产品是什么）',
    DESCP.level === 'warn' && /像商品描述/.test(DESCP.text), DESCP.text);

  // ★★ 2026-10-03（第八次会话）用户又打回两条：
  //   「我的 + 号是为了让你知道什么类型和什么类型合并，**不是让你直接加进标题里**」
  //   「目前你的标题有明显的语病，如你生成的『少年感灰针织毛衣』，
  //     如果能变成『少年感灰针织毛衣太帅了』；或者『军绿调穿搭夹克』⇒『军绿调穿搭夹克 松弛感拉满』」
  const PLUS = copycheck.check({ title: '羽绒服+简约百搭🔥', body: BODY4 },
    { goods: [{ sku: 'S10', color: '灰' }] });
  ok('① ★ 标题里出现「+」⇒ 判 warn（+ 只是「哪类词跟哪类词合并」的示意，不是标题的字）',
    PLUS.level === 'warn' && /拼接符号/.test(PLUS.text) && /\+/.test(PLUS.text), PLUS.text);

  const PASTE_BAD = copycheck.check({ title: '少年感灰针织毛衣🔥', body: BODY4 },
    { goods: [{ sku: 'S11', color: '灰' }] });
  ok('① ★ 用户实测的病句「少年感灰针织毛衣」被点名（热词直贴单品、没有收尾/连接字）',
    PASTE_BAD.level === 'warn' && /语病/.test(PASTE_BAD.text), PASTE_BAD.text);

  // ★ 反向对照：这两条是**用户自己给的**「改成这样就对了」的正例 —— 不许被点名。
  //   只测「病句被报」而不测「正例不报」，等于只验负向（＝假通过）。
  const PASTE_OK1 = copycheck.check({ title: '少年感灰针织毛衣太帅了🔥', body: BODY4 },
    { goods: [{ sku: 'S12', color: '灰' }] });
  ok('① ★ 用户给的正例「少年感灰针织毛衣太帅了」判「一致」（补了收尾就通顺了）',
    PASTE_OK1.level === 'ok' && PASTE_OK1.text === '一致', PASTE_OK1.text);
  const PASTE_OK2 = copycheck.check({ title: '军绿调穿搭夹克 松弛感拉满🧥', body: BODY4 },
    { goods: [{ sku: 'S13', color: '军绿' }] });
  ok('① ★ 用户给的正例「军绿调穿搭夹克 松弛感拉满」判「一致」（有空格断句）',
    PASTE_OK2.level === 'ok' && PASTE_OK2.text === '一致', PASTE_OK2.text);

  // ★ 工具函数层面再钉一次：判据本身要能把这一对分开（不然上面两条可能因为别的原因恰好通过）
  ok('① ★ 标签串判据：病句 true / 用户给的两个正例 false',
    copycheck.looksLikeWordPaste('少年感灰针织毛衣') === true
    && copycheck.looksLikeWordPaste('少年感灰针织毛衣太帅了') === false
    && copycheck.looksLikeWordPaste('军绿调穿搭夹克 松弛感拉满') === false,
    ['少年感灰针织毛衣', '少年感灰针织毛衣太帅了', '军绿调穿搭夹克 松弛感拉满']
      .map(t => t + '=' + copycheck.looksLikeWordPaste(t)).join(' / '));

  /* ---- ①b 正文格式：4~5 行短句（2026-10-03 用户拿官号实发笔记定死） ----
     用户原话：「设定文案格式：4-5行，每段简单描述卖点/氛围感/感受等+少量emoji，最后加入话题。每行均需换行」。
     ⇒ 判「行数」比判「字数」更要紧：字数够但挤成一行，发到得物就是一整段。 */
  const cb = (body, title) => copycheck.check({ title: title || '燕麦色毛衣通勤搭配✨', body },
    { goods: [{ sku: 'S20', color: '燕麦色' }] });
  const L4 = '面料软滑透气不闷，\n宽松版型上身不挑人，\n颜色低调但很显气色，\n日常通勤随手一穿就对🌿';
  ok('①b 4 行正文判「一致」（新格式的正常形态）',
    cb(L4).level === 'ok' && cb(L4).text === '一致', cb(L4).text);
  ok('①b 5 行正文也不告警',
    cb(L4 + '\n长度刚好盖住胯，显腿长。').level === 'ok', cb(L4 + '\n长度刚好盖住胯，显腿长。').text);
  ok('①b ★ 6 行容忍（多一行不标黄；死卡 4~5 会让整列变黄 = 没人看）',
    !/正文只写了/.test(cb(L4 + '\n多一行，\n再多一行').text), cb(L4 + '\n多一行，\n再多一行').text);
  ok('①b ★ 1 行（又写成一整段）会被点出来',
    /正文只写了 1 行/.test(cb(L4.replace(/\n/g, '')).text), cb(L4.replace(/\n/g, '')).text);
  ok('①b ★ 7 行也会被点出来（超过容忍上限）',
    /正文只写了 7 行/.test(cb(L4 + '\n多一行，\n再多一行，\n还来一行').text),
    cb(L4 + '\n多一行，\n再多一行，\n还来一行').text);
  const LONG1 = '这是一行特别特别长的正文句子用来测试单行超长的判据会不会被点出来，\n短句一，\n短句二，\n收尾🌿';
  ok('①b ★ 单行过长会被点出来（说明又写成一整段）', /有一行 \d+ 字/.test(cb(LONG1).text), cb(LONG1).text);
  ok('①b 正文没有 emoji 会被点出来', /正文没有 emoji/.test(cb(L4.replace('🌿', '')).text));
  const E5 = '一行一句短句，🌿\n二行一句短句，🧥\n三行一句短句，✨\n四行一句短句，🤍\n五行一句短句，🍂';
  ok('①b emoji 太多（5 个）会被点出来', /偏多/.test(cb(E5).text), cb(E5).text);

  /* ---- ①c 重复口径：只看相邻两条、换 emoji 就算不同（2026-10-03 用户拍板） ----
     「品牌 a 用了 abcde 文字 + x emoji，品牌 b 也允许用同一个；品牌 a 后续也允许 abcde 文字 + y emoji。
       同一品牌下，只要 emoji 有不同，文字完全相同也不要紧，**只要不要连续 2 条内容文字完全一致即可**。」 */
  const dup = arr => copycheck.checkBatch(arr);
  const T1 = '燕麦色毛衣太温柔了🌿';
  ok('①c ★ 相邻两条标题一字不差 → 只点后一条（前一条不点）',
    dup([{ title: T1 }, { title: T1 }])[0].length === 0 && dup([{ title: T1 }, { title: T1 }])[1].length === 1,
    JSON.stringify(dup([{ title: T1 }, { title: T1 }])));
  ok('①c ★ 只换 emoji（文字完全相同）→ 不算重复（用户明确允许）',
    dup([{ title: T1 }, { title: '燕麦色毛衣太温柔了🤍' }])[1].length === 0);
  ok('①c ★ 隔开几条再撞句 → 不算重复（只比相邻两条；旧口径会误报）',
    dup([{ title: T1 }, { title: '别的句子🌿' }, { title: T1 }])[2].length === 0);
  ok('①c ★ 正文一字不差也点出来；换 emoji 同样放过',
    dup([{ body: '甲，\n乙' }, { body: '甲，\n乙' }])[1].length === 1
    && dup([{ body: '甲，\n乙🌿' }, { body: '甲，\n乙🤍' }])[1].length === 0);
  ok('①c 空文案不算重复（没生成出来的行不该被连坐）', dup([{ title: '' }, { title: '' }])[1].length === 0);

  /* ---- ①d 额外话题的来源：品牌提示词里写的 #话题（2026-10-03 用户拍板） ----
     用户原话：「必带话题保留，额外话题我会在品牌提示词中写入，两者结合是否可行？」 */
  const BRANDP = '二、话题列表（必带 #Cabbeen卡宾 和#卡宾老钱风穿搭，其余3个根据正文挑选）：服装话题：#今日份穿搭 #我的穿搭不秋季新look #如果只能留一件 其他话题：#穿搭里的心动预告 种草测评方向：#穿小熊男装巧赴心动';
  const PT = copywriter.topicsFromPrompt(BRANDP);
  ok('①d ★ 能从品牌提示词里抽出 #话题（含「和#」紧贴、含中文长话题）',
    PT.indexOf('#Cabbeen卡宾') >= 0 && PT.indexOf('#卡宾老钱风穿搭') >= 0 && PT.indexOf('#我的穿搭不秋季新look') >= 0,
    PT.join(' '));
  ok('①d 提示词里没写 # 就抽不到（不会瞎编话题）',
    copywriter.topicsFromPrompt('没有任何话题的提示词').length === 0);
  const cfgB = { requiredTopic: store.get('copy.requiredTopic'), extraTopics: store.get('copy.extraTopics'), pool: store.get('copy.pool') };
  try {
    store.set({
      copy: {
        requiredTopic: '#Cabbeen卡宾, #卡宾老钱风穿搭', extraTopics: 3,
        pool: { 品类: ['#内置词A', '#内置词B', '#内置词C', '#内置词D', '#内置词E'] }
      }
    });
    const pd = copywriter.buildPlan(Array.from({ length: 8 }, (_, i) => ({ id: 'd' + i, color: '黑' })), { promptWrite: BRANDP });
    // ★ 这一条**只查顺序**（必带来自 copy.requiredTopic，跟池子来源无关）——
    //   上一版把它写成了「品牌提示词里的 #话题 真进了话题组合」，其实池子改坏它也照样绿
    //   （定点破坏 N6/N8 各只命中一半，才发现这一条查错了东西）。
    ok('①d 必带话题固定排在最前两位（只查顺序）',
      pd.rows.every(r => r.topics[0] === '#Cabbeen卡宾' && r.topics[1] === '#卡宾老钱风穿搭'),
      JSON.stringify(pd.rows[0].topics));
    // ★ 来源那件事单独查：**每一行的额外位**都必须是品牌提示词里抽出来的。
    ok('①d ★ 额外话题真的来自品牌提示词（每一行的额外位都在抽取结果里，不是内置通用词）',
      pd.rows.every(r => r.topics.slice(2).every(t => PT.indexOf(t) >= 0)),
      JSON.stringify(pd.rows.map(r => r.topics.slice(2))));
    ok('①d ★ 提示词里那两条必带不会重复占额外名额（5 个话题互不相同）',
      pd.rows.every(r => r.topics.length === 5 && new Set(r.topics).size === 5),
      JSON.stringify(pd.rows[0].topics));
    // ★★ 这一条是**真机跑出来才补上**的：第一版把「提示词抽出来的」和「设置页话题池」直接拼起来，
    //   真机 10 条里后 3 条滑进了设置页的 `#男生穿搭 #OOTD #秋冬新款`（用户根本没要）。
    //   行数必须**多过提示词能给的额外个数**（这里 8 行 > 7 个），滑动窗口才会绕回去暴露它。
    const SETPOOL = ['#内置词A', '#内置词B', '#内置词C', '#内置词D', '#内置词E'];
    ok('①d ★ 提示词写得够（≥ 需要的额外个数）时，设置页话题池里的词一个都不许混进来',
      pd.rows.every(r => r.topics.every(t => SETPOOL.indexOf(t) < 0)),
      JSON.stringify(pd.rows.map(r => r.topics.filter(t => SETPOOL.indexOf(t) >= 0))));
    const pd2 = copywriter.buildPlan([{ id: 'e', color: '黑' }], { promptWrite: '提示词里没写话题' });
    ok('①d 提示词里没写 #话题 → 退回设置页的话题池（不是空、也不是崩）',
      pd2.rows[0].topics.indexOf('#内置词A') >= 0, JSON.stringify(pd2.rows[0].topics));
  } finally {
    store.set({ copy: cfgB });
  }

  /* ---- ② 正文尾巴上模型自己加的 #话题要摘掉（话题另有 5 个独立格子） ---- */
  const st1 = copywriter.stripTrailingTopics('燕麦色毛衣上身干净舒服，配牛仔刚刚好。#品牌甲', ['#品牌甲']);
  ok('② 同一行尾巴上的 #话题 被摘掉（实测模型就是这么写的）', st1.body === '燕麦色毛衣上身干净舒服，配牛仔刚刚好。', JSON.stringify(st1.body));
  const st2 = copywriter.stripTrailingTopics('正文第一句。\n正文第二句。\n\n#品牌甲 #男生穿搭\n', ['#品牌甲']);
  ok('② 尾部整行是话题的也摘掉，正文其余行不许动',
    st2.body === '正文第一句。\n正文第二句。' && /正文第一句/.test(st2.body), JSON.stringify(st2.body));
  const st3 = copywriter.stripTrailingTopics('这件衣服背后有个 #小故事，讲给你听。', ['#品牌甲']);
  ok('② 正文中间的 # 不许误删（只认「结尾」）', st3.body === '这件衣服背后有个 #小故事，讲给你听。' && !st3.changed, JSON.stringify(st3.body));

  /* ---- ③ 看图写：真发图 ----
     这一条是整轮的核心 —— 断言「发给模型的请求里有没有图」，而不是「源码里有没有 image_url 这几个字」。 */
  const batchDir = makeBatch('十月第一批', 3);
  store.set({
    copy: {
      concurrency: 3,
      llm: { enabled: true, endpoint: ENDPOINT, apiKey: 'sk-test', model: 'deepseek v4.1 flash', vision: true, imageCount: 2, imageMaxSide: 320 }
    }
  });
  seen.length = 0;
  reply = {
    title: '燕麦色圆领毛衣小熊刺绣休闲风🧸',
    body: '燕麦色针织毛衣，圆领设计，\n胸前一枚黑色小熊刺绣，\n袖口和下摆是竖条罗纹收口，\n绒面看着挺软，搭牛仔裤很干净✨'
  };
  const run1 = await jobs.run('copy.generate', { sourceDir: batchDir, batchId: '十月第一批', label: '十月第一批' });
  ok('③ 批次跑通', run1.ok === true, run1.ok ? '' : run1.error);

  const gen = seen.filter(s => /chat\/completions/.test(s.url));
  ok('③ 每条素材都发了一次请求（3 条素材 → 3 次）', gen.length === 3, `收到 ${gen.length} 次`);
  ok('③ ★ 图真的发出去了：每个请求都带 image_url', gen.length > 0 && gen.every(s => s.hasImage),
    gen.map(s => s.images.length + '张').join(' / '));
  ok('③ ★ 发的是 imageCount 指定的张数（配置 2 张）', gen.every(s => s.images.length === 2),
    gen.map(s => s.images.length).join(' / '));
  const one = gen[0];
  const dataUrl = one.images[0].image_url.url;
  ok('③ 图以 data URL 内联（不是本地路径、不是外链）', /^data:image\/jpeg;base64,/.test(dataUrl), dataUrl.slice(0, 40) + '…');
  let decoded = null;
  try { decoded = jpeg.decode(Buffer.from(dataUrl.split(',')[1], 'base64')); } catch (e) { decoded = null; }
  ok('③ ★ 那段 base64 真能解出一张 JPEG（不是空串 / 不是占位）',
    !!decoded && decoded.width > 0 && decoded.height > 0, decoded ? `${decoded.width}×${decoded.height}` : '解不开');
  ok('③ 图缩到了 imageMaxSide 内（320px）', !!decoded && Math.max(decoded.width, decoded.height) <= 320,
    decoded ? `${decoded.width}×${decoded.height}` : '—');
  ok('③ system 里写着「看图写」的硬约束，并禁掉了货号与那批套话',
    /看图写/.test(one.messages[0].content) && /货号/.test(one.messages[0].content) && /细节，真的顶/.test(one.messages[0].content));
  ok('③ ★ 模型名被换成了接口清单里真认的 id（配置写的是显示名，实测会 400）',
    one.model === 'deepseek-flash', `发出去的 model = ${one.model}`);

  /* ---- ③b 标题 = 「产品词 + 热门词」的词包（2026-10-03 用户投诉后加）----
     用户原话：「你这个标题就是纯描述产品是什么，我要的是产品+热门词」，
     目标是「羽绒服+简约百搭 / 韩系氛围感 / 灰色慵懒风 / 美式学院风 / 蓝调穿搭+羽绒服 / 冬日神器+羽绒服」。
     这里钉三件事：① 公式与热词库真的进了 system；② 每行的「本行标题格式」真的进了 user；③ 整批格式轮换。 */
  const sys = one.messages[0].content;
  ok('③b system 里写着词包公式（产品词 + 热门词）',
    /产品词/.test(sys) && /热门词/.test(sys) && /词包/.test(sys));
  ok('③b system 里带着内置热词库（有具体词可挑，不是让模型自己编）',
    /标题热词库/.test(sys) && /简约百搭/.test(sys) && /冬日神器/.test(sys) && /韩系氛围感/.test(sys));
  ok('③b system 里列全了 10 种标题句式（T01~T10 一个不少）',
    hotwords.STYLES.every(st => sys.includes(st.code + ' ' + st.name) && sys.includes(st.sample)),
    hotwords.STYLES.map(st => st.code).join(','));
  ok('③b system 里明确禁止「写成商品描述」',
    /不许写成商品描述/.test(sys) && /款式特征/.test(sys));
  ok('③b 10 种格式的 code 唯一、正好 10 种',
    hotwords.STYLES.length === 10 && new Set(hotwords.STYLES.map(st => st.code)).size === 10);
  ok('③b 轮换函数走满 10 种再回头（第 11 条回到 T01）',
    hotwords.styleOf(0).code === 'T01' && hotwords.styleOf(9).code === 'T10' && hotwords.styleOf(10).code === 'T01',
    [hotwords.styleOf(0).code, hotwords.styleOf(9).code, hotwords.styleOf(10).code].join(' / '));
  ok('③b 热词库里的 {色} 模板写明「用本行给的颜色去套」，不是让模型编颜色',
    /\{色\}/.test(sys) && /本行给的颜色/.test(sys));
  // ★ 词库的边界：热词只许是「风格/氛围/场景/人群/季节/情绪」。
  //   材质与参数（鹅绒 / 充绒量 / 加厚 / 防风防水 / 羊毛含量…）**不许进词库** ——
  //   那些是这件衣服的客观事实，得图里看得见或货号有写；词库里给了就等于教模型造假。
  const SPEC_RE = /鹅绒|鸭绒|充绒|含绒量|克重|加厚|防风|防水|羊毛|羊绒|德绒|石墨烯|摇粒绒|白鸭绒|质检|含量|参数/;
  ok('③b ★ 热词库不含「材质 / 参数」类词（图里看不出来，写出来就是造假）',
    hotwords.allWords().every(w => !SPEC_RE.test(w)),
    hotwords.allWords().filter(w => SPEC_RE.test(w)).join('、') || '无');
  ok('③b 热词库按角色分组，每个角色都有词',
    hotwords.GROUPS.every(g => Array.isArray(g.words) && g.words.length > 0 && !!g.key),
    hotwords.GROUPS.map(g => `${g.key}:${g.words.length}`).join(' '));
  // ★★ 2026-10-03（第八次）三条硬约束（上一版就是栽在这三条上被打回的）：
  //   ① `+` 只是「哪类词跟哪类词合并」的示意 —— 示例里不许带，system 里要明说标题里也不许出现；
  //   ② 示例里不许写死颜色（实测踩过：示例写「灰」，跑一条酒红的货，模型输出「羽绒服+灰调高级感」）；
  //   ③ 每条句式骨架都要自带连接字或收尾 —— 这是**结构上**防「少年感灰针织毛衣」那类病句。
  ok('③b ★ system 里写明「标题里一个字都不许出现 + 号」',
    /一个字都不许出现「\+」/.test(sys));
  ok('③b ★ 10 条句式示例里没有一个带「+」（示例带 + 模型就会照抄进标题）',
    hotwords.STYLES.every(st => st.sample.indexOf('+') < 0),
    hotwords.STYLES.filter(st => st.sample.indexOf('+') >= 0).map(st => st.code).join(',') || '无');
  const HARD_COLOR = /灰|蓝|黑|白|红|绿|黄|驼|燕麦|卡其|藏青|棕|粉|紫/;
  ok('③b ★ 句式示例一律不写死颜色，颜色位用 {色} 占位（写死了模型会照抄）',
    hotwords.STYLES.every(st => !HARD_COLOR.test(st.sample)),
    hotwords.STYLES.filter(st => HARD_COLOR.test(st.sample)).map(st => st.code).join(',') || '无');
  ok('③b ★ 每条句式骨架都自带连接字或收尾（结构上不会再产出「热词+单品」的标签串）',
    hotwords.STYLES.every(st => /[的才是穿配带入在和与很超太真能要有会让给把自也都可好，, ]/.test(st.sample)),
    hotwords.STYLES.filter(st => !/[的才是穿配带入在和与很超太真能要有会让给把自也都可好，, ]/.test(st.sample)).map(st => st.code).join(',') || '无');
  // ★ 上面那条是「源码里有这几个字」—— 真正的证明是**行为级**的：
  //   把 `{色}` 代入真颜色，跑一遍标签串判据，10 条示例一条都不许被判成标签串。
  //   （否则「有连接字」可能只是凑巧写在了无关位置。）
  const SAMPLE_FILLED = hotwords.STYLES.map(st => ({
    code: st.code,
    text: st.sample.replace(/\{色\}/g, '灰').replace(/\{色\}/g, '灰')
  }));
  ok('③b ★ 行为级：10 条句式示例代入真颜色后，没有一条会被判成「标签串/病句」',
    SAMPLE_FILLED.every(x => copycheck.looksLikeWordPaste(x.text) === false),
    SAMPLE_FILLED.filter(x => copycheck.looksLikeWordPaste(x.text)).map(x => x.code + ':' + x.text).join(' | ') || '无');
  ok('③b 新加了「收尾」词组（用户要的「太帅了」这类就在里面）',
    hotwords.GROUPS.some(g => g.key === '收尾' && g.words.indexOf('太帅了') >= 0),
    hotwords.GROUPS.map(g => g.key).join('/'));
  ok('③b 示例里的 {色} 模板写明「用本行给的颜色去套」',
    /\{色\}/.test(sys) && /本行给的颜色/.test(sys));
  ok('③b system 里写明「示例里的颜色也要换成本行的颜色」',
    /颜色也要换成本行的颜色/.test(sys));
  ok('③b ★ system 里给出「病句反例 vs 正例」，让模型知道为什么不能直贴',
    /少年感灰针织毛衣太帅了/.test(sys) && /松弛感拉满/.test(sys) && /念得通/.test(sys));

  const userText = se => {
    const c = se.messages[1] && se.messages[1].content;
    if (Array.isArray(c)) { const t = c.find(p => p && p.type === 'text'); return t ? t.text : ''; }
    return String(c == null ? '' : c);
  };
  const asks = gen.map(userText);
  // ★ 必须**锚在 JSON 的键上**取：直接写 /T\d\d/ 会误匹配货号里的 `26FWT75`（实测第一条就中招），
  //   那样「3 条格式各不相同」会因为匹配到货号而看起来也成立 —— 典型的断言查错了东西。
  const styleOfAsk = a => {
    const m = a.match(/"本行标题格式":"(T\d\d)[^"]*"/);
    return m ? m[1] : '';
  };
  const codes = asks.map(styleOfAsk);
  ok('③b ★ 每行的「本行标题格式」真的发进 user 了（3 条素材 → 3 条都带）',
    asks.length === 3 && asks.every(a => /"本行标题格式":"T\d\d/.test(a)) && codes.every(Boolean),
    codes.join(' / '));
  ok('③b ★ 整批格式是轮换的（3 条用了 3 种不同格式，不是同一个形状）',
    codes.every(Boolean) && new Set(codes).size === codes.length, codes.join(' / '));
  ok('③b ★ 每行的 user 里也带上了「不许出现 + 号」（只写在 system 里模型会漏）',
    asks.length === 3 && asks.every(a => /不许出现 \+ 号/.test(a)),
    asks.filter(a => !/不许出现 \+ 号/.test(a)).length + ' 条漏了');

  /* ---- ③c 正文格式 + 重复口径 + 「颜色用本行的」也真的进了提示词（2026-10-03 第九次） ---- */
  ok('③c ★ system 里写明正文要写成 4~5 行、每行一句短句、行与行之间真的换行',
    /4~5 行/.test(sys) && /一行一句短句/.test(sys) && /真的换行/.test(sys));
  ok('③c ★ system 里写明「相邻两条别写得一模一样」（换一个 emoji 就算不同）',
    /相邻两条别写得一模一样/.test(sys) && /只换一个 emoji/.test(sys));
  ok('③c ★ system 里写明正文结尾不带 #话题（话题走发布单的独立格子）',
    /正文结尾不要带任何 #话题/.test(sys) && /话题1~5/.test(sys));
  ok('③c ★ 每行 user 的形状示例写明「颜色用本行的、别照抄示例」（示例写死颜色模型会照抄）',
    asks.length === 3 && asks.every(a => /别照抄里面的单品与颜色/.test(a)),
    asks.filter(a => !/别照抄里面的单品与颜色/.test(a)).length + ' 条漏了');
  // ★ 上一版这条写的是 `asks.every(a => !/整批别用同一个形状/.test(a))` —— 但它**永远为真**：
  //   那句是 `plan.titleStyle ? A : B` 的 **B 分支**，而 buildPlan 每一行都会给出格式 ⇒ B 永远走不到
  //   （定点破坏 N12 把 B 改回旧口径，它照样绿）。⇒ 改成**源码级**，并如实标明强度：
  //   这条只能证明「源码里那句兜底文案改过了」，不能证明「运行时走得到」。
  const cwSrc = fs.readFileSync(path.join(base, 'src/main', 'services', 'copywriter.js'), 'utf8');
  ok('③c 源码级：没指定格式时的兜底文案也不再要求「整批别用同一个形状」（运行时几乎走不到这条分支）',
    /只要相邻两条不写成一模一样就行/.test(cwSrc) && !/整批别用同一个形状/.test(cwSrc));

  /* ---- ④ 报告落在素材文件夹、带时间戳、能被反向导入 ---- */
  const rep1 = run1.result.reportFile;
  ok('④ 报告落在**素材文件夹**里（不是输出目录）',
    !!rep1 && fs.existsSync(rep1) && path.resolve(path.dirname(rep1)) === path.resolve(batchDir),
    rep1 ? wp.toDisplay(path.dirname(rep1)) : '(没有报告)');
  ok('④ 文件名 = 品牌_AI内容报告_<时间戳>.xlsx（时间戳到秒）',
    /_AI内容报告_\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.xlsx$/.test(path.basename(rep1 || '')), path.basename(rep1 || ''));
  ok('④ 报告自检通过（写完自己用下游读取器读了一遍）', run1.result.reportVerify && run1.result.reportVerify.ok === true,
    JSON.stringify(run1.result.reportVerify));

  const back = await report.readReport(rep1);
  ok('④ ★ 这份报告能被自己的「AI 内容报告」导入器读回（列名与上游那份对齐）',
    back.rows.length === 3 && back.sheetName === 'AI 内容报告', `${back.rows.length} 行 · ${back.sheetName}`);
  ok('④ 读回来的货号/颜色/标题逐行对得上',
    back.rows.length === 3
    && new Set(back.rows.map(r => r.goods[0].sku)).size === 3
    && (back.rows.find(r => r.goods[0].sku === '26FW-YB160') || {}).goods
    && back.rows.find(r => r.goods[0].sku === '26FW-YB160').goods[0].color === '冠军白'
    && back.rows.find(r => r.goods[0].sku === '26FWT75').goods[0].color === '蓝调蓝'
    && back.rows.find(r => r.goods[0].sku === '26FW-CB122').goods[0].color === '燕麦色'
    && back.rows.every(r => r.title && r.body),
    back.rows.map(r => `${r.goods[0].sku}/${r.goods[0].color}/${r.title.slice(0, 6)}`).join(' | '));
  ok('④ 素材路径写的是叶子目录绝对路径（反向导入靠它一条条对回去）',
    back.rows.every(r => path.isAbsolute(r.dir) && fs.existsSync(r.dir)), back.rows.map(r => path.basename(r.dir)).join(' | '));

  // 直接读 sheet 看附加列（readReport 不认这几列，所以单独读）
  const ExcelJS = require(path.join(base, 'node_modules', 'exceljs'));
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(wp.toLong(rep1));
  const ws = wb.getWorksheet('AI 内容报告');
  const heads = (ws.getRow(1).values || []).slice(1).map(String);
  ok('④ 前 8 列与上游报告逐字一致（列名错一个字就会「表头缺列」）',
    aireport.BASE_COLUMNS.every((h, i) => heads[i] === h), heads.slice(0, 8).join(' | '));
  ok('④ 好物1~9 货号/颜色 共 18 列都在', Array.from({ length: 9 }).every((_, i) => heads.includes(`好物${i + 1}_货号`) && heads.includes(`好物${i + 1}_颜色`)));
  const col = name => heads.indexOf(name) + 1;
  const cells = r => (ws.getRow(r).values || []).slice(1).map(v => (v == null ? '' : String(v)));
  ok('④ 「生成来源」逐行写明是 AI 看图（这条能看出到底走没走模型）',
    [2, 3, 4].every(r => /AI 看图/.test(cells(r)[col('生成来源') - 1])), cells(2)[col('生成来源') - 1]);
  ok('④ 「期待发布时间 / 实际执行时间 / 执行结果」留空（等发布来回写 B/C 列）',
    [2, 3, 4].every(r => !cells(r)[0] && !cells(r)[1] && !cells(r)[2]));
  ok('④ 「内容类型」逐行写出来（图文/视频）', /图文/.test(cells(2)[col('内容类型') - 1]), cells(2)[col('内容类型') - 1]);
  ok('④ 有「图片主色」列（从实拍图实取，用来反查颜色填得对不对）',
    heads.includes('图片主色') && !!cells(2)[col('图片主色') - 1], cells(2)[col('图片主色') - 1]);
  ok('④ 还有一张「列说明」表（不叫「报告」，不会干扰反向导入）',
    !!wb.getWorksheet('列说明') && wb.worksheets.length === 2, wb.worksheets.map(w => w.name).join(' | '));

  /* ---- ⑤ 报告里的「文案核对」真抓得住问题（不是只会写「一致」） ---- */
  seen.length = 0;
  reply = { title: '26FW-YB160 冠军白卫衣的细节，真的顶✅', body: BODY4 };
  const run2 = await jobs.run('copy.generate', { sourceDir: batchDir, batchId: '十月第二批', label: '十月第二批' });
  ok('⑤ 第二次批次跑通', run2.ok === true, run2.ok ? '' : run2.error);
  ok('⑤ 有问题的行会被统计出来（不再全部报「一致」）', run2.result.reportFlagged === 3, `flagged=${run2.result.reportFlagged}`);
  const wb2 = new ExcelJS.Workbook();
  await wb2.xlsx.readFile(wp.toLong(run2.result.reportFile));
  const ws2 = wb2.getWorksheet('AI 内容报告');
  const h2 = (ws2.getRow(1).values || []).slice(1).map(String);
  const c2 = r => (ws2.getRow(r).values || []).slice(1).map(v => (v == null ? '' : String(v)));
  const checkCol = h2.indexOf('文案核对') + 1;
  // 行序按目录枚举，不假设顺序：扫所有数据行找出「标题里那个货号」那一行
  const allCheck = [2, 3, 4].map(r => c2(r)[checkCol - 1]);
  ok('⑤ 报告里写清了「混进货号」与「用了套话」',
    allCheck.some(t => /26FW-YB160/.test(t) && /套话/.test(t)),
    allCheck.find(t => /26FW-YB160/.test(t)) || allCheck.join(' || '));
  ok('⑤ 报告文件名与上一批不同（带时间戳，两批不会互相覆盖）',
    path.basename(run1.result.reportFile) !== path.basename(run2.result.reportFile),
    path.basename(run1.result.reportFile) + ' vs ' + path.basename(run2.result.reportFile));

  /* ---- ⑤b ★ 批级重复**真进报告**（只测 checkBatch 这个工具函数 = 假通过） ----
     目的：证明 `aireport.write()` 真的把批级判据并进了「文案核对」列。
     做法：让假模型对 3 条素材回**一模一样**的标题与正文 —— 相邻两条必须被点名，第一条不许被点名。 */
  store.set({ copy: { concurrency: 1, llm: { enabled: true, endpoint: ENDPOINT, apiKey: 'sk-test', model: 'deepseek-flash', vision: false } } });
  seen.length = 0;
  reply = { title: '燕麦色毛衣太温柔了🌿', body: BODY4 };
  const dupRun = await jobs.run('copy.generate', { sourceDir: batchDir, batchId: '重复批', label: '重复批' });
  ok('⑤b 重复批跑通', dupRun.ok === true, dupRun.ok ? '' : dupRun.error);
  const wbD = new ExcelJS.Workbook();
  await wbD.xlsx.readFile(wp.toLong(dupRun.result.reportFile));
  const wsD = wbD.getWorksheet('AI 内容报告');
  const hD = (wsD.getRow(1).values || []).slice(1).map(String);
  const cD = r => (wsD.getRow(r).values || []).slice(1).map(v => (v == null ? '' : String(v)));
  const colD = hD.indexOf('文案核对') + 1;
  const dCells = [2, 3, 4].map(r => cD(r)[colD - 1]);
  ok('⑤b ★ 相邻两条完全一样 → 报告的「文案核对」列真的写出来了（标题 + 正文各一条）',
    !/与上一条一字不差/.test(dCells[0])
    && /标题与上一条一字不差/.test(dCells[1]) && /正文与上一条一字不差/.test(dCells[1])
    && /标题与上一条一字不差/.test(dCells[2]),
    dCells.map((t, i) => (i + 2) + ':' + t.slice(0, 30)).join(' || '));
  ok('⑤b ★ 重复只算「相邻」，第三条与第一条同句不算（旧口径会多报）',
    !/第 1 条|与第 1 条/.test(dCells[2]));

  /* ---- ⑥ 模型连不上 ⇒ 停下来报错，**不许**拿本地模板冒充 ---- */
  store.set({ copy: { llm: { enabled: true, endpoint: ENDPOINT, apiKey: '', model: 'deepseek-flash' } } });
  seen.length = 0;
  const bad = await jobs.run('copy.generate', { sourceDir: batchDir, batchId: '没key批', label: '没key批' });
  ok('⑥ 开了模型但没配 key ⇒ 任务失败（不是悄悄出一堆模板文案）',
    bad.ok === false && /模型没连上/.test(bad.error || ''), bad.error);
  ok('⑥ 失败时一次模型请求都没发（不存在「试一下再说」）', seen.filter(s => /chat/.test(s.url)).length === 0,
    `发了 ${seen.filter(s => /chat/.test(s.url)).length} 次`);
  const noCopy = path.join(TMP, '输出', 'batches', '没key批', 'copy.json');
  ok('⑥ 失败时连 copy.json 都不落（不留下半批假产物）', !fs.existsSync(noCopy), wp.toDisplay(noCopy));

  // 前端也开着的地址打不通 → 同样要停下来
  store.set({ copy: { llm: { enabled: true, endpoint: 'http://127.0.0.1:1/v1', apiKey: 'sk-x', model: 'deepseek-flash' } } });
  const dead = await jobs.run('copy.generate', { sourceDir: batchDir, batchId: '打不通批', label: '打不通批' });
  ok('⑥ 地址打不通 ⇒ 说清「模型没连上 / 连不上接口」，而不是「未知错误」',
    dead.ok === false && /模型没连上/.test(dead.error || '') && /连不上接口/.test(dead.error || '')
    && /打不通|fetch|ECONN|connect/i.test(dead.error || ''),
    (dead.error || '').slice(0, 140));
  ok('⑥ 地址打不通时**一条都没发出去就停了**（不是每条素材各撞一次墙）',
    !fs.existsSync(path.join(TMP, '输出', 'batches', '打不通批', 'copy.json')));

  /* ---- ⑦ 关掉模型 = 用户主动选本地模板 ⇒ 可以出，但报告里必须**逐行标明「本地模板」** ---- */
  store.set({ copy: { llm: { enabled: false } } });
  seen.length = 0;
  const tpl = await jobs.run('copy.generate', { sourceDir: batchDir, batchId: '模板批', label: '模板批' });
  ok('⑦ 关掉模型时不联网（一次请求都不发）', seen.length === 0, `发了 ${seen.length} 次`);
  ok('⑦ 本地模板照样出文案（离线可用）', tpl.ok === true && tpl.result.count === 3, JSON.stringify(tpl.result && tpl.result.count));
  const wb3 = new ExcelJS.Workbook();
  await wb3.xlsx.readFile(wp.toLong(tpl.result.reportFile));
  const ws3 = wb3.getWorksheet('AI 内容报告');
  const h3 = (ws3.getRow(1).values || []).slice(1).map(String);
  const c3 = r => (ws3.getRow(r).values || []).slice(1).map(v => (v == null ? '' : String(v)));
  const gc = h3.indexOf('生成来源') + 1;
  ok('⑦ ★ 报告里逐行如实写着「本地模板」—— 界面上再也不会把模板货说成 AI 文案',
    [2, 3, 4].every(r => c3(r)[gc - 1] === '本地模板'), c3(2)[gc - 1]);
  // ★ 同一条正文格式规则**不能对模板放松**：模型侧要 4~5 行，本地模板也必须 4~5 行，
  //   否则「关掉模型」的产物会被自己的核对判成「没分行」，用户看到一整列黄。
  let tplBody = '';
  try {
    const cj = JSON.parse(fs.readFileSync(path.join(TMP, '输出', 'batches', '模板批', 'copy.json'), 'utf8'));
    tplBody = String(cj.rows[0].body || '');
  } catch (e) { /* 读不到就看下面那条断言红 */ }
  const tplLines = tplBody.split(/\r?\n/).map(x => x.trim()).filter(Boolean).length;
  const tplChk = copycheck.check({ title: '燕麦色通勤穿搭✨', body: tplBody }, { goods: [{ sku: 'S30', color: '燕麦色' }] });
  ok('⑦ ★ 本地模板的正文也是 4~5 行（同一套格式，不对模板放松）',
    tplLines >= copycheck.BODY_LINES_MIN && tplLines <= copycheck.BODY_LINES_MAX,
    tplLines + ' 行 · ' + JSON.stringify(tplBody.slice(0, 40)));
  ok('⑦ ★ 本地模板的正文自己过一遍核对，不许被判「行数不对 / 没 emoji」',
    !/正文只写了/.test(tplChk.text) && !/正文没有 emoji/.test(tplChk.text), tplChk.text);

  /* ---- ⑧ 网关不收图 ⇒ 自动退回纯文字，并且**如实改口**（不再说自己在看图） ---- */
  // 并发固定 1 路：这条测的是「第一条撞墙 → 之后都不带图」，多路并发时几条请求会同时飞出去、
  // 结果不确定（不是被测逻辑有问题，是测试环境不像真机那样串行），所以这里把变量收掉。
  store.set({ copy: { concurrency: 1, llm: { enabled: true, endpoint: ENDPOINT, apiKey: 'sk-test', model: 'deepseek-flash', vision: true, imageCount: 1, imageMaxSide: 320 } } });
  seen.length = 0;
  mode = 'rejectImageOnce';
  const deg = await jobs.run('copy.generate', { sourceDir: batchDir, batchId: '不收图批', label: '不收图批' });
  mode = 'ok';
  const degReq = seen.filter(s => /chat/.test(s.url));
  ok('⑧ 网关拒图后整批退回纯文字（第一发带图、之后就都不带了）',
    degReq.length >= 2 && degReq[0].hasImage === true && degReq.slice(1).every(s => s.hasImage === false),
    degReq.map(s => (s.hasImage ? '带图' : '纯文字')).join(' → '));
  ok('⑧ 退回纯文字后整批仍然跑通', deg.ok === true, deg.ok ? '' : deg.error);
  const wb4 = new ExcelJS.Workbook();
  await wb4.xlsx.readFile(wp.toLong(deg.result.reportFile));
  const ws4 = wb4.getWorksheet('AI 内容报告');
  const h4 = (ws4.getRow(1).values || []).slice(1).map(String);
  const c4 = r => (ws4.getRow(r).values || []).slice(1).map(v => (v == null ? '' : String(v)));
  const srcAll = [2, 3, 4].map(r => c4(r)[h4.indexOf('生成来源')]);
  ok('⑧ ★ 报告如实改口成「没看图」（不许还写「AI 看图」）',
    srcAll.every(x => /AI 文字/.test(x) && /没看图|这条没图/.test(x) && !/AI\s*看图（/.test(x)), srcAll.join(' | '));

  /* ---- ⑪ 中文标点不许被解析器改掉（这会直接毁掉文案观感） ---- */
  const pj = copywriter.extractJson('{"title":"燕麦色毛衣的细节，真的顶","body":"圆领设计：胸前一枚刺绣。他说“好看”。"}');
  ok('⑪ ★ 合法 JSON 原样解析：正文里的全角标点一个都不许被换掉',
    pj.title === '燕麦色毛衣的细节，真的顶' && pj.body === '圆领设计：胸前一枚刺绣。他说“好看”。',
    JSON.stringify(pj));
  ok('⑪ 真解析不了时仍然兜得住（多余逗号 / 代码块包裹 / 全角引号当分隔符）',
    copywriter.extractJson('```json\n{"title":"t","body":"b",}\n```').title === 't'
    && copywriter.extractJson('前言{"title":"t2","body":"b"}后记').title === 't2',
    JSON.stringify(copywriter.extractJson('```json\n{"title":"t","body":"b",}\n```')));

  /* ---- ⑫ 模型把换行写成**字面的** \n 时要还原 ----
     真机实测（2026-10-03，3 条真素材）：同一批里就有 1 条正文带着字面 `\n`，另外两条是真换行。
     这种串发到得物会原样显示成死文本，用户只会觉得「文案坏了」。 */
  const showNl = s => String(s).replace(/\n/g, '<真换行>').replace(/\\n/g, '<字面\\n>');
  ok('⑫ 字面 \\n 还原成真换行',
    copywriter.unescapeNewlines('第一句。\\n第二句。') === '第一句。\n第二句。',
    showNl(copywriter.unescapeNewlines('第一句。\\n第二句。')));
  ok('⑫ 字面的 \\r\\n 与 \\r 一并还原成真换行',
    copywriter.unescapeNewlines('甲\\r\\n乙\\r丙') === '甲\n乙\n丙',
    showNl(copywriter.unescapeNewlines('甲\\r\\n乙\\r丙')));
  ok('⑫ 已经是真换行的不许再动（也不能多长出一个换行）',
    copywriter.unescapeNewlines('甲\n乙') === '甲\n乙'
    && copywriter.unescapeNewlines('甲\r\n乙') === '甲\n乙',
    showNl(copywriter.unescapeNewlines('甲\r\n乙')));
  ok('⑫ 全角标点 / emoji 一个都不许动',
    copywriter.unescapeNewlines('圆领设计：胸前一枚刺绣。他说“好看”🐻') === '圆领设计：胸前一枚刺绣。他说“好看”🐻',
    showNl(copywriter.unescapeNewlines('圆领设计：胸前一枚刺绣。他说“好看”🐻')));

  // 行为级：让假模型真回一段带字面 \n 的正文，看**落盘**的 copy.json 里到底是什么
  store.set({ copy: { llm: { enabled: true, endpoint: ENDPOINT, apiKey: 'sk-test', model: 'deepseek-flash', vision: true, imageCount: 2, imageMaxSide: 320 } } });
  reply = {
    title: '卡其立领夹克斜拉链口袋🧥',
    body: '面料带点哑光的棉感，不是滑溜溜的化纤。\\n胸前一处小小的刺绣标，低调不抢戏。\\n面料摸上去挺括不软塌，\\n通勤穿它最省心🧥'
  };
  const nlRun = await jobs.run('copy.generate', { sourceDir: batchDir, batchId: '换行批', label: '换行批' });
  ok('⑫ 批次跑通', nlRun.ok === true, nlRun.ok ? '' : nlRun.error);
  let nlBody = '(读不到)';
  try {
    const nlCopy = JSON.parse(fs.readFileSync(path.join(TMP, '输出', 'batches', '换行批', 'copy.json'), 'utf8'));
    nlBody = String(nlCopy.rows[0].body || '');
  } catch (e) { /* 保持 (读不到) */ }
  ok('⑫ ★ 落盘的正文里是真换行，不是字面 \\n',
    nlBody.includes('\n') && !nlBody.includes('\\n'), showNl(nlBody));

  /* ---- ⑨ 接口自检按钮：一次往返把「认不认这个模型 / 收不收图」说清楚 ---- */
  store.set({ copy: { llm: { enabled: true, endpoint: ENDPOINT, apiKey: 'sk-test', model: 'deepseek v4.1 flash' } } });
  const t1 = await jobs.run('copy.llmtest', {});
  ok('⑨ 自检：显示名被解析成真 id，并报出「支持看图」',
    t1.ok && t1.result.modelId === 'deepseek-flash' && t1.result.image === true, JSON.stringify(t1.result && { m: t1.result.modelId, i: t1.result.image }));
  store.set({ copy: { llm: { enabled: true, endpoint: ENDPOINT, apiKey: 'sk-test', model: 'deepseek-v4-pro' } } });
  const t2 = await jobs.run('copy.llmtest', {});
  ok('⑨ 自检：这个模型清单里没有 image ⇒ 如实说「不会看图」（但不拦着不让用）',
    t2.ok && t2.result.image === false && /不会看图/.test(t2.result.note), t2.result && t2.result.note);
  store.set({ copy: { llm: { enabled: false } } });
  const t3 = await jobs.run('copy.llmtest', {});
  ok('⑨ 自检：开关关着时直接说清「现在用的是本地模板，不是 AI 文案」',
    t3.ok && t3.result.enabled === false && /本地模板/.test(t3.result.note), t3.result && t3.result.note);

  /* ---- ⑩ 「留空 = 跟随内置」：不许把内置值写回 config.json ---- */
  const { defaults } = store;
  const d = defaults();
  ok('⑩ 出厂 llm.endpoint / model 都留空（留空 = 跟随内置，不是写死一个厂商）',
    d.copy.llm.endpoint === '' && d.copy.llm.model === '', JSON.stringify({ e: d.copy.llm.endpoint, m: d.copy.llm.model }));
  ok('⑩ 出厂就看图（vision 默认 true），并有张数 / 尺寸 / 超时三个旋钮',
    d.copy.llm.vision === true && d.copy.llm.imageCount >= 1 && d.copy.llm.imageMaxSide >= 320 && d.copy.llm.timeoutSec >= 10,
    JSON.stringify({ v: d.copy.llm.vision, n: d.copy.llm.imageCount, s: d.copy.llm.imageMaxSide, t: d.copy.llm.timeoutSec }));
  const cfgFile = path.join(TMP, 'config.json');
  store.set({ copy: { llm: { endpoint: '', model: '' } } });
  await new Promise(r => setTimeout(r, 400));      // scheduleSave 是 250ms 防抖
  const savedRaw = fs.existsSync(cfgFile) ? fs.readFileSync(cfgFile, 'utf8') : '{}';
  let savedEndpoint = '(读不到)';
  try { savedEndpoint = ((JSON.parse(savedRaw).copy || {}).llm || {}).endpoint; } catch (e) { /* 忽略 */ }
  ok('⑩ ★ 内置地址**没有**被写进 config.json（写回就是固化，以后换服务商顶不动）',
    !/api\.deepseek\.com/.test(savedRaw), `config.json 里的 endpoint = ${JSON.stringify(savedEndpoint)}`);
  const cfgNo = copywriter.cfgOf();
  ok('⑩ 但读的时候要兜底成内置值，并说清来源是「跟随内置」',
    /^https:\/\//.test(cfgNo.endpoint) && cfgNo.endpointSource === '跟随内置' && !!cfgNo.model, cfgNo.endpoint + ' · ' + cfgNo.endpointSource);
  store.set({ copy: { llm: { endpoint: 'https://my.gateway/v1', model: 'my-model' } } });
  const cfgOwn = copywriter.cfgOf();
  ok('⑩ 本机填了就以填的为准（来源写成「本机配置」）',
    cfgOwn.endpoint === 'https://my.gateway/v1' && cfgOwn.model === 'my-model' && cfgOwn.endpointSource === '本机配置');
  ok('⑩ 「不送图」写的是字符串 "false" 也认（界面上存下来就是字符串）',
    copywriter.cfgOf().vision === true
    && (store.set({ copy: { llm: { vision: 'false' } } }), copywriter.cfgOf().vision === false));

  /* ---- ⑬ 可编辑词库：改了到底吃不吃得到（2026-10-03 新增功能）----
     ★ 这组断言的核心**不是**「源码里有 currentGroups 这行字」，而是**行为**：
       把词写进配置 ⇒ 模型看到的那段提示词里真出现它；★ 且**事后判据**也同步（最容易漏的一处）；
       「恢复内置」⇒ 真的回到基线。反向验证时逐条拆，见 REFERENCE §AA4。 */
  const NEWW = '测试词ZZZ';
  const baseWordCount = hotwords.allWords().length;
  ok('⑬ 出厂基线 8 组 / 64 词（含锁定的收尾组）',
    baseWordCount === 64 && hotwords.currentGroups().length === 8, baseWordCount + ' 词');
  ok('⑬ ★ 出厂基线不许踩自己的红线（红线改宽、基线加词，这一条都会红 —— 实测踩过「入冬第一件」被 /第一/ 拦下）',
    hotwords.baselineViolations().length === 0, JSON.stringify(hotwords.baselineViolations()));
  ok('⑬ 出厂 copy.hotwords 是 null（不预置业务数据；「留空 = 用内置基线」）',
    store.defaults().copy.hotwords === null);
  ok('⑬ 没改过时 isCustom()=false，全库不含测试词',
    hotwords.isCustom() === false && hotwords.allWords().indexOf(NEWW) < 0);
  ok('⑬ 收尾组在库里、标了 locked（照样参与生成，只是不给编辑）', (() => {
    const g = hotwords.currentGroups().find(x => x.key === '收尾');
    return !!g && g.locked === true && g.words.length === 12;
  })(), JSON.stringify((hotwords.currentGroups().find(x => x.key === '收尾') || {}).words || []).slice(0, 40));
  ok('⑬ 可编辑组正好 7 组，且不含收尾',
    hotwords.EDITABLE_GROUPS.length === 7 && hotwords.EDITABLE_GROUPS.indexOf('收尾') < 0,
    hotwords.EDITABLE_GROUPS.join('/'));
  ok('⑬ T01~T10 骨架一个不少、都是有 code 的对象（骨架不许被做成可编辑）',
    hotwords.STYLES.length === 10 && hotwords.STYLES.every(s => !!s.code && !!s.sample));
  ok('⑬ 出厂基线里没有材质 / 参数词（与 ③b 同一口径，这里再钉一次）',
    hotwords.allWords().every(w => !SPEC_RE.test(w)),
    hotwords.allWords().filter(w => SPEC_RE.test(w)).join('、') || '无');

  const curLib = hotwords.currentGroups().map(g => ({ key: g.key, words: g.words.slice() }));
  curLib.find(g => g.key === '风格').words.push(NEWW);
  const lexDry = hotwords.sanitizeLibrary(curLib);
  ok('⑬ 合法新词通过红线校验', lexDry.rejected.length === 0, JSON.stringify(lexDry.rejected));
  hotwords.saveLibrary(curLib);
  ok('⑬ ★ 保存后 isCustom()=true、全库 65 词',
    hotwords.isCustom() === true && hotwords.allWords().length === baseWordCount + 1,
    hotwords.allWords().length + ' 词');
  ok('⑬ ★★ 提示词（模型实际看到的那一段）里真出现了新词 —— 不是「源码里写了这行字」',
    hotwords.promptBlock().indexOf(NEWW) >= 0);
  ok('⑬ ★★ 事后判据同步：copycheck.prefixWords() 里真出现了新词（这处最容易漏改）',
    copycheck.prefixWords().indexOf(NEWW) >= 0, copycheck.prefixWords().length + ' 个前缀热词');
  ok('⑬ ★★ 行为级：拿「新词开头 + 单品结尾」的标题喂判据，必须被判成标签串',
    copycheck.looksLikeWordPaste(NEWW + '羽绒服') === true);
  ok('⑬ 正向对照：正常成句的标题不被误判', copycheck.looksLikeWordPaste('羽绒服才是过冬的答案') === false);

  const lexRej = hotwords.sanitizeLibrary([{ key: '风格', words: ['简约百搭', '鹅绒', '顶级', '淘宝'] }]);
  ok('⑬ 红线：材质 / 极限 / 别的平台名一律被拒，合法词保留',
    lexRej.rejected.length === 3 && lexRej.groups.find(g => g.key === '风格').words.join() === '简约百搭',
    JSON.stringify(lexRej.rejected.map(x => x.word)));
  ok('⑬ ★ 缺失的组＝沿用基线（渲染层少传一个组，不许把那组词悄悄清掉）',
    hotwords.sanitizeLibrary([{ key: '风格', words: ['简约百搭'] }]).groups.find(g => g.key === '氛围').words.length === 8);
  ok('⑬ ★ 收尾组与 T01~T10 骨架**不落盘**（保存下来的东西里连「收尾」都不该出现）',
    JSON.stringify(store.get('copy.hotwords')).indexOf('收尾') < 0);
  ok('⑬ {色} 占位被删光时给出告警（那时颜色就不会跟着本行颜色走了）',
    hotwords.sanitizeLibrary([{ key: '色感', words: ['高级感'] }]).warnings.some(s => s.indexOf('{色}') >= 0));

  /* ---- ⑭ 本地模板那条路**本来就不读词库** ----
     ★ 不钉住的话，将来会有人把「关掉模型后标题没变」报成「词库没生效」的 bug。
       这里趁着词库还带着测试词，跑一条**关模型**的批次，标题里必须**不含**它。 */
  store.set({ copy: { llm: { enabled: false } } });
  const lxLocal = await jobs.run('copy.generate', { sourceDir: batchDir, batchId: '词库本地批', label: '词库本地批' });
  let lxLocalTitles = [];
  try {
    const lc = JSON.parse(fs.readFileSync(path.join(TMP, '输出', 'batches', '词库本地批', 'copy.json'), 'utf8'));
    lxLocalTitles = (lc.rows || []).map(r => String(r.title || ''));
  } catch (e) { /* 读不到就空数组 ⇒ 下面会红 */ }
  ok('⑭ ★ 关掉模型走本地模板时，标题里不含词库新词（＝这条路不读词库，不是「没生效」）',
    lxLocalTitles.length > 0 && lxLocalTitles.every(t => t.indexOf(NEWW) < 0),
    lxLocalTitles.length + ' 条：' + lxLocalTitles.slice(0, 2).join(' | '));

  /* ---- ⑮ 恢复内置 ---- */
  hotwords.resetLibrary();
  ok('⑮ 恢复内置后 isCustom()=false、全库回到 64 词',
    hotwords.isCustom() === false && hotwords.allWords().length === 64, hotwords.allWords().length + ' 词');
  ok('⑮ 恢复内置后提示词里的测试词消失', hotwords.promptBlock().indexOf(NEWW) < 0);
  ok('⑮ 恢复内置后判据里的测试词也消失', copycheck.prefixWords().indexOf(NEWW) < 0);
  ok('⑮ ★ 恢复内置写回的是 null，不是「和基线一样的一份副本」（否则以后改基线顶不动老机器）',
    store.get('copy.hotwords') === null, JSON.stringify(store.get('copy.hotwords')));


  srv.close();
  srvRef = null;
  console.log('\nTMP: ' + TMP);
})().catch(e => {
  console.error('COPY TEST ERROR', (e && e.stack) || e);
  // ★★ 断言中途抛异常时，假 HTTP 服务会一直占着事件循环 ⇒ 进程**永不退出**，
  //    上层（定点破坏脚本 / CI）会一直等下去。实测踩过：12 条破坏跑到第 1 条就挂死十几分钟。
  //    所以出错路径必须**硬退出**，不能指望事件循环自己空掉。
  try { if (srvRef) srvRef.close(); } catch (x) { /* 已经在关 */ }
  process.exit(1);
});
