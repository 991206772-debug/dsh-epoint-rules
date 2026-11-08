# 后端 CRUD 写法示例

用于基础管理端功能：Entity、ServiceApi、内部 Service、ServiceImpl、List/Add/Edit/Detail Action。生成前仍要先读当前项目同模块样例；本文件只保留公司框架骨架。

字段名提醒：示例中的 `status`、`type`、`name`、`ordernum` 等只是为了展示 CRUD 写法。真实字段名、方法名和查询条件必须来自需求、表结构、Entity 和工作包列出的项目同类代码。

## Entity

```java
import java.util.Date;

import com.epoint.core.BaseEntity;
import com.epoint.core.annotation.Entity;

@Entity(table = "xxx_table_name", id = "rowguid")
public class XxxInfo extends BaseEntity implements Cloneable {
    private static final long serialVersionUID = 1L;

    public String getRowguid() {
        return super.get("rowguid");
    }

    public void setRowguid(String rowguid) {
        super.set("rowguid", rowguid);
    }

    public String getName() {
        return super.get("name");
    }

    public void setName(String name) {
        super.set("name", name);
    }

    public Integer getOrdernum() {
        return super.getInt("ordernum");
    }

    public void setOrdernum(Integer ordernum) {
        super.set("ordernum", ordernum);
    }

    public Date getOperatedate() {
        return super.getDate("operatedate");
    }

    public void setOperatedate(Date operatedate) {
        super.set("operatedate", operatedate);
    }
}
```

要点：

- 不生成 Lombok POJO、JPA Entity、MyBatis-Plus Entity。
- getter/setter 用 `super.get/super.set`；日期和数字取值方式跟项目样例。
- 公共字段名按项目：常见 `operatedate/operateusername/operateuserguid`，也可能是 `createdate/creatorname`。

## ServiceApi

```java
import java.util.List;
import java.util.Map;

import com.epoint.database.peisistence.crud.impl.model.PageData;

public interface IXxxInfoService {
    int insert(XxxInfo record);

    int deleteByGuid(String guid);

    int update(XxxInfo record);

    XxxInfo getBeanByGuid(String guid);

    Integer getCount(Map<String, String> conditionMap);

    List<XxxInfo> getAllRecord(Map<String, String> conditionMap);

    PageData<XxxInfo> findListPageList(Map<String, String> params, int first, int pageSize);

    void updateStatus(String guid, String status);
}
```

要点：

- `Map<String, String>` 和 `Map<String, Object>` 以当前项目接口为准。
- 主从表在 ServiceApi 增加 `saveWithDetails(main, details)`、`findDetails(mainGuid)`，不要由 Action 直接操作明细表。

## 内部 Service

```java
import java.util.List;
import java.util.Map;

import com.epoint.core.dao.CommonDao;
import com.epoint.core.dao.ICommonDao;
import com.epoint.core.utils.sql.SqlConditionUtil;
import com.epoint.database.peisistence.crud.impl.model.PageData;

public class XxxInfoService {
    protected ICommonDao baseDao;

    public XxxInfoService() {
        baseDao = CommonDao.getInstance();
    }

    public int insert(XxxInfo record) {
        return baseDao.insert(record);
    }

    public int update(XxxInfo record) {
        return baseDao.update(record);
    }

    public XxxInfo getBeanByGuid(String guid) {
        return baseDao.find(XxxInfo.class, guid);
    }

    public int deleteByGuid(String guid) {
        XxxInfo entity = baseDao.find(XxxInfo.class, guid);
        if (entity == null) {
            return 0;
        }
        return baseDao.delete(entity);
    }

    public PageData<XxxInfo> paginatorList(Map<String, Object> conditionMap, int pageNumber, int pageSize) {
        SqlConditionUtil conditionUtil = new SqlConditionUtil(conditionMap);
        List<XxxInfo> list = baseDao.findList(conditionUtil.getMap(), pageNumber, pageSize, XxxInfo.class);
        int count = baseDao.findCount(conditionUtil.getMap(), XxxInfo.class);
        return new PageData<XxxInfo>(list, count);
    }
}
```

项目里也可能用 `SQLManageUtil`：

```java
String table = XxxInfo.class.getAnnotation(Entity.class).table();
SQLManageUtil sqlutil = new SQLManageUtil();
String sql = "select * from " + table + " where 1=1 " + sqlutil.buildPatchSql(params);
List<XxxInfo> list = baseDao.findList(sql, first, pageSize, XxxInfo.class);
```

要点：

- SQL 条件必须参数化或使用项目工具构造，不能拼接用户输入。
- 同名/同编号唯一性、引用校验、状态流转放 Service，不塞 Action；普通表单必填、长度、格式留在 HtmlPage。
- 排序字段来自前端时，按项目样例做白名单或保持字段可控。

## ServiceImpl

```java
import java.util.Map;

import org.springframework.stereotype.Component;

import com.epoint.database.peisistence.crud.impl.model.PageData;

@Component
public class XxxInfoServiceImpl implements IXxxInfoService {

    @Override
    public int insert(XxxInfo record) {
        return new XxxInfoService().insert(record);
    }

    @Override
    public int deleteByGuid(String guid) {
        return new XxxInfoService().deleteByGuid(guid);
    }

    @Override
    public int update(XxxInfo record) {
        return new XxxInfoService().update(record);
    }

    @Override
    public XxxInfo getBeanByGuid(String guid) {
        return new XxxInfoService().getBeanByGuid(guid);
    }

    @Override
    public PageData<XxxInfo> findListPageList(Map<String, String> params, int first, int pageSize) {
        return new XxxInfoService().findListPageList(params, first, pageSize);
    }
}
```

要点：

- 老项目可能有 Dubbo `@Service`，以工作包列出的当前项目样例为准；没有精确样例时，用骨架包名、Service 接口或对象键检索当前工程相近实现，命中后停止。
- ServiceImpl 多数只做接口实现和委托，不写大段 SQL。

## ListAction

```java
import java.util.List;
import java.util.Map;

import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.context.annotation.Scope;
import org.springframework.web.bind.annotation.RestController;

import com.epoint.basic.controller.BaseController;
import com.epoint.basic.faces.export.ExportModel;
import com.epoint.basic.faces.util.DataUtil;
import com.epoint.core.utils.sql.SqlConditionUtil;
import com.epoint.core.dto.model.DataGridModel;
import com.epoint.core.dto.model.SelectItem;
import com.epoint.core.utils.date.EpointDateUtil;
import com.epoint.core.utils.string.StringUtil;
import com.epoint.database.peisistence.crud.impl.model.PageData;
import com.epoint.frame.service.metadata.mis.util.CodeModalFactory;

@RestController("xxxinfolistaction")
@Scope("request")
public class XxxInfoListAction extends BaseController {
    @Autowired
    private IXxxInfoService service;

    private DataGridModel<XxxInfo> model;
    private ExportModel exportModel;
    private String keyword;
    private String status;
    private String startDate;
    private String endDate;

    public DataGridModel<XxxInfo> getDataGridData() {
        if (model == null) {
            model = new DataGridModel<XxxInfo>() {
                @Override
                public List<XxxInfo> fetchData(int first, int pageSize, String sortField, String sortOrder) {
                    SqlConditionUtil sql = new SqlConditionUtil();
                    if (StringUtil.isNotBlank(keyword)) {
                        sql.like("name", keyword.trim());
                    }
                    if (StringUtil.isNotBlank(status)) {
                        sql.eq("status", status);
                    }
                    if (StringUtil.isNotBlank(startDate)) {
                        sql.ge("operatedate", EpointDateUtil.getBeginOfDateStr(startDate));
                    }
                    if (StringUtil.isNotBlank(endDate)) {
                        sql.lt("operatedate", EpointDateUtil.getEndOfDateStr(endDate));
                    }
                    if (StringUtil.isNotBlank(sortField)) {
                        if ("desc".equalsIgnoreCase(sortOrder)) {
                            sql.setOrderDesc(sortField);
                        }
                        else {
                            sql.setOrderAsc(sortField);
                        }
                    }
                    else {
                        sql.setOrderDesc("operatedate");
                    }

                    PageData<XxxInfo> pageData = service.findListPageList(sql.getMap(), first, pageSize);
                    this.setRowCount(pageData.getRowCount());
                    return pageData.getList();
                }
            };
        }
        return model;
    }

    public void deleteSelect() {
        List<String> select = getDataGridData().getSelectKeys();
        if (select == null || select.isEmpty()) {
            addCallbackParam("msg", "请选择要删除的记录！");
            return;
        }
        for (String guid : select) {
            service.deleteByGuid(guid);
        }
        addCallbackParam("msg", "删除成功！");
    }

    @SuppressWarnings("unchecked")
    public List<SelectItem> getStatusModel() {
        return DataUtil.convertMap2ComboBox(
                (List<Map<String, String>>) CodeModalFactory.factory("下拉列表", "是否", null, true));
    }

    public ExportModel getExportModel() {
        if (exportModel == null) {
            exportModel = new ExportModel("name,status,operatedate", "名称,状态,操作时间");
        }
        return exportModel;
    }
}
```

要点：

- `@RestController("xxxaction")` 与页面 `epoint.initPage('xxxaction')` 完全一致。
- `@Scope("request")`、`BaseController`、`DataGridModel`、`addCallbackParam` 是管理端强风格信号。

## Add/Edit/Detail Action

```java
@RightRelation(XxxInfoListAction.class)
@RestController("xxxinfoaddaction")
@Scope("request")
public class XxxInfoAddAction extends BaseController {
    @Autowired
    private IXxxInfoService service;

    private XxxInfo dataBean;

    @Override
    public void pageLoad() {
        dataBean = new XxxInfo();
        dataBean.setStatus("0");
    }

    public void add() {
        dataBean.setRowguid(java.util.UUID.randomUUID().toString());
        dataBean.setOperatedate(new java.util.Date());
        if (userSession != null) {
            dataBean.setOperateusername(userSession.getDisplayName());
            dataBean.setOperateuserguid(userSession.getUserGuid());
        }
        service.insert(dataBean);
        addCallbackParam("msg", "保存成功！");
    }
}
```

```java
@RightRelation(XxxInfoListAction.class)
@RestController("xxxinfoeditaction")
@Scope("request")
public class XxxInfoEditAction extends BaseController {
    @Autowired
    private IXxxInfoService service;

    private XxxInfo dataBean;

    @Override
    public void pageLoad() {
        String guid = getRequestParameter("guid");
        dataBean = service.getBeanByGuid(guid);
    }

    public void save() {
        dataBean.setOperatedate(new java.util.Date());
        if (userSession != null) {
            dataBean.setOperateusername(userSession.getDisplayName());
            dataBean.setOperateuserguid(userSession.getUserGuid());
        }
        service.update(dataBean);
        addCallbackParam("msg", "修改成功！");
    }
}
```

```java
@RightRelation(XxxInfoListAction.class)
@RestController("xxxinfodetailaction")
@Scope("request")
public class XxxInfoDetailAction extends BaseController {
    @Autowired
    private IXxxInfoService service;

    private XxxInfo dataBean;

    @Override
    public void pageLoad() {
        String guid = getRequestParameter("guid");
        dataBean = service.getBeanByGuid(guid);
        if (dataBean == null) {
            dataBean = new XxxInfo();
        }
    }
}
```

要点：

- 新增/编辑/详情常带 `@RightRelation(ListAction.class)`。
- 新增主键常用 `UUID.randomUUID().toString()`。
- 用户信息常用 `userSession.getDisplayName()`、`userSession.getUserGuid()`。
