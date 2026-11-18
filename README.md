# TVBox PC

基于 TVBox 开源接口协议的 Windows 桌面影视客户端（空壳播放器）。
软件本身不含任何影视资源，只加载你自己填写的接口（json / txt），解析站点、分类、搜索、详情、剧集和直播地址并播放。

> 接口与内容由使用者自行提供，请使用合法授权的影视来源。本项目不包含 TVBox 原项目的 APK、spider jar 或第三方资源。

## 功能

- **点播 / 搜索 / 直播 / 收藏 / 设置**：遥控器优先布局，对齐安卓 TVBox 排法
- **多接口管理**：支持 URL、json 文本、本地 txt/json 文件导入，一键切换，多仓可选线路
- **浏览与诊断**：首页推荐、分类浏览、站点体检、接口诊断
- **播放**：HLS（m3u8）/ mp4 / flv，续播、自动下一集、选集抽屉、全屏、倍速
- **直播**：m3u 与 TVBox txt 源，左侧分组栏 + 右侧频道墙，多源标签切换
- **外观**：浅色 / 深色 / 跟随系统；海报尺寸、界面字号可调
- **本地记录**：收藏、观看进度、外观设置均保存在本机

## 环境要求

- Node.js LTS（仅开发和打包使用，最终用户不需要安装 Node）
- Windows x64；Linux 可打包 tar.gz 解压包

## 快速开始

```powershell
npm install    # 安装依赖
npm start      # 本地运行
```

## 打包

```powershell
npm run dist     # 免安装便携版 exe（portable）
npm run setup    # 安装版 exe（NSIS）
```

产物输出到 `dist/`。打 Linux 解压包：

```powershell
npx electron-builder --linux tar.gz --x64
```

## 目录结构

```
TVBox-PC/
├─ src/
│  ├─ main.js          # 主进程：静态服务、窗口、请求转发（绕过 CORS）
│  ├─ netfetch.js      # 取数三层链路与编码解码
│  ├─ preload.js       # 安全桥
│  └─ renderer/        # 界面：HTML / CSS / JS、焦点引擎、播放器与规则引擎
├─ build/              # 应用图标
├─ test/                # 自测脚本与本地 mock 接口
├─ tools/               # 探测与辅助脚本
└─ package.json
```

## 接口格式

```json
{
  "sites": [
    {
      "key": "demo",
      "name": "示例站点",
      "type": 1,
      "api": "https://example.com/api.php/provide/vod/",
      "searchable": 1
    }
  ],
  "lives": [
    { "name": "示例直播", "url": "https://example.com/live.txt", "type": 0 }
  ],
  "parses": [
    { "name": "示例解析", "type": 1, "url": "https://example.com/parse?url=" }
  ]
}
```

- `type: 0 / 1` 为苹果 CMS 直连站点，支持
- `type: 3`（spider jar 规则站）桌面端不支持，加载时自动跳过

## 数据位置

接口（含本地导入的内容）、收藏、观看进度、外观设置写入：

```
%APPDATA%\TVBox PC\tvbox-store.json
```

## 已知限制

- 加密 / DRM 流、需要登录鉴权的源站无法播放
- spider（jar 规则）站点不支持，这是 Electron 与 Android 运行环境的根本差异
- 部分源站需要在设置里配置 Referer 才能播放

## 许可证

MIT
