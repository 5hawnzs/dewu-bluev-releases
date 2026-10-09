# 文件夹工具自动部署

网站：<https://material-folder-generator.pages.dev/>。

主分支推送 `web/folder-tool/` 内的网页改动后，GitHub Actions 自动更新现有 Cloudflare Pages 项目。也可以在 Actions 的“部署素材文件夹工具”中手动运行。

部署只上传 `web/folder-tool/`，不上传桌面 App 源码、配置或安装包。修改桌面 App 时不触发网页部署。

## 一次性授权

仓库 Settings → Secrets and variables → Actions 中需要以下配置：

- Repository variable `CLOUDFLARE_ACCOUNT_ID`：现有 Pages 项目的 Cloudflare 账号 ID（非密钥）。
- Repository secret `CLOUDFLARE_API_TOKEN`：专用 API 令牌，权限为 Account → Cloudflare Pages → Edit，账号范围限定到网站所属账号。

在 Cloudflare 的 API Tokens 页面创建令牌。令牌只能保存在 GitHub Secrets 中，不写入仓库，不使用短期 Wrangler OAuth 登录令牌代替。

现有 Pages 项目的生产分支应为 `main`，工作流明确使用此分支发布；公网网址保持不变。

## 检查更新结果

打开 GitHub Actions，确认最新“部署素材文件夹工具”运行成功，再打开网站检查本次修改。部署失败时查看失败步骤，修复授权或配置后重新运行。
