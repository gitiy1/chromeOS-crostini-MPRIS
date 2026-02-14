# **跨进程架构下的 Linux 媒体元数据同步与实时进度控制的可行性深度研究报告**

## **1\. 执行摘要**

关于在 Web 环境（如 Chrome 浏览器扩展）中精确获取并同步 Arch Linux 系统底层媒体播放器（如 Spotify, VLC, mpv 等）的元数据（标题、艺术家、专辑）及实时播放进度（Position）的可行性，经过对系统架构、D-Bus 通信协议、浏览器安全模型及现代 Web 标准的详尽分析，本报告得出确定的肯定结论：**该方案完全可行，且能够实现高保真的“真实”数据同步。**

用户所关心的核心疑点——“进度是否真实”——在技术层面上是一个关于时间同步与状态推演（Dead Reckoning）的问题。虽然通过 IPC（进程间通信）传输每一毫秒的进度更新在物理上是不切实际且极其低效的，但通过 MPRIS（Media Player Remote Interfacing Specification）协议提供的“基准时间戳”与“播放速率”模型，结合现代浏览器提供的 **Media Session API** 中的 setPositionState 接口，可以在 Web 端重建出与原生播放器毫秒级同步的“真实”进度条。这种“真实”并非基于高频轮询的瞬时快照，而是基于确定性数学模型的实时推演，其视觉表现与数据准确性与本地应用无异。

然而，实现这一目标并非简单的 API 调用，它需要构建一个复杂的中间件架构来跨越操作系统与浏览器沙箱之间的鸿沟。主要的挑战在于：

1. **D-Bus 与 Web 协议的异构性**：浏览器无法直接访问 Linux 的系统总线。  
2. **安全策略限制**：现代浏览器（尤其是 Chrome）对本地网络资源的访问（CORS 和 Private Network Access 规范）有严格限制。  
3. **资源生命周期**：Chrome Manifest V3 扩展的 Service Worker 短暂生命周期与媒体会话的持久性需求存在冲突。  
4. **本地文件访问**：MPRIS 返回的专辑封面通常是 file:// 协议路径，被浏览器严格禁止加载。

本报告将详细阐述如何利用 **Rust 语言** 构建高性能中间件（基于 Axum 框架），结合 **Server-Sent Events (SSE)** 实时推送技术，以及 Chrome 扩展的 **Offscreen Document** 机制，来逐一攻克上述技术壁垒，最终实现从 Arch Linux 内核态到 Web 前端的高精度数据流转。

## ---

**2\. 核心技术背景与数据源真伪性分析**

在回答“能不能获取”之前，必须深入解构 Linux 桌面环境下的媒体控制标准——MPRIS，以此证明数据的“真实性”来源。

### **2.1 MPRIS：Linux 媒体控制的“真理之源”**

MPRIS (Media Player Remote Interfacing Specification) V2 是 Linux 桌面环境下的事实标准。无论是 Arch Linux、Ubuntu 还是 Fedora，几乎所有主流媒体播放器都实现了该接口。

#### **2.1.1 D-Bus 接口架构**

在 Arch Linux 中，当一个媒体播放器启动时，它会向 Session D-Bus 注册一个类似 org.mpris.MediaPlayer2.spotify 或 org.mpris.MediaPlayer2.vlc 的服务名称。该服务暴露了 org.mpris.MediaPlayer2.Player 接口，这是所有元数据和控制指令的入口 1。

数据的“真实性”由 D-Bus 的原子性保证。当播放器切歌时，它会主动在总线上发射 PropertiesChanged 信号。这是一个系统级的事件，意味着数据的更新是推送式的，而非猜测式的。

#### **2.1.2 元数据字段的映射关系**

用户关心的 Title, Artist, Album 均存储在 Metadata 属性中，这是一个 a{sv} (String to Variant map) 结构。根据 XESAM (XML Enriched Shared Abstract Metadata) 标准，其映射关系如下表所示：

| 数据项 (用户需求) | MPRIS 标准键值 (XESAM/MPRIS) | 数据类型 | 说明 | 真实性判定 |
| :---- | :---- | :---- | :---- | :---- |
| **Title** | xesam:title | String | 轨道标题 | **绝对真实**。直接来自播放器内核。 |
| **Artist** | xesam:artist | List\<String\> | 艺术家列表 | **绝对真实**。需注意处理多艺术家的情况。 |
| **Album** | xesam:album | String | 专辑名称 | **绝对真实**。 |
| **Artwork** | mpris:artUrl | String (URI) | 封面图片路径 | **真实但受限**。通常为 file:// 本地路径，需转换。 |
| **Duration** | mpris:length | Int64 | 时长(微秒) | **高精度真实**。微秒级精度。 |
| **Track ID** | mpris:trackid | Object Path | 唯一标识符 | 用于区分播放列表中的重复曲目 3。 |

**结论**：元数据的获取在理论和实践上都是完全可行的，数据源是操作系统的核心消息总线，不存在“模拟”或“伪造”的情况。

### **2.2 进度的“真实性”悖论与解决方案**

用户特别提到的“进度也是真的”是一个极具深度的技术问题。在分布式系统或跨进程通信中，并不存在绝对实时的“当前时间”。

#### **2.2.1 为什么不能轮询进度？**

如果 Web 端通过轮询（Polling）方式，每秒向 Linux 系统询问 10 次“现在播放到哪了？”，会产生两个严重问题：

1. **性能损耗**：D-Bus 调用的上下文切换和 JSON 序列化/反序列化开销会显著增加 CPU 负载。  
2. **视觉抖动**：网络延迟（即使是本地回环网络）会导致进度条跳跃，无法呈现平滑的 60fps 动画。

#### **2.2.2 MPRIS 的快照模型 (Snapshot Model)**

MPRIS 协议设计者早已预见到此问题，因此设计了基于“快照”的机制 1。当客户端请求 Position 属性时，播放器返回的是 **API 被调用瞬间** 的时间戳（微秒）。

真实的进度 ![][image1] 是一个关于时间的线性函数，由以下参数决定：

* ![][image2]: 参考时间点（读取 Position 的那一刻的系统单调时间）。  
* ![][image3]: 参考位置（在 ![][image2] 时刻的播放进度）。  
* ![][image4]: 播放速率（PlaybackRate，播放时为 1.0，暂停为 0.0，倍速时为 2.0 等）。

Web 端显示的“真实”进度实际上是基于该模型的实时推演：

![][image5]  
只要 ![][image4]（速率）和 ![][image3]（基准点）是准确的，Web 端计算出的进度就与播放器内部的进度在数学上保持一致。每当用户进行“暂停”、“播放”或“拖动进度条（Seek）”操作时，MPRIS 会发送 PropertiesChanged 或 Seeked 信号，Web 端接收到信号后重置 ![][image2] 和 ![][image3]，从而消除累积误差。

**结论**：进度的“真”，不是指每毫秒都传输一个数据包，而是指**状态模型的同步**。这种机制是所有现代流媒体系统（包括 YouTube、Netflix、Spotify 客户端）处理进度条的标准做法。

## ---

**3\. 系统架构设计：Rust 中间件与 Web 桥接**

鉴于浏览器环境无法直接执行 D-Bus 指令，必须引入一个运行在用户态的“桥接服务”。Rust 语言凭借其内存安全、无 GC（垃圾回收）暂停以及强大的异步 I/O 能力（Tokio），是构建此类即时通讯中间件的最佳选择。

### **3.1 总体架构图**

代码段

graph LR  
    subgraph Arch Linux Host  
        A \-- D-Bus Signals \--\> B  
        B \-- Read File \--\> C\[Local Filesystem (Album Art)\]  
    end  
      
    subgraph Web Browser (Chrome/Firefox)  
        D \-- SSE (Events) \--\> B  
        D \-- HTTP GET (Images) \--\> B  
        D \-- HTTP POST (Control) \--\> B  
        D \-- Media Session API \--\> E  
    end

### **3.2 Rust 后端实现深度解析 (基于 Axum)**

使用 Rust 的 axum web 框架配合 mpris crate，可以构建一个轻量级、高并发的桥接服务。

#### **3.2.1 D-Bus 事件监听循环**

不同于传统的请求-响应模型，我们需要一个持续运行的事件循环来监听 D-Bus 信号。Rust 的 tokio::task 可以轻松实现这一点。

代码逻辑核心在于 ProgressTracker 的实现 5。我们需要监听 PropertiesChanged 信号，一旦检测到 Metadata 变化（切歌）或 PlaybackStatus 变化（暂停/播放），立即向前端推送事件。

Rust

// 伪代码逻辑示意：监听 MPRIS 事件流  
let player \= PlayerFinder::new()?.find\_active()?;  
let events \= player.events()?;

for event in events {  
    match event {  
        Ok(mpris::Event::Playing) \=\> {  
            // 推送播放状态：Rate \= 1.0  
            broadcast\_sse(PlaybackState { rate: 1.0,.. });  
        },  
        Ok(mpris::Event::Paused) \=\> {  
            // 推送暂停状态：Rate \= 0.0  
            broadcast\_sse(PlaybackState { rate: 0.0,.. });  
        },  
        Ok(mpris::Event::TrackChanged(metadata)) \=\> {  
            // 推送新元数据  
            broadcast\_sse(parse\_metadata(metadata));  
        },  
        \_ \=\> {}  
    }  
}

#### **3.2.2 解决本地文件访问难题 (artUrl Proxy)**

MPRIS 返回的 mpris:artUrl 往往是 file:///home/user/.cache/spotify/cover.jpg 3。出于安全原因，Web 页面禁止直接加载 file:// 资源 8。

**解决方案**：Axum 服务必须充当**静态文件代理**。

1. Rust 后端接收到 file:// 路径。  
2. 解析出文件系统绝对路径。  
3. 生成一个临时的 HTTP URL，例如 http://127.0.0.1:3000/art/current\_track\_hash。  
4. 利用 tower\_http::services::ServeFile 或直接读取文件字节流，将图片以 image/jpeg 的 Content-Type 返回给浏览器 9。

这里需要特别注意路径遍历攻击（Path Traversal），虽然服务运行在本地，但最佳实践要求严格验证请求的路径是否确实是当前播放曲目的封面路径。

#### **3.2.3 实时通信协议选型：SSE vs WebSockets**

虽然 WebSockets 支持双向通信，但对于本场景，**Server-Sent Events (SSE)** 是更优选择 12：

* **协议开销**：SSE 基于标准 HTTP，握手简单，不需要复杂的帧协议。  
* **断线重连**：浏览器原生 EventSource API 自带自动重连机制，非常适合处理服务重启或休眠唤醒的情况。  
* **单向主导**：主要数据流是从 Linux \-\> Web。Web \-\> Linux 的控制指令（如“下一首”）可以通过简单的 HTTP POST 请求完成，无需维持 WebSocket 的全双工通道。

Rust 的 Axum 框架对 SSE 有原生的一流支持 (axum::response::sse)，能够轻松处理并发连接 15。

## ---

**4\. 前端集成：Chrome Media Session API 的关键作用**

在浏览器端，仅仅接收到数据是不够的，必须将其“告诉”浏览器，以便浏览器能将其集成到操作系统级别的媒体控制中心（如 Windows 的 SMTC 或 Linux 的 MPRIS 代理，实现闭环）。这就要用到 **Media Session API**。

### **4.1 数据映射与元数据更新**

当 Chrome 扩展通过 SSE 收到 Rust 推送的 JSON 数据后，直接映射到 MediaMetadata 对象：

JavaScript

// 收到 SSE 消息后的处理逻辑  
navigator.mediaSession.metadata \= new MediaMetadata({  
  title: sseData.title,  
  artist: sseData.artist,  
  album: sseData.album,  
  artwork:  
});

这一步保证了浏览器通知中心显示的 Title, Artist, Album 是完全真实的 16。

### **4.2 进度同步的核心：setPositionState**

为了回答用户关于“进度是否真实”的疑虑，这是最关键的环节。Chrome 81+ 引入了 setPositionState 方法，专门用于解决非 Web 媒体（或自定义播放器）的进度同步问题 18。

当 Rust 后端检测到 Seeked 信号或切歌时，会发送包含 position (微秒), duration (微秒), playbackRate 的数据包。前端代码如下：

JavaScript

const durationSec \= sseData.duration / 1\_000\_000; // 转换为秒  
const positionSec \= sseData.position / 1\_000\_000;

if ('setPositionState' in navigator.mediaSession) {  
    navigator.mediaSession.setPositionState({  
        duration: durationSec,  
        playbackRate: sseData.playbackStatus \=== 'Playing'? 1.0 : 0.0,  
        position: positionSec  
    });  
}

**关键机制**：一旦调用了 setPositionState，浏览器就会接管进度条的推演。浏览器内部会根据设定的 position 和 playbackRate 自动更新 UI 上的进度条，无需任何 JavaScript 定时器参与。这意味着，即使 JavaScript 主线程被阻塞，媒体控制中心的进度条依然会流畅走动。这就是“真实”进度的技术实现——它利用了底层的时钟同步机制 20。

## ---

**5\. 必须克服的工程障碍与安全限制**

即便理论模型完美，现代浏览器的安全策略（尤其是 Chrome）为这种本地通信设置了重重障碍。忽略这些将导致方案完全不可用。

### **5.1 跨域与私有网络访问 (CORS & PNA)**

这是最容易被忽视但最致命的问题。Chrome 正在逐步推行 **Private Network Access (PNA)** 规范（前身为 CORS-RFC1918），旨在防止公网网站攻击本地内网设备 22。

当 Chrome 扩展（或网页）试图请求 http://127.0.0.1:3000 时，浏览器会发起一个 Preflight (OPTIONS) 请求。Rust 服务器必须正确响应特定的 PNA 头信息，否则连接会被静默阻断。

**Rust Axum 必须配置的响应头：**

1. **Access-Control-Allow-Origin**: 必须明确指定扩展的 Origin（如 chrome-extension://abcdefg...）或者在开发模式下设为 \*。  
2. **Access-Control-Allow-Private-Network**: 必须设为 true。这是通过 PNA 检查的唯一通行证 23。  
3. **Access-Control-Allow-Methods**: 包含 GET, POST, OPTIONS。

如果缺少 Access-Control-Allow-Private-Network: true，控制台将报错 "Blocked by CORS policy: Response to preflight request doesn't pass access control check" 25。

### **5.2 Chrome 扩展生命周期 (Manifest V3)**

Manifest V3 强制使用 Service Worker 替代了常驻的后台页面。Service Worker 在闲置约 30 秒后会被强制终止 27。这对于一个需要持续监听 SSE 连接的媒体控制器来说是灾难性的——如果用户暂停音乐 1 分钟，Service Worker 就会死掉，连接断开，之后再播放时就无法同步了。

**解决方案：Offscreen Documents** Chrome 109+ 引入了 chrome.offscreen API。这允许扩展创建一个隐藏的 HTML 文档，该文档拥有完整的 DOM 环境，并且其生命周期可以独立于 Service Worker 29。

**最佳实践**：

1. 扩展启动时创建一个 Offscreen Document。  
2. 在 Offscreen Document 中建立与 Rust 服务器的 SSE 连接。  
3. Offscreen Document 负责维护 navigator.mediaSession 的状态。由于 Offscreen Doc 是一个真实的（虽然不可见）页面，它可以完美承载 Media Session API 的所有功能，并且不会像 Service Worker 那样被频繁杀掉，从而保证了连接的持久性和数据的实时性。

### **5.3 ChromeOS / Crostini 的特殊网络拓扑**

如果用户是在 ChromeOS 的 Linux 容器（Crostini）中运行 Arch Linux，情况会变得极其复杂 32。

* **网络隔离**：ChromeOS 的浏览器运行在宿主机，而 Arch Linux 运行在容器中。  
* **地址解析**：容器内的 localhost 对宿主机不可见。ChromeOS 为 Linux 容器分配了一个特殊的域名：**penguin.linux.test** 33。  
* **HTTPS 限制**：penguin.linux.test 通常不支持 HTTPS。如果 Web 应用是 HTTPS 的（如 Spotify Web Player），混合内容策略（Mixed Content）可能会阻止对 http://penguin.linux.test 的访问。  
* **解决方案**：在 ChromeOS 上，扩展必须请求 penguin.linux.test 的主机权限，并且在代码中动态检测环境，将 API 端点从 127.0.0.1 切换到 penguin.linux.test。同时，Rust 服务器需要监听 0.0.0.0 而非 127.0.0.1，以便接受来自外部（宿主机）的连接。

## ---

**6\. 综合数据流表与可行性总结**

为了直观展示各环节的数据如何流转并保持“真实性”，特编制下表：

| 数据属性 | Linux 源头 (MPRIS/D-Bus) | Rust 中间件处理 | 传输协议 | Web 接收端 (Chrome API) | 真实性/延迟分析 |
| :---- | :---- | :---- | :---- | :---- | :---- |
| **Title/Album** | xesam:title (Variant String) | 解析并封装 JSON | SSE | MediaMetadata.title | **实时**。事件驱动，无轮询延迟。 |
| **Artwork** | mpris:artUrl (file://URI) | 路径解析 \+ HTTP 文件服务 | HTTP GET | MediaMetadata.artwork.src | **真实**。通过 HTTP 代理加载本地文件字节流。 |
| **Duration** | mpris:length (Int64 微秒) | 转换为毫秒/秒 | SSE | setPositionState({duration}) | **高精度**。源数据精度高于 JS Number 安全范围，需转换，但在感知上无损。 |
| **Position** | Position (调用时快照) | 读取快照 \+ 时间戳 \+ 速率 | SSE | setPositionState({position}) | **数学真实**。依赖浏览器基于 playbackRate 的本地推演，消除网络抖动。 |
| **Status** | PlaybackStatus (Playing/Paused) | 监听 PropertiesChanged | SSE | navigator.mediaSession.playbackState | **实时**。D-Bus 信号触发毫秒级推送。 |

### **6.1 结论**

回答用户的原始提问：**这个 title artist album 能不能真的从 arch linux 内获取，另外还有进度也是真的，还是说不可行？**

**答案是：完全可行，且数据是真实的。**

这并非是通过不可靠的屏幕抓取或模拟按键实现的，而是通过直接对接 Linux 系统的底层媒体总线（D-Bus/MPRIS）实现的。

1. **元数据真实性**：直接读取播放器进程暴露的内存数据，与系统通知完全一致。  
2. **进度真实性**：通过“快照+速率”模型（Position State），利用浏览器的底层时钟进行同步推演，实现了与本地播放器数学层面的一致性，解决了网络传输延迟带来的“不真实”感。

**实施路线图建议**：

1. **后端**：使用 Rust (mpris \+ axum \+ tokio) 构建轻量级守护进程。  
2. **通信**：采用 SSE (Server-Sent Events) 进行单向状态推送。  
3. **网络**：配置 CORS 和 PNA (Private Network Access) 头以允许浏览器连接本地服务。  
4. **前端**：使用 Chrome 扩展的 Offscreen Document 承载 navigator.mediaSession 和 SSE 连接，避开 Service Worker 的生命周期限制。  
5. **兼容性**：针对 ChromeOS 用户，适配 penguin.linux.test 域名解析。

通过上述架构，可以构建出一种用户体验极佳、性能损耗极低且数据绝对准确的跨平台媒体同步方案。

## ---

**7\. 附录：关键实施代码片段参考**

### **7.1 Rust (Axum) PNA 头配置**

Rust

// 必须添加此中间件以通过 Chrome 的 PNA 检查 \[26, 36\]  
let cors \= CorsLayer::new()  
   .allow\_origin(Any) // 生产环境建议指定 Extension ID  
   .allow\_methods()  
   .allow\_headers(Any)  
   .expose\_headers(Any);

let app \= Router::new()  
   .route("/sse", get(sse\_handler))  
   .layer(cors)  
   .layer(SetResponseHeaderLayer::overriding(  
        HeaderName::from\_static("access-control-allow-private-network"),  
        HeaderValue::from\_static("true"), // 关键：允许私有网络访问  
    ));

### **7.2 前端 (Offscreen Document) 进度同步**

JavaScript

// 处理来自 Rust 的 SSE 消息 \[19\]  
evtSource.onmessage \= (event) \=\> {  
    const data \= JSON.parse(event.data);  
    if (data.type \=== 'playback\_update') {  
        // 使用 setPositionState 进行平滑同步，无需轮询  
        navigator.mediaSession.setPositionState({  
            duration: data.duration\_sec,  
            playbackRate: data.rate,  
            position: data.position\_sec   
        });  
    }  
};

#### **引用的著作**

1. altdesktop/playerctl: mpris media player command-line controller for vlc, mpv, RhythmBox, web browsers, cmus, mpd, spotify and others. \- GitHub, 访问时间为 二月 14, 2026， [https://github.com/altdesktop/playerctl](https://github.com/altdesktop/playerctl)  
2. playerctl — control media players via MPRIS \- Ubuntu Manpage, 访问时间为 二月 14, 2026， [https://manpages.ubuntu.com/manpages/noble/man1/playerctl.1.html](https://manpages.ubuntu.com/manpages/noble/man1/playerctl.1.html)  
3. Metadata in mpris \- Rust \- Docs.rs, 访问时间为 二月 14, 2026， [https://docs.rs/mpris/latest/mpris/struct.Metadata.html](https://docs.rs/mpris/latest/mpris/struct.Metadata.html)  
4. MPRIS v2 metadata guidelines \- Freedesktop.org, 访问时间为 二月 14, 2026， [https://www.freedesktop.org/wiki/Specifications/mpris-spec/metadata/](https://www.freedesktop.org/wiki/Specifications/mpris-spec/metadata/)  
5. Progress in mpris \- Rust \- Docs.rs, 访问时间为 二月 14, 2026， [https://docs.rs/mpris/latest/mpris/struct.Progress.html](https://docs.rs/mpris/latest/mpris/struct.Progress.html)  
6. Player in mpris \- Rust \- Docs.rs, 访问时间为 二月 14, 2026， [https://docs.rs/mpris/latest/mpris/struct.Player.html](https://docs.rs/mpris/latest/mpris/struct.Player.html)  
7. mpris \- Rust \- Docs.rs, 访问时间为 二月 14, 2026， [https://docs.rs/mpris](https://docs.rs/mpris)  
8. Google Chrome extension relative path \- Stack Overflow, 访问时间为 二月 14, 2026， [https://stackoverflow.com/questions/3958617/google-chrome-extension-relative-path](https://stackoverflow.com/questions/3958617/google-chrome-extension-relative-path)  
9. Serving static files in Axum? \- Stack Overflow, 访问时间为 二月 14, 2026， [https://stackoverflow.com/questions/79581666/serving-static-files-in-axum](https://stackoverflow.com/questions/79581666/serving-static-files-in-axum)  
10. axum/examples/static-file-server/src/main.rs at main · tokio-rs/axum \- GitHub, 访问时间为 二月 14, 2026， [https://github.com/tokio-rs/axum/blob/main/examples/static-file-server/src/main.rs](https://github.com/tokio-rs/axum/blob/main/examples/static-file-server/src/main.rs)  
11. Serving Static Files With Axum, 访问时间为 二月 14, 2026， [https://benw.is/posts/serving-static-files-with-axum](https://benw.is/posts/serving-static-files-with-axum)  
12. WebSockets vs Server-Sent-Events vs Long-Polling vs WebRTC vs WebTransport | RxDB \- JavaScript Database, 访问时间为 二月 14, 2026， [https://rxdb.info/articles/websockets-sse-polling-webrtc-webtransport.html](https://rxdb.info/articles/websockets-sse-polling-webrtc-webtransport.html)  
13. Tiny SSE \- A programmable server for Server-Sent Events built on Axum, Tokio, and mlua : r/rust \- Reddit, 访问时间为 二月 14, 2026， [https://www.reddit.com/r/rust/comments/1jjup2a/tiny\_sse\_a\_programmable\_server\_for\_serversent/](https://www.reddit.com/r/rust/comments/1jjup2a/tiny_sse_a_programmable_server_for_serversent/)  
14. SSE vs WebSockets: Comparing Real-Time Communication Protocols \- SoftwareMill, 访问时间为 二月 14, 2026， [https://softwaremill.com/sse-vs-websockets-comparing-real-time-communication-protocols/](https://softwaremill.com/sse-vs-websockets-comparing-real-time-communication-protocols/)  
15. axum/examples/sse/src/main.rs at main · tokio-rs/axum \- GitHub, 访问时间为 二月 14, 2026， [https://github.com/tokio-rs/axum/blob/main/examples/sse/src/main.rs](https://github.com/tokio-rs/axum/blob/main/examples/sse/src/main.rs)  
16. MediaSession: metadata property \- Web APIs | MDN, 访问时间为 二月 14, 2026， [https://developer.mozilla.org/en-US/docs/Web/API/MediaSession/metadata](https://developer.mozilla.org/en-US/docs/Web/API/MediaSession/metadata)  
17. Customize media notifications and handle playlists | Blog \- Chrome for Developers, 访问时间为 二月 14, 2026， [https://developer.chrome.com/blog/media-session](https://developer.chrome.com/blog/media-session)  
18. mediasession/explainer.md at main \- GitHub, 访问时间为 二月 14, 2026， [https://github.com/w3c/mediasession/blob/main/explainer.md](https://github.com/w3c/mediasession/blob/main/explainer.md)  
19. MediaSession: setPositionState() method \- Web APIs | MDN, 访问时间为 二月 14, 2026， [https://developer.mozilla.org/en-US/docs/Web/API/MediaSession/setPositionState](https://developer.mozilla.org/en-US/docs/Web/API/MediaSession/setPositionState)  
20. Customize media notifications and playback controls with the Media Session API | Articles, 访问时间为 二月 14, 2026， [https://web.dev/articles/media-session](https://web.dev/articles/media-session)  
21. Give Users Control: The Media Session API \- CSS-Tricks, 访问时间为 二月 14, 2026， [https://css-tricks.com/give-users-control-the-media-session-api/](https://css-tricks.com/give-users-control-the-media-session-api/)  
22. CORS issue with Version 142 but not in Version 141 \- Chrome Enterprise & Education Community \- Google Help, 访问时间为 二月 14, 2026， [https://support.google.com/chrome/a/thread/384022238/cors-issue-with-version-142-but-not-in-version-141?hl=en](https://support.google.com/chrome/a/thread/384022238/cors-issue-with-version-142-but-not-in-version-141?hl=en)  
23. Private Network Access: introducing preflights | Blog \- Chrome for Developers, 访问时间为 二月 14, 2026， [https://developer.chrome.com/blog/private-network-access-preflight](https://developer.chrome.com/blog/private-network-access-preflight)  
24. Private Network Access: Extended protection for web workers and navigation fetches | Blog, 访问时间为 二月 14, 2026， [https://developer.chrome.com/blog/private-network-access-update-2024-03](https://developer.chrome.com/blog/private-network-access-update-2024-03)  
25. Bypassing CORS with a Google Chrome extension | by Jonelle Noelani Yacapin \- Medium, 访问时间为 二月 14, 2026， [https://medium.com/geekculture/bypassing-cors-with-a-google-chrome-extension-7f95fd953612](https://medium.com/geekculture/bypassing-cors-with-a-google-chrome-extension-7f95fd953612)  
26. How to solve No 'Access-Control-Allow-Private-Network' | by Telephant | Medium, 访问时间为 二月 14, 2026， [https://medium.com/@telephant11/how-to-solve-no-access-control-allow-private-network-23dd56310355](https://medium.com/@telephant11/how-to-solve-no-access-control-allow-private-network-23dd56310355)  
27. Persistent Service Worker in Chrome Extension \- Stack Overflow, 访问时间为 二月 14, 2026， [https://stackoverflow.com/questions/66618136/persistent-service-worker-in-chrome-extension](https://stackoverflow.com/questions/66618136/persistent-service-worker-in-chrome-extension)  
28. developer.chrome.com/site/en/docs/extensions/migrating/to-service-workers/index.md at main · GoogleChrome/developer.chrome.com · GitHub, 访问时间为 二月 14, 2026， [https://github.com/GoogleChrome/developer.chrome.com/blob/main/site/en/docs/extensions/migrating/to-service-workers/index.md](https://github.com/GoogleChrome/developer.chrome.com/blob/main/site/en/docs/extensions/migrating/to-service-workers/index.md)  
29. chrome.offscreen | API \- Chrome for Developers, 访问时间为 二月 14, 2026， [https://developer.chrome.com/docs/extensions/reference/api/offscreen](https://developer.chrome.com/docs/extensions/reference/api/offscreen)  
30. How to Create Offscreen Documents in Chrome Extensions: A Complete Guide, 访问时间为 二月 14, 2026， [https://dev.to/notearthian/how-to-create-offscreen-documents-in-chrome-extensions-a-complete-guide-3ke2](https://dev.to/notearthian/how-to-create-offscreen-documents-in-chrome-extensions-a-complete-guide-3ke2)  
31. Offscreen Documents in Manifest V3 | Blog \- Chrome for Developers, 访问时间为 二月 14, 2026， [https://developer.chrome.com/blog/Offscreen-Documents-in-Manifest-v3](https://developer.chrome.com/blog/Offscreen-Documents-in-Manifest-v3)  
32. penguin.linux.test links \-- err connection \- Chromebook Community \- Google Help, 访问时间为 二月 14, 2026， [https://support.google.com/chromebook/thread/35641335/penguin-linux-test-links-err-connection?hl=en](https://support.google.com/chromebook/thread/35641335/penguin-linux-test-links-err-connection?hl=en)  
33. Accessing crostini-hosted network services from chrome \- Reddit, 访问时间为 二月 14, 2026， [https://www.reddit.com/r/Crostini/comments/c6v9xu/accessing\_crostinihosted\_network\_services\_from/](https://www.reddit.com/r/Crostini/comments/c6v9xu/accessing_crostinihosted_network_services_from/)  
34. penguin.linux.test not secure in browser \- Crostini \- Reddit, 访问时间为 二月 14, 2026， [https://www.reddit.com/r/Crostini/comments/l0lerl/penguinlinuxtest\_not\_secure\_in\_browser/](https://www.reddit.com/r/Crostini/comments/l0lerl/penguinlinuxtest_not_secure_in_browser/)  
35. Subdomains for penguin.linux.test \- Crostini \- Reddit, 访问时间为 二月 14, 2026， [https://www.reddit.com/r/Crostini/comments/dcwlr0/subdomains\_for\_penguinlinuxtest/](https://www.reddit.com/r/Crostini/comments/dcwlr0/subdomains_for_penguinlinuxtest/)

[image1]: <data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACUAAAAaCAYAAAAwspV7AAACGElEQVR4Xu2WT0gVURjFT2RR9g8kQwz6A0ERLUJw10JJFJGENrZoIxS4yF20aFvQpqgEiaJVOwWDEMUoCGwnYmQQ1EKFFlEQFoILi6jz8c3YfWfujE/ygYv3gwMz59z7Xe7MfPc9oEqVzU8PdUDNCOfVqBTt1Ay1U4MIrdReNWN0UC8LNERdXB2d5RN1TM0CrOY2NfO4Tr1Wk9RQP6g/GpA71G41E2wjsTmX4PXKed0Yo26qmfAR2QVqqUXxQh4gO8ewTS7A80K2Ut/h71yxxX8iu0BfxAt5g/zcnvAKtUODkGZ4gdgg6xjLfos/ivwn1QCfYw0Qw7rV8jYNQp4hu6vt1HP4wr2lEerg4wfET3kCz7s0CPhFPVUzZQv1DV5EZR//wX9DVzkOz29okLAAz/OawPhMvVIzJX11+qSKOAMff1UDcgieTWsgvKdm1Uy5hvKKhJyFz+nXgFyAZ/c0EOx7+6CmYe25DC/SLVkRR+BzbotvvINn+5N7O5fsE1GW4AdphhZ4AeusXaVRIXvg8x5rAPengvsXwXWKNZGNe6iBnU1pl8xTR0vjNZmjJtWE1xtJrk9RJ4Is5TR8XG9o1sOfjgWh1sNd+AGoPKK+UPfhR0qMK/D1Y539X9i/g7yN7KNOqhkwnKginKMOq7kGt6i3am40E4h3Vx5fqSY1N5px+MlfDvbj3qlmJbCjZJBq1CDCZTWqrJe/heJ3vbWUnRQAAAAASUVORK5CYII=>

[image2]: <data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAA8AAAAaCAYAAABozQZiAAAA4ElEQVR4Xu2SvQ4BQRSFb4jQqcRPpxCJoFYRofEOFIgIb6D3CGolnQcQEolOolVqvYGWM+4Os5eN20p8yZfsnJmT3blZoj8/yhWeZKjlBhcy1GLKIxlqMeWcDDXU4FyGWiZwIEMtK1iUIUjDHvEsUmLvyUUGHkdYhwW4gw3fLugTD8vSotdbhk5eIf+5B2ZQNkwS/yhxmIAdewiU6EN56YUxuCG+oyEL2/YQ8ae/lZvwDLfkn3iGFGVDCEZEFoVdZ12mgHIQM+fZDHbtrL+yh1M4hgfioakJwzysEl/j17kDdGAjAjn2/j0AAAAASUVORK5CYII=>

[image3]: <data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABQAAAAaCAYAAAC3g3x9AAABFklEQVR4XmNgGAUjDzgB8W48eA0QpwExI0wDsaAIiM+hCzJADLoDxP/RJQiBtUDcjy4IBUcYyDDwORB7ogsCARMQv2Yg0UAdBogGAXQJILBlgMiRZOByBkwNrEC8Hoi/MkDCF+RSosELBoQrkHE9ECshqSMK6DEQ76VYIM4HYk10CWSQxwAx7Bq6BBoQB+JgIJYD4hVAXIkqDQGgNPaBAWJgOJocOniCxAbp+43EhwNrBoR3scUwDIDk0IPkDRqfgRmI5zJAFD4DYmVUaRQgw4Bp4EtkjggQ/2XAjFWQJdiAMAMBA0kFoDQIcgAyeI/GJxlUI7F1gfgzEp8sAMo5k4E4DoiPA3EYqjR5AJRr7IFYEF1ihAEA8VE+pBpnV/4AAAAASUVORK5CYII=>

[image4]: <data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAA8AAAAaCAYAAABozQZiAAABBklEQVR4XmNgGAUDB9KAeDcOvAuIu4DYGq4aB9gMxP+BuAxNnBGIrwFxPJo4HDAB8XsGiGZLNDkQALlgDbogDOgxQDR+AmIWNDkQeAzEM9AFYSCdAaJ5O7oEELgxQOQU0SVg4AEDRMF0IPYG4lwgngfEr4F4PhDLwlWiAZAESON3IK6F4qVQsSVAzIxQigliGCAKQVGDDOZCxZvRxFHATAaIokY08VCo+DE0cRQAUvALiLnRxFdB5bAFIhyAFBxCFwSCFwwIf4OAOxCzwiRB8WkIVQCyhR8mAQXXoXKLofzLMAkNqAQ67oUpAAIrBkhUPQPiJCAOQJIjCoDCwROIq9AlRgE9AAC93D75IghPXQAAAABJRU5ErkJggg==>

[image5]: <data:image/png;base64,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>