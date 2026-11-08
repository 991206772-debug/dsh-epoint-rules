# 设计文档 Markdown 模板 (entity-first)

以下为 `设计文档.md` 的输出结构（由 Builder 在 Step 7 渲染落盘，LLM 不直接写）。`{{...}}` 为占位符，输出时替换为实际内容。

> 大章节结构：1 Actor / 2 业务对象关系树 / 3 功能模块设计 / 4 数据库设计 / 5 配置设计 / 6 需求规则池快照。设计阶段不输出实体-规则矩阵。

---

# {{需求名称}} — 设计文档

> 分析日期：{{yyyy-MM-dd}}
> 业务对象数：{{entity 总数}}
> 需求阶段确认规则数：{{confirmedRules 数}}

---

## 1. Actor 列表

| Actor | 类型 | 来源业务对象 |
|---|---|---|
| {{Actor 名称}} | 主要/次要 | {{entityKey/displayName}} |

---

## 2. 业务对象关系树

```text
└─ {{业务域 / 功能域名称}}
   ├─ [业务对象] {{entityKey}} {{displayName}}（新建表 / 复用表 / 无本地持久化）
   └─ [子对象] {{childEntityKey}} {{childDisplayName}}（承载于 {{parentEntityKey}}）
```

---

## 3. 功能模块设计（按 entityKey 分块）

### {{entityKey}} {{displayName}}

- **业务对象**：{{businessObject}}
- **聚合根**：{{aggregateRoot}}
- **业务模块（bizModule）**：{{bizModule}}
- **包路径业务大类（domain）**：{{domain}}
- **实体类（entityName）**：{{entityName}}
- **关联 Story**：{{US1, US2, ...}}
- **关联表**：{{new/reuse/none + tableName/tableComment/reuseSource}}

**User Stories**

> [{{US1}}] {{userStory}}

**验收标准**

| 类型 | 来源 Story | 场景 | Given | When | Then |
|---|---|---|---|---|---|
| Happy Path | {{sourceStoryId}} | {{场景名}} | {{前置条件}} | {{触发动作}} | {{期望结果}} |
| 异常 | {{sourceStoryId}} | {{场景名}} | {{前置条件}} | {{触发动作}} | {{期望结果}} |
| 边界 | {{sourceStoryId}} | {{场景名}} | {{前置条件}} | {{触发动作}} | {{期望结果}} |

**业务不变量**

- [{{US1}}] {{不变量描述}}

**后台文件 / 前端页面**

| 类型 | 子类型 | 路径 |
|---|---|---|
| {{fileKind}} | {{subType}} | {{resolvedPath}} |

---

## 4. 数据库设计

{{涉及持久化时输出以下内容；无持久化需求时替换为"本需求不涉及数据库设计"}}

### 4.1 设计说明

- 需求名称：{{需求名称}}
- 业务对象：{{中文业务对象列表}}
- 设计状态：ready / blocked / not_needed
- 表总数：{{N}}（新建 {{N}} / 复用 {{N}}）

### 4.2 复用已有表

| 表名 | 用途 | 复用 API / 落点 | 追加字段 | 关联业务对象 |
|---|---|---|---|---|
| {{已有表名}} | {{用途说明}} | {{API 或 reuseSourceFile}} | {{追加字段或无}} | {{entityKeys}} |

### 4.3 新建表结构草案

| 序号 | 字段名 | 类型 | 长度 | 必填 | 含义 |
|---|---|---|---|---|---|
| 1 | {{业务字段}} | {{类型}} | {{长度}} | {{是/否}} | {{含义}} |

### 4.4 公共字段（每张新建表自动追加）

| 字段名 | 类型 | 含义 |
|---|---|---|
| operatedate | DATETIME | 操作日期 |
| operateusername | VARCHAR(50) | 操作人姓名 |
| operateuserguid | VARCHAR(50) | 操作人 Guid |
| operateuserouguid | VARCHAR(50) | 操作人所在部门 Guid |
| operateuserbaseouguid | VARCHAR(50) | 操作人所在独立部门 Guid |
| yearflag | VARCHAR(4) | 年份标识 |
| belongxiaqucode | VARCHAR(50) | 所属辖区编号 |
| pviguid | VARCHAR(50) | 工作流标识 |

### 4.5 主子表关系 / 业务约束 / 建表 SQL

按 Builder 从 `databaseDesign` 渲染；最终 SQL 仍由 Coder 按项目规则复核。

---

## 5. 配置设计

### 5.1 代码项字段绑定

| 表名 | 字段 | 代码项名称 | 模式 | 来源 |
|---|---|---|---|---|
| {{tableName}} | {{columnName}} | {{codeItem}} | new/reuse | {{本需求新增或Requirement事实ref}} |

### 5.2 新增代码项

| 名称 | 值列表 |
|---|---|
| {{codeItem}} | {{codeValue-codeLabel, ...}} |

### 5.3 复用代码项

| 名称 | Requirement事实ref |
|---|---|
| {{codeItem}} | {{sourceRef}} |

---

## 6. 需求规则池快照

| 规则别名 | 来源 |
|---|---|
| {{ruleAlias}} | demand/rule-pool.json |

---

*本设计文档由 `epoint-requirement-design` Skill 生成；设计阶段不做 entity/module 规则绑定，规则真值来自需求阶段已确认的 `demand/rule-pool.json`。*
