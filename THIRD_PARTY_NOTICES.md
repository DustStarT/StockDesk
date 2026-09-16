# 第三方组件与致谢 / Third-Party Notices

StockDesk 自身以 **MIT License** 发布，见 [`LICENSE`](LICENSE)。本文件说明所使用的外部组件、其许可证与使用方式。

---

## 1. 可选下载的本地 AI 模型（**不随本仓库分发**）

「策略实验室 → 本地 AI 增强」中的模型**默认未安装**。只有用户显式点击安装后，程序才会在 `~/.stockdesk/ai-engine/` 下创建独立 Python venv，并通过 `pip` 与官方仓库**直接从上游**获取以下依赖与权重。本仓库不包含、也不分发其中任何代码或权重文件。

| 组件 | 用途 | 许可证 | 上游 |
|:--|:--|:--|:--|
| [Kronos](https://github.com/shiyu-coder/Kronos)（`NeoQuasar/Kronos-mini` / `-small` / `-base`） | 金融 K 线基础模型，影子预测 | MIT | GitHub / Hugging Face |
| [MASTER](https://github.com/SJTU-DMTai/MASTER) | AAAI 2024，A 股横截面排序 | MIT | GitHub |
| [Qlib](https://github.com/microsoft/qlib)（TRA） | 市场模式路由，需自行训练 | MIT | GitHub |
| [river](https://github.com/online-ml/river) | 在线学习，盘中概率校准与漂移检测 | **BSD-3-Clause** | GitHub / PyPI |

其余随 venv 安装的通用依赖（`torch` / `numpy` / `pandas` / `einops` / `safetensors` / `huggingface_hub` / `tqdm` / `psutil`）按其各自许可证使用。

```
BSD 3-Clause License (river)

Copyright (c) 2020, the river developers
All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice,
   this list of conditions and the following disclaimer.
2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.
3. Neither the name of the copyright holder nor the names of its contributors
   may be used to endorse or promote products derived from this software
   without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE
LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR
CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF
SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS
INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN
CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
POSSIBILITY OF SUCH DAMAGE.
```

> ⚠️ 许可证以上游仓库**当前**声明为准。上游可能变更许可证，安装前请自行复核；本仓库不对上游许可证的持续有效性作担保。

---

## 2. 构建与运行依赖（npm）

本程序**运行时零 npm 依赖** —— 业务代码只使用 Node.js 内置模块，`dependencies` 为空。以下仅用于开发与打包：

| 包 | 用途 | 许可证 |
|:--|:--|:--|
| [electron](https://github.com/electron/electron) | 桌面运行时 | MIT |
| [electron-builder](https://github.com/electron-userland/electron-builder) | 打包 NSIS / portable | MIT |

---

## 3. 数据来源（公开 HTTP 接口，非开源软件）

行情、资讯、公告等数据来自公开可访问的第三方接口。**StockDesk 与这些服务商无任何关联、合作或授权关系**，仅以用户本机身份发起普通 HTTP 请求。

**内置数据源**：腾讯行情、东方财富、新浪行情、交易所 / 巨潮资讯（权威辅助）

**可选、默认关闭**（需自行安装依赖或配置凭据）：通达信 / pytdx、Tushare Pro、Baostock、AKShare 聚合适配，以及用户自定义的 REST Provider

**外部研究检索**：必应（主）、百度（兜底）

### 使用约束

StockDesk 通过 Provider Hub 对每个数据源实施**全局节流、能力级节流与熔断退避**：遇到 403 / 412 / 418 / 429 或典型 WAF 响应会立即进入冷却，冷却状态持久化到 `~/.stockdesk/provider-health.json`，重启后不会把刚被限流的源当作健康源立即重试。

该机制用于**尊重访问限制、降低单源负载与故障回退**，**不尝试绕过任何 WAF 或访问控制**。请遵守各服务商的服务条款并自行控制请求频率。数据可能存在延迟、缺失或错误，**不保证准确性，不构成投资建议**。

---

## 4. 上游方法论参考（无代码依赖）

以下项目为设计思路提供过参考，本仓库**不含**其任何代码：

- [anthropics/financial-services-plugins](https://github.com/anthropics/financial-services-plugins) — 机构级分析方法论
- [akshare](https://github.com/akfamily/akshare) — A 股数据引擎（本项目的 AKShare 适配器在运行时调用其 Python 包）

---

<div align="center">

如果这份清单有遗漏或标注错误，欢迎提 Issue 或 PR 纠正。

</div>
