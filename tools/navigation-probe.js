'use strict';
// 只验证发布入口，停在相册之前，不推素材、不清相册、不提交。
const fs = require('fs'), path = require('path'), os = require('os'), Module = require('module');
const root = path.resolve(__dirname, '..'), tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bluev-nav-'));
const load = Module._load;
Module._load = function(name) { if (name === 'electron') return { app: { getPath: () => tmp, getVersion: () => '1.1.1' }, BrowserWindow: { getAllWindows: () => [] } }; return load.apply(this, arguments); };
const adb = require('../src/main/services/adb'), publisher = require('../src/main/services/publisher'), uimap = require('../src/main/services/uimap');
adb.setBundledAdbDir(path.join(root, 'vendor/adb'));
const config = JSON.parse(fs.readFileSync(path.join(process.env.APPDATA, 'dewu-bluev-publisher/config.json'), 'utf8'));
const serial = config.publish.device;
(async () => {
  if (process.argv.includes('--cleanup')) {
    console.log(JSON.stringify(await adb.clearMediaDir(serial, '/sdcard/Pictures/bluev_entry_probe_20261012')));
    return;
  }
  if (process.argv.includes('--chain')) {
    const jpeg = require('jpeg-js');
    const remote = '/sdcard/Pictures/bluev_entry_probe_20261012';
    await adb.shell(serial, 'mkdir -p ' + remote);
    const files = [];
    for (let i = 1; i <= 2; i++) {
      const data = Buffer.alloc(320 * 320 * 4);
      for (let p = 0; p < data.length; p += 4) { data[p] = i === 1 ? 60 : 220; data[p + 1] = 140; data[p + 2] = 160; data[p + 3] = 255; }
      const local = path.join(tmp, i + '.jpg'), target = remote + '/' + i + '.jpg';
      fs.writeFileSync(local, jpeg.encode({ data, width: 320, height: 320 }, 90).data);
      if (!(await adb.push(serial, local, target)).ok) throw Error('测试图推送失败');
      await adb.mediaScan(serial, target); files.push(target);
    }
    if (!(await adb.mediaVisible(serial, files)).ok) throw Error('测试图片未入库，停止验证');
    await adb.makeNewest(serial, files[0], files);
    const rounds = [];
    for (let round = 1; round <= 3; round++) {
      const ctx = { uiMapScreen: { w: 1080, h: 1920 }, cancelled: () => false, animOffSteps: {}, log: s => console.log(s) };
      const start = Date.now();
      await publisher.openPublishEntry(serial, ctx);
      const steps = require('../src/main/uimapdefaults').steps;
      for (const original of steps.slice(5, 11)) {
        const step = { ...original };
        if (step.count) step.count = 2;
        await publisher.runStep(serial, step, {}, ctx);
      }
      const dump = await adb.dumpEx(serial, { pkg: uimap.DEWU.pkg, retries: 0, preferAnimOff: true });
      if (!dump.ok || !dump.xml.includes('com.shizhuang.duapp:id/etTitle')) throw Error('没有到达标题编辑页');
      rounds.push({ round, seconds: (Date.now() - start) / 1000, focus: await adb.currentFocus(serial), reachedTitleEditor: true, submitted: false });
      console.log(JSON.stringify(rounds[rounds.length - 1]));
    }
    fs.writeFileSync(path.join(root, '../investigation-20261012/entry-editor-rounds.json'), JSON.stringify(rounds, null, 2));
    await adb.ensureApp(serial, { pkg: uimap.DEWU.pkg, activity: uimap.DEWU.launchActivity, want: uimap.DEWU.homeActivity, judge: f => uimap.isHomeScreen(f), timeoutMs: 30000 });
    return;
  }
  if (process.argv.includes('--entry') || process.argv.includes('--fallback')) {
    const rounds = [];
    for (let i = 0; i < 3; i++) {
      const start = Date.now();
      const ctx = { cancelled: () => false, log: s => console.log(s) };
      let result;
      if (process.argv.includes('--fallback')) {
        await adb.ensureApp(serial, { pkg: uimap.DEWU.pkg, activity: uimap.DEWU.launchActivity, want: uimap.DEWU.homeActivity, judge: f => uimap.isHomeScreen(f), timeoutMs: 30000 });
        // 首页动态不含主页按钮：走真实 runStep 的缺失分支，不替换 dump、不伪造节点。
        await publisher.runStep(serial, { action: 'tapId', value: 'com.shizhuang.duapp:id/tab_trends' }, {}, ctx);
        result = await publisher.runStep(serial, { action: 'tapId', value: 'com.shizhuang.duapp:id/tvGoHomePage', name: '主页' }, {}, ctx);
        await publisher.runStep(serial, { action: 'tapId', value: 'com.shizhuang.duapp:id/rlPublish', name: '发布动态' }, {}, ctx);
        result.focus = await adb.currentFocus(serial);
        if (!/TotalPublishProcessActivity|DraftActivity/.test(result.focus)) throw Error('没有进入发布流程');
      } else result = await publisher.openPublishEntry(serial, ctx);
      rounds.push({ round: i + 1, seconds: (Date.now() - start) / 1000, ...result });
    }
    fs.writeFileSync(path.join(root, '../investigation-20261012/' + (process.argv.includes('--fallback') ? 'fallback-rounds' : 'navigation-rounds') + '.json'), JSON.stringify(rounds, null, 2));
    console.log(JSON.stringify(rounds, null, 2));
    return;
  }
  if (process.argv.includes('--home')) {
    console.log(JSON.stringify(await adb.ensureApp(serial, { pkg: uimap.DEWU.pkg, activity: uimap.DEWU.launchActivity, want: uimap.DEWU.homeActivity, judge: f => uimap.isHomeScreen(f), timeoutMs: 30000 })));
  }
  const ctx = { uiMapScreen: { w: 1080, h: 1920 }, cancelled: () => false, log: (s) => console.log(s) };
  if (process.argv.includes('--mine')) {
    const step = config.publish.uiMap.steps.find(s => s.action === 'tapXY' && /底部/.test(s.name || ''));
    await publisher.runStep(serial, step, {}, ctx);
    await new Promise(r => setTimeout(r, 800));
  }
  const d = await adb.dumpEx(serial, { pkg: uimap.DEWU.pkg, retries: 0, preferAnimOff: true });
  if (!d.ok) throw Error(d.why);
  const nodes = uimap.parseNodes(d.xml);
  const name = process.argv.includes('--mine') ? 'mine' : 'current';
  fs.writeFileSync(path.join(root, '../investigation-20261012/nav-' + name + '.xml'), d.xml);
  console.log(JSON.stringify({ focus: await adb.currentFocus(serial), size: await adb.uiSize(serial), nodes: nodes.filter(n => n.text || n.desc || /tab_|Camera|Publish|HomePage/i.test(n.id || '')).map(n => ({ id: n.id, text: n.text, desc: n.desc, bounds: n.bounds, center: n.center })) }, null, 2));
})().catch(e => { console.error(e.stack); process.exitCode = 1; });
