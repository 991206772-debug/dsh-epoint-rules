/* eslint-disable */

function array(value) {
    return Array.isArray(value) ? value : [];
}

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

function stripUndefined(obj = {}) {
    const out = {};
    Object.keys(obj || {}).forEach(key => {
        const value = obj[key];
        if (value !== undefined && value !== null && value !== '') out[key] = value;
    });
    return out;
}

const BACKEND_FILE_KINDS = Object.freeze([
    'Action',
    'Rest',
    'ServiceApi',
    'ServiceImpl',
    'ServiceInternal',
    'Job',
    'Entity'
]);

const PAGE_FILE_KINDS = Object.freeze([
    'HtmlPage',
    'Js',
    'Css'
]);

class DesignTddFrameworkWorkModeCardService {
    buildCards({ currentFileKind = '', allowedTargetFiles = [], apiUsageCard = null } = {}) {
        const fileKinds = uniqueNonEmptyStrings([
            currentFileKind,
            ...array(allowedTargetFiles).map(file => file && file.fileKind),
            apiUsageCard && apiUsageCard.fileKind
        ]);
        const hasBackend = fileKinds.some(kind => BACKEND_FILE_KINDS.includes(kind));
        const hasPage = fileKinds.some(kind => PAGE_FILE_KINDS.includes(kind));
        return stripUndefined({
            epointFrameworkWorkModeCard: this.buildGlobalCard({ fileKinds }),
            backendFrameworkWorkModeCard: hasBackend ? this.buildBackendCard({ fileKinds, apiUsageCard }) : null,
            pageFrameworkWorkModeCard: hasPage ? this.buildPageCard({ fileKinds }) : null
        });
    }

    buildGlobalCard({ fileKinds = [] } = {}) {
        return {
            actionMode: 'epoint_framework_mode_before_patch',
            advisory: true,
            timing: '读 current-execution-bundle 后、读目标文件和写 patch 前先看；不新增 Gate。',
            fileKinds: uniqueNonEmptyStrings(fileKinds),
            principle: '当前不是通用 Spring Boot/通用 Java/通用前端生成；必须按 Epoint 公司框架、规则池、小抄、最佳实践和项目样例写最小增量代码。',
            mustUseAsTruth: [
                '规则池、小抄、practiceCards、routeContracts、reuse/source 文件是当前 patch 的写法依据，不是可选参考。',
                '非 JDK/非浏览器内置 API、公司 Util、项目 Service/API、页面 epoint/MiniUI/FUI 调用，必须有签名、调用形态或项目样例证据。',
                '证据不足时先按当前 bundle 的 READ/RULE/API 行精确补读；仍无证据就 BLOCKER，不凭训练记忆补方法。'
            ],
            beforePatchOutput: [
                '本轮属于页面轨还是后端轨。',
                '当前 fileKind 必须采用的公司写法结论。',
                '本轮新增/修改的 API/工具/页面调用分别来自哪张小抄、规则、源码或样例。'
            ]
        };
    }

    buildBackendCard({ fileKinds = [], apiUsageCard = null } = {}) {
        return stripUndefined({
            actionMode: 'epoint_backend_mode_before_patch',
            advisory: true,
            appliesToFileKinds: BACKEND_FILE_KINDS,
            currentBackendFileKinds: uniqueNonEmptyStrings(fileKinds).filter(kind => BACKEND_FILE_KINDS.includes(kind)),
            responsibilityMap: [
                'Action/Rest：入口适配、参数校验、统一返回、调用 Service/API；不直接写 DAO/SQL。',
                'ServiceApi：只声明接口签名。',
                'ServiceImpl：只做 @Component + implements + 转发，不写业务/DAO/SQL。',
                'ServiceInternal：承载真实业务、SqlConditionUtil 条件和 DAO/SQL。',
                'Job：调度入口，业务落 Service；不把查询/DAO/SQL塞进 Job。',
                'Entity：按 Epoint Entity/BaseEntity 写法，不写通用 JPA/Lombok/MyBatis。'
            ],
            apiEvidenceRule: '新增/修改 receiver.method(...) 或 Class.staticMethod(...) 前，先在 apiUsageCard / rule_expert / 真实源码 / 项目样例中找到签名或 callShape。',
            quickPositiveExamples: [
                'JSONObject paramsObj = jsonObject.getJSONObject("params");',
                'Integer pageNumObj = paramsObj.getInteger("pageNum"); int pageNum = pageNumObj == null || pageNumObj <= 0 ? 1 : pageNumObj;',
                'EpointDateUtil.convertDate2String(date, "yyyy-MM-dd HH:mm:ss");'
            ],
            quickNegativeExamples: [
                '不要写 JSONObject.getIntValue("pageNum", 1)：未证实默认值重载。',
                '不要写 EpointDateUtil.format(...) / parseDate(...)：未在规则小抄或项目样例证实。',
                '不要在 Action/Rest/Job 里直接 CommonDao/ICommonDao/baseDao/裸 SQL。'
            ],
            apiUsageCardHint: apiUsageCard
                ? '当前施工包已带 API 证据；优先使用真实 owner、签名和调用形态，缺签名再按 RULE/READ 行补读。'
                : '当前施工包没有 API 证据时，必须按 READ/RULE 行或真实源码补证据。'
        });
    }

    buildPageCard({ fileKinds = [] } = {}) {
        return {
            actionMode: 'epoint_page_mode_before_patch',
            advisory: true,
            appliesToFileKinds: PAGE_FILE_KINDS,
            currentPageFileKinds: uniqueNonEmptyStrings(fileKinds).filter(kind => PAGE_FILE_KINDS.includes(kind)),
            responsibilityMap: [
                'HtmlPage/Js/Css 走 Epoint 页面、MiniUI/FUI 和项目页面实践；不套后端 DAO/ServiceInternal 写法。',
                '页面调用后台方法必须以 routeContracts、epoint.initPage 默认 Action 或显式 action/method 为证据。',
                '弹窗、回调、DataGrid、表单提交和刷新逻辑按页面 practiceCards/routes 写；不凭按钮名猜后台方法。'
            ],
            mustReadWhenTouchingPage: [
                '当前 HtmlPage practiceCards。',
                'routes.json / routeContracts。',
                '目标页面源码中的 initPage、toolbar、datagrid、form、callback 锚点。'
            ],
            quickNegativeExamples: [
                '不要在页面轨引用后端 DAO/SQL/ServiceInternal 规则。',
                '不要裸拼复杂 HTML 当业务弹窗。',
                '不要跳过 routeContracts 直接猜 Action public 方法。'
            ]
        };
    }
}

module.exports = DesignTddFrameworkWorkModeCardService;
