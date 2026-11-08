# 资源配置写法示例

用于菜单权限、Action 权限、调度注册、MQ listener、安全放行、页面路径和敏感配置判断。先读 `references/config/resource-config-map.md`，本文件只给常见片段。

## 前置库/外部库配置读取

常见功能场景：

- 前置库定时同步：Service 读外部库，Job 定时调用 Service，失败写同步日志，后台手动补偿复用同一 Service。
- 前置库即时查询：列表页或选择弹窗实时查外部库，Action 仍返回 `DataGridModel`，查询细节放 Service。

配置文件常见位置：

```text
jdbc.properties
datasyncjdbc.properties
```

Java 取法示例，不要在最终回复输出真实 URL、账号、密码：

```java
DataSourceConfig sourceConfig = new DataSourceConfig(
        ConfigUtil.getConfigValue("jdbc", "xxxUrl"),
        ConfigUtil.getConfigValue("jdbc", "xxxUsername"),
        ConfigUtil.getConfigValue("jdbc", "xxxPassword"));
ICommonDao sourceDao = CommonDao.getInstance(sourceConfig);
```

如果项目把同步库单独分组，按本项目样例替换配置组：

```java
String url = ConfigUtil.getConfigValue("datasyncjdbc", "xxx_url");
String username = ConfigUtil.getConfigValue("datasyncjdbc", "xxx_username");
String password = ConfigUtil.getConfigValue("datasyncjdbc", "xxx_password");
```

要点：

- `jdbc.properties`/`datasyncjdbc.properties` 默认只读；不要新增或改账号密码。
- 同步类需求通常还要读 `quartz_data.xml`，但只有 cron 和注册意图明确才追加。
- 数据源 key、表/视图、同步方向、幂等键先从已确认资料、真实配置和源码查证；查不到时保留依赖该资料的任务缺口并继续其他任务，只询问资料无法回答的必要业务事实，不让用户决定技术写法。

## 固定参数/系统参数读取

常见功能场景：

- 第三方接口地址、平台地址、appKey 引用、超时时间、业务开关、默认值。
- 附件预览开关、项目页面路径等框架能力校验。

常见配置文件：

```text
epointframe.properties
tbhub.properties
zwbgcheck.properties
sdkconfig.properties
thirdsdkconfig.properties
其他业务专属 *.properties
```

Java 取法示例：

```java
String sysurl = ConfigUtil.getConfigValue("sysurl");
String apiUrl = ConfigUtil.getConfigValue("tbhub", "tbhuburlnew");
String appKey = ConfigUtil.getConfigValue("tbhub", "appkeynew");
String frameValue = ConfigUtil.getFrameConfigValue("xxxKey");
```

有些项目封装了配置服务，跟项目样例：

```java
String ownsysurl = configService.getFrameConfigValue("ownsysurl");
```

要点：

- 环境地址、开关、阈值不写死在 Java/HTML/JS。
- 新增配置 key 前必须确认配置文件、key 名、默认值和是否含敏感信息。
- `projectPagePath` 只用于校验页面根路径，生成文件路径以工程导航契约为准。

## 业务配置表维护

常见功能场景：

- 业务人员维护多条规则、模板、映射、推送系统、事项与系统关系。
- 运行逻辑按事项、区域、系统、状态、优先级等条件查生效配置。

需求判断：

```text
“是否推送第三方由配置控制”
- 如果是一个全局开关：系统参数。
- 如果不同事项/区域/系统不同：业务配置表。

“维护推送系统，办件按事项推给不同系统”
- 推送系统：业务配置表。
- 事项到系统：映射配置表。
- token/clientId/clientSecret：外部凭证字段或既有配置来源。
```

页面示例，字段名只表示写法，不是公司固定字段：

```html
<input id="name" class="mini-textbox" bind="dataBean.name" required="true" />
<input id="push_url" class="mini-textbox" bind="dataBean.push_url" required="true" />
<input id="status" class="mini-radiobuttonlist" bind="dataBean.status"
       action="getEnableModel" required="true" />
```

Action 代码项示例：

```java
public List<SelectItem> getEnableModel() {
    return DataUtil.convertMap2ComboBox(
            (List<Map<String, String>>) CodeModalFactory.factory("下拉列表", "是否", null, false));
}
```

运行逻辑示例：

```java
SqlConditionUtil condition = new SqlConditionUtil();
condition.eq("themebaseinfoid", taskId);
condition.eq("status", "1");
ItemToSystemInfo mapping = itemToSystemInfoService.find(condition.getMap());
if (mapping != null) {
    PushSystemInfo systemInfo = pushSystemInfoService.find(mapping.getSystem_guid());
    if (systemInfo != null && "1".equals(systemInfo.getStatus())) {
        // 读取凭证、调用第三方、写业务日志；不要在日志中输出敏感值
    }
}
```

要点：

- 多条业务规则不要写进 `properties`。
- 只生成维护页不够，还要生成业务运行时查询生效配置的 Service 逻辑。
- 配置唯一性、生效范围、是否启停、是否保留历史不明确时先问。

## 外部凭证和 token

常见功能场景：

- 第三方接口认证、token 获取/刷新、签名、clientId/clientSecret、证书。
- 多个接入方各自有不同账号、token 地址、接口地址。

全局单套凭证按系统参数配置理解，Coder 再按项目样例从配置服务或既有配置文件读取：

```java
String tokenUrl = ConfigUtil.getConfigValue("thirdsdkconfig", "xxxTokenUrl");
String clientId = ConfigUtil.getConfigValue("thirdsdkconfig", "xxxClientId");
String clientSecret = ConfigUtil.getConfigValue("thirdsdkconfig", "xxxClientSecret");
String token = tokenService.getToken(tokenUrl, clientId, clientSecret);
```

多接入方凭证通常随业务配置记录维护：

```java
String token = getToken(systemInfo.getToken_url(),
        systemInfo.getClientId(), systemInfo.getClientSecret());
headers.put("Authorization", "Bearer " + token);
```

要点：

- 不问用户“密钥放哪个文件”；需求阶段先判断全局单套还是多接入方，Coder 阶段再定位 key、配置组和读取方式。
- 不在最终回复、日志、测试数据里输出真实 token、secret、密码、证书内容。
- token 获取失败要有业务后果：阻断、跳过、写失败日志或进入补偿，不能静默吞掉。

## RabbitMQ 连接配置读取

常见功能场景：

- 发送 MQ 消息。
- 监听外部队列，消费后落库或触发补偿。

常见配置文件：

```text
rabbitmq.properties
zwfwmq.properties
spring/appcontext-rabbitmq.xml
spring/rabbitmq-task.xml
```

连接参数读取示例：

```java
String host = ConfigUtil.getConfigValue("rabbitmq", "PRODUCER_HOST");
String username = ConfigUtil.getConfigValue("rabbitmq", "USERNAME");
String password = ConfigUtil.getConfigValue("rabbitmq", "PASSWORD");
```

要点：

- `rabbitmq.properties` 只读连接信息，不输出真实 host/user/password。
- 新增 listener 注册只按本项目 XML 样例追加，必须确认 queue、exchange、routing key、ack 策略。
- Listener 入口只解析和派发，业务处理、幂等和失败日志放 Service。

## epointsecurity.properties

用户明确要求按钮权限或 Action 权限时才考虑追加：

```properties
xxxinfosecurity=xxxinfolistaction;xxxinfoaddaction;xxxinfoeditaction;xxxinfodetailaction
```

要点：

- key 通常是权限组名，value 是分号分隔 Action bean。
- 必须确认权限组、菜单归属、按钮权限要求。
- 普通 CRUD 默认不改 `epointsecurity.properties`。

## module_data.xml

不是所有项目都有，先用工程导航契约或 `rg --files` 定位；找不到不能猜。

处理规则：

- 只在用户明确要求挂菜单、模块入口、初始化菜单时改。
- 复制本项目同文件相邻菜单条目的 XML 结构。
- 只替换编码、名称、URL、父节点、排序等已确认字段。
- 不重排全文件，不把别的项目 XML 套过来。

## quartz_data.xml

见 `references/integration/job-mq.md`。只有用户确认 cron 和注册意图后追加。

## spring/appcontext-rabbitmq.xml

见 `references/integration/job-mq.md`。只有队列、exchange、routing key、listener ref/class 明确后追加。

## EpointSecurityConfig.properties

用于安全过滤、白名单、SQL skip 等。用户说“免登录”“接口放行”“白名单”时必须高风险处理。

处理规则：

- 默认只读定位并提示风险。
- 必须确认放行 URL、原因、影响范围和是否允许未登录访问。
- 不把列表接口为了调通随手加入白名单。
- 不在最终回复输出配置里的 token、密钥、内网地址。

## epointframe.properties

常见关注项：

```properties
projectPagePath=qhzwfw
```

处理规则：

- 生成页面路径优先看工程导航契约，`projectPagePath` 只作校验。
- 普通管理端页面不改此文件。
- 上传预览、加密、启动开关属于高风险或环境项，必须明确确认后才改。

## 外部数据源、加密、License、SSO

常见文件：

```text
jdbc.properties
datasyncjdbc.properties
encryption.properties
*.lic
EpointSSOClient.properties
MultiEpointSSOClient.properties
EpointSSOServer.xml
```

处理规则：

- 默认只读，不写入。
- 不输出账号、密码、密钥、License、内网连接串。
- 数据同步功能优先调用项目已有 Service/SDK，不直接改连接配置。
