# StockDesk

A 股桌面盯盘与量化研究工具，基于 Electron。

> 本项目为个人练习项目，不稳定且不定时更新。
> 本项目是研究与信息整理工具，不构成投资建议。行情、资讯、搜索结果与模型输出均可能延迟、缺失或错误。

---

## 功能

### 行情与盯盘

- 自选股分组管理，实时行情列表，可为个股设置买入 / 卖出目标价
- 日 K / 周 K / 月 K（前复权）与分时图
- 可拖动分隔条调整布局，比例本机保存，双击复位
- 图表支持滚轮缩放与拖动平移，技术副图与主图时间范围联动
- 刷新间隔 2–60 秒可选，毛玻璃透明度可调
- 关闭按钮可最小化到托盘；窗口隐藏时暂停界面刷新，后台监控继续运行

### 量化信号

右侧「信号」面板分为几层：

- **市场状态**：指数合成强度、市场风险、多空家数
- **基础因子综合方向**：偏多 / 中性 / 偏空，多空阈值统一为 ±25
- **短 / 中 / 长期趋势**：分别按 5–10、20–60、60–120 交易日独立计算
- **基础因子族**：趋势 / 动量 / 量价 / 情绪 / 波动 / 支撑压力 / 成本
- **22 类扩展指标**：按因子族聚合后的方向分与过热波动风险
- **历史信号验证**：历史上出现相似信号后 1 / 5 / 20 日的胜率与平均收益
- **当前事件**与**分时择时**（按分钟增量成交量计算的 VWAP 关系）

长中短期趋势只描述当前形态，不预测未来涨跌。历史匹配样本不足时显示「样本不足/待验证」，不输出不可靠的胜率。

### 技术指标

支持 22 类参数化指标：

```
MACD  DMI  DMA  FSL  TRIX  BRAR  CR  VR  OBV  ASI  EMV
VOL-TDX  RSI  WR  SAR  KDJ  CCI  ROC  MIKE  BOLL  PSY  MCST
```

- 每类指标有独立超参数，可持久化
- 支持 1 / 2 / 3 屏副图
- 分为 7 个因子族，族内先聚合再参与综合评分，避免同源指标重复计票
- 修改参数会同时影响副图、扩展指标评分、综合研报与发送给 LLM 的技术证据

### 选股

按行业板块筛选全市场成分股，支持三种口径：

| 口径 | 计算方式 |
| --- | --- |
| 技术 | 技术因子综合评分 |
| 价值 | 估值 / 基本面评分 |
| 混合 | 技术 ×0.6 + 价值 ×0.4（默认） |

支持行业搜索、结果二次搜索、每页 10/20/50/100 条分页，最大结果留空或填 0 表示返回全部（单行业上限 500）。切换面板后再返回会保留筛选条件与分页位置。

### 策略实验室

内置四类规则：

| 预设 | 思路 |
| --- | --- |
| 趋势突破 | 趋势已形成，接近/突破 20 日高点且量能确认时介入 |
| 趋势回踩 | 保持中期多头，价格回到 MA20 附近且风险不过热时介入 |
| 动量强化 | 偏重 20/60 日动量与量价共振，容忍更高波动 |
| 稳健趋势 | 提高趋势门槛、压低允许风险，信号更少，偏向控制回撤 |

默认使用智能推荐：依据历史信号分布、近期 ATR、风险分布与市场状态构造自适应参数，在历史前段选参、中段验证，把最后约 20% 历史作为独立保留检验，并做 27 组邻近参数扫描评估邻域稳健性，最后输出稳健 / 均衡 / 积极三档建议。

回测按次日开盘成交，计入手续费与滑点；指标含收益、超额收益、最大回撤、胜率、Sharpe、盈亏比、分段验证与交易明细。

当样本过少、保留段交易不足、明显跑输买入持有或参数邻域脆弱时，推荐器会降级为「样本不足 / 当前不优先」。手动高级模式保留全部原始参数。

### 策略监控

可将当前策略快照加入后台监控：

```
观察中 → 接近买点 → 待分时确认 → 正式买点
                                    ↓
                             模拟/实际持仓
                                    ↓
                        风险预警 → 退出触发
```

- 入场完成度默认 80% 时提醒「接近买点」，正式买点可要求分时 VWAP 确认
- 持仓监控固定止损、移动止损、止盈、最长持有期、因子转弱与风险阈值
- 提醒中心汇总全部监控标的与最近提醒，通知带去重与冷却（5–120 分钟可选）
- 默认只在 A 股常规交易时段弹系统通知；监控间隔独立于行情刷新间隔

监控只发提醒，不会自动下单。

### 研报

研报整合技术因子与 22 类扩展指标、历史信号验证、策略回测、关联报价、资金流向、综合资讯、板块资讯、法定披露公告、基本面与全球关联环境。

- 公告按股票代码精确采集，分为「公司治理/经营事项」与「财报业绩」两组
- 每个指标附带最近 12 期轨迹、5/20 期变化、斜率、60 期分位与近期交叉，供模型分析曲线变化
- 支持 OpenAI、DeepSeek、Anthropic Claude、Google Gemini 及任何 OpenAI-compatible 服务
- 研报存档在 `~/.stockdesk/ai-reports/`，可导出 Word `.docx` 与 PDF
- LLM 原始响应与输入快照保存在程序目录的 `llm_raw_outputs/`，不含 API Key

### 自主外部研究 Agent

启用后由模型多轮决策，而非预设固定搜索词：

```
本地结构化数据 → LLM 判断信息缺口 → 自主制定查询与来源偏好
→ 程序执行搜索与安全读取网页 → LLM 评估新增证据
→ 决定继续、换方向或停止 → 最终研报
```

三档预算（上限而非目标，模型可提前停止）：

| 档位 | 轮数 | 查询 | 网页 |
| --- | --- | --- | --- |
| 快速 · 盘中 | ~2 | 4 | 4 |
| 标准 · 推荐 | ~3 | 10 | 12 |
| 深度 · 收盘后 | ~5 | 20 | 28 |

网页来源标记 A–E 类型先验（A 为一手/官方，E 为聚合/百科/社区），该等级只提示来源类型，不代表内容真实。搜索结果与网页正文按不可信数据处理，URL 与重定向执行 SSRF 与私网地址防护。

### 数据源管理

内置八个数据源：腾讯行情、东方财富、新浪行情、交易所/巨潮（权威辅助）、通达信/pytdx、Tushare Pro、Baostock、AKShare 聚合适配。后四个默认关闭，需自行安装依赖或配置凭据。

行情统一经过 Provider Hub 调度：

- 三种调度方式：自适应轮换（默认）/ 严格轮换 / 按优先级
- 每个数据源有源级与能力级两层最小访问间隔
- 遇到 403 / 412 / 418 / 429 或典型 WAF 响应自动熔断冷却，状态持久化到 `~/.stockdesk/provider-health.json`
- 支持请求合并与多档缓存策略

该机制用于尊重访问限制、降低单源负载与故障回退，不尝试绕过任何 WAF。

也支持自定义 REST 数据源，可映射 `quote / kline / minute`，支持 GET/POST、字段映射、批量报价与 `{secret}` 密钥占位。密钥使用 Electron `safeStorage` 单独保存，不写入普通设置文件。

### 可选本地 AI

本地 AI 是策略实验室的可选增强模块，默认关闭且未安装，主程序不依赖 Python。

显式点击安装后，程序在 `~/.stockdesk/ai-engine/` 下创建独立 venv 并从上游官方仓库下载模型：

| 模型 | 定位 |
| --- | --- |
| Kronos-mini / small / base | 金融 K 线基础模型 |
| MASTER CSI300 / CSI800 | 横截面排序 |
| Qlib TRA | 市场模式路由，需自行训练 |
| River | 盘中在线概率校准与漂移检测 |

AI 运行在影子模式，只记录和展示结果，不影响正式策略监控。安装前会显示 CPU、内存、GPU/显存、Python 版本与磁盘空间并给出硬件推荐。

---

## 环境要求

Windows 10/11，Node.js 20+（推荐 22+）

## 安装与运行

```powershell
npm install --include=dev
npm start
```

也可以双击 `install.bat` 安装依赖并创建桌面快捷方式，之后双击 `start.bat` 启动。

国内网络下载 Electron 较慢时：

```powershell
npm config set registry https://registry.npmmirror.com
$env:ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"
npm install --include=dev
```

## 打包

双击 `build-installer.bat`，会先执行发布门禁再打包 NSIS 与 portable 版本到 `build/dist/`。

```powershell
npm run dist
```

## 测试

```powershell
npm run test:release        # 发布门禁：语法 + 结构 + 16 项离线检查
npm run check               # 离线核心检查
npm run test:regression     # 回归
npm run test:security       # 安全
npm run test:llm            # LLM 适配层（mock）
npm run test:ui             # UI / IPC 契约
npm run test:screener       # 选股
npm run test:monitor        # 策略监控
npm run test:global         # 全球关联上下文
npm run test:research-agent
npm run test:local-ai
npm run test:data-sources
npm run test:performance    # 性能冒烟
```

需要真实公网访问的测试单独执行；环境 DNS 受限时会返回 `BLOCKED_BY_ENV`，不会记为通过。

```powershell
npm run test:network
npm run test:market-coverage
```

## 目录结构

```
StockDesk_v1.9.3_source/
├─ main.js                     主进程，50 个 IPC 通道
├─ preload.js                  contextBridge 白名单暴露面
├─ engine/
│  ├─ data-provider-hub.js     多数据源调度：限速 / 轮换 / 熔断 / 合并 / 缓存
│  ├─ indicators.js            基础因子与信号判定
│  ├─ technical-indicators.js  22 类参数化指标与因子族聚合
│  ├─ signal-service.js        信号统一计算入口与缓存
│  ├─ trend-horizons.js        短 / 中 / 长期趋势独立计算
│  ├─ strategy-lab.js          策略回测与智能推荐
│  ├─ strategy-monitor.js      后台监控与提醒状态机
│  ├─ screener.js              行业选股
│  ├─ research-report.js       结构化规则报告
│  ├─ report-export.js         Word / PDF 导出（手写 OOXML）
│  ├─ llm-service.js           多厂商 LLM 适配
│  ├─ research-agent.js        自主外部研究 Agent
│  ├─ web-research.js          搜索、安全读取网页、来源分级
│  ├─ company-search.js        企业公告与公司新闻检索
│  ├─ market-fetchers.js       东财 F10、龙虎榜、研报、分红、资金流
│  ├─ global-context.js        海外指数 / 商品 / 汇率上下文
│  ├─ local-ai.js              可选本地 AI：硬件探测与模型注册
│  ├─ sectors.js  market.js
│  └─ data/a_stocks.json       离线股票名录
├─ renderer/                   渲染层，原生 JS
│  ├─ index.html  app.js  chart.js  indicator-chart.js
│  ├─ layout.js  styles.css  assets/icon.png
├─ python-ai/                  可选本地 AI sidecar
├─ scripts/                    自检与冒烟脚本
├─ start.bat  install.bat  check.bat  build-installer.bat
├─ LICENSE  THIRD_PARTY_NOTICES.md  README.md  RELEASE_NOTES_v1.9.3.md
```

## 运行时数据

程序状态保存在用户主目录，不写入安装目录：

```
~/.stockdesk/
├─ provider-health.json     数据源健康与熔断状态
├─ strategy-monitors.json   监控配置
├─ monitor-alerts.json      提醒历史
├─ ai-reports/              AI 研报存档
└─ ai-engine/               可选本地 AI 的 venv 与模型
```

## 安全

- API Key 使用 Electron `safeStorage` 加密，不写入普通设置文件；安全存储不可用时只保留在本次运行内存中
- 渲染进程受 CSP 约束（`default-src 'self'`、`script-src 'self'`，无 `unsafe-eval`）
- 渲染层通过 `preload.js` 的白名单 API 访问主进程，无 Node 权限
- 外部研究读取网页前校验 URL 与重定向目标，拦截私网地址

## 第三方组件

本仓库不包含第三方项目的移植代码。可选的本地 AI 模型（Kronos、MASTER、Qlib、river）不随仓库分发，需用户显式安装后从上游官方仓库获取。完整组件清单、许可证原文与数据来源说明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

## 许可证

[MIT License](LICENSE)
