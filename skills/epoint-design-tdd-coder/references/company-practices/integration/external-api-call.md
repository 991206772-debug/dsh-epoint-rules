# 外部接口调用最佳实践

用于需求明确出现“外部接口、第三方接口、平台接口、HTTP/API、同步接口、回调”等信号时。“调阅/检索”只有明确来源是外部平台或第三方接口时才算命中；普通本地查询、列表筛选、数据库检索不要默认引入外部接口调用。

## 读取顺序

1. 先看 Builder、复用卡、用户或 scan 是否给了本项目同类工具类/Action 的精确路径；没有精确路径时，用外部接口名、骨架 Action 或 Service 绑定作为锚点检索当前工程相近实现，命中后停止。
2. 若项目已确认引入 Hutool，可优先沿用 `HttpUtil.createPost(...).form(...).timeout(...).execute()` 这类项目样例。
3. 再读 `references/company-practices/config/resource-config-map.md`，确认接口地址、token、appKey、secret、证书等来源。
4. 最后按 Action -> Service/Util -> 外部接口 -> 响应解析 -> addCallbackParam 的链路补代码。

## 推荐分层

- HTML/JS：只调用本项目 Action，例如 `epoint.execute('queryXxx', '@none', [arg1, arg2], callback)`；不要从页面直连第三方地址。
- Action：校验页面参数、读取 userSession/上下文、调用 Service/Util、解析业务返回并 `addCallbackParam`。
- Service/Util：封装外部 HTTP 调用、请求参数转换、超时、异常、状态码、空响应和业务失败处理。
- Config：地址、凭证、固定系统参数只来自项目配置、系统参数、接口文档或已确认事实。

## Hutool 调用样例

项目已引入 Hutool 时，可按这种结构写公共调用方法：

```java
private static String sendPostForm(String baseUrl, String apiPath, Map<String, Object> paramMap) {
    String activeBaseUrl = StrUtil.blankToDefault(baseUrl, "");
    if (StrUtil.isBlank(activeBaseUrl)) {
        throw new IllegalArgumentException("缺少外部接口基础地址");
    }
    String activeApiPath = StrUtil.nullToEmpty(apiPath);
    String url = activeBaseUrl.endsWith("/") || activeApiPath.startsWith("/")
            ? activeBaseUrl + activeApiPath
            : activeBaseUrl + "/" + activeApiPath;
    try {
        HttpResponse response = HttpUtil.createPost(url)
                .form(paramMap)
                .timeout(15000)
                .execute();
        if (response == null) {
            throw new RuntimeException("接口无响应");
        }
        String responseBody = response.body();
        if (response.getStatus() < 200 || response.getStatus() >= 300) {
            throw new RuntimeException("接口 HTTP 状态异常：" + response.getStatus());
        }
        return responseBody;
    }
    catch (Exception e) {
        throw new RuntimeException("外部接口调用异常：" + e.getMessage(), e);
    }
}
```

> 说明：示例只固定“项目 Hutool 调用结构”，不固定业务接口路径、token、字段名或状态码语义。

## Action 闭合样例

```java
public void queryExternalResult(String certType, String holderCode) {
    if (StringUtil.isBlank(certType) || StringUtil.isBlank(holderCode)) {
        addCallbackParam("msg", "缺少必要参数");
        return;
    }
    String responseStr = externalService.query(certType, holderCode);
    if (StringUtil.isBlank(responseStr)) {
        addCallbackParam("msg", "外部接口未返回数据");
        return;
    }
    // 响应字段必须来自接口文档、项目样例或需求事实；这里只演示“已确认 head/status/data 结构”的写法。
    JSONObject jsonObject = JSONObject.parseObject(responseStr);
    JSONObject head = jsonObject == null ? null : jsonObject.getJSONObject("head");
    if (head == null || head.getIntValue("status") != 0) {
        addCallbackParam("msg", head == null ? "解析外部接口返回失败" : head.getString("message"));
        return;
    }
    addCallbackParam("data", jsonObject.get("data"));
    addCallbackParam("msg", "调用成功");
}
```

## 场景边界

- 只要求“调用第三方校验并返回通过/不通过”：只做外部接口卡，不默认加审计日志或结果列表。
- 需求明确“记录调用日志、入参出参、调用状态、耗时”：再读 `audit-call-log.md`。
- 需求明确“展示外部接口结果列表、临时结果面板/弹窗、预览、下载”：再按 `frontend/legacy-miniui-best-practices.md` 的 BP-04/BP-05/BP-13 做页面交互边界；涉及附件/文件预览下载时读 `attachment-index.md`。

## 红线

- 不要在前端写第三方接口 URL、token、appKey、secret。
- 不要把接口地址、凭证、默认 token 写死到新增代码里。
- 不要凭接口名称猜响应字段；响应结构必须来自接口文档、项目样例或需求事实。
- 不要把外部调用直接写成普通 Spring Boot Controller 风格；Action/Service 分层按项目框架。
- 不要把接口调用异常静默吞掉；必须返回明确失败信息或按需求进入补偿/日志。
