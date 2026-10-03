'use strict';
/**
 * 模型接口的内置默认值 —— **留空＝跟随内置**（和云端协作那一套同一个规矩）。
 *
 * ★★ 为什么要有这个文件（2026-10-02 实测挖出来的根因）：
 *   用户配了 `copy.llm.enabled=true` + 一个 key，但**接口地址是空的**，
 *   而代码里 `if (!endpoint) throw '未配置接口地址'` ⇒ 每次生成都抛，被 catch 后
 *   静默回退到本地模板。于是界面一路显示「已生成」，用户看到的却是一堆
 *   「灰色的细节，真的顶」这种模板货，还以为那就是 AI 写的。
 *   实测证据：`%APPDATA%\dewu-bluev-publisher\config.json` 里 `copy.llm.endpoint === ''`。
 *
 * ★★ 为什么内置这两个值：
 *   1) **地址**：留空就跟随内置 ⇒ 装上就能用；换项目/换服务商时发新包，各台自动跟随
 *      （老机器 config.json 里那个键仍是空的，不会被焊死）。
 *   2) **模型 id**：用户填的显示名（`deepseek v4.1 flash`）**不是接口认的 id**，
 *      实测直接 HTTP 400：`The supported API model names are deepseek-flash, ...`。
 *      所以只留一个「认不出就别硬发」的兜底 id；真正的解析在 copywriter.preflight()
 *      里按 `/models` 清单做（按 id 精确匹配 → 按显示名归一化匹配 → 才落到这里的兜底）。
 *
 * ★ 这里**只有地址和模型 id，没有任何凭据**：key 永远是各台机器自己配的
 *   （内置 key = 谁拿到包谁就能刷你的额度，绝不能写）。
 * ★ 用户填了就以填的为准，这里只在**空**的时候兜底，且**绝不写回 config.json**
 *   （写回＝固化，以后换服务商顶不动，见 store.js 里那段长注释）。
 */
module.exports = {
  endpoint: 'https://api.deepseek.com/v1',
  model: 'deepseek-flash',
  // 出厂默认看图的张数 / 单边像素 / 超时。留在这里是为了让「默认值」只有一个来源，
  // 界面上改的就是覆盖它（copywriter.cfgOf 读的优先级：本机配置 > 这里）
  imageCount: 2,
  // ★ 视频素材没有实拍图时，从视频里抽几帧送给模型（services/frame.js）。**出厂 1 帧** ——
  //   用户拍板「抽帧送模型，但是在尽可能少消耗模型费用的前提下做」：抽帧的算力花在本机，
  //   真花钱的是**送出去几张图**，所以这个数是个常数、跟视频多长无关。
  //   0 = 不抽（只有视频的素材就只按货号/颜色写）—— 界面上不摆这个旋钮，手改 config.json 才有。
  videoFrames: 1,
  imageMaxSide: 768,
  timeoutSec: 90
};
