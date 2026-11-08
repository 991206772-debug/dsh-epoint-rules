# 管理端 CRUD 代码配方

本文件供 `epoint-design-tdd-coder` 的 company-practices 读卡使用。补业务代码时先以工作包列出的项目样例、候选文件和规则小抄为准；本配方只提供层次和常见写法，不能覆盖项目契约。没有精确引用时，用当前 Story 和骨架锚点检索相近项目实现，命中后停止；仍不确定再报告。

字段名提醒：配方里的 `status`、`type`、`ordernum` 等是示例占位，不是公司固定字段。实现时按业务语义和项目已有命名决定，例如启用、发布、审核、有效标志可能分别用不同字段。

## Entity 配方

生成目标：

```java
@Entity(table = "表名", id = "rowguid")
public class Xxx extends BaseEntity implements Cloneable {
    public String getRowguid() {
        return super.get("rowguid");
    }

    public void setRowguid(String rowguid) {
        super.set("rowguid", rowguid);
    }
}
```

要点：

- 包路径来自工程导航契约的 entity 路径。
- `@EntityLength`、日期类型、数字类型按项目实体样例写。
- 字段 getter/setter 使用 `super.get/super.set` 风格。
- 不使用 Lombok。

## ServiceApi 配方

常见方法：

```java
PageData<Xxx> paginatorList(Map<String, Object> conditionMap, int pageIndex, int pageSize);

Xxx findById(String rowguid);

void save(Xxx data);

void delete(String rowguid);

void updateStatus(String rowguid, String status);
```

主从表追加：

```java
void saveWithDetails(Xxx main, List<XxxDetail> details);

List<XxxDetail> findDetails(String mainGuid);
```

要点：

- 方法命名贴近项目样例，不强行统一。
- 需要同名/同编号唯一性校验时暴露 `checkNameExists` 或在 `save` 内部封装；不要把页面已有的必填、长度、格式重复写进 Service。

## ServiceInternal 配方

常见结构：

```java
public class XxxService {

    private ICommonDao baseDao = CommonDao.getInstance();

    public PageData<Xxx> paginatorList(Map<String, Object> conditionMap, int pageIndex, int pageSize) {
        SqlConditionUtil conditionUtil = new SqlConditionUtil(conditionMap);
        StringBuilder sql = new StringBuilder();
        sql.append("select * from 表名 where 1=1 ");
        // conditionUtil 追加条件，按项目样例写
        SqlHelper sqlHelper = new SqlHelper();
        return baseDao.findPage(sqlHelper.getSqlComplete(sql.toString()), pageIndex, pageSize, Xxx.class);
    }
}
```

要点：

- 以本项目已有 Service 为准，可能是 `baseDao.find/delete/update/insert`，也可能有项目封装。
- 查询条件必须参数化，不能拼接用户输入。
- 删除前做引用校验。
- 状态流转在 Service 做业务校验，不只在前端限制。

## ServiceImpl 配方

常见结构：

```java
@Component
public class XxxServiceImpl implements IXxxService {

    private XxxService service = new XxxService();

    @Override
    public PageData<Xxx> paginatorList(Map<String, Object> conditionMap, int pageIndex, int pageSize) {
        return service.paginatorList(conditionMap, pageIndex, pageSize);
    }
}
```

要点：

- `@Component`、接口前缀、委托方式按项目样例。
- 不在 ServiceImpl 里写复杂 SQL。

## ListAction 配方

常见结构：

```java
@RestController("xxxlistaction")
@Scope("request")
public class XxxListAction extends BaseController {

    @Autowired
    private IXxxService service;

    public void pageLoad() {
    }

    public void datagrid(DataGridModel model) {
        Map<String, Object> conditionMap = new HashMap<String, Object>();
        conditionMap.put("name", getRequestParameter("name"));
        PageData<Xxx> pageData = service.paginatorList(conditionMap, model.getPageIndex(), model.getPageSize());
        outputDataGrid(pageData);
    }

    public void delete() {
        String rowguid = getRequestParameter("rowguid");
        service.delete(rowguid);
        addCallbackParam("msg", "删除成功");
    }
}
```

要点：

- 方法名和参数以项目 ListAction 样例为准。
- `DataGridModel`、`addCallbackParam`、输出 grid 的方法照样例。
- 批量删除、启停、发布撤回都在这里做入口，业务规则交给 Service。

## Add/Edit/Detail Action 配方

Add：

```java
@RestController("xxxaddaction")
@Scope("request")
@RightRelation(XxxListAction.class)
public class XxxAddAction extends BaseController {

    @Autowired
    private IXxxService service;

    private Xxx data = new Xxx();

    public void pageLoad() {
        // 初始化字典、默认值
    }

    public void save() {
        data.setRowguid(UUID.randomUUID().toString());
        // 创建人、创建时间按项目样例写
        service.save(data);
        addCallbackParam("msg", "保存成功");
    }
}
```

Edit：

- `pageLoad` 根据 `rowguid` 回显。
- `save` 更新修改人和修改时间。

Detail：

- 只查询和展示，不提供保存。

## List HTML 配方

必须闭合：

```html
<script type="text/javascript">
    epoint.initPage('xxxlistaction');
</script>
```

常见组成：

- `cssboot.js`、`jsboot` 引入方式按样例。
- 查询区控件：`mini-textbox`、`mini-combobox`、`mini-datepicker`。
- 操作按钮：新增、编辑、删除、启停。
- `mini-datagrid`：`url`、`idField`、分页属性、列定义。
- JS 方法：`search`、`add`、`edit`、`remove`、`enable`、`disable`。

## Form HTML 配方

必须闭合：

```html
<script type="text/javascript">
    epoint.initPage('xxxaddaction');
</script>
```

常见组成：

- FUI 表单结构按项目样例。
- 必填字段加 required 或项目样例校验属性。
- 保存前调用 `epoint.validate`。
- 保存动作调用 `epoint.execute` 或项目样例方法。

## 生成后的最小验收

- 列表打开时能初始化 Action。
- 查询条件能传到 Action。
- 新增保存成功，重复/必填失败有提示。
- 编辑能回显并保存。
- 详情只读。
- 删除有确认和后端校验。
- 启停/发布等状态操作前后端都有校验。
- 页面 Action bean 名全部闭合。
