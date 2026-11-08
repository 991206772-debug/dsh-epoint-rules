/* eslint-disable */

function uniqueNonEmptyStrings(values = []) {
    const out = [];
    const seen = new Set();
    for (const value of (Array.isArray(values) ? values : [])) {
        const text = String(value || '').trim();
        if (!text || seen.has(text)) continue;
        seen.add(text);
        out.push(text);
    }
    return out;
}

function compactText(value = '', max = 160) {
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    if (text.length <= max) return text;
    return `${text.slice(0, Math.max(1, max - 1)).trim()}…`;
}

const REF = Object.freeze({
    index: { path: 'references/company-practices/index.md' },
    dispatch: { path: 'references/company-practices/company-best-practice-dispatch.md' },
    commonMechanisms: { path: 'references/company-practices/company-common-mechanisms.md' },
    examples: { path: 'references/company-practices/company-code-examples.md' },
    pageGuidelines: { path: 'references/company-practices/frontend/page-guidelines.md' },
    legacyMiniui: { path: 'references/company-practices/frontend/legacy-miniui-best-practices.md' },
    commonJs: { path: 'references/company-practices/frontend/common-js.md' },
    crudPages: { path: 'references/company-practices/frontend/crud-pages.md' },
    specialPages: { path: 'references/company-practices/frontend/special-pages.md' },
    crudRecipes: { path: 'references/company-practices/backend/crud-recipes.md' },
    crudExamples: { path: 'references/company-practices/backend/crud-examples.md' },
    dictionaryStatusDialog: { path: 'references/company-practices/interaction/dictionary-status-dialog.md' },
    attachmentImportExport: { path: 'references/company-practices/integration/attachment-import-export.md' },
    attachmentIndex: { path: 'references/company-practices/integration/attachment-index.md' },
    importExport: { path: 'references/company-practices/integration/import-export.md' },
    externalApiCall: { path: 'references/company-practices/integration/external-api-call.md' },
    auditCallLog: { path: 'references/company-practices/integration/audit-call-log.md' },
    jobMq: { path: 'references/company-practices/integration/job-mq.md' },
    resourceConfigMap: { path: 'references/company-practices/config/resource-config-map.md' }
});

const CARD_DEFS = Object.freeze({
    page_framework: {
        practiceId: 'PAGE-FUI',
        label: 'MiniUI/FUI 页面基础写法',
        useWhen: '候选文件包含 HtmlPage 时，写页面前先核对公司页面基础结构和前后台 action 闭合。',
        fileKinds: ['HtmlPage'],
        responsibilities: {
            HTML: [
                '必须保留 cssboot/jsboot/page-loading/fui-condition/fui-form/mini-datagrid 等公司页面启动结构；业务 patch 禁止删除或移动基础资源。',
                '新增控件只在原页面合适区域小范围 patch，不重写页面。'
            ],
            JS: [
                '使用 epoint.initPage/execute/refresh/openDialog/renderCell 等公司 API。',
                '禁止 fetch/axios/原生 ajax/原生 alert confirm。'
            ],
            Action: ['页面 action 和 epoint.execute 必须闭合到当前 Action public 方法。']
        },
        mustReadReferences: [REF.pageGuidelines, REF.commonJs],
        closureChecks: [
            '所有 action="..." 必须能闭合到当前或显式指定 Action public 方法。',
            "所有 epoint.execute('...') 必须能闭合到 Action public 方法。"
        ],
        redLines: ['不要写 Vue/React/ElementUI 页面。', '不要用原生 form/table/button 替代 MiniUI/FUI 控件。']
    },
    backend_layering: {
        practiceId: 'BACKEND-LAYER',
        label: 'Epoint 后端分层写法',
        useWhen: '候选文件包含 Entity/Service/Action/Rest/Job 时，写业务逻辑前先核对公司后端分层职责。',
        fileKinds: ['Entity', 'ServiceApi', 'ServiceInternal', 'ServiceImpl', 'Action', 'Rest', 'Job'],
        responsibilities: {
            Entity: ['只做表映射和字段访问，继承项目实体基类。'],
            ServiceApi: ['声明页面或业务动作需要调用的服务方法。'],
            ServiceInternal: ['承载查询、保存、删除、状态/权限/跨记录等业务约束和事务性业务处理；不重复页面已有的必填、长度、格式校验。'],
            ServiceImpl: ['对外实现接口并委托内部 Service。'],
            Action: ['做页面入口、参数接收、调用 Service 或项目既有查询方法、返回 callback 参数。'],
            Rest: [
                '做对外接口入口、参数解析、调用 Service/工具类并按项目 REST 返回模型输出。',
                'REST 入参固定从 @RequestBody String params 解析根 JSON：token 从根对象取，业务字段从 params 子对象取；HttpServletRequest 只承载 HTTP 上下文。'
            ],
            Job: ['做调度入口、日志、异常包装；简单条件查询按项目样例可用 SqlConditionUtil，复杂业务优先下沉 Service。']
        },
        mustReadReferences: [REF.crudRecipes, REF.crudExamples],
        closureChecks: ['Action/Rest/Job 不写复杂 SQL；状态、权限、跨字段/跨记录业务约束放 Service，普通表单必填、长度、格式留在 HtmlPage。'],
        redLines: [
            '不要生成 Lombok/JPA/MyBatis-Plus/普通 Spring Boot Controller。',
            'REST 认证和业务字段不得绕开根 JSON token + params 子对象这条固定入参合同。'
        ]
    },
    crud: {
        practiceId: 'GP-01',
        label: '基础 CRUD 全链路',
        useWhen: '本需求新增维护类业务对象，或候选文件包含完整 Entity/Service/Action/HtmlPage owner 文件。',
        fileKinds: ['Entity', 'ServiceApi', 'ServiceInternal', 'ServiceImpl', 'Action', 'HtmlPage'],
        responsibilities: {
            HTML: ['列表、表单、详情按 MiniUI/FUI 页面配方补业务字段和按钮。'],
            Action: ['List/Add/Edit/Detail Action 与页面 initPage 闭合。'],
            Service: ['查询、保存、删除、详情和业务校验放到服务层。'],
            Entity: ['字段访问方法与数据库业务字段一致。']
        },
        mustReadReferences: [
            { ...REF.dispatch, section: 'GP-01' },
            REF.crudRecipes,
            REF.crudExamples,
            REF.crudPages,
            REF.commonJs
        ],
        closureChecks: ['页面、Action、ServiceApi、ServiceImpl、ServiceInternal 方法链路闭合。'],
        redLines: ['不要把骨架当模板重写；只 patch 业务差异。']
    },
    master_detail: {
        practiceId: 'GP-05',
        label: '主从表和事务明细',
        useWhen: '受管pageComposition包含child_edit或child_readonly业务块。',
        fileKinds: ['HtmlPage', 'Action', 'ServiceInternal'],
        responsibilities: {
            HTML: ['主对象表单与明细MiniUI表格按受管组合骨架闭合。'],
            Action: ['接收主表单与明细变更，只做参数接收和Service调用。'],
            Service: ['主从新增、修改、删除和业务校验在Service事务闭合。']
        },
        mustReadReferences: [{ ...REF.dispatch, section: 'GP-05' }, REF.specialPages, REF.crudRecipes],
        closureChecks: ['主表保存、明细变更和Service事务调用链闭合。'],
        redLines: ['不要把主从事务写在Action；不要把明细拼成原生table。']
    },
    accordion: {
        practiceId: 'BP-11',
        label: '手风琴业务块布局',
        useWhen: '受管pageComposition.layout明确为accordion。',
        fileKinds: ['HtmlPage'],
        responsibilities: { HTML: ['保留Builder生成的fui-accordions和稳定业务块ID，只补需求明确的动态显隐。'] },
        mustReadReferences: [REF.specialPages],
        closureChecks: ['手风琴块顺序、标题、显隐和内部控件保持一致。'],
        redLines: ['不要用字符串拼装复杂业务块。']
    },
    inline_edit: {
        practiceId: 'BP-12',
        label: '明细行编辑',
        useWhen: '受管pageComposition包含child_edit业务块。',
        fileKinds: ['HtmlPage', 'Action', 'ServiceInternal'],
        responsibilities: {
            HTML: ['使用allowCellEdit、property=editor和grid.isValid。'],
            Action: ['页面表格action与Action public方法闭合。'],
            Service: ['校验并保存新增、修改和删除的明细集合。']
        },
        mustReadReferences: [REF.specialPages, { ...REF.dispatch, section: 'GP-05' }],
        closureChecks: ['编辑器、明细校验、提交参数和后端保存入口闭合。'],
        redLines: ['不要使用原生表格输入框代替MiniUI行编辑。']
    },
    query: {
        practiceId: 'GP-02/BP-02',
        label: '查询分页和搜索条件',
        useWhen: 'User Story 或验收项涉及查询、检索、筛选、列表、分页或结果查看。',
        fileKinds: ['HtmlPage', 'Action', 'Rest', 'Job', 'ServiceInternal'],
        responsibilities: {
            HTML: ['查询区使用 fui-condition + fui-form + MiniUI 控件。'],
            JS: ["查询刷新使用 epoint.refresh(['datagrid','fui-form'], '', true)。"],
            Action: ['getDataGridData 接收查询条件并返回分页模型。'],
            Rest: ['对外查询接口接收参数后按项目 REST 返回模型输出。'],
            Job: ['定时统计/同步查询按项目样例构造条件；复杂查询封装到 Service。'],
            Service: ['查询条件用项目规则和参数化方式拼接，日期范围处理起止边界。']
        },
        mustReadReferences: [
            { ...REF.dispatch, section: 'GP-02' },
            { ...REF.legacyMiniui, section: 'BP-02' },
            REF.commonJs
        ],
        closureChecks: ['mini-datagrid action 与 Action getDataGridData 闭合。'],
        redLines: ['不要手拼 URL 请求列表；不要拼接未参数化 SQL。']
    },
    toolbar_action: {
        practiceId: 'BP-03/BP-04',
        label: '工具栏按钮和操作列增量 patch',
        useWhen: 'User Story 或验收项涉及新增按钮、批量操作、行内查看、行内编辑、下载、预览或删除。',
        fileKinds: ['HtmlPage', 'Action', 'ServiceInternal'],
        responsibilities: {
            HTML: ['工具栏用 mini-button，操作列用 renderer + epoint.renderCell。'],
            JS: ['批量操作先 getSelecteds 判空，危险动作先 epoint.confirm，再 epoint.execute。'],
            Action: ['补对应 public 方法，方法名与 epoint.execute 或控件 action 一致。'],
            Service: ['删除、状态、下载、预览等业务规则放 Service 兜底。']
        },
        mustReadReferences: [
            { ...REF.legacyMiniui, section: 'BP-03' },
            { ...REF.legacyMiniui, section: 'BP-04' },
            REF.commonJs
        ],
        closureChecks: ["epoint.execute('methodName') 必须闭合到 Action public methodName。"],
        redLines: ['不要返回原生 button/a onclick 作为操作列。']
    },
    dialog_flow: {
        practiceId: 'GP-07/BP-05/BP-06',
        label: '弹窗关闭、父页回调和选择回填',
        useWhen: 'User Story 或验收项涉及新增/编辑/详情弹窗、选择弹窗、保存后刷新父页或回填当前页面。',
        fileKinds: ['HtmlPage', 'Action', 'ServiceInternal'],
        responsibilities: {
            HTML: ['弹窗入口沿用 mini-button、操作列 renderer 或项目既有入口。'],
            JS: [
                '父页使用 epoint.openDialog/openTopDialog 第三个参数传 searchData 或回填 callback。',
                '生成型 CRUD 保存/删除/状态操作默认消费 data.msg；只有既有页面已明确读取 message/messageno 时才沿用既有字段。',
                '子页保存成功用 epoint.closeDialog(data.msg)，选择页用 epoint.closeDialog(row/object) 回传。'
            ],
            Action: ['新增/编辑/选择页 initPage 与 Action public 方法闭合。', '保存、删除、状态类方法默认 addCallbackParam("msg", "...")，与前端 data.msg 闭合。'],
            Service: ['保存、过滤、权限范围等业务规则放 Service 处理。']
        },
        mustReadReferences: [
            { ...REF.dispatch, section: 'GP-07' },
            { ...REF.legacyMiniui, section: 'BP-05' },
            { ...REF.legacyMiniui, section: 'BP-06' },
            REF.commonJs,
            REF.dictionaryStatusDialog
        ],
        closureChecks: [
            '新增/编辑弹窗需要刷新父页时，父页 openDialog 第三个参数必须是 searchData 或等价刷新函数。',
            '选择弹窗父页 callback 必须处理取消/空返回，再 setValue/setText 回填。'
        ],
        redLines: ['不要用 window.open/window.close 替代公司弹窗。', '不要从子页面直接操作父页面 DOM。']
    },
    code_item: {
        practiceId: 'GP-06/BP-08',
        label: '代码项展示和选择',
        useWhen: '业务字段已标记 codeItem，或 codingFactHandoff 提示存在代码项/字典/下拉候选事实。',
        fileKinds: ['HtmlPage', 'Action', 'ServiceInternal'],
        responsibilities: {
            HTML: ['列表/详情优先 data-options 展示中文；表单/查询用 mini-combobox 或 mini-radiobuttonlist。'],
            Action: ['补 getXxxModel public 方法，按项目规则返回代码项模型。'],
            Service: ['业务表字典需过滤禁用、权限或范围时在 Service 处理。']
        },
        mustReadReferences: [
            { ...REF.dispatch, section: 'GP-06' },
            { ...REF.legacyMiniui, section: 'BP-08' },
            REF.dictionaryStatusDialog
        ],
        closureChecks: ['action="getXxxModel" 必须闭合到 Action public getXxxModel。'],
        redLines: ['不要在 JS renderer 里手写中文枚举映射。']
    },
    status_flow: {
        practiceId: 'GP-04/BP-09',
        label: '状态流转和启停发布',
        useWhen: 'User Story、验收项或机制事实涉及启用、停用、发布、撤回、作废、状态流转。',
        fileKinds: ['HtmlPage', 'Action', 'ServiceInternal'],
        responsibilities: {
            HTML: ['工具栏或操作列增加状态动作按钮。'],
            JS: ['选中记录、确认后再 epoint.execute。'],
            Action: ['补状态动作 public 方法。'],
            Service: ['非法流转、重复操作、引用状态等必须在 Service 校验。']
        },
        mustReadReferences: [
            { ...REF.dispatch, section: 'GP-04' },
            { ...REF.legacyMiniui, section: 'BP-03' },
            { ...REF.legacyMiniui, section: 'BP-09' }
        ],
        closureChecks: ['前端状态动作和 Action public 方法闭合；Service 有后端兜底校验。'],
        redLines: ['状态规则不能只靠按钮显隐或前端判断。']
    },
    attachment: {
        practiceId: 'GP-08',
        label: '附件/材料/预览/下载',
        useWhen: 'User Story、验收项或机制事实涉及附件、材料、上传、预览、下载、文件查看。',
        fileKinds: ['HtmlPage', 'Action', 'ServiceInternal'],
        responsibilities: {
            HTML: ['按项目样例选择上传/预览控件；详情页只读预览时隐藏上传删除动作。'],
            Action: ['补上传模型、预览、下载相关 public 方法，并处理 GUID 生命周期。'],
            Service: ['保存附件 GUID 或查询附件信息；必要时查 FrameAttachInfo。']
        },
        mustReadReferences: [
            { ...REF.dispatch, section: 'GP-08' },
            REF.attachmentIndex
        ],
        closureChecks: ['附件控件 action、预览/下载 execute 与 Action 方法闭合。'],
        redLines: ['不要自造上传接口；不要在上传模型方法里反复生成新 GUID。']
    },
    import_export: {
        practiceId: 'GP-09',
        label: '导入导出',
        useWhen: 'User Story、验收项或机制事实涉及 Excel 导入、列表导出、模板下载、导入结果。',
        fileKinds: ['HtmlPage', 'Action', 'ServiceInternal'],
        responsibilities: {
            HTML: ['导出优先使用公司数据导出组件并带查询条件。'],
            Action: ['补 getExportModel 或导入相关 Action 方法。'],
            Service: ['复杂导入解析、错误收集和结果反馈放 Service。']
        },
        mustReadReferences: [
            { ...REF.dispatch, section: 'GP-09' },
            REF.importExport
        ],
        closureChecks: ['getExportModel 与页面导出 action 闭合。'],
        redLines: ['不要手写浏览器下载 URL 绕过公司组件。']
    },
    job_mq: {
        practiceId: 'GP-11/GP-12',
        label: '定时任务/MQ/补偿',
        useWhen: '机制事实涉及定时、补偿、同步、MQ、队列、消息监听。',
        fileKinds: ['Job', 'Action', 'ServiceInternal', 'ServiceImpl'],
        responsibilities: {
            Job: ['做调度入口、日志、异常包装和调用 Service；简单条件查询按项目样例可用 SqlConditionUtil，复杂 DAO / SQL 下沉 Service。'],
            Service: ['同步或消息处理逻辑放 Service，保证幂等、失败隔离和日志。'],
            Action: ['如有手动补偿入口，Action 调用同一业务方法。'],
            Config: ['配置只在用户明确确认 cron/队列/注册方式后修改。']
        },
        mustReadReferences: [
            { ...REF.dispatch, section: 'GP-11' },
            { ...REF.dispatch, section: 'GP-12' },
            REF.jobMq,
            REF.resourceConfigMap
        ],
        closureChecks: ['Job/MQ/手动补偿复用同一 Service 业务方法。'],
        redLines: [
            'Job 内不要写大段复杂 DAO / SQL；跨业务统计、写库和事务处理优先下沉 Service。',
            '不能凭空编 cron、队列名、exchange、routing key。'
        ]
    },
    config_risk: {
        practiceId: 'GP-15',
        label: '配置文件写入风险',
        useWhen: '机制事实涉及系统参数、第三方地址、安全放行、菜单权限、Quartz、MQ 或其它配置文件。',
        fileKinds: ['Action', 'Rest', 'Job', 'ServiceInternal', 'ServiceImpl'],
        responsibilities: {
            Config: ['默认只读定位配置触点；写入配置必须有已确认参数和风险说明。'],
            Backend: ['运行期参数优先通过项目已有参数/配置读取方式消费，不在 Action/Rest/Job/Service 里硬编码。']
        },
        mustReadReferences: [
            { ...REF.dispatch, section: 'GP-15' },
            REF.resourceConfigMap
        ],
        closureChecks: ['配置 key、地址、cron、队列名必须来自用户确认、项目样例或规则事实。'],
        redLines: ['不要输出或改写账号、密码、密钥、token、License。']
    },
    external_api: {
        practiceId: 'GP-13/EXT-API',
        label: '外部接口调用',
        useWhen: 'User Story、验收项或机制事实明确涉及外部/第三方/平台接口、HTTP/API、同步接口或回调时使用。',
        fileKinds: ['Action', 'Rest', 'Job', 'ServiceInternal', 'ServiceImpl'],
        responsibilities: {
            JS: ['前端只调用本项目 Action；不要从页面直接请求第三方地址。'],
            Action: ['做参数校验、用户上下文和 addCallbackParam；接口调用封装到 Service 或项目工具类。'],
            Rest: ['做对外接口参数解析和返回包装；外部平台调用封装到 Service 或项目工具类；对外 REST 入参仍按根 JSON token + params 子对象读取。'],
            Job: ['定时/补偿调用外部平台时处理超时、空响应、状态码、异常和日志隔离。'],
            Service: ['优先复用本项目 Hutool/HttpUtil 工具类样例，处理超时、空响应、状态码、异常和返回字段解析。'],
            Config: ['接口地址、token、appKey、secret 等只来自已确认配置、系统参数或已有项目样例。']
        },
        mustReadReferences: [
            { ...REF.dispatch, section: 'GP-13' },
            REF.externalApiCall,
            REF.resourceConfigMap
        ],
        closureChecks: [
            '页面 epoint.execute 闭合到 Action public 方法；Action 再调用 Service/Util。',
            '外部响应必须判断空值、状态码和业务失败信息后再 addCallbackParam。'
        ],
        redLines: [
            '不要在前端直连第三方接口。',
            '不要新增硬编码地址、token、secret、appKey。',
            '不要凭接口名猜响应字段；字段必须来自接口文档、项目样例或需求事实。'
        ]
    },
    audit_log: {
        practiceId: 'AUDIT-CALL-LOG',
        label: '调用记录/审计留痕',
        useWhen: '需求明确要求审计、留痕、调用记录、接口日志、入参出参、调用状态或耗时时使用。',
        fileKinds: ['Entity', 'Action', 'Rest', 'Job', 'ServiceInternal'],
        responsibilities: {
            Entity: ['日志表字段按已确认表或项目既有实体，不因外部接口自动新建日志表。'],
            Action: ['补操作者、组织、年份等上下文字段时沿用项目公共字段写法。'],
            Rest: ['记录对外接口调用方、入参、出参、状态和耗时；敏感字段脱敏。'],
            Job: ['记录定时/补偿批次、执行时间、处理数量、失败原因；日志失败不影响主流程，除非需求明确阻断。'],
            Service: ['围绕被审计动作写入日志；日志写入失败默认隔离，不能破坏主业务返回，除非需求明确要求阻断。']
        },
        mustReadReferences: [
            REF.auditCallLog,
            REF.crudRecipes
        ],
        closureChecks: [
            '只有需求明确要查看日志列表/下载日志时，才把日志查询拆成独立可验收入口。',
            '入参、出参、错误信息存储前要考虑长度和敏感字段脱敏。'
        ],
        redLines: [
            '不要把所有外部接口默认扩展成日志管理页。',
            '不要记录明文 token、secret、密码或证书内容。',
            '不要让日志写入异常覆盖主业务接口返回。'
        ]
    },
    result_interaction: {
        practiceId: 'RESULT-LIST/PREVIEW-DOWNLOAD',
        label: '结果列表、预览和下载交互边界',
        useWhen: '需求明确要求展示外部接口结果列表、临时结果列表/面板/弹窗，或在结果中预览/下载文件时使用。',
        fileKinds: ['HtmlPage', 'Action', 'ServiceInternal'],
        responsibilities: {
            HTML: ['结果列表优先落在已有页面区域或独立结果页；复杂 MiniUI 结构不要用 JS 字符串拼装。'],
            JS: ['操作列用 renderer + epoint.renderCell；预览/下载先闭合到 Action，再由 Action 返回后端确认的 URL 或业务结果。'],
            Action: ['结果数据、预览地址、下载地址都由 Action 方法闭合返回；不要让页面拼第三方接口地址。'],
            Service: ['校验当前行参数和文件权限，再调用外部接口或项目附件/文件服务。']
        },
        mustReadReferences: [
            { ...REF.legacyMiniui, section: 'BP-04' },
            { ...REF.legacyMiniui, section: 'BP-05' },
            REF.commonJs,
            REF.attachmentIndex
        ],
        closureChecks: [
            '操作列 renderer 不返回原生 a/button onclick。',
            '业务页/结果弹窗用公司弹窗；文件流下载或框架预览 URL 只能使用后端已确认返回值。'
        ],
        redLines: [
            '不要用字符串拼复杂 mini-datagrid 弹窗内容。',
            '不要在操作列拼原生 <a onclick>。',
            '不要在页面手写第三方预览/下载 URL。'
        ]
    },
    statistics_analysis: {
        practiceId: 'STATISTICS-ANALYSIS',
        label: '统计分析页与聚合查询',
        useWhen: 'constructionSceneKey=statistics_analysis，或 Story 明确要求统计、分析、汇总、报表、趋势、排名、分布等结果。',
        fileKinds: ['HtmlPage', 'Action', 'ServiceApi', 'ServiceInternal', 'ServiceImpl'],
        responsibilities: {
            HTML: ['只做筛选、汇总展示、统计表格/图表占位和刷新；筛选、维度、指标来自 statisticsContract。'],
            Action: ['只接收筛选参数、读取上下文、调用 Service 并返回页面数据；不直接写 SQL 或大段聚合。'],
            ServiceApi: ['声明统计查询方法，入参/返回围绕 statisticsContract.filters/dimensions/metrics。'],
            ServiceInternal: ['承载 SqlConditionUtil、聚合查询、指标计算、空结果 0 值和异常处理。'],
            ServiceImpl: ['只转发到 ServiceInternal，不写业务 SQL。']
        },
        mustReadReferences: [
            { ...REF.dispatch, section: 'GP-02' },
            { ...REF.legacyMiniui, section: 'BP-02' },
            REF.crudRecipes,
            REF.commonJs
        ],
        closureChecks: [
            '筛选条件、维度、指标必须逐项对齐 statisticsContract。',
            'Action/HtmlPage 不做聚合；ServiceInternal 负责统计查询和结果组装。',
            '空结果要返回空集合或 0 值汇总，不能抛前端异常。'
        ],
        redLines: [
            '不要把统计分析降级成普通 CRUD add/edit/detail。',
            '不要在 Action/Job/HtmlPage 写 SQL 或聚合逻辑。',
            '不要凭字段名扩展未确认的指标、维度或筛选条件。',
            '没有项目样例时不要凭空引入新图表库。'
        ]
    },
    workflow: {
        practiceId: 'WORKFLOW-PROCESS',
        label: '工作流/审批流施工',
        useWhen: 'constructionSceneKey=workflow_process，或 Story 明确包含审批、提交、退回、转办、待办、流程历史、审批意见等工作流结果。',
        fileKinds: ['HtmlPage', 'Action', 'ServiceApi', 'ServiceInternal', 'ServiceImpl', 'Entity'],
        responsibilities: {
            HTML: ['工作流列表、我的申请、办理页和详情页必须围绕 workflowContract 的流程节点和业务结果补充，不自造普通状态流转页面。'],
            Action: ['只做页面入口、流程上下文参数接收、调用 Service 和公司工作流能力；按钮返回遵守项目 Action callback 写法。'],
            ServiceApi: ['声明本业务流程需要的保存、流程动作前置条件和流程结果查询等方法。'],
            ServiceInternal: ['承载状态、权限、跨字段业务关系等流程动作前置条件、实体保存、流程相关业务字段维护和异常隔离；不得重复 HtmlPage 已表达的普通必填、长度、格式校验。'],
            Entity: ['最终实体/DDL/XML 需要 pviguid 等工作流公共字段，但这些字段由 Builder/公共字段规则补齐，Coder 不从需求文案硬造。']
        },
        mustReadReferences: [
            { ...REF.dispatch, section: 'GP-02' },
            { ...REF.legacyMiniui, section: 'BP-02' },
            REF.crudRecipes,
            REF.commonJs
        ],
        closureChecks: [
            '每个流程按钮、办理动作和查看入口必须能闭合到 Action/Service。不要只在前端写按钮。',
            'workflowContract.processName、activities、transitions 是流程事实来源；不要从示例项目反推当前流程节点。',
            'XML GUID、vmlId、开始/结束节点等实现标识由 Builder/XML 生成器确定，不由 Coder 编写。'
        ],
        redLines: [
            '不要把工作流降级成普通 status 字段手工改值。',
            '不要在 HtmlPage 拼装流程推进参数或绕过后端 Service。',
            '不要手写 XML GUID、vmlId 或把示例流程名/节点名带入当前项目。'
        ]
    }
});

const FACT_TYPE_TO_CARD = Object.freeze({
    external_api: ['external_api', 'config_risk'],
    api: ['external_api', 'config_risk'],
    http_api: ['external_api', 'config_risk'],
    third_party_api: ['external_api', 'config_risk'],
    record_keeping: ['audit_log'],
    audit_log: ['audit_log'],
    call_log: ['audit_log'],
    result_interaction: ['result_interaction'],
    preview_download: ['result_interaction', 'attachment'],
    import_export: ['import_export'],
    export: ['import_export'],
    'company_mechanism.code_item_candidate': ['code_item'],
    'company_mechanism.code_item_confirmed': ['code_item'],
    'company_mechanism.system_parameter': ['config_risk'],
    'company_mechanism.config_file': ['config_risk'],
    'company_mechanism.external_data_source': ['query', 'config_risk'],
    'company_mechanism.external_api': ['external_api', 'config_risk'],
    'company_mechanism.transaction': ['backend_layering'],
    'company_mechanism.attachment_preview': ['attachment'],
    'company_mechanism.attachment_file': ['attachment'],
    'company_mechanism.file_preview': ['attachment'],
    'company_mechanism.file_download': ['attachment'],
    'company_mechanism.import_export': ['import_export'],
    'company_mechanism.user_session': ['backend_layering'],
    'company_mechanism.menu_permission': ['config_risk'],
    'company_mechanism.scheduled_compensation': ['job_mq'],
    'company_mechanism.mq_message': ['job_mq'],
    'company_mechanism.workflow': ['workflow'],
    'company_mechanism.workflow_process': ['workflow'],
    'company_mechanism.approval_flow': ['workflow'],
    'company_mechanism.idempotent_log': ['audit_log'],
    'company_mechanism.audit_log': ['audit_log'],
    'company_mechanism.call_log': ['audit_log'],
    'company_mechanism.config_high_risk': ['config_risk'],
    'company_mechanism.status_flow': ['status_flow']
});

const PRACTICE_SCENE_TO_CARD = Object.freeze({
    code_item: ['code_item'],
    attachment_preview_download: ['attachment', 'result_interaction'],
    external_api: ['external_api', 'config_risk'],
    audit_log: ['audit_log'],
    system_parameter: ['config_risk'],
    scheduled_job: ['job_mq', 'config_risk'],
    job_or_mq: ['job_mq', 'config_risk'],
    status_flow: ['status_flow'],
    workflow: ['workflow'],
    workflow_process: ['workflow'],
    statistics_analysis: ['statistics_analysis', 'query'],
    report_analysis: ['statistics_analysis', 'query']
});

class CoderCompanyPracticeCardService {
    buildPracticeCards({ userStories = [], candidateFiles = [], businessFacts = {}, rulePool = {} } = {}) {
        const context = this._buildContext({ userStories, candidateFiles, businessFacts, rulePool });
        const requiredCardKeys = new Set();
        const candidateCardKeys = new Set();

        if (context.fileKinds.has('Job')) requiredCardKeys.add('job_mq');
        if (context.hasCodeItem) requiredCardKeys.add('code_item');

        this._addCardsByStructuredSignals(requiredCardKeys, context);
        this._addCardsByPracticeSceneKeys(requiredCardKeys, context.practiceSceneKeys);
        this._addCardsByFactTypes(requiredCardKeys, context.factTypes);
        this._addCardsByTextSignals(candidateCardKeys, context.text);

        return [
            ...Array.from(requiredCardKeys).map(key => ({ key, selectionMode: 'required' })),
            ...Array.from(candidateCardKeys)
                .filter(key => !requiredCardKeys.has(key))
                .map(key => ({ key, selectionMode: 'candidate' }))
        ]
            .map(item => this._buildCard(item.key, context, item.selectionMode))
            .filter(Boolean)
            .slice(0, 10);
    }

    _buildContext({ userStories = [], candidateFiles = [], businessFacts = {}, rulePool = {} } = {}) {
        const fileKinds = new Set((Array.isArray(candidateFiles) ? candidateFiles : [])
            .map(file => String(file && file.fileKind || '').trim())
            .filter(Boolean));
        const textParts = [];
        const factTypes = [];
        const codingFactSummaries = [];
        for (const story of (Array.isArray(userStories) ? userStories : [])) {
            textParts.push(story && story.userStory);
            if (Array.isArray(story && story.invariants)) textParts.push(...story.invariants);
            const ac = story && story.acceptanceCriteria && typeof story.acceptanceCriteria === 'object'
                ? story.acceptanceCriteria
                : {};
            Object.values(ac).forEach(group => {
                if (Array.isArray(group)) {
                    group.forEach(item => {
                        textParts.push(item && item.scenario, item && item.given, item && item.when, item && item.then);
                    });
                }
            });
            (Array.isArray(story && story.codingFactHandoff) ? story.codingFactHandoff : []).forEach(item => {
                const factType = String(item && item.factType || '').trim();
                const description = String(item && item.description || '').trim();
                if (factType) factTypes.push(factType);
                if (description) codingFactSummaries.push(`${factType ? `${factType}: ` : ''}${description}`);
                textParts.push(factType, description);
            });
        }
        (Array.isArray(businessFacts && businessFacts.databaseTables) ? businessFacts.databaseTables : [])
            .forEach(table => {
                textParts.push(table && table.tableName, table && table.tableComment);
                (Array.isArray(table && (table.businessColumns || table.fields)) ? (table.businessColumns || table.fields) : [])
                    .forEach(column => {
                        textParts.push(column && column.name, column && column.comment, column && column.codeItem, column && column.attachmentLabel);
                    });
            });
        (Array.isArray(businessFacts && businessFacts.statisticsContracts) ? businessFacts.statisticsContracts : [])
            .forEach(contract => {
                textParts.push(
                    contract && contract.title,
                    contract && contract.purpose,
                    ...(Array.isArray(contract && contract.filters) ? contract.filters : []).flatMap(item => [item && item.label, item && item.key, item && item.type]),
                    ...(Array.isArray(contract && contract.dimensions) ? contract.dimensions : []).flatMap(item => [item && item.label, item && item.key, item && item.granularity]),
                    ...(Array.isArray(contract && contract.metrics) ? contract.metrics : []).flatMap(item => [item && item.label, item && item.key, item && item.aggregate, item && item.condition])
                );
            });
        (Array.isArray(businessFacts && businessFacts.workflowContracts) ? businessFacts.workflowContracts : [])
            .forEach(contract => {
                textParts.push(
                    contract && contract.processName,
                    contract && contract.starter,
                    ...(Array.isArray(contract && contract.activities) ? contract.activities : []).flatMap(item => [
                        item && item.name,
                        item && item.actor,
                        ...(Array.isArray(item && item.operations) ? item.operations : []).map(op => {
                            if (op && typeof op === 'object' && !Array.isArray(op)) return op.name || op.key;
                            return op;
                        })
                    ]),
                    ...(Array.isArray(contract && contract.businessResults) ? contract.businessResults : [])
                );
            });
        const practiceSceneKeys = [];
        const compositionPracticeIds = [];
        (Array.isArray(businessFacts && businessFacts.pageCompositions) ? businessFacts.pageCompositions : [])
            .forEach(composition => (Array.isArray(composition && composition.practiceIds) ? composition.practiceIds : [])
                .forEach(id => compositionPracticeIds.push(String(id || '').trim())));
        (Array.isArray(businessFacts && businessFacts.businessObjects) ? businessFacts.businessObjects : [])
            .forEach(item => {
                const constructionSceneKey = String(item && item.constructionSceneKey || '').trim();
                if (constructionSceneKey) practiceSceneKeys.push(constructionSceneKey);
                if (item && item.statisticsContract) practiceSceneKeys.push('statistics_analysis');
                if (item && item.workflowContract) practiceSceneKeys.push('workflow_process');
                if (Array.isArray(item && item.workflowContracts) && item.workflowContracts.length > 0) practiceSceneKeys.push('workflow_process');
                (Array.isArray(item && item.practiceSceneKeys) ? item.practiceSceneKeys : [])
                    .forEach(key => practiceSceneKeys.push(String(key || '').trim()));
            });
        const confirmedRules = Array.isArray(rulePool && rulePool.confirmedRules) ? rulePool.confirmedRules : [];
        textParts.push(...confirmedRules);
        const text = textParts.map(value => String(value || '').trim()).filter(Boolean).join('\n');
        const candidateKinds = Array.from(fileKinds);
        return {
            fileKinds,
            text,
            factTypes: uniqueNonEmptyStrings(factTypes),
            practiceSceneKeys: uniqueNonEmptyStrings(practiceSceneKeys),
            compositionPracticeIds: uniqueNonEmptyStrings(compositionPracticeIds),
            codingFactSummaries: uniqueNonEmptyStrings(codingFactSummaries).slice(0, 6),
            hasCodeItem: this._hasCodeItem(businessFacts),
            hasAttachmentKey: this._hasAttachmentKey(businessFacts),
            hasFullCrudShape: ['Entity', 'ServiceApi', 'ServiceInternal', 'ServiceImpl', 'Action', 'HtmlPage']
                .every(kind => fileKinds.has(kind)),
            targetFileKinds: candidateKinds
        };
    }

    _hasCodeItem(businessFacts = {}) {
        const tables = Array.isArray(businessFacts && businessFacts.databaseTables) ? businessFacts.databaseTables : [];
        return tables.some(table => (Array.isArray(table && (table.businessColumns || table.fields)) ? (table.businessColumns || table.fields) : [])
            .some(column => String(column && column.codeItem || '').trim()));
    }

    _hasAttachmentKey(businessFacts = {}) {
        const tables = Array.isArray(businessFacts && businessFacts.databaseTables) ? businessFacts.databaseTables : [];
        return tables.some(table => (Array.isArray(table && (table.businessColumns || table.fields)) ? (table.businessColumns || table.fields) : [])
            .some(column => column && column.attachmentKey === true));
    }

    _addCardsByFactTypes(cardKeys, factTypes = []) {
        for (const factType of factTypes) {
            const normalized = String(factType || '').trim();
            const tokens = this._factTypeTokens(normalized);
            const mapped = FACT_TYPE_TO_CARD[normalized];
            if (mapped) mapped.forEach(key => cardKeys.add(key));
            if (tokens.some(token => /^(external|thirdparty|third|party|api|http|interface)$/iu.test(token))) cardKeys.add('external_api');
            if (tokens.some(token => /^(record|audit|call|log|trace|keeping)$/iu.test(token))) cardKeys.add('audit_log');
            if (tokens.some(token => /^(result|preview|download|interaction)$/iu.test(token))) cardKeys.add('result_interaction');
            if (tokens.some(token => /^(import|export|excel)$/iu.test(token))) cardKeys.add('import_export');
            if (/^company_mechanism\..*(attachment|preview|download|file)/u.test(normalized)) cardKeys.add('attachment');
            if (/^company_mechanism\..*(config|parameter|security|menu|permission)/u.test(normalized)) cardKeys.add('config_risk');
            if (/^company_mechanism\..*(job|scheduled|mq|message|compensation)/u.test(normalized)) cardKeys.add('job_mq');
            if (/^company_mechanism\..*(external|api|http|interface)/u.test(normalized)) cardKeys.add('external_api');
            if (/^company_mechanism\..*(audit|log|trace)/u.test(normalized)) cardKeys.add('audit_log');
        }
    }

    _addCardsByPracticeSceneKeys(cardKeys, practiceSceneKeys = []) {
        for (const key of (Array.isArray(practiceSceneKeys) ? practiceSceneKeys : [])) {
            const normalized = String(key || '').trim();
            const mapped = PRACTICE_SCENE_TO_CARD[normalized];
            if (Array.isArray(mapped)) {
                mapped.forEach(cardKey => cardKeys.add(cardKey));
            }
        }
    }

    _factTypeTokens(value = '') {
        return String(value || '')
            .trim()
            .split(/[._\-\s/]+/u)
            .map(token => token.trim().toLowerCase())
            .filter(Boolean);
    }

    _addCardsByTextSignals(cardKeys, text = '') {
        const source = String(text || '');
        const hasResultInteraction = /外部接口.*结果列表|第三方.*结果列表|平台接口.*结果列表|接口返回.*列表|结果列表.*(预览|下载|调阅)|结果弹窗|结果面板|临时结果|预览下载|预览和下载|调阅和下载/u.test(source)
            || ((/预览|下载|调阅/u.test(source)) && (/结果|列表|弹窗|面板|证照|材料|附件|文件/u.test(source)));
        if (/外部接口|第三方接口|平台接口|对外接口|接口调用|调用.{0,12}接口|HTTP|API|REST|回调|同步接口|Hutool|HttpUtil|HttpRequest/iu.test(source)) cardKeys.add('external_api');
        if (/审计|留痕|调用记录|接口日志|调用日志|记录日志|入参|出参|调用耗时|调用状态|调用结果/u.test(source)) cardKeys.add('audit_log');
        if (hasResultInteraction) cardKeys.add('result_interaction');
        if (/查询|检索|筛选|搜索|列表|分页|结果/u.test(source)) cardKeys.add('query');
        if (/统计|分析|汇总|报表|趋势|排名|分布|成功率|失败率|调用量/u.test(source)) cardKeys.add('statistics_analysis');
        if (/工作流|审批流|审批|提交|退回|转办|待办|流程历史|审批意见|办理流转/u.test(source)) cardKeys.add('workflow');
        if (/按钮|批量|操作列|行内|查看|预览|下载|删除|编辑/u.test(source)) cardKeys.add('toolbar_action');
        if (/弹窗|回填|父页|父页面|openDialog|openTopDialog|closeDialog/u.test(source)) cardKeys.add('dialog_flow');
        if (/启用|停用|发布|撤回|作废|状态流转|上架|下架/u.test(source)) cardKeys.add('status_flow');
        if (/附件|材料|上传|预览|下载|文件/u.test(source)) cardKeys.add('attachment');
        if (/导入|导出|Excel|模板下载/u.test(source)) cardKeys.add('import_export');
        if (/定时|补偿|同步|Quartz|MQ|队列|消息/u.test(source)) cardKeys.add('job_mq');
        if (/配置|系统参数|开关|地址|超时|阈值|白名单|SSO|权限|菜单/u.test(source)) cardKeys.add('config_risk');
    }

    _addCardsByStructuredSignals(cardKeys, context = {}) {
        if (context && context.hasAttachmentKey === true) cardKeys.add('attachment');
        if (Array.isArray(context && context.practiceSceneKeys)
            && context.practiceSceneKeys.some(key => key === 'workflow' || key === 'workflow_process')) {
            cardKeys.add('workflow');
        }
        const compositionMap = { 'GP-05': 'master_detail', 'BP-11': 'accordion', 'BP-12': 'inline_edit' };
        (Array.isArray(context && context.compositionPracticeIds) ? context.compositionPracticeIds : [])
            .forEach(id => {
                const key = compositionMap[String(id || '').trim()];
                if (key) cardKeys.add(key);
            });
    }

    _buildCard(key, context, selectionMode = 'required') {
        const def = CARD_DEFS[key];
        if (!def) return null;
        const appliesToFileKinds = (Array.isArray(def.fileKinds) ? def.fileKinds : [])
            .filter(kind => context.fileKinds.has(kind));
        const references = this._normalizeReferences(def.mustReadReferences);
        const isCandidate = selectionMode === 'candidate';
        return {
            practiceId: def.practiceId,
            label: def.label,
            selectionMode: isCandidate ? 'candidate' : 'required',
            useWhen: def.useWhen,
            doNotUseWhen: def.doNotUseWhen
                || '只有相似词或示例命中，但当前Story、验收标准和结构化事实不包含该机制时不适用。',
            ...(appliesToFileKinds.length > 0 ? { appliesToFileKinds } : {}),
            ...(context.codingFactSummaries.length > 0 && this._cardUsesMechanismFacts(key)
                ? { triggerFacts: context.codingFactSummaries.map(item => compactText(item, 140)) }
                : {}),
            responsibilities: def.responsibilities,
            mustReadReferences: isCandidate ? [] : references,
            ...(isCandidate ? { candidateReadReferences: references } : {}),
            closureChecks: uniqueNonEmptyStrings(def.closureChecks || []),
            redLines: uniqueNonEmptyStrings(def.redLines || [])
        };
    }

    _cardUsesMechanismFacts(key = '') {
        return ['code_item', 'attachment', 'import_export', 'job_mq', 'config_risk', 'status_flow',
            'external_api', 'audit_log', 'result_interaction'].includes(key);
    }

    _normalizeReferences(refs = []) {
        const seen = new Set();
        return (Array.isArray(refs) ? refs : [])
            .map(ref => {
                const pathValue = String(ref && ref.path || '').trim();
                if (!pathValue) return null;
                const section = String(ref && ref.section || '').trim();
                const key = `${pathValue}::${section}`;
                if (seen.has(key)) return null;
                seen.add(key);
                return {
                    path: pathValue,
                    ...(section ? { section } : {}),
                    readPolicy: section
                        ? '只读本文件相关章节；需要上下文时读取相邻小节，不全量展开其它参考。'
                        : '按本卡场景精确读取；不要遍历整个 company-practices 目录。'
                };
            })
            .filter(Boolean)
            .slice(0, 8);
    }
}

module.exports = CoderCompanyPracticeCardService;
