# Web 前端计划

这里用于放未来真正多端同步的 Web/PWA 前端。

当前已有本地静态前台：

```text
D:\project\life\apps\life-rpg\个人SOP Agent.html
```

下一步会把它升级为连接 Supabase 的前端应用。

## 需要的 Supabase 信息

请从 Supabase 后台复制：

```text
Project URL
anon public key
```

不要提供 `service_role key`。

## 第一版前端能力

- 登录 / 退出
- 一句话记录 → `inbox_events`
- 库存货架 → `items` + `inventory_batches`
- 任务池 → `tasks`
- 健康指标 → `health_metrics`
- 学习/知识 → `reading_records` + `knowledge_cards`
- 周复盘 → `reviews`
