# Epoint 前端 API 合同

本文件用于纠正 LLM 把 Epoint 前端 API 当成通用 Ajax、浏览器原生 API 或现代前端框架 API 的习惯。页面代码必须先服从当前项目的 MiniUI/FUI + `epoint.*` 合同，再参考通用 JavaScript 经验。

## 总原则

- `epoint.*` 不是 axios/fetch/jQuery 的薄封装；不要套用对象参数、Promise、async/await 或 REST URL 思维。
- MiniUI 控件 `action="xxx"` 不是 URL，也不是备注；它必须能闭合到当前页面默认 Action 或显式指定 Action 的 public 方法。
- 弹窗、刷新、提示、选择回传、URL 参数读取都优先使用项目已有 `epoint.*` / `Util.*` 写法，不自造浏览器原生流程。
- 本文件只说明 API 合同；字段名、方法名、Action 名仍以 `routeCards`、候选文件、业务事实和项目样例为准。

## epoint.execute

### 合同

- 裸 `epoint.execute('method')` 只调用页面 `epoint.initPage('xxxaction')` 的默认 Action。
- 跨 Action 调用沿用当前项目已确认的写法；`xxxaction.method` 与 `xxxaction/method` 不能任意互换。按项目适用规则、真实 `epoint.execute`/路由源码和同类页面确认，已有有效证据直接复用，不为每次调用重复查证。
- 第二参 `ids` 表示表单、表格或控件提交范围；无表单提交时用 `@none`。
- 第三参 `params` 只按 `string | Array` 传递；多个 Java public 方法参数按方法形参顺序传数组。
- 禁止把多个参数写成对象字面量，不能套用 axios/fetch/$.ajax 的 `{ data: ... }` 或 `{ a: a, b: b }` 习惯。

### 正例

当前项目通过 `url.indexOf('.')` 识别显式 Action 时（如已核对的 9.3.4 项目）：

```javascript
epoint.execute('gxhaction.save', '@none', [name, code], callback);
```

```java
public void save(String name, String code) {
}
```

只有当前项目的调用实现已确认支持斜杠形式时，才使用 `gxhaction/save`；不能把上例机械改成斜杠。点号识别实现会给不带点号的调用补上当前 Action，导致错误路由。

调用当前页面的 Action：

```javascript
epoint.execute('save', 'fui-form', callback);
```

### 反例

```javascript
epoint.execute('save', '', { name: name, code: code }, callback);
```

```javascript
epoint.execute('/api/save', '@none', [name, code], callback);
```

## MiniUI action 属性

- `mini-datagrid action="getDataGridData"` 必须闭合到 Action public `getDataGridData()`。
- `mini-combobox action="getXxxModel"` 必须闭合到 Action public `getXxxModel()`。
- `mini-dataexport action="getExportModel"` 必须闭合到 Action public `getExportModel()`。
- 不要把 `action` 写成 URL、接口路径或不存在的方法名。

## 刷新与查询

```javascript
function searchData() {
    epoint.refresh(['datagrid', 'fui-form'], '', true);
}
```

- 搜索条件优先放在 `fui-form`，用 `epoint.refresh` 带表单和表格刷新。
- 不用 `fetch/axios/$.ajax` 自己请求列表数据。

## 弹窗与回传

```javascript
epoint.openDialog('选择记录', './xxxlist', function(row) {
    mini.get('name').setValue(row.name);
}, { width: 900, height: 600 });
```

子页：

```javascript
epoint.closeDialog(grid.getSelected());
```

- 不用 `window.close()`、`window.opener`、`parent.document` 直接操作父页面。
- 新增/编辑保存后需要刷新父页时，父页传 `searchData` 或等价刷新函数，子页保存成功后 `epoint.closeDialog(data.msg)`。

## 提示

```javascript
epoint.alert(data.msg, '', searchData, 'info');
epoint.confirm('确认删除?', '', function() {});
```

- `epoint.alert` 是合法平台方法，不要为了“统一提示”替换成 `showTips`。
- 原生 `alert()` / `confirm()` 不符合公司页面交互。
