# 资源配置地图

本文件供 `epoint-design-tdd-coder` 的 company-practices 读卡使用。它描述 Epoint 项目 `src/main/resources` 常见配置文件在代码施工中的作用、读取时机和写入边界。

配置文件不是普通业务代码。默认策略是先读、少改、显式确认后再改。含账号、密钥、License、安全放行、SSO、数据库连接的文件默认高风险。

## 写入策略定义

| 策略 | 含义 |
| --- | --- |
| `read-only` | 只读参考，不写入。含环境、账号、密钥、License、加密、数据库连接等。 |
| `explicit-only` | 只有用户明确要求改该配置，并确认关键参数后才写。 |
| `append-only-by-sample` | 只能按本项目同文件已有结构追加一段配置，不能重排、重写或批量格式化。 |
| `business-code-first` | 优先写业务代码；配置文件只作为路径、能力开关或样例依据。 |

## 高频功能场景到配置触点

先从“功能场景”判断，再决定读哪个配置文件、是否能写。不要看到配置文件就改，也不要遇到同步/接口/附件就把值硬编码到 Java。

| 高频功能场景 | 常见需求说法 | 常命中配置文件 | 代码取法/代码落点 | 未确认事项与写入边界 |
| --- | --- | --- | --- | --- |
| 前置库定时同步 | 从前置库/共享库/同步库拉数据；每天凌晨同步；失败补偿 | `jdbc.properties` 或 `datasyncjdbc.properties` 只读；需要自动调度时再看 `quartz_data.xml` | Service 用 `ConfigUtil.getConfigValue("jdbc", "...")` 或同项目配置组取 URL/账号/密码，构造 `DataSourceConfig`，再 `CommonDao.getInstance(sourceConfig)`；Job 只调用 Service；手动补偿页调用同一 Service | 数据源 key、表/视图、同步方向、幂等键、cron 未查证时保留依赖缺口，继续其他任务；不输出账号密码 |
| 前置库即时查询/弹窗选择 | 页面直接查前置库事项/人员/项目信息；选择外部数据回填 | `jdbc.properties`、`datasyncjdbc.properties` 只读 | ListAction/SelectAction 调 Service，Service 通过外部 `CommonDao` 查询；页面仍用 `mini-datagrid action="getDataGridData"` | 数据量、查询条件、是否允许实时跨库查不明确时先问；高频查询要考虑落库或缓存 |
| 第三方接口/平台核验 | 调平台接口、材料核验、统一受理、TBHub、背景核验 | `tbhub.properties`、`zwbgcheck.properties`、`sdkconfig.properties`、`thirdsdkconfig.properties`，有些项目也放 `epointframe.properties` | `ConfigUtil.getConfigValue("配置组", "key")`、`ConfigUtil.getFrameConfigValue("key")` 或项目 `configService.getFrameConfigValue("key")`；Service 组装请求 | endpoint、appKey、密钥来源、签名方式无法查证时保留该接入缺口，继续无依赖任务；禁止硬编码地址和密钥 |
| 固定参数/业务开关 | 接口地址可配置、固定账号/令牌/外部调用凭证引用、超时时间、默认区域、是否启用某策略、阈值 | 系统参数配置；项目可能落到 `epointframe.properties` 或业务专属 `*.properties` | `ConfigUtil.getConfigValue("key")`、`ConfigUtil.getConfigValue("配置组", "key")`、`ConfigUtil.getFrameConfigValue("key")`；在 Service/Action 读取，不在 JS 写死 | 按主 Skill 查证 key、默认值和归属配置；仍缺少时保留依赖该参数的任务，继续其他任务，不编造值或申请编码卡 |
| 业务配置维护 | 维护规则、模板、映射、推送系统、不同事项/区域/系统配置不同规则 | 通常不是 resources；优先业务表 + Entity/Service/Action/HTML | 生成管理端 CRUD；运行 Service 按状态、范围、优先级查询生效配置 | 谁维护、唯一性、生效范围、状态字段、是否保留历史不明确时先问 |
| 外部凭证/多接入方认证 | token、clientId/clientSecret、appKey、证书、签名，不同系统账号不同 | 全局单套按系统参数配置理解，项目可能通过配置服务或 `sdkconfig.properties`/`thirdsdkconfig.properties` 等读取；多套通常随业务配置表维护 | 全局单套用 `ConfigUtil` 或配置服务；多接入方从业务配置记录取凭证字段；Service 获取 token/签名并写失败日志 | 敏感值不输出；凭证来源、刷新策略、认证失败业务后果未确认时保留受影响任务，不编造认证事实或停止其他任务 |
| 附件上传/预览/加密 | 材料附件、证照预览、OFD/PDF 预览、附件加密 | `epointframe.properties` 的 `uploadpreview.*`、`tc.properties`、`encryption.properties` | 页面用 `mini-webuploader`；Action 返回 `FileUploadModel9`；Service 用附件服务；配置只作能力开关参考 | 预览开关、加密 key、附件服务地址属于高风险，默认不改 |
| 定时任务/补偿批处理 | 每天/每小时跑一次、失败重试、手动补偿 | `quartz_data.xml`、`spring/appcontext-epointjob.xml` | `Job` 实现 Quartz `execute`，通过 `ContainerFactory` 或项目注入方式拿 Service；自动调度注册才追加 XML | cron、job-class、group/name、是否自动注册不明确时不改 XML |
| MQ 外部变更通知 | 监听队列、RabbitMQ、外部消息推送、异步消费 | `rabbitmq.properties`/`zwfwmq.properties` 只读；监听注册看 `spring/appcontext-rabbitmq.xml`、`spring/rabbitmq-task.xml` | Listener 实现工作包列出的项目同类接口，消息解析后调用 Service；发送端需要连接参数时用 `ConfigUtil.getConfigValue("rabbitmq", "KEY")` | queue、exchange、routing key、ack 策略、幂等键无法查证时保留消息接入缺口并继续其他任务，不改未授权注册配置 |
| 挂菜单/按钮权限 | 新增后台菜单、左侧入口、角色按钮权限、Action 权限 | `module_data.xml`、`epointsecurity.properties` | 页面和 Action 先生成闭合；配置只按同文件样例追加菜单/权限映射 | 菜单编码、父节点、排序、权限组不明确时不能写 |
| 登录/SSO/接口放行 | 免登录、白名单、统一认证、SSO 回调、SQL skip | `EpointSecurityConfig.properties`、`EpointSSOClient.properties`、`MultiEpointSSOClient.properties`、`loginflow.properties` | 默认只读定位现状；真正改动必须按项目安全配置样例最小追加 | 安全高风险；没有明确 URL、原因、影响范围和用户确认时阻断 |
| 导入导出/大文件 | Excel 导入、列表导出、模板下载、上传大小不够 | 通常不改配置；文件大小问题才看 `application*.properties` 或附件相关配置 | 导出优先 Action 返回 `ExportModel`；导入按项目模板/导入服务；上传限制只作为问题诊断 | 不因普通导入导出随手改上传大小或应用启动配置 |

## 什么时候该用配置文件

| 判断问题 | 应选手段 |
| --- | --- |
| 每条业务记录都不同，页面要维护 | 业务表字段，不放配置文件 |
| 多条规则/模板/映射由业务人员维护 | 业务配置表 + 管理端页面 + 运行 Service 查询生效配置 |
| 状态、是否、类型这类稳定枚举 | 代码项：页面 `action="getXxxModel"` + Java `CodeModalFactory` |
| 地址、固定凭证、开关、阈值、默认值会因环境或运维调整 | 系统参数配置；Coder 按项目样例用 `ConfigUtil` 或配置服务读取 |
| 框架必须启动时注册才能生效 | resources 配置：菜单、权限、Quartz、MQ listener、安全/SSO |
| 连接外部库/前置库 | `jdbc.properties` 或 `datasyncjdbc.properties` 只读取值，代码用 `DataSourceConfig/CommonDao` |
| token、clientId、secret、证书、签名 | 外部凭证；先判断全局单套还是多接入方，多接入方常随业务配置表维护 |
| 含账号、密码、密钥、License、SSO、白名单 | 高风险配置，默认只读并阻断确认 |

## 常见配置文件总表

| 文件 | 能力域 | 读取时机 | 关注点 | 写入策略 |
| --- | --- | --- | --- | --- |
| `epointframe.properties` | 核心框架、页面路径、启动开关、上传预览、MQ 队列 | 生成页面、附件、MQ、框架启动相关功能时 | `projectPagePath`、`epointStartInit`、`ep.mq.listener.queues`、`uploadpreview.*` | `business-code-first`，改动需 `explicit-only` |
| `application.properties`、`application-*.properties`、`application-micro.properties`、`application-javachassis.properties` | 应用启动、微服务、上传大小、服务配置 | 涉及上传限制、服务注册、微服务调用时 | `servicecomb.*`、上传临时目录和大小、应用名 | `explicit-only` |
| `module_data.xml` | 菜单、模块、初始化功能入口 | 用户明确要求挂菜单、模块初始化、左侧入口时 | 菜单编码、父节点、Action/URL、排序、模块归属 | `append-only-by-sample`，必须确认菜单信息 |
| `epointsecurity.properties` | Action 权限组、功能权限映射 | 用户要求配置按钮权限、Action 权限、模块权限时 | `xxxaction` 映射、权限组归属、已有模块模式 | `append-only-by-sample`，必须确认权限组 |
| `EpointSecurityConfig.properties` | 安全过滤、放行、SQL skip、URL 白名单 | 用户明确要求接口放行、安全过滤调整时 | `Sql_SkipURL`、白名单、过滤策略 | `explicit-only`，高风险 |
| `antisamy.xml` | XSS/HTML 安全策略 | 富文本、XSS、安全加固需求 | 标签/属性白名单 | `explicit-only`，高风险 |
| `fastjson.properties` | JSON 序列化安全/兼容 | JSON 兼容或安全问题 | fastjson 配置项 | `explicit-only`，高风险 |
| `EpointSSOClient.properties`、`MultiEpointSSOClient.properties`、`EpointSSOServer.xml` | SSO 单点登录 | 登录、票据、统一认证、回调问题 | SSO 地址、client/server、回调、票据参数 | `read-only`，除非用户明确做 SSO 配置任务 |
| `loginflow.properties`、`yjslogin.properties`、`krb5.conf` | 登录流程、认证集成 | 登录方式、第三方认证、Kerberos 相关需求 | 登录流程开关、认证地址、realm/keytab 类配置 | `read-only`，高风险 |
| `jdbc.properties`、`jdbc_bak.properties` | 主数据库连接 | 诊断数据库或用户明确要求环境配置 | 数据源 URL、账号、驱动、连接池 | `read-only`，不要输出敏感值 |
| `datasyncjdbc.properties`、`wzmconfig.properties`、`ycdburlconfig.properties`、`spy.properties` | 数据同步库、外部库、SQL 监控 | 数据同步、外部数据源、第三方库调用 | 数据源名称、地址、驱动、监控开关 | `read-only`，改动需用户明确确认 |
| `encryption.properties` | 加密配置 | 附件加密、数据库加密、SSO 加密、工作流加密 | 加密开关、密钥引用、算法配置 | `read-only`，高风险 |
| `quartz_data.xml` | Quartz 定时任务注册 | 定时同步、补偿任务、周期任务 | job 名称、job-class、cron-expression、启停策略 | `append-only-by-sample`，必须确认 cron 和注册意图 |
| `spring/appcontext-epointjob.xml` | 定时任务 Spring 上下文 | Job 注入、任务容器、调度上下文 | bean、扫描包、调度器配置 | `explicit-only` |
| `rabbitmq.properties`、`zwfwmq.properties` | MQ 连接和业务队列 | RabbitMQ 发送/消费、队列监听 | host、vhost、queue、exchange、routing key | `read-only`，连接信息不外泄 |
| `spring/appcontext-rabbitmq.xml`、`spring/rabbitmq-task.xml` | MQ bean、listener、队列绑定 | 需要新增监听器、绑定队列时 | listener bean、queue/exchange/binding、container | `append-only-by-sample`，必须确认 MQ 参数 |
| `log4j2.xml`、`log4j2.component.properties`、`tracing.properties` | 日志、链路追踪 | 日志配置、链路追踪、排障增强 | logger、appender、level、trace 开关 | `explicit-only`，普通需求只在代码里加业务日志 |
| `license.xml`、`*.lic`、`Epoint*.lic` | License | 不作为代码生成输入 | License 文件存在性 | `read-only`，禁止修改 |
| `sdkconfig.properties`、`thirdsdkconfig.properties`、`tbhub.properties`、`zwbgcheck.properties`、`inteligentSearch.properties` | 第三方 SDK、搜索、核验、平台集成 | 调第三方接口、智能搜索、背景核验等 | endpoint、appKey 引用、业务开关 | `read-only`，改动需明确环境配置任务 |
| `tc.properties` | 附件/文件相关平台配置 | 附件上传、文件预览、材料处理 | 附件路径、附件服务相关 key | `business-code-first`，改动需 `explicit-only` |
| `messages_*.properties` | 国际化消息 | 用户明确要求多语言文案 | message key、展示文案 | `append-only-by-sample` |

## 需求信号到配置动作

| 需求信号 | 先读 | 默认动作 | 需要确认后才做 |
| --- | --- | --- | --- |
| 新建管理端页面 | 工程导航契约、`epointframe.properties` | 用导航契约确定路径；`projectPagePath` 只作校验 | 修改 `epointframe.properties` |
| 挂菜单/左侧入口 | `module_data.xml`、本地菜单样例 | 说明需要菜单编码和父节点 | 追加菜单/模块初始化配置 |
| 配按钮权限/Action 权限 | `epointsecurity.properties`、现有 Action 权限样例 | 生成 Action 时保持 bean 命名闭合 | 追加权限映射 |
| 接口放行/白名单 | `EpointSecurityConfig.properties` | 先提示高风险，确认是否真要放行 | 改 `Sql_SkipURL` 或白名单 |
| 定时同步 | Job 样例、`quartz_data.xml` | 先生成 Job/Service/日志和手动触发入口 | 注册 cron 到 `quartz_data.xml` |
| MQ 监听 | MQ 样例、`rabbitmq.properties`、`spring/rabbitmq-task.xml` | 先生成 listener/Service 幂等逻辑 | 追加 queue/listener/binding |
| 附件上传/预览 | 附件样例、`epointframe.properties`、`tc.properties`、`encryption.properties` | 复用项目附件控件和服务 | 改上传预览或加密配置 |
| SSO/登录 | SSO/Login 配置 | 只读定位现有认证方式 | 改 SSO 地址、回调、登录流程 |
| 数据同步/外部库 | 数据源配置、同步样例 | 复用项目封装，不输出账号密码 | 改数据源连接 |
| 业务规则/映射/接入方维护 | 本项目相似配置维护页、Entity、Service | 生成业务配置表维护页面；运行逻辑按生效条件查配置 | 把多条业务配置写入 `properties` |
| 第三方 token/凭证 | 既有 token 工具类、配置服务、业务配置表样例 | 读取或使用已配置凭证；Service 处理 token 获取、刷新和失败日志 | 输出真实密钥；凭空指定凭证存放文件 |
| 日志增强 | 本地 logger 样例 | 在业务代码里加必要日志 | 改 `log4j2.xml` 或 tracing |

## 编辑资源配置文件前的检查

未确认资料按主 Skill 区分技术查证、业务事实及授权：只挂起依赖缺失资料的任务，继续其他可执行任务。表中的只读、显式授权和高风险写入限制不变，不因记录缺口取得配置写入权限。

- 用户是否明确提出“修改/新增配置”，而不是只要求实现业务功能。
- 是否已经读取本项目同文件的已有结构和相似条目。
- 是否知道唯一编码、父节点、队列名、cron、权限组、URL 路径等关键参数。
- 是否会影响登录、安全、数据库、License、加密或生产环境连接。
- 是否可以先用业务代码完成，再把配置变更作为待确认项交给用户。

## 禁止事项

- 禁止为了让代码“看起来完整”而随手改 `jdbc.properties`、`encryption.properties`、License、SSO、安全白名单。
- 禁止在最终回复里泄露配置文件中的账号、密码、密钥、token、内网地址。
- 禁止重排 XML/properties 全文件或批量格式化无关配置。
- 禁止把其他项目的配置键和值直接套到当前项目。
- 禁止没有本项目样例时凭空编写 `module_data.xml`、`quartz_data.xml`、RabbitMQ listener 配置。
