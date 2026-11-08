# 前端代码必查清单（公司硬铁律）

涉及前端文件（`*.html` / `*.html.js`，禁止 `.jsp`）时，按实际页面功能选择检查项。只读详情不要求 execute 保存、validate、刷新、删除或导出；无删除功能的列表不检查 L4/L5。不得为凑齐断言增加按钮或业务。

清单只列出公司规则正文中明确标注"严禁 / 铁律 / 强制自检"的项；
完整规则正文通过 readCatalog 当前规则卡定位；读取顺序以主 Skill 为准。

## ❶ 第一红线：严禁 JSP

公司前端**只用** `HTML + MiniUI + EUI`，**绝对不用 JSP**。来自所有版本桶的 `代码生成规范-前端页面.md` 铁律 ❶。

| 编号 | 必查项 | 必须不含 |
|---|---|---|
| F0 | 严禁生成任何 `.jsp` 文件 / 严禁页面里出现 JSP 语法 | 文件名 `\.jsp$` / 内容 `<%[\s\S]*%>` 或 `<%@\s+page` 或 `<%=` |

**如果 LLM 凭其它 Spring 项目记忆生成了 `.jsp`**：立即删除该文件，按 `代码生成规范-前端页面.md` 模板重写为 `.html`。这是**第一红线**，policy.json 也物理拦截。

## 6 条铁律（来自 `前端API-开发手册.mdc`）

| 编号 | 必查项 | 必须不含 |
|---|---|---|
| F1 | 严禁 `$.ajax` / `Util.ajax` 新增使用 | `\$\s*\.\s*ajax\s*\(` / `Util\.ajax\s*\(` |
| F2 | 严禁直接引用 `boot.js`（必须 `cssboot.js` + `jsboot`） | `<script[^>]+src="[^"]*boot\.js"` 但允许 `cssboot\.js` |
| F3 | 严禁原生 `<table><tr><td>` 做表单布局 | `<table\b` 在 `<form\|fui-form` 容器内 |
| F4 | 严禁 jQuery 选择器 / 其它前端框架 | `layui\b` / `layer\.open\b` / `\bVue\b` / `\bReact\b` |
| F5 | 严禁直接 DOM 操作或手动 setData（必须 `bind="dataBean.xxx"`） | `document\.getElementById` / `\.innerHTML\s*=` 在 .html 内 |
| F6 | 严禁污染：示例工程路径写成默认 | 不得含 `webapp/example/`、不得把示例模块名写死成默认值 |

## 必备 API（来自 `前端API-开发手册.mdc` 自检清单）

| 编号 | 必查项 | 必须含 |
|---|---|---|
| F7 | 页面打开必须 `epoint.initPage('xxxaction')` | `epoint\.initPage\s*\(\s*['"][a-z0-9]+action['"]` |
| F8 | 数据交互必须 `epoint.execute(method, ids, params, callback)` | `epoint\.execute\s*\(` |
| F9 | 列表/局部刷新必须 `epoint.refresh([...], '', true/false)` | `epoint\.refresh\s*\(` |
| F10 | 表单保存必须 `epoint.validate()` 后再 execute | `epoint\.validate\s*\(\s*\)`（位置在 execute 之前） |
| F11 | 资源引入必须 `cssboot.js` + `jsboot` | `cssboot\.js` 和 `rest/resource/jsboot` |

### `epoint.execute` 参数合同

本清单只负责检查是否使用公司调用体系；`epoint.execute` 的参数语义、跨 Action 写法、正反例统一看：

- `references/company-practices/frontend/epoint-api-contract.md#epointexecute`

## 列表页强约束（subType=list）

| 编号 | 必查项 | 断言 |
|---|---|---|
| L1 | 必须 `<div class="mini-datagrid"` + `action="getDataGridData"` | grep 必须含 |
| L2 | 操作列必须 `epoint.renderCell(e, 'action-icon icon-xxx', 'handler')` | grep 必须含（涉及行操作时） |
| L3 | 搜索条件区必须 `<a role="searcher" callback="searchData" opend="true">` | grep 必须含 |
| L4 | 删除前必须 `epoint.confirm` 二次确认 | `epoint\.confirm\s*\(` |
| L5 | 删除前必须 `getSelecteds().length == 0` 校验 | `getSelecteds\(\)\.length` |
| L6 | 导出按钮必须 `<a class="mini-dataexport" gridId="datagrid"` | grep 必须含（涉及导出时） |

## 表单页强约束（subType=add / edit）

| 编号 | 必查项 | 断言 |
|---|---|---|
| FM1 | 必须 `<div class="fui-form" id="fui-form">` 容器 | grep 必须含 |
| FM2 | 必须 `<div role="form"><div role="row">` 包裹 | grep 必须含 |
| FM3 | 控件区必须 `<div role="control" label="xxx">` | grep 必须含 |
| FM4 | 必填字段必须同时有 `starred="true"` + `required="true"` | grep 必须含 |
| FM5 | 控件值绑定必须 `bind="dataBean.xxx"` | `bind\s*=\s*['"]dataBean\.[a-z]` |
| FM6 | 保存按钮调用必须 `epoint.execute('add\|save', 'fui-form', callback)` | grep 必须含 |
| FM7 | 关闭必须使用 `epoint.closeDialog`，弹窗保存成功后必须明确关闭刷新父页、保存并新建或按需求留页提示 | 弹窗默认 grep 必须含 `epoint\.closeDialog`；仅当 User Story 明确保存并继续/保存后停留时，才允许 `epoint.clear('fui-form')` 或带说明的留页 `epoint.alert` |

## 详情页强约束（subType=detail）

| 编号 | 必查项 | 断言 |
|---|---|---|
| DT1 | 只读控件必须 `<div class="mini-output" bind="dataBean.xxx">` | grep 必须含 |
| DT2 | 时间字段必须 `data-options="{'format':'yyyy-MM-dd HH:mm:ss'}"` | grep 必须含（涉及时间字段时） |
| DT3 | 严禁含 `mini-textbox` / `mini-combobox` 等可编辑控件 | 不得含 |

## 页面控件 action 与后台方法核对

保留页面引用的完整方法名：`action="getBorrowTypeModel"` 对应 `getBorrowTypeModel()`，不能去掉 `get` 或改变大小写。按页面 `initPage` 找当前 Action；显式 `xxxaction.getXxxModel` 则找指定 bean，不把多个 Action 的方法混成一个集合。

核对所有实际控件入口，不限于字典 getter 或 `List<SelectItem>`：表格、树、导出、附件等返回类型按对应控件合同确认。方法可能继承自父类，当前类未声明时定向查父类或已确认框架来源；动态 action 也需按实际值查证，不能只凭文本匹配判定后台缺失。后台多出的已有方法不要求删除或强行加到页面。

### PowerShell 文本预检（当前页面和当前 Action）

先按真实导航设置 `$pagePath`、`$actionPath`。脚本只筛出短 action 在当前类中是否有 public 方法声明，不是 Java 解析器；指定 Action、动态调用、继承方法和文本误匹配需定向核实。通过后仍须核对参数、返回类型、真实声明和页面交互，不把文本预检当运行验证。

```powershell
# $pagePath、$actionPath 必须指向本次核对的页面和其默认 Action，不使用全目录通配符。
$pageText = Get-Content -LiteralPath $pagePath -Raw -ErrorAction Stop
$actionText = Get-Content -LiteralPath $actionPath -Raw -ErrorAction Stop
$bindings = @([regex]::Matches($pageText, '\baction\s*=\s*["'']([^"'']+)["'']') |
    ForEach-Object { $_.Groups[1].Value } | Sort-Object -Unique)
$localMethods = @($bindings | Where-Object { $_ -cmatch '^[A-Za-z_$][\w$]*$' })
$otherBindings = @($bindings | Where-Object { $_ -cnotmatch '^[A-Za-z_$][\w$]*$' })
$publicMethods = @([regex]::Matches($actionText,
    '\bpublic\s+(?:(?:static|final|synchronized|abstract)\s+)*[\w.$<>,?\[\]\s]+?\s+([A-Za-z_$][\w$]*)\s*\(') |
    ForEach-Object { $_.Groups[1].Value } | Sort-Object -Unique)
$notDeclaredHere = @($localMethods | Where-Object { $_ -cnotin $publicMethods })

if ($notDeclaredHere.Count) {
    Write-Output "本类未声明，需定向核对继承或真实方法声明：$($notDeclaredHere -join ', ')"
} else {
    Write-Output '本类短 action 方法名核对通过；仍需核对参数、返回类型及页面交互。'
}
if ($otherBindings.Count) {
    Write-Output "指定 Action 或动态调用需单独核对：$($otherBindings -join ', ')"
}
```

只有沿真实声明、继承和目标 bean 确认引用缺少方法后才修复；后端未使用方法不能误删。

## 命名 / 路径硬约束（来自 `项目结构与命名规范.mdc`）

| 编号 | 必查项 | 断言 |
|---|---|---|
| N1 | 已生成页面按导航核对；新增页面按公司路径和授权业务目录确定 | 已生成文件核对 targetIndex.resolvedPath；新增文件核对公司路径规则及承载模块 |
| N2 | 已生成页面名按契约核对；新增页面按公司命名规则确定 | 已生成文件核对 targetIndex 文件名；新增文件核对适用规则及当前调用方 |
| N3 | `epoint.initPage('xxxaction')` 的 xxxaction 必须等于 `<类名去 Action 后缀>` 全小写 + `action` | 双向核对 |

> 本清单不另起命名规则。已生成页面使用 `targetIndex` 导航，Coder 必要新增页面使用公司路径、命名规则和承载模块范围，不因未列入 targetIndex 停工；职责和验证结果归原任务计划、进度。

## URL 参数

| 编号 | 必查项 | 断言 |
|---|---|---|
| U1 | 必须 `Util.getUrlParams('paramName')` 读 URL 参数 | 涉及 URL 参数时必须含 |
| U2 | URL 参数写法必须贴合项目实战样例 | 普通管理端弹窗可直接拼接主键参数；参数名必须跟随同目录历史页面和 Action 读取参数，如 `guid`/`rowguid`，若项目已有 `Util.addUrlParams` 再沿用 |

## 页面动作闭合与历史入口保护

| 编号 | 必查项 | 断言 |
|---|---|---|
| P1 | `epoint.initPage('xxxaction')` 必须能在对应 Action 找到 `@RestController("xxxaction")` | 前后端参数完全一致，大小写也一致 |
| P2 | `epoint.execute(...)` 调用的动作必须能回到当前 Action 或 plan/reuseCard 指定的后端方法 | 裸方法名绑定默认 Action；显式 Action 的分隔符按前端 API 合同和当前项目实现确认，目标 `@RestController("xxxaction")` 中必须有同名 public 方法或可核实的继承方法 |
| P3 | 保存类动作前必须走项目样例中的 validate 方式 | 涉及表单保存时必须能看到 `epoint.validate` 或项目样例等价校验 |
| P4 | 列表刷新必须沿用项目样例方式 | 新增/删除/状态操作成功后应刷新 datagrid 或保留原页面结果 |
| P5 | 历史入口改造不能破坏原查询区、原按钮、原表格列和原 URL 参数读取 | 对照 `preserveBehaviors[]`，只增补本次 Story 所需控件/事件 |
| P6 | 禁止前端框架漂移 | 不得引入 Vue/React/Angular、axios/fetch、原生 alert/confirm、JSP 表格布局 |
| P7 | 新增/编辑弹窗必须形成父页回调闭环 | 父页 `epoint.openDialog('标题', url, searchData/callback, options)`；子页保存成功 `epoint.closeDialog(data.msg)`，或明确保存并新建/留页 |
| P8 | 选择弹窗必须通过 `closeDialog(row/object)` 回传 | 子选择页 `epoint.closeDialog(grid.getSelected())` 或自定义对象；父页 callback 中 `mini.get(...).setValue/setText` 回填 |
| P9 | HtmlPage `bind` 必须和后台属性闭合 | 裸 `bind="xxx"` 要在当前 Action 有 `getXxx/setXxx`；`bind="dataBean.xxx"` 要在 `dataBean` 实体有对应 getter/setter。新增查询条件、隐藏字段或表单字段时同步改 Action/Entity，不能只改 HTML |

弹窗闭环红线：

- 不使用 `window.open/window.close` 代替公司弹窗。
- 不从子页面直接操作父页面 DOM。
- 不只写 `epoint.execute('add/save')` 而遗漏关闭、刷新或留页处理。
- 详情只读弹窗可传空回调；新增/编辑后父页需刷新时必须传 `searchData` 或等价刷新函数。

## MiniUI 控件句柄常用方法

| 场景 | 推荐方法 |
|---|---|
| 文本/隐藏值赋值 | `mini.get(id).setValue(value)` |
| 文本/隐藏值取值 | `mini.get(id).getValue()` |
| 列表批量选择 | `mini.get('datagrid').getSelecteds()` |
| 显隐控制 | `mini.get(id).show()` / `mini.get(id).hide()` |
| 启用禁用 | `mini.get(id).setEnabled(bool)` |

严禁用 `mini.get` 绕过 `bind="dataBean.xxx"` 做整页手动赋值。

## 执行约束

每个 module 涉及前端文件时：

1. 当前页面适用的断言通过才算该页面批次闭合
2. 任一不通过，直接修复页面或后端调用，并在 `demand-implementation-tasks.md` 对应任务记录验证结果
3. 前端引用缺少对应后端模型时修复并验证；后端多余方法不属于失败

## 与设计文档的对账

适用项的验证结果及缺口统一写入主 Skill 定义的进度记录，不新增完成标记。调用和绑定静态闭合不等于页面实际交互已验证；没有运行环境时保留限制。
