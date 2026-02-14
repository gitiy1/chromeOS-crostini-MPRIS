# chromeOS-crostini-MPRIS

轻量化桥接方案：在 **ChromeOS 宿主** 使用蓝牙耳机按键控制 **Crostini (Arch Linux)** 内的 MPRIS 播放器。

方案由两个模块组成：

1. `backend/`：Rust 守护进程（MPRIS -> SSE、控制 API、封面代理、PNA/CORS）
2. `extension/`：Bun 构建的 Manifest V3 扩展（Offscreen + Media Session）

## 架构

- Linux 容器内 Rust 轮询活跃 MPRIS 播放器，提供：
  - `GET /events` SSE 状态流
  - `GET /state` 当前快照
  - `POST /control/:action` 控制指令
  - `GET /art?src=file://...` 专辑封面代理
- Chrome 扩展 Offscreen 页面：
  - 监听 SSE，同步 `navigator.mediaSession.metadata`
  - 使用 `setPositionState` 同步进度
  - 注册 `play/pause/next/previous` handler，把蓝牙按钮回传 Linux

## 后端（Rust）

```bash
cd backend
cargo run --release
```

环境变量：

- `BIND_ADDR`（默认 `0.0.0.0:5000`）
- `POLL_INTERVAL_MS`（默认 `500`，最小 200）

## 前端（Bun + MV3）

```bash
cd extension
bun install
bun run build
```

打包输出在 `extension/dist`，在 Chrome 扩展管理页以“加载已解压的扩展程序”加载。

### 可选配置

扩展支持 `chrome.storage.local.baseUrl` 覆盖后端地址（默认 `http://penguin.linux.test:5000`）。

## systemd 用户服务（容器内）

`docs/crostini-mpris-bridge.service` 提供开机自启模板。


## 调试方式（推荐）

点击扩展图标会打开内置调试面板（popup），可用于：

- 查看桥接健康状态（idle/connecting/connected/error）
- 查看当前播放器、曲目信息、播放状态、进度
- 查看 Offscreen 日志（SSE 连接、控制指令、错误）
- 在线修改 `baseUrl` 并立即生效
- 点击“测试 /healthz”快速验证后端连通性

调试数据写入 `chrome.storage.local`：

- `bridgeDebug`：当前状态快照
- `bridgeLogs`：最近 200 条日志
- `baseUrl`：后端地址
