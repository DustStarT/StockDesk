# StockDesk Local AI Sidecar (v1.9 experimental)

这是可选组件。StockDesk 主程序不依赖 Python/PyTorch；只有用户在“策略实验室 → 本地AI增强”明确点击安装后，才会在 `~/.stockdesk/ai-engine/` 创建隔离 venv 并下载模型。

v1.9 真正可运行的第一条链路是 **Kronos → 影子预测 → River 在线校准**。MASTER 的公开 A 股 checkpoint 已进入模型注册/安装体系，但由于它要求完整的横截面 222 维特征和股票池，v1.9 不会拿它对单只股票伪造实时分数。TRA 同理暂列高级实验项，需要后续在 StockDesk Feature Store 上训练。
