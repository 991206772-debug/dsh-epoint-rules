# 统计分析实现参考

本参考适配 Design TDD Vibe Coding：骨架已经存在，统计专项只补业务逻辑，不从头生成模块。

## 1. 统计口径映射

先把 `statisticsContract` 翻译成施工表：

| 合同字段 | 落点 |
|---|---|
| `filters[]` | HtmlPage 筛选控件、Action 字段/getter/setter、Service WHERE 参数 |
| `dimensions[]` | datagrid 维度列、SQL SELECT 字段、GROUP BY 字段 |
| `metrics[]` | datagrid 指标列、SQL COUNT/SUM/CASE WHEN 聚合表达式 |
| `dataSources[]` | 来源表/承载 Service/复用查询方法，只能用 business-facts.json 或 work-slices 列出的精确源码证据 |
| `display` | 表格、左树右表、下钻、图表；没有明确要求不要引入图表库，明确要求图表时可使用本地 ECharts 静态资源 |
| `exportRequired` | HtmlPage `mini-dataexport` + Action `getExportModel` |

缺筛选、维度、指标或来源证据时，停下问用户；不要临时编造。

参数命名规则：

- 前后端绑定参数保持全小写，避免 `deptGuid` / `leftTreeNodeGuid` 这类大小写不一致导致绑定失败。
- 如果既有骨架已经使用驼峰字段，先保持骨架现状并确保 HtmlPage bind、Action getter/setter、Service 参数一致；不要为了统计专项重构无关字段。

通用 Java import 规则见 [backend-rules-checklist.md](backend-rules-checklist.md)，统计实现不另维护一份重复规则。

## 2. HtmlPage 统计页

普通统计页使用：

- 筛选区：`fui-condition` + `fui-form` + `role="searcher"`。
- 时间范围：`mini-daterangepicker`，常见绑定 `startDate,endDate`。
- 表格：`mini-datagrid`，`action="getDataGridData"`，列来自 dimensions + metrics。
- 导出：`mini-dataexport`，`gridId="datagrid"`，`action="getExportModel"`，通常带 `extraId="fui-form"`。
- 刷新：`epoint.refresh(['datagrid', 'fui-form'])`。
- 静态资源：`cssboot.js` 和 `rest/resource/jsboot` 路径由既有页面骨架或 Builder 生成结果决定；只在路径明显缺失且规则给出证据时局部补齐，不手工按记忆重算。
- 表格细节：保留骨架已有 `idField`、`showPager`、`allowResize`、`multiSelect` 等配置；新增列只围绕 dimensions + metrics。

### ECharts

只有 `statisticsContract.display.chart` 或验收项明确要求时才做图表。ECharts 必须是本地静态资源，禁止 CDN/npm/在线脚本。

施工要点：

1. 确认 chart 需求来自 `statisticsContract.display.chart` 或验收项；没有明确 chart 时只做 datagrid/汇总卡。
2. `echarts.min.js` 优先来自项目已有文件；项目没有时可从本 Coder 的 `assets/vendor/echarts.min.js` 复制（ECharts 5.4.3）。没有可复制来源时停下问用户。
3. HTML 中按页面相对路径引入：在 `rest/resource/jsboot` 后、页面业务 JS 前加入 `<script src="./js/echarts.min.js"></script>`。
4. 图表容器使用固定高度，例如 `<div id="status-chart" style="height: 320px;"></div>`。
5. 页面 JS 在 `epoint.initPage` 完成后初始化：`var chart = echarts.init(document.getElementById('status-chart')); chart.setOption(option);`。数据来自 Action/Service 返回值，不在前端硬编码。
6. 查询条件变化后复用同一个 chart 实例并 `setOption` 更新；窗口变化时绑定 `resize`。

前后端联动闭合关系：

| 前端元素 | 后端落点 |
|---|---|
| `epoint.initPage('xxxaction')` | `@RestController("xxxaction")` |
| `name="startdate"` / `name="enddate"` | Action `setStartdate` / `setEnddate`，并传 Service |
| `action="getDataGridData"` | Action `public DataGridModel<Record> getDataGridData()` |
| `mini-dataexport action="getExportModel"` | Action `public ExportModel getExportModel()` |
| `epoint.execute('getChartData', '', params, callback)` | Action `public void getChartData()` + `addCallbackParam("chartdata", rows)` |

左树右表只在合同或验收项明确时做：左侧用 `mini-filtertree`，右侧保留统计筛选区和 datagrid，用 hidden 字段保存树节点。

下钻只在合同或验收项明确时做：指标列使用 renderer，0 或空值不打开弹窗，弹窗用 `epoint.openDialog` 带当前筛选条件和维度值。

## 3. Action 统计入口

Action 只做参数接收、默认值、调用 Service 和返回模型：

- 使用 `DataGridModel<Record>` 提供 datagrid 数据。
- `fetchData(first, pageSize, sortField, sortOrder)` 调 Service 列表方法，再调 count 方法并 `setRowCount(count)`。
- `ExportModel` 只在需要导出时提供，调用同一统计列表方法。
- `pageLoad()` 可设置默认时间范围（当月第一天到当前时间）；若骨架已有默认值保持现状。
- 返回给页面或回调时沿用 `addViewData` / `addCallbackParam` 习惯。
- 不写 SQL、DAO、复杂聚合或数据来源拼装。

日期范围必须补时：如果页面 bind/name 使用全小写 `startdate/enddate`，Action 字段和 setter 也保持同名口径：

```java
public void setStartdate(String startdate) {
    if (StringUtil.isNotBlank(startdate) && startdate.length() == 10) {
        this.startdate = startdate + " 00:00:00";
    } else {
        this.startdate = startdate;
    }
}

public void setEnddate(String enddate) {
    if (StringUtil.isNotBlank(enddate) && enddate.length() == 10) {
        this.enddate = enddate + " 23:59:59";
    } else {
        this.enddate = enddate;
    }
}
```

## 4. Service 三层统计写法

优先复用承载模块 Service。不要因为是统计报表就新建 `XxxStatService` 包；只有骨架已授权独立统计 Service 三层时，才在新 Service 三层里补方法。

### 4.1 ServiceApi：只声明合同

在承载 Service 接口里补两个方法：列表和 count。参数来自 `statisticsContract.filters[]`，不要传整个页面对象或 Map，除非骨架/既有 Service 已经统一用 Map。

```java
List<Record> getCallStatList(String startdate, String enddate, String ouguid, int first, int pageSize);
int getCallStatListCount(String startdate, String enddate, String ouguid);
List<Record> getChartData(String startdate, String enddate);
```

方法名表达统计结果，不写 `queryStatisticsData` 这种泛名，除非骨架已生成且需要沿用。

### 4.2 ServiceImpl：只转发

`ServiceImpl` 是壳层，只 new 内部 Service 并转发。不持有 `ICommonDao`，不写 SQL。

### 4.3 ServiceInternal：真实统计查询

真实统计只写在内部 Service。先读取当前 ServiceInternal 文件已有 DAO 字段、构造器、关闭方式和查询 helper，再落统计方法。

DAO 使用规则：

- 当前类已有 `baseDao/commonDao` 字段时复用该字段，不要局部 `CommonDao.getInstance()`。
- 当前类已有 `getSql(...)`、`SqlHelper`、`SqlConditionUtil` 等查询 helper 时优先复用。
- 当前类没有 DAO 字段时，按主 Skill 的技术查证顺序确认获取方式，不要求用户决定技术写法；必要接口仍无法查证时只保留依赖该接口的任务缺口，继续其余任务，不编造 DAO API。

典型结构（字段名只是示意，真实字段来自 `statisticsContract` 和业务表）：

```java
public List<Record> getCallStatList(String startdate, String enddate, String ouguid, int first, int pageSize) {
    try {
        StringBuilder sql = new StringBuilder();
        List<Object> params = new ArrayList<>();
        sql.append("SELECT t.ouguid, t.ouname, COUNT(1) AS totalcount, ");
        sql.append("COUNT(CASE WHEN t.result = '1' THEN 1 END) AS successcount ");
        sql.append("FROM <source_table> t WHERE 1=1 ");
        if (StringUtil.isNotBlank(startdate)) { sql.append("AND t.calltime >= ? "); params.add(startdate); }
        if (StringUtil.isNotBlank(enddate)) { sql.append("AND t.calltime <= ? "); params.add(enddate); }
        if (StringUtil.isNotBlank(ouguid)) { sql.append("AND t.ouguid = ? "); params.add(ouguid); }
        sql.append("GROUP BY t.ouguid, t.ouname ");
        return baseDao.findList(sql.toString(), first, pageSize, Record.class, params.toArray());
    } catch (Exception e) { return new ArrayList<>(); }
}
```

### 4.4 Count 方法：和列表同口径

分组统计的 count 是"统计行数"，不是原始明细行数。使用同口径子查询：

```java
public int getCallStatListCount(String startdate, String enddate, String ouguid) {
    try {
        StringBuilder sql = new StringBuilder();
        List<Object> params = new ArrayList<>();
        sql.append("SELECT COUNT(1) FROM (");
        sql.append("SELECT t.ouguid, t.ouname FROM <source_table> t WHERE 1=1 ");
        // WHERE 条件必须和列表方法一致
        sql.append("GROUP BY t.ouguid, t.ouname) temp ");
        return baseDao.queryInt(sql.toString(), params.toArray());
    } catch (Exception e) { return 0; }
}
```

不得直接 `SELECT COUNT(1) FROM source_table WHERE ...` 冒充统计行数。

统计 SQL 要求：

- 参数化查询，禁止拼接用户输入。
- WHERE 来自 filters；SELECT/GROUP BY 来自 dimensions；COUNT/SUM/CASE WHEN 来自 metrics。
- list 和 count 使用同一筛选口径。
- 多值 IN 条件使用公司 DAO 工具模式（如 `DbKit.splitIn(...)`），不要把逗号字符串直接拼进 SQL。
- 分页查询使用项目既有 `findList` 分页签名。
- 只在 ServiceInternal 写 DAO 查询；Action、HtmlPage、Job 禁止接触 DAO。
- 空结果返回空集合或 0，不把异常抛给前端。

## 5. 完成检查

完成前逐项确认：

- 每个 filter 都有页面控件或明确不展示理由，并能传到 Action/Service。
- 每个 dimension 都有 datagrid 列和 SQL 分组/选择来源。
- 每个 metric 都有 datagrid 列和聚合表达式。
- 日期筛选若使用 DateRangePicker，Action setter 已补时。
- 需要导出时 HtmlPage 和 Action 双侧闭合。
- 需要下钻时 renderer、弹窗 URL、筛选参数和目标页授权闭合。
