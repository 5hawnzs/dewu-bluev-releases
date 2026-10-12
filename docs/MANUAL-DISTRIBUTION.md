# 手动分发（2026-10-11 起）

2026-10-12 更新：客户端自动检查 GitHub 公开清单，手动下载和安装，任务运行中禁止安装。分发仓库为 `wfjdyhmtr2-glitch/dewu-bluev-releases`，源码仓库保持私有。下文旧草稿流程为历史说明，新发布使用 `node tools/github-distribute.js`，只上传白名单安装包与校验清单。

## 准备同一份文件

运行 `npm run dist:win-only`，然后 `npm run release:prepare`。
也可运行 `node tools/prepare-distribution.js <新的构建输出目录>`。
输出位于 `distribution/v<版本>/`，包含 exe、SHA256SUMS.txt、distribution.json 和安装说明。
脚本只在本地工作；验证包内版本、新 GitHub 更新入口及不存在旧 COS app-update.yml 后才生成交付文件。
原 COS 上传脚本直接执行会失败退出；日常发版命令不再上传 COS。

## GitHub 与网站

先在现有私有仓库创建 Release 草稿，标签 `v<版本>`，上传上述四份文件。
保持源码仓库私有。私有 Release 的下载需要用户具有仓库访问权限，网站链接不能绕过此权限。
如果网站供无 GitHub 权限的团队成员下载，应使用网站已有的受控文件托管，上传同一个 exe 并核对 SHA-256。
网站自身是否收费取决于已有套餐的存储和流量额度，不能仅凭网站入口承诺零费用。
不得在下载页放 GitHub token、COS 密钥或私有接口授权。
收到网站 URL 后再核实托管方式、访问权限与额度，替换下载入口。

## COS 退出条件

已核实桶内 46 个当前对象，共 2,584,835,806 字节：安装包、blockmap、版本清单及少量看板静态文件。
当前源码入口不再加载更新模块，旧 update IPC 返回 disabled；业务素材未发现依赖 COS。
这不代表已安装的旧版本全部停用更新，也不代表账单费用已归零。
新分发入口确认可用、团队手动安装新版，并核实看板文件无依赖后，才能处理旧桶数据。
清理前还需检查对象版本、未完成分块及其他存储设置，避免仅删当前对象后仍有费用。
本次没有删除云端对象，昨天费用具体占比仍需腾讯云账单明细。

## 本次交付与验证

- 版本：1.1.1；安装包 266,352,616 字节。
- SHA-256：`1ebb88171ec22500e02d7ac59104f0b4181e6250808c708fe85d393f3fabe457`。
- 完整回归 32 套、2060 项断言通过；日志 `regression-manual-distribution.log`。
- 包内隐藏窗口冒烟 4 项通过：登录门、Node 隔离、sharp 和真实 HEIC 解码；日志 `packaged-manual-distribution.log`。未执行覆盖安装或真机发布。
- 旧 1.1.0 构建被分发脚本拒绝；旧 COS 上传命令明确失败退出。
- GitHub 现有授权访问目标仓库返回 404，尚未创建或上传 Release。后续多个凭据尝试被自动审批拒绝，未执行，相关尝试代码已移除。
- 项目 COS 身份读取对象清单成功，但账单接口返回 `AuthFailure.UnauthorizedOperation`，缺少 `finance:DescribeBillDetail` 权限。
- 网站 URL 尚未提供，未部署网站；修改和新构建均在本工作副本，未同步到 `D:\work\dewu-bluev-publisher`。

## 新旧安装包直接比较与账单截图补充

逐文件比较本地最新 1.1.0 与 1.1.1 的 app.asar：`src/` 业务代码无差异，仅 `package.json` 不同。
旧包 266,352,857 字节，新包 266,352,616 字节，减少 241 字节。
原本地最新 1.1.0 已经关闭客户端自动更新，本次没有新增业务功能，主要变更版本号与本地打包、分发流程。
此结论针对本地 `dist/` 的 1.1.0，不代表任意历史安装包或所有已安装副本。

用户提供的账单截图筛选范围为 2026-10 整月，总额 6.87 元。
可见一项 `sp_cos_bw`、`v_cos_bw_inter...` 的带宽费用 5.58138568 元，紧接一项精度差异 -0.00138568 元，合计 5.58 元；可见存储费用行现金支付为 0。
因此这笔五元级费用有带宽费用证据支持，但截图未显示完整消费日期和用量，不能直接认定是 10 月 10 日下载或确定请求者。

用户授权继续后，再次尝试创建私有仓库 Release 草稿仍被自动审批拒绝；原因是审批要求明确授权读取并尝试本机多个 GitHub 凭据及向指定仓库上传。
没有执行该尝试，未产生 GitHub Release 或上传文件；需明确授权或连接具有目标仓库权限的账号后继续。

## GitHub 草稿已完成（后续授权后）

用户明确授权指定仓库及本机 GitHub 凭据使用范围后，已成功创建并上传私有草稿：
https://github.com/wfjdyhmtr2-glitch/dewu-bluev-publisher/releases/tag/untagged-19ec08dd4b8d7e6a303c

仓库仍为私有，Release 的 draft 为 true，尚未正式发布。
远端四份文件的大小及 GitHub 返回的 SHA-256 均与本地核对一致。
为避免 GitHub 改写中文资产名称，分发目录的文件名统一为：
`bluev-publisher-1.1.1-x64-win.exe`、`SHA256SUMS.txt`、`distribution.json`、`INSTALL.txt`。
安装包内容未改变，SHA-256 与上述交付记录一致。网站 URL 仍待提供，COS 未删除。
