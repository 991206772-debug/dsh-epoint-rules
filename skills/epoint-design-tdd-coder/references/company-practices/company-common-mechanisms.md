# 公司常用机制识别

用于需求分析和代码生成前的“公司手段”判断。它解决的是：一个需求到底该用代码项、系统参数、业务配置、外部凭证、配置文件、前置库、事务、附件、日志审计、权限，还是普通字段/普通 CRUD。

使用链路：

```text
需求描述 -> 能力域 -> 公司常用机制 CM -> GP 最佳实践 -> BP 页面动作 -> 文件层细责
```

内部拆解格式：

```text
需求信号：状态下拉、接口地址可配置、从前置库读取、主从一起保存
命中机制：CM-01 代码项 + CM-02 系统参数 + CM-04 前置库 + CM-05 事务
影响：
- 代码项：页面 action=getStatusModel，Action 补 getStatusModel()
- 系统参数：地址不硬编码，读取 ConfigUtil 或项目配置样例
- 前置库：读取 jdbc 配置，DataSourceConfig/CommonDao 访问外部库
- 事务：主从保存同一事务，失败回滚
阻断：配置 key、前置库连接、事务边界不明确时先问
```

## 需求语义分流

用户通常不会说“用代码项/系统参数/业务配置”。LLM 按业务要求和已有证据识别公司能力，再按当前阶段交接事实或实现；机制名称和下表信号只是检索导航，不证明当前产品/版本已有该功能。用户明确说明、适用规则正文或真实源码可作为依据；已确认事实直接复用，只对当前缺口取证。需求阶段只保留业务范围和来源，Coder 才核对配置 key 与 API 签名。

区分交付范围：平台现成代码项、角色和菜单管理只需配置，不新建管理页面；业务页面使用代码项、附件或会话 API 时，仍须开发自己的绑定、保存、校验和联动；事项/区域映射、生效规则等定制业务不能仅因包含“配置、权限、菜单”就当作现成。现有能力只覆盖部分时，复用该部分，开发剩余行为，不重造底层能力，也不省略需求。

| 用户真实需求信号 | 应识别为 | 为什么 | 不该问用户什么 | 该确认/交接什么 |
| --- | --- | --- | --- | --- |
| “这个字段是下拉”“来源要显示中文”“列表里把 1/2 转成名称”“是否/类型/渠道/证照类型” | CM-01 代码项 | 这是稳定选项来源和展示转义 | 不问 `CodeItemID`、不要求用户说技术名 | 代码项名称、真实字段名、是否已有项目样例；前端 `action=getXxxModel` 与 Action 方法闭合 |
| “这个地址以后会变”“固定账号/令牌/外部调用凭证”“某功能可开关”“默认值/阈值/超时可配置”“不同环境不同值” | CM-02 系统参数 | 这是全局单值可配置事实，不是业务维护表 | 不让用户设计配置表；需求阶段不问 key/文件名 | 需求阶段交接系统参数配置语义；Coder 阶段按 CM-02 定位已有 key/配置组/默认值，保留具体缺口，不扩大为整需求停工 |
| “不同系统/事项/区域有不同规则”“要维护模板/映射/推送系统”“业务人员能新增修改规则”“配置生效/停用” | CM-13 业务配置 | 这是多条业务记录，由业务人员维护，并被运行逻辑查询 | 不把它粗暴写进 properties，也不当代码项 | 谁维护、唯一性、生效范围、生效时间/状态、运行逻辑如何匹配 |
| “调用第三方要 token/appKey/clientId/secret/证书/签名”“接口失败怎么办”“token 失效重取” | CM-14 外部凭证 | 这是接入认证材料，敏感且影响失败策略；全局固定凭证通常按系统参数配置理解，多接入方才进入业务配置 | 不问用户把 token 放哪个文件、不让用户明文贴密钥 | 需求阶段只确认全局固定还是按主体分套、失败业务后果；Coder 阶段定位凭证来源、缓存/刷新和读取方式 |
| “从前置库/共享库/中台库取数”“同步外部数据”“跨库查事项/人员/项目” | CM-04 前置库/外部数据源 | 数据归属在外部库，需要连接配置、同步方向和幂等 | 不让用户提供数据库账号密码 | 数据归属、表/视图、同步方向、主键/幂等键、失败后果、是否落本地库 |

### 分流例子

| 需求句子 | LLM 内部判断 |
| --- | --- |
| “列表加个来源筛选，保存编码，页面显示来源名称” | 代码项；生成 `mini-combobox action=getSourceModel`，列表展示用代码项转义，Action 补 `getSourceModel()` |
| “是否推送第三方由配置控制” | 如果只有一个全局开关，用系统参数配置；如果不同事项/系统/区域各自配置，用业务配置表 |
| “维护推送系统，办件按事项推给不同系统” | 业务配置 + 外部凭证 + 日志审计；系统地址/token 地址/clientId/clientSecret 是配置记录字段或既有配置来源，推送失败要记日志 |
| “每天凌晨从前置库同步事项，失败能补偿” | 前置库 + Job + 幂等日志 + 可选补偿页；缺数据源 key、表、幂等键、cron 时问 |
| “接口要支持免登录回调” | 高风险安全配置；默认只读定位，确认 URL、原因、范围和风险接受后才改 |

## 机制索引

| 编号 | 机制 | 何时使用 | 需求信号 |
| --- | --- | --- | --- |
| CM-01 | 代码项 | 固定枚举、状态、类型、是否、类别，页面需要下拉/单选/中文展示 | 状态、类型、是否、类别、下拉、单选、显示中文 |
| CM-02 | 系统参数 | 环境可变、运维可调、地址/开关/阈值/默认值 | 可配置、开关、默认值、地址、超时、阈值、平台地址 |
| CM-03 | resources 配置文件 | 菜单、权限、Quartz、MQ、安全、SSO、数据源等需要注册或框架加载 | 挂菜单、cron、队列、免登录、白名单、数据源 |
| CM-04 | 前置库/外部数据源 | 从同步库、共享库、前置库、第三方库读取或写入 | 前置库、同步库、共享库、中台库、外部数据库 |
| CM-05 | 事务 | 一次操作跨多表、主从保存、批量状态、多步骤同步，失败要回滚 | 同时保存、明细一起保存、失败回滚、批量处理 |
| CM-06 | 附件机制 | 上传、预览、下载、材料、证照、模板、OFD/PDF | 附件、材料、上传、预览、下载、模板 |
| CM-07 | 用户会话/组织区域 | 按登录人、部门、区域、权限范围过滤或写创建人 | 当前用户、登录人、区域、部门、所属机构 |
| CM-08 | 菜单/按钮权限 | 后台入口、按钮权限、角色可见、模块注册 | 菜单、入口、权限、按钮权限、角色 |
| CM-09 | 定时/补偿 | 定时同步、失败重试、手动补偿 | 每天凌晨、定时、补偿、重试、Quartz |
| CM-10 | MQ/异步消息 | 队列监听、消息发送、外部变更通知 | MQ、RabbitMQ、队列、监听、消息 |
| CM-11 | 幂等/日志审计 | 外部同步、发布、撤回、作废、接口回调、补偿 | 幂等、重复推送、记录日志、审计、追踪 |
| CM-12 | 配置高风险边界 | SSO、安全放行、数据库账号、加密、License、日志核心配置 | SSO、免登录、白名单、SQL skip、账号、密钥、License |
| CM-13 | 业务配置 | 业务人员维护多条规则、模板、映射、接入方、按状态生效 | 规则配置、模板维护、映射维护、推送系统、按事项/区域配置 |
| CM-14 | 外部凭证 | 第三方接口认证、token、clientId/clientSecret、证书、签名 | token、appKey、clientId、secret、证书、签名、凭证 |

## 何时使用快速判定

LLM 先按这张表做判断。命中“使用条件”就启用对应机制；命中“先问/阻断”就不要直接写代码。

| 机制 | 遇到这些情况就用 | 不要用在 | 先问/阻断点 |
| --- | --- | --- | --- |
| CM-01 代码项 | 稳定枚举；使用现成代码项管理配置取值；业务页面选择或翻译编码 | 选项来自业务记录或外部接口；有定制生效/关联逻辑的业务配置 | 名称或取值未确认时保留具体缺口；没有同名代码项不代表要开发代码项管理 |
| CM-02 系统参数 | 值会因环境、地区、运维调整变化；接口地址、开关、阈值、默认值不能写死 | 普通业务字段；每条记录都不同的业务数据 | 配置 key、默认值、归属配置文件不明确；包含密钥/账号 |
| CM-03 resources 配置文件 | 框架需要注册：菜单、Quartz、MQ listener、安全放行、SSO、数据源 | 普通 CRUD、普通页面字段、普通 Service 方法 | cron、队列、菜单编码、白名单路径、安全风险未确认 |
| CM-04 前置库/外部数据源 | 数据来自前置库/共享库/同步库/第三方库；需要跨库查询或同步落库 | 本系统业务表已有数据；只是普通字典或代码项 | 数据源 key、表/视图、同步方向、主键/幂等键不明确 |
| CM-05 事务 | 主从一起保存；批量跨表；发布/同步多步骤；失败要整体回滚 | 单表简单保存；只读查询 | 事务边界不清；是否允许部分成功不明确 |
| CM-06 附件机制 | 上传、预览、下载、材料、证照、模板、OFD/PDF | 只是存一个外部 URL；不需要公司附件服务 | 附件类型、数量、是否只读、GUID 来源不明确 |
| CM-07 用户会话/组织区域 | 需要当前用户、创建人、修改人、区域、部门、权限范围 | 用户可自由填写的普通字段 | 区域字段、组织来源、权限范围不明确 |
| CM-08 菜单/按钮权限 | 用户明确说挂菜单、后台入口、按钮权限、角色可见 | 只是页面上加一个按钮，不涉及权限控制 | 菜单编码、父节点、权限组、按钮编码不明确 |
| CM-09 定时/补偿 | 定时同步、每天凌晨、失败补偿、手动重试 | 用户只要手动按钮，不需要自动执行 | cron、是否注册调度、补偿范围不明确 |
| CM-10 MQ/异步消息 | RabbitMQ/队列监听/消息发送/外部变更消息 | 普通同步接口调用；页面按钮触发即可完成 | 队列、exchange、routing key、消息体、幂等键不明确 |
| CM-11 幂等/日志审计 | 外部同步、MQ、定时、接口回调、发布撤回、补偿需要可追踪 | 普通页面查询；无需追踪的只读动作 | 幂等键、日志表/日志方式、敏感字段脱敏不明确 |
| CM-12 配置高风险边界 | SSO、免登录、白名单、XSS、SQL skip、数据库账号、密钥、License | 普通业务配置、普通页面按钮 | 未获得明确确认；路径/环境/风险接受不明确 |
| CM-13 业务配置 | 多条配置记录；业务人员维护规则/模板/映射/接入方；按状态、区域、事项、时间生效 | 单个环境开关；稳定枚举选项；外部数据库连接串 | 谁维护、唯一性、生效状态、匹配条件、是否需要历史记录不明确 |
| CM-14 外部凭证 | 第三方认证、token 获取/刷新、签名、clientId/clientSecret、证书 | 普通业务字段；代码项；无认证的公开接口 | 凭证来源、刷新策略、失败业务后果、敏感值存放边界不明确 |

## 需求措辞到机制

| 用户可能这么说 | LLM 应识别 |
| --- | --- |
| “状态下拉”“是否启用”“类型单选”“列表显示状态名称” | CM-01 代码项，通常再命中 GP-06、BP-08 |
| “这个地址以后可能换”“做成开关”“默认值可配置”“超时时间” | CM-02 系统参数，必要时 CM-03 |
| “挂菜单”“配置按钮权限”“每天凌晨跑”“监听队列”“接口免登录” | CM-03 resources 配置文件，并按 GP-10/11/12/14/15 判断 |
| “从前置库取”“同步共享库”“读中台库数据” | CM-04 前置库/外部数据源，通常还要 CM-11 幂等日志 |
| “主表和明细一起保存”“失败全部回滚”“批量发布要么全成功” | CM-05 事务 |
| “附件上传”“材料预览”“模板下载”“证照 OFD/PDF” | CM-06 附件机制 |
| “按当前登录人”“按所属区域”“只看本部门” | CM-07 用户会话/组织区域 |
| “失败可补偿”“重复推送不要重复处理”“记录同步日志” | CM-09 定时/补偿 + CM-11 幂等/日志审计 |
| “SSO”“白名单”“免登录”“数据库账号”“License” | CM-12 高风险配置边界，默认只读定位并询问 |
| “维护规则/模板/映射”“不同事项对应不同系统”“业务人员配置生效” | CM-13 业务配置，通常再命中 GP-16，维护页细节复用 GP-01/02/04 |
| “token”“clientId”“clientSecret”“appKey”“证书”“签名” | CM-14 外部凭证 + CM-12 高风险边界，通常再命中 GP-17，必要时 CM-02/CM-13 |

## 高频功能场景联动

需求分析阶段先用这张表做“场景联想”。例如用户只说“从前置库同步事项”，LLM 不能只命中 CM-04，还要继续判断是否常见地联动 Job、补偿、幂等日志和配置边界。

| 功能场景 | 常联动机制 | 常读配置/文件 | 生成代码时的重点 |
| --- | --- | --- | --- |
| 前置库定时同步 | CM-04 前置库 + CM-09 定时/补偿 + CM-11 幂等日志 + CM-12 配置边界 | `jdbc.properties`/`datasyncjdbc.properties` 只读；需要自动调度时读 `quartz_data.xml` | Service 通过 `ConfigUtil + DataSourceConfig + CommonDao` 读外部库；Job 调 Service；后台补偿页复用 Service；缺数据源 key、表、幂等键、cron 就问 |
| 前置库即时查询/选择 | CM-04 前置库 + CM-02 系统参数可选 + CM-11 日志可选 | `jdbc.properties`/`datasyncjdbc.properties` 只读 | SelectAction/ListAction 返回 `DataGridModel`；Service 做外部库查询；数据量大或查询频繁时提示是否落本地库 |
| 第三方接口核验/推送 | CM-02 系统参数 + CM-11 幂等日志 + CM-12 配置边界 | `tbhub.properties`、`zwbgcheck.properties`、`sdkconfig.properties`、`thirdsdkconfig.properties`、`epointframe.properties` | endpoint/appKey/超时从配置取；Service 负责签名、请求、失败日志；账号密钥不输出 |
| 固定参数/业务开关 | CM-02 系统参数 + CM-03 配置文件 | `epointframe.properties` 或业务 `*.properties` | 先搜本项目已有 key；通过 `ConfigUtil.getConfigValue`/`getFrameConfigValue` 读取；key 和默认值不明确时问 |
| 附件材料上传预览 | CM-06 附件 + CM-12 配置边界 | `epointframe.properties` 的 `uploadpreview.*`、`tc.properties`、`encryption.properties` | 页面用公司上传控件；Action 稳定返回上传模型；配置只读参考，预览/加密开关不随手改 |
| 每日批处理/失败补偿 | CM-09 定时/补偿 + CM-11 幂等日志 | `quartz_data.xml`、`spring/appcontext-epointjob.xml` | 业务逻辑放 Service；Job/手动按钮共用；cron 不明确不注册 |
| MQ 外部消息 | CM-10 MQ + CM-11 幂等日志 + CM-12 配置边界 | `rabbitmq.properties`、`spring/appcontext-rabbitmq.xml`、`spring/rabbitmq-task.xml` | Listener 解析消息后调 Service；确认 queue/exchange/routing/ack；幂等和失败日志必须有 |
| 挂菜单/按钮权限 | CM-08 菜单权限 + CM-03 配置文件 | `module_data.xml`、`epointsecurity.properties` | 先闭合页面和 Action；菜单编码、父节点、权限组明确后才追加配置 |
| 免登录/SSO/安全放行 | CM-12 配置高风险边界 | `EpointSecurityConfig.properties`、SSO/Login 配置 | 默认只读定位；确认 URL、原因、影响范围和风险接受后才改 |
| 业务规则/模板/映射维护 | CM-13 业务配置 + CM-01 代码项可选 + CM-05 事务可选 | 本业务表、Entity、CRUD 页面；不要默认改 properties | 生成管理端维护页；Service 按状态/范围/优先级查询生效配置；缺唯一性/生效范围就问 |
| 多接入方第三方推送 | CM-13 业务配置 + CM-14 外部凭证 + CM-11 幂等日志 + CM-02 系统参数可选 | 业务配置表或既有配置 Service；`*.properties` 只读参考 | 配置页维护接入方；运行逻辑读取配置获取 token 并推送；失败写日志；敏感字段不在最终回复展开 |

## CM-01 代码项

字段名说明：

- 本节示例里的字段名只用于说明写法，不代表公司固定字段。
- 遇到“状态、是否、类型、类别”时，先判断它是不是稳定枚举，再按当前项目字段/表结构/业务语义确定真实字段名。
- 例如“是否启用”在不同项目里可能叫 `isuse`、`validflag`、`enableflag`、`usestatus`；“发布状态”可能叫 `publishstate`；“审核状态”可能叫 `auditstatus`。不要因为示例里出现 `status` 就统一生成 `status`。

何时使用：

- 字段值是稳定枚举，且多个页面可能复用。
- 页面需要下拉、单选、列表/详情展示中文。
- 常见字段：状态、是否、类型、类别、来源、级别。

需求分析判断：

- 先判断是否为稳定枚举，复用已确认代码项名称、取值及项目样例，不因字段名推断。
- 平台已有代码项管理时，人工维护枚举取值仍可通过现成功能配置，维护频率不是另建表或管理页的依据；只有选项本身是独立业务记录或有定制关系、生效规则时才评估业务配置。
- 代码项展示和选择必须同时考虑前端和 Action 方法。

页面/Action 示例：

```html
<!-- 以“是否启用”字段 enableflag 为例；真实字段名按项目和业务确定 -->
<input class="mini-combobox" bind="enableflag" action="getEnableFlagModel"
       textField="text" valueField="id" />
<div field="enableflag" data-options="{code:'是否'}">是否启用</div>
```

```java
public List<SelectItem> getEnableFlagModel() {
    return DataUtil.convertMap2ComboBox(
            CodeModalFactory.factory("下拉列表", "是否", null, false));
}
```

红线：

- 不在 JS 里手写中文枚举映射。
- `action="getXxxModel"` 必须补 Java Action public 方法。

## CM-02 系统参数

何时使用：

- 值随环境变化或运维调整：平台地址、接口地址、固定账号/令牌/外部调用凭证引用、开关、超时时间、默认区域、阈值。
- 不能写死在 Java/HTML 中，尤其是 URL、appKey、开关。

需求分析判断：

- 需求阶段：用户说“固定值/可配置/平台地址/固定账号令牌/开关/默认值/环境不同”，优先识别为系统参数配置，只交接机制事实，不问配置 key、配置组、文件名或读取方式。
- Coder 阶段：按主 Skill 的技术查证顺序定位参数 key、默认值和归属配置；查不到时只保留依赖该参数的任务缺口并继续其他任务，不凭空创造 key 或默认值。业务取值或配置写入确需用户授权时只确认该事项，不申请编码卡或逐批确认。
- 涉及账号、密码、token、密钥时只读定位，不在回复、日志或测试数据里输出原文。

示例：

```java
String tbhubUrl = ConfigUtil.getConfigValue("tbhub", "tbhuburlnew");
String appKey = ConfigUtil.getConfigValue("tbhub", "appkeynew");
String sysurl = ConfigUtil.getConfigValue("sysurl");
```

红线：

- 不把环境地址、密钥、开关硬编码进业务代码。
- 新增配置 key 前先确认归属配置文件和默认值。

## CM-03 resources 配置文件

何时使用：

- 框架需要注册或加载：菜单、按钮权限、Quartz、MQ listener、安全放行、SSO、数据源、日志核心配置。

需求分析判断：

- 普通 CRUD 不默认改 `resources`。
- 只在用户明确要求注册菜单、调度、MQ、安全放行等时进入配置写入判断。
- 高风险配置先读 `references/config/resource-config-map.md`，再问关键参数。

红线：

- 不重排整个配置文件。
- 不输出账号、密码、密钥、token、License、内网连接串。
- 没有 cron/队列/exchange/routing key/菜单编码/白名单路径时阻断。

## CM-04 前置库/外部数据源

何时使用：

- 需求说从前置库、共享库、同步库、中台库、第三方库读取或写入。
- 本业务库没有数据，需要跨库查询或同步。

需求分析判断：

- 先判断是只读查询、同步落库，还是双写。
- 连接信息来自配置文件，不在代码中写死。
- 要确认数据源名称、表/视图、主键/幂等键、同步方向。

示例：

```java
DataSourceConfig sourceConfig = new DataSourceConfig(
        ConfigUtil.getConfigValue("jdbc", "sxzxUrl"),
        ConfigUtil.getConfigValue("jdbc", "sxzxUsername"),
        ConfigUtil.getConfigValue("jdbc", "sxzxPassword"));
ICommonDao baseDao = CommonDao.getInstance(sourceConfig);
```

红线：

- 前置库账号密码不得出现在最终回复。
- 不明确数据源 key、表名、同步方向时不生成跨库写入。

## CM-05 事务

何时使用：

- 主表和明细一起保存。
- 批量操作跨多表。
- 同步/发布需要多步骤全部成功。
- 用户明确说失败回滚、全部成功才算成功。

需求分析判断：

- 单表普通保存不强行加复杂事务。
- 跨多表/主从/附件元数据/日志状态一起写时必须识别事务。
- 优先跟项目样例：有的模块用 `@Transactional`，有的用 `commonDao.beginTransaction()`。

示例 1：注解事务

```java
@Transactional(rollbackFor = Exception.class)
public void saveMainAndDetails(Main main, List<Detail> details) {
    saveMain(main);
    saveDetails(main.getRowguid(), details);
}
```

示例 2：项目常见手动事务

```java
try {
    commonDao.beginTransaction();
    commonDao.insert(main);
    for (Detail detail : details) {
        commonDao.insert(detail);
    }
    commonDao.commitTransaction();
}
catch (Exception e) {
    commonDao.rollBackTransaction();
    throw e;
}
```

红线：

- 主从保存不能只保存主表。
- 事务内不要吞异常；失败要回滚并返回明确错误。

## CM-06 附件机制

何时使用：

- 附件、材料、证照、模板、OFD/PDF 预览、下载。

需求分析判断：

- 附件上传按项目高频使用 `mini-webuploader`。
- 新增页附件 GUID 需要 `!isPostback()` 生成并 `addViewData`；postback 要恢复。
- 编辑页优先复用库中 GUID；详情页只读预览。

必须读取：

- `references/integration/attachment-index.md`
- `references/integration/import-export.md`
- 涉及手风琴附件再读 `references/frontend/legacy-miniui-best-practices.md` 的 BP-11。

红线：

- 不自造上传接口。
- `getXxxFileUploadModel()` 不反复生成新 GUID。

## CM-07 用户会话/组织区域

何时使用：

- 需要当前登录人、区域、部门、所属机构、创建人、修改人、按区域过滤。

需求分析判断：

- 创建/修改信息按项目样例写入。
- 区域/部门过滤必须确认字段来源和权限范围。
- 前端传来的用户/区域不能作为最终可信来源，后端用 `UserSession` 或项目会话类兜底。

示例：

```java
String regioncode = ZwfwUserSession.getInstance().getAreaCode();
String userguid = UserSession.getInstance().getUserGuid();
String username = UserSession.getInstance().getDisplayName();
```

红线：

- 不让前端隐藏字段决定最终用户身份。
- 不跨区域查询未授权数据。

## CM-08 菜单/按钮权限

何时使用：

- 挂后台菜单、增加模块入口、按钮权限、角色可见。

需求分析判断：

- 平台角色与菜单管理已确认存在时，仅整理具体配置要求，不另写角色或菜单管理功能；业务页面及后台仍须落实访问范围和无权拒绝。
- 菜单编码、父节点、排序、权限组、按钮编码沿用已确认配置；不确定时保留受影响配置项，继续其他可执行任务。
- 只加页面按钮不等于改权限配置；需要用户明确要求。
- 配置写入读 `resource-config-map.md`。

红线：

- 不凭空编菜单编码。
- 不把安全放行当按钮权限处理。

## CM-09 定时/补偿

何时使用：

- 定时同步、每天凌晨、失败补偿、手动补偿、Quartz。

需求分析判断：

- 业务逻辑放 Service，Job 和手动补偿复用。
- 失败要记录日志/状态，支持重试或排查。
- cron 不明确时不改 `quartz_data.xml`。

必须读取：

- `references/integration/job-mq.md`
- `references/config/resource-config-map.md`

## CM-10 MQ/异步消息

何时使用：

- RabbitMQ、队列监听、消息发送、外部变更通知。

需求分析判断：

- 先确认队列、exchange、routing key、消息体格式。
- Listener 只做入口，业务处理放 Service。
- 必须考虑幂等、失败日志和补偿。

红线：

- 不凭空编队列名。
- 不只写 listener 不做幂等。

## CM-11 幂等/日志审计

何时使用：

- 对外接口、外部同步、MQ、定时任务、发布/撤回/作废、补偿。

需求分析判断：

- 外部请求要有业务唯一键或 traceId/txId。
- 同步类需求要记录来源、状态、失败原因、重试次数、最后步骤。
- 普通 CRUD 操作日志按项目已有日志/审计表样例处理。

红线：

- 不能只 `log.info` 而没有可追踪业务状态。
- 日志里不输出敏感参数、密钥、完整身份证/手机号等敏感信息。

## CM-12 配置高风险边界

何时使用：

- SSO、登录、安全放行、白名单、SQL skip、XSS、数据库账号、加密、License、日志核心配置。

需求分析判断：

- 默认只读定位和说明风险。
- 用户明确确认后按项目样例最小变更。
- 缺路径、环境、风险接受时阻断。

红线：

- 不把高风险配置当普通业务代码改。
- 不在最终回复中原文输出敏感配置值。

## CM-13 业务配置

何时使用：

- 需求说“配置维护、规则维护、模板维护、映射维护、不同事项/区域/系统有不同规则”。
- 业务人员需要在管理端新增、编辑、启停多条配置记录。
- 运行逻辑要按事项、区域、系统、时间、生效状态等条件查一条或多条配置。

不要用在：

- 单个全局开关、单个地址、单个阈值：优先 CM-02 系统参数。
- 稳定枚举选项：优先 CM-01 代码项。
- 数据库连接串、账号密码、License、SSO、安全白名单：属于 CM-12 高风险配置边界。

需求分析判断：

- 先判断是环境参数、平台现成配置，还是有独立关系/生效规则的业务记录。先评估已确认平台能力是否覆盖全部行为；只在不覆盖时由Design决定业务表和页面，不能因“多条记录可维护”就新建。
- 要确认谁维护、唯一性、生效范围、生效状态、是否需要排序/优先级、是否保留历史。
- 配置运行逻辑必须写 Service 查询，不能只生成维护页面。

实战例子：

```text
需求：维护推送系统，办件按事项推送到不同系统。
判断：推送系统是业务配置；事项与系统关系是映射配置；token/clientId/clientSecret 属于外部凭证字段或既有配置来源。
落点：
- PushSystemInfo 类似配置表：系统名称、推送地址、token 地址、clientId、clientSecret、启用状态。
- ItemToSystemInfo 类似映射表：事项 ID -> 推送系统。
- 运行 Service/Controller：先查启用映射，再查启用推送系统，获取 token，调用接口，写推送日志。
```

页面/Action 示例：

```html
<!-- 字段名只是示例，真实字段按项目表结构确定 -->
<input id="status" class="mini-radiobuttonlist" bind="dataBean.status"
       action="getEnableModel" required="true" />
<input id="push_url" class="mini-textbox" bind="dataBean.push_url" required="true" />
<input id="token_url" class="mini-textbox" bind="dataBean.token_url" />
```

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
        // 获取 token、调用第三方、写业务日志；敏感值不输出到日志
    }
}
```

红线：

- 不把业务人员维护的多条规则塞进 `properties`。
- 不因为示例用了 `status`、`push_url` 就固定生成这些字段名；字段名来自需求、表结构和本项目样例。
- 有维护页还不够，必须补运行逻辑查询生效配置。

## CM-14 外部凭证

何时使用：

- 第三方接口需要 token、appKey、clientId/clientSecret、证书、签名、加解密密钥。
- 需求涉及“获取 token、token 失效重试、签名校验、接口认证、不同账号接入不同系统”。

不要用在：

- 页面普通字段、代码项、普通查询条件。
- 不需要认证的普通内部 Service 调用。

需求分析判断：

- 需求阶段先确认凭证是全局单套还是按部门/事项/接入方多套；全局固定凭证按系统参数配置理解，多接入方通常随 CM-13 业务配置维护。
- Coder 阶段再定位凭证是来自配置服务、已有 `*.properties` 还是业务配置记录；不要让需求用户回答文件名或 key。
- 需要明确 token 获取/刷新/缓存策略、认证失败是否阻断主流程、失败是否写日志/可补偿；敏感值不外泄。

Java 示例：

```java
String tokenUrl = ConfigUtil.getConfigValue("thirdsdkconfig", "xxxTokenUrl");
String clientId = ConfigUtil.getConfigValue("thirdsdkconfig", "xxxClientId");
String clientSecret = ConfigUtil.getConfigValue("thirdsdkconfig", "xxxClientSecret");
String token = tokenService.getToken(tokenUrl, clientId, clientSecret);
```

多接入方示例：

```java
String token = getToken(systemInfo.getToken_url(),
        systemInfo.getClientId(), systemInfo.getClientSecret());
headers.put("Authorization", "Bearer " + token);
```

红线：

- 最终回复和日志不输出真实 token、clientSecret、密码、证书内容。
- 不让用户在需求里明文贴密钥；只问“是否已有配置/由谁维护/失败后果”。
- token 获取失败时必须有业务后果：阻断、跳过、写失败日志、进入补偿，不能静默吞掉。

## 机制到最佳实践映射

| 机制 | 常配 GP | 常配 BP |
| --- | --- | --- |
| CM-01 代码项 | GP-06 | BP-08、BP-02 |
| CM-02 系统参数 | GP-13、GP-15 | 无 |
| CM-03 配置文件 | GP-10、GP-11、GP-12、GP-14、GP-15 | 无 |
| CM-04 前置库 | GP-11、GP-13、GP-15 | 需要管理页时选 BP |
| CM-05 事务 | GP-03、GP-04、GP-05、GP-08、GP-11、GP-12 | BP-06、BP-12 |
| CM-06 附件 | GP-08 | BP-11 |
| CM-07 用户会话 | GP-01、GP-02、GP-04 | BP-02、BP-06 |
| CM-08 菜单权限 | GP-10、GP-15 | 无 |
| CM-09 定时补偿 | GP-11、GP-15 | 手动补偿页 BP-03 |
| CM-10 MQ | GP-12、GP-15 | 补偿页 BP-03 |
| CM-11 幂等日志 | GP-11、GP-12、GP-13 | 日志列表 BP-02 |
| CM-12 高风险配置 | GP-14、GP-15 | 无 |
| CM-13 业务配置 | GP-16、GP-01、GP-02、GP-04、GP-13、GP-15 | BP-02、BP-03、BP-06 |
| CM-14 外部凭证 | GP-17、GP-13、GP-15 | 无 |

## 需求分析阶段自检

- 是否存在枚举/状态/类型：命中 CM-01。
- 是否存在环境可变值/地址/开关：命中 CM-02。
- 是否是业务人员维护的多条规则/模板/映射/接入方：命中 CM-13。
- 是否涉及 token/appKey/clientId/clientSecret/证书/签名：命中 CM-14，并检查 CM-12 风险。
- 是否需要注册菜单、Job、MQ、安全放行：命中 CM-03/CM-12。
- 是否访问前置库/外部库：命中 CM-04。
- 是否跨多表/主从/批量/同步：命中 CM-05。
- 是否上传/预览/材料：命中 CM-06。
- 是否按登录人/区域/组织过滤：命中 CM-07。
- 是否外部同步/消息/补偿：命中 CM-09/CM-10/CM-11。
