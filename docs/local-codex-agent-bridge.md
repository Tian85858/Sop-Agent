# 本地 Codex Agent 缓存处理桥接

> 用途：当用户在本机打开 `http://localhost:8080` 并登录后，页面会把待结构化缓存同步到本机运行目录。用户随后在 Codex 对话中发指令，Codex 可以读取这些缓存并批量结构化回写到 Supabase。

## 工作方式

```text
本机页面 localhost:8080
  → 用户登录 Supabase
  → 页面读取 inbox_events 待处理记录
  → POST /agent/context 同步到本机 .agent-runtime/context.json
  → 用户在 Codex 中发出“处理缓存”指令
  → Codex 运行 tools/sop-agent-pull-cache.mjs 拉取最新 pending 数据
  → Codex 根据个人 SOP 规则生成 .agent-runtime/structured-output.json
  → Codex 运行 tools/sop-agent-apply-cache.mjs 回写 inbox_events
```

## 重要边界

- 这个桥接只在本机 `localhost` 生效。
- GitHub Pages 或手机远程页面不会把登录 token 同步给本机。
- `.agent-runtime/` 存放本地临时上下文，已加入 `.gitignore`，不要上传。
- 当前第一阶段先处理 `inbox_events`：结构化、归类、标记处理状态、记录去向。
- 真正写入各模块专属表，如 `tasks`、`items`、`health_logs`，需要等模块输入规则和字段定义逐步明确后再开启。

## 用户侧操作

1. 重启本地服务，让新的 `/agent/context` 端点生效。
2. 打开 `http://localhost:8080`。
3. 登录 Supabase。
4. 进入页面或缓存记录页，等待页面自动同步。
5. 在 Codex 中说：“把缓存待结构化内容全部处理掉”。

## Codex 处理命令

拉取待处理缓存：

```powershell
node .\tools\sop-agent-pull-cache.mjs
```

读取：

```text
.agent-runtime/pending-cache.json
```

生成结构化结果：

```text
.agent-runtime/structured-output.json
```

回写：

```powershell
node .\tools\sop-agent-apply-cache.mjs
```

## structured-output.json 格式

```json
{
  "processed": [
    {
      "id": "inbox_events.id",
      "module_guess": "tasks",
      "related_modules": ["tasks"],
      "status": "processed",
      "structured_json": {
        "module_key": "tasks",
        "event_type": "task",
        "summary": "结构化摘要",
        "facts": {},
        "tasks": [],
        "risks": [],
        "questions": [],
        "confidence": 0.8
      },
      "destination_log": [
        {
          "module": "tasks",
          "status": "structured_only",
          "note": "已结构化，等待模块表写入规则确认"
        }
      ]
    }
  ]
}
```

## 当前自动化行为

- 页面加载登录状态后，会先判断本机 `/agent/context` 是否可访问。
- 如果可访问，则视为已接入本地 Agent 桥接。
- 首页输入按钮统一显示为“↗ 提交”。
- 已接入 Agent 时，提交后会自动同步缓存并调用 `/agent/process` 做第一阶段结构化。
- 未接入 Agent 时，仍然可以提交，但页面显示“未接入Agent 暂计入缓存记录”。
- 快捷键：`Enter` 提交，`Shift + Enter` 在输入框内换行。

## 当前能力边界

当前 `/agent/process` 是本地第一阶段结构化 Agent：可做模块预判、事件类型判断、日期/数量提取、任务/风险初步识别，并回写 `inbox_events`。它不是云端大模型服务，也不是永久后台运行的 Codex 对话。若要在任何设备上都自动获得更强模型判断，需要后续接入 OpenAI / DeepSeek API 或 Supabase Edge Function。

## 模块表直写规则

本地 Agent 自动处理缓存时，不再只停留在 `inbox_events` 标记结构化；它需要把一句话拆成多个意图，并直接写入对应模块表。

示例：

```text
我买了一盒面膜，准备今晚试用一片
```

应拆成：

1. 物品库存：新增 `面膜`，数量 `1`，单位 `盒`，写入 `items` + `inventory_batches`。
2. 个人任务：新增任务 `试用面膜`，截止日期为今天，写入 `tasks`。

当前已开启直写：

- `inventory_add` → `items` + `inventory_batches`
- `task_create` → `tasks`
- `health_log` → `health_logs`

同时仍会更新原始 `inbox_events`：保存原文、拆分意图、结构化结果、写入去向和处理状态。


## 多意图拆解与模块表直写链路

用户在首页输入的内容可能不是单一事件，而是一句话中同时包含多个意图。Agent 不能只做单一分类，也不能只把整句话塞进缓存记录；必须先拆解，再分别写入对应模块表。

### 处理链路

```text
首页自然语言输入
  → 保留原文到 inbox_events
  → Agent 识别一句话中的多个意图
  → 每个意图生成独立结构化对象
  → 分别写入对应模块表
  → 回写 inbox_events 的 structured_json、destination_log、apply_result
  → 前端刷新后在对应模块页展示
```

### 拆解原则

- 一句话可以拆成多条记录。
- 每条记录必须有明确模块归属。
- 原始表达必须保留，不得被结构化结果覆盖。
- 如果一句话同时包含库存、任务、健康、财务等信息，需要分别落到对应模块表。
- 如果某个意图无法确定字段，先写入 `inbox_events` 的结构化结果，并标记需要复核。

### 示例

用户输入：

```text
我买了一盒面膜，准备今晚试用一片
```

Agent 应拆成：

1. 物品库存意图
   - 类型：`inventory_add`
   - 表：`items` + `inventory_batches`
   - 结果：新增或匹配 `面膜`，数量 `1`，单位 `盒`
2. 个人任务意图
   - 类型：`task_create`
   - 表：`tasks`
   - 结果：新增任务 `试用面膜`，截止日期为今天 / 今晚，优先级默认 `P1` 或 `P2` 按语义判断

同时 `inbox_events` 需要保留：

- `raw_text`：用户原文
- `structured_json.intents`：拆出的意图数组
- `structured_json.applied_records`：实际写入的表、记录 ID 和模块
- `structured_json.destination_log`：去向日志
- `status = processed`

### 当前已开启的直写映射

| 意图类型 | 目标模块 | 写入表 | 展示位置 |
|---|---|---|---|
| `inventory_add` | 物品库存 | `items` + `inventory_batches` | 物品库存模块页货架 |
| `task_create` | 个人任务 | `tasks` | 个人任务模块页、首页今日核心事 |
| `health_log` | 健康管理 | `health_logs` | 健康管理模块页 |

后续模块输入规则完善后，再逐步开启：

- `finance_record` → `finance_records`
- `learning_record` / `knowledge_card` → `reading_records` / `knowledge_cards`
- `relationship_record` → `relationships`
- `decision_record` → `decisions`
- `review_record` → `reviews`
- `life_sop_record` → `life_sops`

### 模块页展示要求

- 写入模块表后，页面必须能在对应模块页展示出来。
- 首页只展示低压的核心信息，不把所有拆解结果堆在首页。
- 首页 Personal SOP 九个模块卡片只展示“亟待关注事项”摘要，不展示模块内完整任务、记录或明细列表，避免卡片被任务项撑高。
- 模块页负责展示该模块的结构化数据。
- 缓存记录负责追踪原文、结构化结果、去向和处理状态。

### 首页九模块摘要口径

| 模块 | 摘要生成规则 |
|---|---|
| 个人任务 | 从 `tasks.due_date` 提取今日 deadline 数量，显示 `今天有 x 个任务 deadline`。 |
| 健康管理 | 从体检数据和健康记录中提取长期关注或异常指标，并转成用户可理解提醒；例如 `尿蛋白+` → `注意尿路感染、运动后波动或肾脏压力，建议复查尿常规`。 |
| 学习系统 | 从学习记录、课程进度、阅读记录中提取学习中断 days 或进度 delay。 |
| 生活 SOP | 从个人日程、流程清单、价格关注中提取最近亟待事项，例如旅行倒计时或商品接近心理预期价。 |
| 物品库存 | 从库存品类和批次中提取；有快过期物品优先显示过期倒计时，无快过期则显示库存品类数。 |
| 财务管理 | 从月度预算和财务记录中提取预实对比，优先使用进度条和百分比展示预算使用、超期或结余。 |
| 关系维护 | 从关系档案、纪念日、宠物信息和边界记录中提取生日倒计时、宠物疫苗、人际维护等提醒。 |
| 复盘系统 | 从周度/月度复盘中抽离关键词和风险提示，例如高压、减负、拖延、睡眠不足。 |
| 决策记录 | 从决策台账中提取复盘、演习、预演和近期最要执行的注意事项。 |

### 跨模块联动与派生任务

- Agent 写入模块表后，需要判断该记录是否会触发其他模块的任务、风险或提醒。
- 物品库存、健康管理、关系维护、财务管理、学习系统、生活 SOP、复盘系统和决策记录都可以派生个人任务。
- 示例：补剂剩余量约 5 天时，物品库存显示库存风险，个人任务新增“购买 xxx 补剂”。
- 示例：体检指标异常时，健康管理记录异常，个人任务新增“预约复查 / 调整补剂 / 观察症状”等下一步。
- 派生任务必须保留来源模块、来源记录、触发原因和处理状态，避免后续无法追溯。

## 外包装与内含数量规则

当用户描述库存时，如果同时出现“外包装数量”和“内含数量”，库存应优先记录可消耗的内含单位。

示例：

```text
买了一包手纸，大概有80小包吧里面，然后今晚准备给同事两小包，再拿出一包放车里
```

应拆成：

1. 物品库存：`手纸 +80 小包`，写入 `items` + `inventory_batches`。
2. 个人任务：`给同事两小包手纸`，截止今天 / 今晚。
3. 个人任务：`拿手纸放车里`，截止今天 / 今晚。

注意：

- “一包手纸”是外包装，不应覆盖“80小包”的库存数量。
- “准备给同事两小包”“拿出一包放车里”是计划动作，默认先生成任务，不自动扣减库存。
- 只有用户明确说“已经给了 / 已经拿走 / 已经用掉”，才应生成库存扣减或消耗记录。
