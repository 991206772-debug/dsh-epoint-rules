/* eslint-disable */
/**
 * DesignTddExampleHintService — 示例代码指针解析（共享 helper）
 *
 * 故事线：LLM 写每条 Story 验收项业务代码前，需要看公司规范的示例代码学 Epoint API 用法
 * （epoint.execute / baseDao / SqlConditionUtil / @RestController 命名）。
 * Builder 给精确文件清单，让 LLM 按字典查表 read_file，避免：
 *   - search_codebase 全工程找参考实现（红线"不跨阶段搜工程补事实"）
 *   - list_directory 自己列目录挑文件（边缘违反"可推导路径必须精确读"）
 *
 * 设计取舍：
 *   - aifactor 是 Epoint 公司知识库 f9 框架的标准 CRUD 示例约定（跨项目稳定）
 *   - 路径 / 文件不存在则相应 key 省略；整个 examples 都没有则返回 null（字段省略）
 *   - 返回相对 projectPath 的相对路径，跨机器迁移友好
 *   - 由骨架服务和整需求编码资料共同使用，按 fileKind/subtype 提供示例指针
 */
const fs = require('fs');
const path = require('path');

const EXAMPLE_ROOT_SEGMENTS = ['.knowledge', 'frameworks', 'f9', 'crud-examples', 'aifactor'];
const F9_ROOT_SEGMENTS = ['.knowledge', 'frameworks', 'f9'];
const LEGACY_CANDIDATES = {
    'Entity': path.join('api', 'entity', 'AiFactor.java'),
    'ServiceApi': path.join('api', 'IAiFactorService.java'),
    'ServiceInternal': path.join('impl', 'AiFactorService.java'),
    'ServiceImpl': path.join('impl', 'AiFactorServiceImpl.java'),
    'Action': path.join('action', 'AiFactorListAction.java'),
    'list.html': path.join('pages', 'aifactorlist.html'),
    'add.html': path.join('pages', 'aifactoradd.html'),
    'edit.html': path.join('pages', 'aifactoredit.html'),
    'detail.html': path.join('pages', 'aifactordetail.html')
};
const SUBTYPE_CANDIDATES = {
    Action: {
        list: path.join('action', 'AiFactorListAction.java'),
        add: path.join('action', 'AiFactorAddAction.java'),
        edit: path.join('action', 'AiFactorEditAction.java'),
        detail: path.join('action', 'AiFactorDetailAction.java')
    },
    HtmlPage: {
        list: path.join('pages', 'aifactorlist.html'),
        add: path.join('pages', 'aifactoradd.html'),
        edit: path.join('pages', 'aifactoredit.html'),
        detail: path.join('pages', 'aifactordetail.html')
    }
};
const CONTRACT_TEXT = {
    mustReusePatterns: [
        '先把 primaryExample 当母版示例，沿用其主结构、Epoint API 调用方式与文件分层。',
        '优先复用与目标 subtype 对应的交互骨架、命名节奏和入口职责。'
    ],
    allowedBusinessDiffs: [
        '允许替换为当前需求的实体、字段、校验、查询条件和接口参数。',
        '允许按真实业务调整列、表单项、按钮文案和页面内容，但只改业务差异。'
    ],
    note: '先精确 read_file primaryExample，secondaryExamples 只补联动结构；只复用框架写法，不复用 AiFactor 业务内容。'
};

function toProjectRelative(projectPath, absolutePath) {
    return path.relative(projectPath, absolutePath).replace(/\\/g, '/');
}

function toExistingProjectRelative(projectPath, exampleDir, relativePath) {
    const absolutePath = path.join(exampleDir, relativePath);
    if (!fs.existsSync(absolutePath)) return null;
    return toProjectRelative(projectPath, absolutePath);
}

function collectExamples(projectPath, exampleDir) {
    return Object.entries(LEGACY_CANDIDATES).reduce((acc, [key, relativePath]) => {
        const resolved = toExistingProjectRelative(projectPath, exampleDir, relativePath);
        return resolved ? { ...acc, [key]: resolved } : acc;
    }, {});
}

function buildSlimContract(projectPath, exampleDir, fileKind, subType) {
    const subtypeMap = SUBTYPE_CANDIDATES[fileKind];
    if (!subtypeMap || !subType || !subtypeMap[subType]) return null;

    const primaryExample = toExistingProjectRelative(projectPath, exampleDir, subtypeMap[subType]);
    if (!primaryExample) return null;

    const htmlExample = toExistingProjectRelative(projectPath, exampleDir, SUBTYPE_CANDIDATES.HtmlPage[subType]);
    const actionExample = toExistingProjectRelative(projectPath, exampleDir, SUBTYPE_CANDIDATES.Action[subType]);
    const secondaryExamples = [htmlExample, actionExample]
        .filter(example => example && example !== primaryExample)
        .slice(0, 2);

    return {
        primaryExample,
        secondaryExamples,
        mustReusePatterns: [...CONTRACT_TEXT.mustReusePatterns].slice(0, 3),
        allowedBusinessDiffs: [...CONTRACT_TEXT.allowedBusinessDiffs].slice(0, 4),
        note: CONTRACT_TEXT.note
    };
}

function existingReadRef(projectPath, relativePath, purpose) {
    const absolutePath = path.join(projectPath, relativePath);
    if (!fs.existsSync(absolutePath)) return null;
    return { path: toProjectRelative(projectPath, absolutePath), purpose };
}

function resolveFrameworkReadCard(projectPath, options = {}) {
    try {
        const normalizedMode = String(options.constructionMode || 'crud_form').trim();
        const targets = Array.isArray(options.targets) ? options.targets : [];
        const firstTarget = targets.find(target => target && String(target.fileKind || '').trim()) || {};
        const firstFileKind = String(firstTarget.fileKind || '').trim();
        // 样例按切片真实内容给：工作流表单面给工作流样例，Service/Entity/其它页面面给对应文件类型样例。
        // 工作流 Story 的 Service 切片如果也拿工作流样例，就会拿到跟本片无关的页面写法。
        const isWorkflowSurface = targets.some(target =>
            ['Action', 'HtmlPage'].includes(String(target && target.fileKind || '').trim())
            && String(target && target.subType || '').trim().toLowerCase() === 'workflow');
        const refs = [];

        if (normalizedMode === 'workflow_form' && (isWorkflowSurface || targets.length === 0)) {
            refs.push(
                existingReadRef(projectPath, path.join(...F9_ROOT_SEGMENTS, 'frontend', 'standards', '表单开发规范.md'), 'FUI 表单、必填、长度与提交校验'),
                existingReadRef(projectPath, path.join(...F9_ROOT_SEGMENTS, 'frontend', 'components', 'ValidateRule 验证规则.md'), '字段格式、长度和自定义校验'),
                existingReadRef(projectPath, path.join(...F9_ROOT_SEGMENTS, 'workflow-examples', 'audittakeoffworkflow.html'), '工作流表单、handlecontrols 和回调')
            );
        } else {
            if (firstFileKind === 'HtmlPage') {
                refs.push(
                    existingReadRef(projectPath, path.join(...F9_ROOT_SEGMENTS, 'frontend', 'standards', '表单开发规范.md'), 'FUI 表单、必填、长度与提交校验'),
                    existingReadRef(projectPath, path.join(...F9_ROOT_SEGMENTS, 'frontend', 'components', 'ValidateRule 验证规则.md'), '字段格式、长度和自定义校验')
                );
            }
            const hint = resolveExampleHint(projectPath, {
                fileKind: firstFileKind,
                subType: String(firstTarget.subType || '').trim()
            });
            const primaryExample = hint && (hint.primaryExample
                || hint.examples && hint.examples[firstFileKind]);
            if (primaryExample) refs.push({ path: primaryExample, purpose: '当前文件类型的 CRUD 主样例' });
            (hint && Array.isArray(hint.secondaryExamples) ? hint.secondaryExamples : []).forEach(example => {
                refs.push({ path: example, purpose: '当前文件类型的 CRUD 配对样例' });
            });
        }

        const readRefs = refs
            .filter(Boolean)
            .filter((ref, index, all) => all.findIndex(item => item.path === ref.path) === index)
            .slice(0, 4);
        if (readRefs.length === 0) return null;
        return {
            mode: normalizedMode,
            readRefs,
            applyInstruction: '精确读取 readRefs，并以当前工作包下发的 WorkflowAction 骨架作为工作流 Action 唯一范式；沿用样例的 Epoint 结构、分层和 API 调用形态，只替换当前需求的业务字段、规则和分支。直接修改当前切片，不输出总结，不遍历 .knowledge。'
        };
    } catch (_) {
        return null;
    }
}

/**
 * 解析项目根 .knowledge/frameworks/f9/crud-examples/aifactor 下的示例文件清单。
 *
 * @param {string} projectPath 项目根
 * @param {{ fileKind?: string, subType?: string }} [options]
 * @returns {{ exampleRoot: string, examples: object, note: string } | { primaryExample: string, secondaryExamples: string[], mustReusePatterns: string[], allowedBusinessDiffs: string[], note: string } | null}
 *   examples 形如：
 *     {
 *       Entity: 'api/entity/AiFactor.java',
 *       ServiceApi: 'api/IAiFactorService.java',
 *       ServiceInternal: 'impl/AiFactorService.java',
 *       ServiceImpl: 'impl/AiFactorServiceImpl.java',
 *       Action: 'action/AiFactorListAction.java',
 *       'list.html': 'pages/aifactorlist.html',
 *       'add.html': 'pages/aifactoradd.html',
 *       'edit.html': 'pages/aifactoredit.html',
 *       'detail.html': 'pages/aifactordetail.html'
 *     }
 *   每个 value 都是相对 projectPath 的相对路径；文件不存在的 key 省略。
 */
function resolveExampleHint(projectPath, options = {}) {
    try {
        const exampleDir = path.join(projectPath, ...EXAMPLE_ROOT_SEGMENTS);
        if (!fs.existsSync(exampleDir)) return null;

        const examples = collectExamples(projectPath, exampleDir);
        if (Object.keys(examples).length === 0) return null;

        const slimContract = buildSlimContract(
            projectPath,
            exampleDir,
            String(options.fileKind || '').trim(),
            String(options.subType || '').trim()
        );
        if (slimContract) return slimContract;

        return {
            exampleRoot: toProjectRelative(projectPath, exampleDir) + '/',
            examples,
            note: '动手前按字典查 examples[fileKind] 直接 read_file 对应示例（不要 list_directory 列目录、不要 search_codebase 全工程找）。示例只学 Epoint API 用法（epoint.execute / baseDao / SqlConditionUtil / @RestController 命名），不抄具体业务字段。'
        };
    } catch (_) {
        return null;
    }
}

module.exports = { resolveExampleHint, resolveFrameworkReadCard };
