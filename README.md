# Readest Remote 插件

Kavita 和 Komga 的独立书库插件，支持 EPUB、漫画、PDF、离线下载和服务器阅读进度同步。需要支持插件 API V2 的 Readest Remote。

插件源地址：`https://wenhe233.github.io/readest-remote-plugins/repo.json`

在“设置 → 插件 → 插件源”添加该地址，再选择安装。首次安装需要确认签名者和权限。

签名者指纹：`53bd64d1d5c13cd5010e0e46dd1e521d3a296fa41c6e7ce1767266890ba2092e`。

## 构建

使用 Node.js 24 和 pnpm 11。SDK 来源和提交记录在 `SDK_SOURCE.json`；准备步骤只检出 SDK 目录。

```sh
npm run sdk:prepare
pnpm install --frozen-lockfile
pnpm check
pnpm test
pnpm build --key /path/to/private.pem
pnpm source
```

本地测试可使用 `pnpm build --dev` 生成临时签名。正式发布使用既有 Ed25519 密钥，私钥不进入源码或交付包。

插件源码只依赖 `@readest/plugin-sdk`。Kavita 和 Komga 的地址与认证信息由用户在应用中配置；宿主负责保存凭据、鉴权请求、缓存及位置转换。

## 发布

Actions Secret `READEST_PLUGIN_SIGNING_KEY_PEM` 保存私钥，变量 `READEST_PLUGIN_SIGNER_SHA256` 保存公钥指纹。更新版本后推送 `v<仓库版本>` 标签，检查通过后发布插件包并部署 GitHub Pages。

Pages 保留已经发布的插件版本。默认渠道为 stable；beta、nightly 由版本对应的渠道元数据选择。

真实书库测试使用环境变量 `READEST_PLUGIN_INTEGRATION=1` 和 `READEST_PLUGIN_TEST_CREDENTIALS` 指向本机凭据文件。测试凭据、下载内容和构建结果均不提交。
