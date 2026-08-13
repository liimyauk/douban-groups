# 豆瓣小组浏览器

一个轻量的豆瓣小组浏览工具：**Node.js 代理服务 + 单页前端**，无需登录即可浏览热门小组、讨论列表与帖子详情（含图片/动图/评论），支持收藏、最近浏览、主题切换与极简模式。

## 功能特性

- 🏠 **热门小组与搜索**：抓取豆瓣 explore 页，关键词搜索小组
- 📋 **讨论列表**：分页加载、按回复/发帖时间排序、帖内搜索
- 📄 **帖子详情**：正文、图片画廊（动图 raw 原图代理）、评论区（含评论图片）、Lightbox 看图
- ⭐ **收藏同步**：收藏跨浏览器/设备共享（服务器端 `favs.json` 持久化），标签一键删除（带二次确认）
- 🕘 **最近浏览**：自动记录访问过的小组
- 🎨 **主题与极简模式**：暗色/浅色主题切换；极简模式下图片需点击才加载（省流量）
- ⌨️ **快捷键**：`?` 快捷键面板、`b` 返回、`r` 刷新、`/` 搜索、`Esc` 关闭
- 📱 **响应式**：桌面与移动端适配

## 技术架构

- **后端**：`server.js`（原生 Node.js，无第三方依赖）——代理豆瓣 rexxar API 与网页接口，图片代理带 SSRF 白名单（仅 douban.com/doubanio.com）、收藏持久化 API、静态文件服务
- **前端**：`index.html` 单页应用（原生 JS + CSS 变量主题），无构建步骤
- **安全**：输出转义（XSS 防护）、同源写保护（收藏 API）、SSRF 白名单、ID 白名单校验

## 本地运行

```bash
node server.js
```

打开 http://localhost:4112/

## 部署

### 方式一：直接运行

服务器需有 Node.js（≥14）。上传 `server.js` 与 `index.html` 到任意目录，执行：

```bash
node server.js
```

### 方式二：systemd 服务（推荐）

```ini
# /etc/systemd/system/douban-groups.service
[Unit]
Description=豆瓣小组浏览器（douban-groups）
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/douban-groups
ExecStart=/usr/bin/node /opt/douban-groups/server.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
systemctl daemon-reload
systemctl enable --now douban-groups
```

服务默认监听 `0.0.0.0:4112`。如仅本机使用，可将 `server.js` 中 `HOST` 改为 `127.0.0.1`。

## 数据与隐私

- 收藏数据保存在服务器 `favs.json`（本地文件），跨浏览器共享
- 最近浏览/主题/极简模式保存在浏览器 localStorage
- 不收集任何用户个人信息，不依赖登录

## 目录结构

```
index.html       单页前端（样式/脚本内联）
server.js        Node.js 代理服务
start.command    macOS 本地双击启动
```

## License

MIT
