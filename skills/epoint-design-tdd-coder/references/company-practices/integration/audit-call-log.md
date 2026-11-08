# 调用记录与审计留痕最佳实践

仅在需求明确出现“审计、留痕、调用记录、接口日志、入参、出参、调用状态、调用耗时、失败原因”等信号时使用。外部接口调用本身不自动等于必须新建日志表或日志列表。

## 判断规则

- 主业务只要求调用接口并返回结果：不默认写日志。
- 需求要求“记录本次调用”：围绕主动作写日志，日志写入失败默认不影响主业务返回。
- 需求要求“查看/查询/导出调用日志”：这已经是独立可验收结果，应有独立 Story 或独立入口。
- 已有日志表/实体/Service：优先复用；缺少已确认表字段时回上游补事实，不凭空建字段。

## 写入结构

```java
long startTime = System.currentTimeMillis();
String callStatus = "1";
String errorMessage = null;
String responseStr = null;
String inputParams = JSONObject.toJSONString(request);
try {
    responseStr = externalService.call(request);
    // 解析响应，失败时设置 callStatus / errorMessage，并 addCallbackParam
}
catch (Exception e) {
    callStatus = "0";
    errorMessage = e.getMessage();
    addCallbackParam("msg", "调用失败：" + errorMessage);
}
finally {
    long duration = System.currentTimeMillis() - startTime;
    try {
        ApiCallLogRecord logRecord = new ApiCallLogRecord();
        logRecord.setRowguid(UUID.randomUUID().toString());
        logRecord.setApiName("业务接口名称");
        logRecord.setApiMethod("POST");
        logRecord.setInputParams(inputParams);
        logRecord.setOutputParams(responseStr);
        logRecord.setDuration(duration);
        logRecord.setCallStatus(callStatus);
        logRecord.setErrorMessage(errorMessage);
        logRecord.setOperatedate(new Date());
        if (userSession != null) {
            logRecord.setOperateusername(userSession.getDisplayName());
            logRecord.setOperateuserguid(userSession.getUserGuid());
            logRecord.setOperateuserouguid(userSession.getOuGuid());
            logRecord.setOperateuserbaseouguid(userSession.getOuGuid());
        }
        logRecord.setYearflag(EpointDateUtil.getCurrentDate("yyyy"));
        commonService.insert(logRecord);
    }
    catch (Exception logEx) {
        // 日志失败默认隔离，不覆盖主业务返回
    }
}
```

> 说明：类名、字段名、公共字段和 commonService 名称以项目已有实体/Service 为准。示例只表达调用前后留痕和异常隔离结构。

## 日志字段建议

- 接口名称、接口路径或业务动作名。
- 请求方式、入参摘要、出参摘要。
- 调用状态、错误信息、耗时。
- 操作人、操作人 guid、组织 guid、操作时间、年份标识等项目公共字段。

## 脱敏与长度

- token、secret、密码、证书内容、身份证号、手机号等敏感值不要明文入库。
- 入参/出参较长时存摘要、截断值或业务关键字段，避免超字段长度。
- 日志异常不能覆盖主业务异常；主业务失败和日志失败要分开处理。

## 红线

- 不要把所有外部接口默认扩展成日志管理页。
- 不要为了“留痕”修改无关历史流程。
- 不要记录明文凭证。
- 不要让日志写入异常导致主业务成功回调丢失。
