/* eslint-disable */
/**
 * TechStackGuardService
 *
 * 故事线：骨架物化已做到无旧占位块（公司风格壳完整），但 LLM 在 acceptance loop
 * 补业务方法体时可能凭训练记忆写出 MyBatis/Vue/axios 等外部技术栈代码。
 *
 * 本服务提供：
 *   1. getDeclaration() — 返回 techStackDeclaration（must/forbidden 清单）给 prepare_context 首屏
 *   2. scan(content, ext, options) — 对指定内容跑 forbidden pattern 检测，返回 violations[]
 *
 * 设计原则：
 *   - Declaration 和 Scan 用同一份数据源（PATTERNS），不复制两套清单
 *   - 硬禁（hard）：命中即拦，不看上下文
 *   - 条件禁（conditional）：命中后需通过 condition(content) 二次确认
 *   - 注释行默认跳过（// / 块注释 / HTML 注释）
 *   - 字符串内关键词不误伤（通过行级判断是否在引号内）
 */
'use strict';

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

class TechStackGuardService {
    constructor() {}

    /**
     * 返回 techStackDeclaration（给 LLM 首屏看的 must/forbidden 清单）。
     * 瘦身版，不超过 ~600 字符。
     */
    getDeclaration() {
        return {
            backend: {
                must: [
                    '先对照公司示例优先改写公司 CRUD 结构，再补当前业务方法体',
                    '数据库操作：ICommonDao + CommonDao.getInstance()，只在 ServiceInternal 里持有',
                    '条件构建：SqlConditionUtil 链式（.eq/.like/.in/.ge/.le + .getMap()）',
                    '注册：ServiceImpl 用 @Component（老代码可能有 Dubbo @Service 并存，新代码必须有 @Component）',
                    '管理端 Action：@RestController("xxx") + @Scope("request") + extends BaseController',
                    'REST 接口：按 REST接口开发规范使用 @RestController + @RequestMapping',
                    '显式事务（仅级联/跨表时）：EpointFrameDsManager.begin/commit/rollback/close'
                ],
                forbidden: [
                    'MyBatis（@Mapper / XML Mapper / BaseMapper / selectByExample）',
                    'JPA（EntityManager / @Repository / JpaRepository / CrudRepository）',
                    '@Transactional（用 EpointFrameDsManager 手动事务）',
                    'Action 里直接持有 ICommonDao / baseDao',
                    'SpringContextUtil.getBean',
                    'Action 禁用 @RequestMapping / @PostMapping / @GetMapping（epoint.execute 直接调方法名）；REST 接口按 REST规范例外'
                ]
            },
            frontend: {
                must: [
                    '先对照公司示例优先改写公司页面结构，再补当前页面交互与业务逻辑',
                    '初始化：epoint.initPage(\'{actionName}\')',
                    '数据交互：epoint.execute(method, ids, params, callback)',
                    '刷新：epoint.refresh([ids], callback, keepPageIndex)',
                    '布局：EUI role="form/row/control"',
                    '控件：MiniUI class="mini-textbox/mini-datagrid/mini-combobox"',
                    '弹窗：epoint.openDialog / epoint.openTopDialog',
                    '提示：epoint.alert / epoint.confirm / epoint.showTips'
                ],
                forbidden: [
                    'Vue / React / Angular（v-model / v-for / useState / JSX）',
                    'Element Plus / Ant Design / Naive UI（<el-xxx> / <a-xxx>）',
                    '$.ajax / axios / fetch / XMLHttpRequest',
                    '原生 alert() / confirm()（用 epoint.alert / epoint.confirm）',
                    '<table><tr><td> 做表单布局（用 EUI role 体系）',
                    'JSP'
                ]
            }
        };
    }

    /**
     * 公共：按 fileKind 取后端/前端的 must/forbidden 摘要，给"写代码那一刻"内联用。
     * 共享给 design-tdd-acceptance（每条 Story 卡）和 design-tdd-skeleton（首改卡），
     * 避免 must/forbidden 逻辑两份拷贝。practice 卡由调用方各自附加（依赖 facts）。
     */
    buildReminder(fileKind = '', note = '') {
        const decl = this.getDeclaration();
        const isFrontend = String(fileKind || '').trim() === 'HtmlPage';
        const side = isFrontend ? decl.frontend : decl.backend;
        return {
            forFileKind: String(fileKind || '').trim() || 'unknown',
            mustUse: Array.isArray(side && side.must) ? side.must.slice(0, 4) : [],
            forbidden: Array.isArray(side && side.forbidden) ? side.forbidden.slice(0, 4) : [],
            hardLines: this.getHardLines(),
            companyCodeRedlines: this.getCoreCodeRedlines(fileKind),
            note: String(note || '').trim() || '公司框架写法清单；以本项目框架为准，不要凭训练记忆写 Spring/MyBatis/Vue。'
        };
    }

    buildCompanyCodeRedlineCard({ currentFileKind = '', allowedTargetFiles = [] } = {}) {
        const currentKind = this._normalizeFileKind(currentFileKind);
        const fileKinds = uniqueNonEmptyStrings([
            currentKind,
            ...(Array.isArray(allowedTargetFiles) ? allowedTargetFiles : [])
                .map(file => this._normalizeFileKind(file && file.fileKind))
        ]).filter(Boolean);
        const targetKinds = fileKinds.length > 0 ? fileKinds : [currentKind || 'Backend'];
        return {
            actionMode: 'must_apply_company_code_redlines_before_edit',
            timing: '读 current-execution-bundle 后、编辑任一 TARGET|write 文件前先看本卡；不是 Gate，是动手前施工小抄。',
            principle: '先判断当前文件职责边界，再写代码；公司 API/Util/Service 方法必须有规则原文或真实源码签名证据，禁止凭记忆补方法名。',
            currentFileKind: currentKind || undefined,
            currentFileKindRedlines: this.getCoreCodeRedlines(currentKind),
            perAllowedFileKindRedlines: targetKinds.map(kind => ({
                fileKind: kind,
                redlines: this.getCoreCodeRedlines(kind)
            })),
            globalBackendBoundary: [
                'Action/Rest/Job 不直接持有 CommonDao/ICommonDao/baseDao/commonDao，不写裸 SQL/select/queryInt/findList/insert/update/delete。',
                '查询、统计、写库、复杂业务规则下沉 ServiceInternal；ServiceApi 声明、ServiceImpl 只代理、ServiceInternal 实现。',
                '新增或调用公司工具方法前必须先有规则/源码签名证据；先读 readCatalog 登记的本地正文或精确源码，本地证据缺失时才调 rule_expert(read)，仍无则 blocked。',
                '整文件重写前先核对 imports/父类/注解/已有方法；不要把骨架或项目已有依赖写丢。'
            ]
        };
    }

    _normalizeFileKind(fileKind = '') {
        const text = String(fileKind || '').trim();
        const lower = text.toLowerCase();
        if (lower === 'htmlpage' || lower === 'html' || lower === 'page') return 'HtmlPage';
        if (lower === 'action' || lower === 'listaction' || lower === 'addaction' || lower === 'editaction' || lower === 'detailaction') return 'Action';
        if (lower === 'rest' || lower === 'restcontroller') return 'Rest';
        if (lower === 'job' || lower === 'quartz') return 'Job';
        if (lower === 'serviceapi' || lower === 'api') return 'ServiceApi';
        if (lower === 'serviceimpl') return 'ServiceImpl';
        if (lower === 'serviceinternal' || lower === 'service') return 'ServiceInternal';
        if (lower === 'entity') return 'Entity';
        return text;
    }

    /**
     * 行为红线（每轮内联重投）：trace 显示 LLM 会忘掉 SKILL 里的这几条，
     * 所以把最硬的几条行为约束随 reminder 一起放到"写代码那一刻"的卡里。
     * 只放行为类（搜索/造文件/路由闭合/逐条 evidence），技术栈类已在 mustUse/forbidden。
     * 保持 ≤5 条、短句，避免淹没；它是高信号提醒，不是新 Gate。
     */
    getHardLines() {
        return [
            '只在 authorizedWriteRoots 内修改或新增业务源码；候选文件和既有入口仅作参考，骨架已就位的不重写。',
            '禁止 search_codebase/file_search/list_directory 搜工程；要读源码只走 reuseCard/relatedFiles 精确路径。',
            '改页面后核对 epoint.execute/action 闭合到候选 Action 的 public 方法；裸 execute 只走默认 Action，跨 Action 写 action/method。',
            '每个 Story 提交一次 todoDoneItems；按当前 Story pending 验收项逐条填 code + summary，禁止跨 Story silent 批量打勾。'
        ];
    }

    /**
     * 公司代码红线（每个 Draft 前部短投）：只表达所有需求都适用的风格底线。
     * 细节仍以 practiceCards / ruleRefs / 公司最佳实践 MD 为准，这里不展开。
     */
    getCoreCodeRedlines(fileKind = '') {
        const normalizedKind = this._normalizeFileKind(fileKind);
        if (normalizedKind === 'HtmlPage') {
            return [
                '管理端页面必须按 FUI/MiniUI/epoint.* 写，不写 Vue/React/Element/axios/fetch。',
                '页面初始化、datagrid/combobox action、epoint.execute 必须和 Action public 方法闭合。',
                '生成型 CRUD 保存、删除、状态操作的前端回调默认读取 data.msg；只有既有页面已明确使用 message/messageno 时才沿用既有字段。',
                '弹窗、刷新、提示、表单布局按公司 epoint/EUI 写法，不自造原生交互。',
                '代码项、附件、导入导出等能力按命中实践和项目样例，不在 JS 里硬编码业务机制。'
            ];
        }
        if (normalizedKind === 'Action') {
            return [
                '管理端 Action 必须是公司 Action 写法：@RestController("xxx")、@Scope("request")、extends BaseController。',
                'Action 只做入参、回调和 Service 编排，禁止 CommonDao/ICommonDao/baseDao/commonDao、裸 SQL、queryInt/findList/insert/update/delete。',
                'epoint.execute 调用的方法必须是 Action public 方法；Action 内不用 @RequestMapping/@PostMapping。',
                '登录用户、UserSession、父类方法必须按 UserSession 规则或真实父类源码取证，禁止猜 getUserSession/getCurrentUser。',
                '管理端 CRUD 保存、删除、状态类方法默认 addCallbackParam("msg", "...")；前端默认 data.msg，除非既有页面已明确读取 message/messageno。',
                '返回、弹窗回调、异常提示按 addCallbackParam/epoint 体系，不写普通 Spring Boot Controller 套路。'
            ];
        }
        if (normalizedKind === 'Rest') {
            return [
                'REST 只做 JSON 入参解析、token/必填校验、返回封装和 Service 编排，不写 DAO/裸 SQL。',
                '入参固定从 @RequestBody String params 根 JSON 取 token、从 params 子对象取业务字段；不得改走 request/header 猜字段。token 不要从 Authorization/X-Token/Bearer 等 HTTP header 取。',
                'token 校验沿用项目已有轻量方式（如 ZwdtConstant.SysValidateData.equals(token)、JsonUtils.checkUserAuth(token)）；禁止硬编码字面量（"valid_token_for_thirdparty" 等），禁止凭空新增 XxxTokenService/XxxCredentialManager/OAuth 模型；项目无可确认样例时 blocker，不自造认证体系。',
                'JsonUtils、JSONObject、EpointDateUtil 等工具方法必须有规则/源码签名证据，禁止猜 getIntValue/parseDate 等未证实方法。',
                '分页/查询/统计应调用已证实 Service 方法；需要新增查询能力先补 ServiceApi/ServiceImpl/ServiceInternal 闭环。'
            ];
        }
        if (normalizedKind === 'Job') {
            return [
                'Job 只做调度入口、日志、日期/上下文参数、异常包装和调用 Service。',
                'Job 禁止 CommonDao/ICommonDao/baseDao/commonDao/SqlConditionUtil/String sql/select/queryInt/findList/insert/update/delete。',
                '统计、查询、批量写库必须下沉 ServiceInternal，并通过 ServiceApi/ServiceImpl 三层同名同参闭合。',
                'Job 依赖获取、日志写法按定时任务 Job 规则或项目真实样例；不要整文件写丢 import。'
            ];
        }
        if (normalizedKind === 'ServiceApi') {
            return [
                'ServiceApi 只声明接口方法和必要类型 import，不写方法体、不写 DAO/SQL/业务实现。',
                '新增业务方法名、参数、返回类型必须和 ServiceImpl/ServiceInternal 同名同参闭合。',
                '接口方法必须来自当前 Story 业务能力，不为绕过 Action/Rest/Job 红线乱造低层 DAO 方法。',
                '不要把 CommonDao、SqlConditionUtil、Controller/Request/Response 依赖引入 ServiceApi。'
            ];
        }
        if (normalizedKind === 'ServiceImpl') {
            return [
                'ServiceImpl 只做接口实现和转发：return new XxxService().method(args)，不写业务分支。',
                'ServiceImpl 禁止 CommonDao/ICommonDao/baseDao/commonDao/SqlConditionUtil/String sql/select/queryInt/findList/insert/update/delete。',
                '新增或修改方法必须和 ServiceApi/ServiceInternal 同名同参同返回闭合。',
                'ServiceImpl 不读取 request/session/page 回调，不承载 Action/Rest/Job 职责。'
            ];
        }
        if (normalizedKind === 'ServiceInternal') {
            return [
                'ServiceInternal 是唯一常规 DAO/SQL/SqlConditionUtil 落点；真实查询、统计、写库放这里。',
                'ICommonDao/CommonDao/SqlConditionUtil 方法必须按规则或真实源码签名使用，禁止猜 queryMapList/count/parse 等方法。',
                '对外业务能力由 ServiceApi 暴露、ServiceImpl 代理；不要只在 ServiceInternal 单层新增孤立方法。',
                'ServiceInternal 不写 Controller 注解、页面回调、HttpServletRequest/Response 入参解析。'
            ];
        }
        if (normalizedKind === 'Entity') {
            return [
                'Entity 只放字段 getter/setter 和必要注解，不写业务逻辑、DAO、Service 调用。',
                '字段类型、字段名、表映射以设计表和项目实体习惯为准，不凭中文名自由造列。',
                '日期/整型等 getter/setter 按项目既有 Entity 风格，不混入 Lombok/JPA。'
            ];
        }
        return [
            '后端按 Epoint Action/Service/Entity/CommonDao 风格写，不套 MyBatis/JPA/Lombok/Spring Boot CRUD。',
            'Action/Rest/Job 禁止直接 DAO/SQL；查询、统计、写库落 ServiceInternal，ServiceApi/ServiceImpl 闭环。',
            '页面与 Action 方法必须闭合；跨 Action 调用写 action/method，不写无法路由的裸方法。',
            '公司 API/Util/Service 方法必须有规则或源码签名证据；禁止凭空造 API/key/协议。'
        ];
    }

    /**
     * 返回 techStackReminder 精简版（每次 nextStep 带的 3 条提醒）。
     */
    getReminder() {
        return [
            '后端先对照公司示例优先改写公司 CRUD 结构，禁止 MyBatis/JPA',
            '前端先对照公司示例优先改写公司页面结构，禁止 Vue/React/axios',
            '用 ICommonDao + SqlConditionUtil + epoint.execute'
        ];
    }

    /**
     * 扫描内容，返回 violations[]。
     *
     * @param {string} content - 要扫描的代码内容
     * @param {string} ext - 文件扩展名（'.java' / '.html' / '.htm'）
     * @param {object} options
     * @param {boolean} options.skipComments - 是否跳过注释行（默认 true）
     * @param {string[]} options.onlyLines - 可选，只扫描这些行内容（用于 patch 扫描）
     * @returns {{ violations: Array<{line: number, snippet: string, msg: string}> }}
     */
    scan(content, ext, options = {}) {
        const skipComments = options.skipComments !== false;
        const lines = String(content || '').split('\n');

        // 确定用哪套 patterns
        const isJava = ext === '.java';
        const isHtml = ext === '.html' || ext === '.htm';
        if (!isJava && !isHtml) return { violations: [] };

        const scanContext = this._buildScanContext(content, ext, options);
        const hardPatterns = isJava ? JAVA_HARD : HTML_HARD;
        const conditionalPatterns = isJava ? JAVA_CONDITIONAL : HTML_CONDITIONAL;

        // 如果指定了 onlyLines，只扫这些内容
        const linesToScan = options.onlyLines
            ? options.onlyLines.map((text, i) => ({ text, lineNo: i + 1 }))
            : lines.map((text, i) => ({ text, lineNo: i + 1 }));

        const violations = [];
        let inBlockComment = false;

        for (const { text, lineNo } of linesToScan) {
            const trimmed = text.trim();

            // 跳过注释
            if (skipComments) {
                if (isJava) {
                    if (inBlockComment) {
                        if (trimmed.includes('*/')) inBlockComment = false;
                        continue;
                    }
                    if (trimmed.startsWith('/*')) {
                        inBlockComment = !trimmed.includes('*/');
                        continue;
                    }
                    if (trimmed.startsWith('//')) continue;
                }
                if (isHtml) {
                    if (inBlockComment) {
                        if (trimmed.includes('-->')) inBlockComment = false;
                        continue;
                    }
                    if (trimmed.startsWith('<!--')) {
                        inBlockComment = !trimmed.includes('-->');
                        continue;
                    }
                    // JS 行内注释
                    if (trimmed.startsWith('//')) continue;
                }
            }

            // 跳过字符串内容（简单启发式：行内引号数为偶数且关键词在引号间）
            // 这里用简化判断：如果整行是 String 赋值且关键词在引号内，跳过
            // 完整实现太复杂，用 hard pattern 设计时就避开字符串内常见误伤

            // 硬禁
            for (const rule of hardPatterns) {
                if (rule.pattern.test(text) && this._shouldReportRule(rule, text, scanContext)) {
                    violations.push({
                        line: lineNo,
                        snippet: text.trim().slice(0, 80),
                        msg: rule.msg
                    });
                    break; // 一行只报第一个违规
                }
            }

            // 条件禁
            for (const rule of conditionalPatterns) {
                if (rule.pattern.test(text) && rule.condition(content)) {
                    violations.push({
                        line: lineNo,
                        snippet: text.trim().slice(0, 80),
                        msg: rule.msg
                    });
                    break;
                }
            }
        }

        return { violations };
    }

    _buildScanContext(content, ext, options = {}) {
        const filePath = String(options.filePath || options.path || '').replace(/\\/g, '/');
        const fileKind = String(options.fileKind || '').trim();
        const isJava = ext === '.java';
        const isActionController = isJava && (
            /^Action$/i.test(fileKind)
            || /\/action\//i.test(filePath)
            || /Action\.java$/i.test(filePath)
            || /\bclass\s+[A-Za-z0-9_]*Action\b/.test(content || '')
            || /extends\s+BaseController\b/.test(content || '')
        );
        const isRestController = isJava && !isActionController && (
            /^Rest$/i.test(fileKind)
            || /\/rest\//i.test(filePath)
            || /RestController\.java$/i.test(filePath)
            || (
                /@RestController\b/.test(content || '')
                && (
                    /\bclass\s+[A-Za-z0-9_]*RestController\b/.test(content || '')
                    || /zwdtRestReturn\b/.test(content || '')
                )
            )
        );
        const isJob = isJava && (
            /^Job$/i.test(fileKind)
            || /\/job\//i.test(filePath)
            || /Job\.java$/i.test(filePath)
            || /\bimplements\s+Job\b/.test(content || '')
        );
        const isServiceInternal = isJava && (
            /^ServiceInternal$/i.test(fileKind)
            || (/Service\.java$/i.test(filePath) && !/^I[A-Za-z0-9_]+Service\.java$/i.test(pathBasename(filePath)))
        );
        const isServiceImpl = isJava && (
            /^ServiceImpl$/i.test(fileKind)
            || /ServiceImpl\.java$/i.test(filePath)
        );
        const isSpringManagedBackend = isActionController || isRestController || isServiceInternal || isServiceImpl;
        return { filePath, fileKind, isJava, isActionController, isRestController, isJob, isServiceInternal, isServiceImpl, isSpringManagedBackend };
    }

    _shouldReportRule(rule, text, scanContext = {}) {
        if (!rule || !rule.kind) return true;
        if (rule.kind === 'spring_route_annotation') {
            if (scanContext.isRestController && /@RequestMapping\b/.test(text)) {
                return false;
            }
        }
        if (rule.kind === 'dao_sql_outside_service_internal') {
            return !scanContext.isServiceInternal;
        }
        if (rule.kind === 'job_dao_sql') {
            return scanContext.isJob;
        }
        if (rule.kind === 'container_factory_managed_backend') {
            return scanContext.isSpringManagedBackend;
        }
        if (rule.kind === 'rest_hardcoded_token_literal'
            || rule.kind === 'rest_invent_token_model'
            || rule.kind === 'rest_header_token_lookup') {
            return scanContext.isRestController;
        }
        return true;
    }
}

function pathBasename(filePath = '') {
    const normalized = String(filePath || '').replace(/\\/g, '/');
    return normalized.split('/').pop() || '';
}

// ═══════════════════════════════════════════════════════
// Pattern 定义（Declaration 和 Scan 共享同一份源）
// ═══════════════════════════════════════════════════════

const JAVA_HARD = [
    { pattern: /@Mapper\b/, msg: '禁止 MyBatis @Mapper，用 ICommonDao + SqlHelper' },
    { pattern: /\bBaseMapper\b|MybatisPlus|MapperScan/, msg: '禁止 MyBatis-Plus' },
    { pattern: /\bJpaRepository\b|\bEntityManager\b|\bCrudRepository\b/, msg: '禁止 JPA' },
    { pattern: /@Transactional\b/, msg: '用 EpointFrameDsManager.begin/commit/rollback 不用 @Transactional' },
    { pattern: /@RequestMapping\b|@PostMapping\b|@GetMapping\b|@DeleteMapping\b|@PutMapping\b/, kind: 'spring_route_annotation', msg: 'Action 不用 Spring MVC 路由注解，epoint.execute 直接调方法名；REST接口按 REST接口开发规范使用 @RequestMapping' },
    { pattern: /\bResponseEntity\b|\bModelAndView\b/, msg: '用 addCallbackParam 返回数据，不用 ResponseEntity' },
    { pattern: /SpringContextUtil\.getBean\s*\(/, msg: '禁止 SpringContextUtil.getBean，用 @Autowired' },
    { pattern: /\bAI_TODO\b/i, msg: '骨架 AI_TODO 必须替换成真实业务代码' },
    { pattern: /\bCommonDao\b|\bICommonDao\b|\bbaseDao\b|\bString\s+sql\b|\bqueryForList\s*\(|\bqueryMapList\s*\(|\bqueryInt\s*\(/, kind: 'job_dao_sql', msg: 'Job 只做调度入口和调用 Service，禁止 DAO/SQL/查询写库逻辑' },
    { pattern: /\bContainerFactory\s*\.\s*(?:getContainInfo\s*\(\)\s*\.\s*)?getComponent\s*\(/, kind: 'container_factory_managed_backend', msg: 'Action/Rest/Service 属于 Spring 管理类，禁止用 ContainerFactory 手动取服务；IConfigService 等依赖优先 @Autowired 成员注入。Job/MQ/listener/static util 例外' },
    // REST token 红线（仅在 Rest fileKind 触发；只匹配字符串字面量里的硬编码 token，不误伤变量名/常量名）
    { pattern: /["'](?:valid_token_for_thirdparty|test_token|fake_token|mock_token|dummy_token)["']/, kind: 'rest_hardcoded_token_literal', msg: 'REST token 校验禁止硬编码字面量（valid_token_for_thirdparty 等）；优先沿用项目已有轻量校验如 ZwdtConstant.SysValidateData.equals(token) 或 JsonUtils.checkUserAuth(token)。当前项目无可确认样例时 blocker，不自造认证体系' },
    { pattern: /\bclass\s+[A-Z][A-Za-z0-9_]*(?:Token|Credential|OAuth)(?:Service|Manager|Provider|Repository|Dao|Mapper|Entity)\b/, kind: 'rest_invent_token_model', msg: 'REST 不要凭空新增 token/credential/OAuth 模型类（XxxTokenService/XxxCredentialManager 等）；token 校验沿用项目已有常量或工具方法，证据不足时 blocker' },
    { pattern: /request\s*\.\s*getHeader\s*\(\s*["'](?:Authorization|X-Token|access_token|Bearer)["']/i, kind: 'rest_header_token_lookup', msg: 'REST 入参合同：token 从 @RequestBody String params 根 JSON 取，业务字段从 params 子对象取；不要从 HTTP header（Authorization/X-Token/Bearer）取 token，HttpServletRequest 只承载 HTTP 上下文' },
];

const JAVA_CONDITIONAL = [
    {
        // 新增管理端 ServiceImpl 只有 @Service 没有 @Component
        pattern: /@Service\b/,
        condition: (content) => {
            // 如果有 Dubbo import，不拦（老代码兼容）
            if (/com\.alibaba\.dubbo/.test(content)) return false;
            // 如果已有 @Component，不拦
            if (/@Component\b/.test(content)) return false;
            // 如果是 ServiceImpl 类，拦
            return /ServiceImpl\b/.test(content);
        },
        msg: '新增管理端 ServiceImpl 必须有 @Component（@Service 单独不注册 Spring 容器）'
    },
    {
        // Action 里直接持有 ICommonDao
        pattern: /(?:private|protected)\s+ICommonDao\b/,
        condition: (content) => /extends\s+BaseController\b/.test(content),
        msg: 'Action 禁止直接持有 ICommonDao，数据库操作只在 ServiceInternal 里做'
    }
];

const HTML_HARD = [
    { pattern: /<el-[a-z-]+|<a-[a-z-]+|<n-[a-z-]+/, msg: '禁止 Element/Ant/Naive 标签，用 MiniUI' },
    { pattern: /\bv-(?:model|for|if|else|show|bind)\b/, msg: '禁止 Vue 指令' },
    { pattern: /import\s+.*from\s+['"](?:vue|react|angular)['"]/, msg: '禁止前端框架导入' },
    { pattern: /\$\.ajax\s*\(/, msg: '用 epoint.execute 不用 $.ajax' },
    { pattern: /\baxios\.|\baxios\s*\(/, msg: '用 epoint.execute 不用 axios' },
    { pattern: /\bfetch\s*\(\s*['"]/, msg: '用 epoint.execute 不用 fetch' },
    { pattern: /\blayer\.open\s*\(/, msg: '管理端页面弹窗按公司 epoint.openDialog/openTopDialog 或现有页面结构，禁止 layer.open 自造复杂弹窗' },
    { pattern: /\bwindow\.open\s*\(/, msg: '禁止 window.open 代替公司弹窗/预览/下载封装' },
    { pattern: /<a\b[^>]*\bonclick\s*=/, msg: 'HtmlPage 禁止裸拼 <a onclick=...>，按公司按钮/事件绑定/Action 闭合写法处理' },
    { pattern: /renderer\s*:\s*function[\s\S]*?<a\b[\s\S]*?onclick\s*=/, msg: 'renderer 禁止裸拼 <a onclick=...>，按公司按钮/事件绑定/Action 闭合写法处理' },
];

const HTML_CONDITIONAL = [
    {
        // alert() 在字符串拼接里（如 "alert('xxx')" 作为 onclick）不拦；
        // 但在 JS 逻辑行里直接调用 alert( / window.alert( 要拦；
        // epoint.alert( 是公司平台方法，不能误伤。
        pattern: /(?:^|[^\w$.])(?:window\.)?alert\s*\(\s*['"]/,
        condition: (content) => {
            // 如果整个文件有 epoint.alert 说明项目已经用了平台方法，
            // 但又出现原生 alert( 就是违规
            return /epoint\.(?:alert|showTips|confirm)\s*\(/.test(content);
        },
        msg: '禁止原生 alert()/window.alert()；epoint.alert 是合法平台方法，不要替换为 showTips'
    }
];

module.exports = TechStackGuardService;
