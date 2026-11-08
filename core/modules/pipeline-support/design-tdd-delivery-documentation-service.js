const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const DeliveryFactsService = require('./delivery-facts-service');

const DOCUMENTATION_CARD_SCHEMA_VERSION = 'documentation-task-card/v3';
const MAX_DOCUMENTATION_CARD_BYTES = 16 * 1024;

function array(value) {
    return Array.isArray(value) ? value : [];
}

function stableStringify(value) {
    if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
    if (value && typeof value === 'object') {
        return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
    }
    return JSON.stringify(value);
}

class DesignTddDeliveryDocumentationService {
    constructor(options = {}) {
        this.fs = options.fsImpl || fs;
        this.path = options.pathImpl || path;
        this.templatePath = String(options.templatePath || '').trim();
        this.deliverySummaryTemplatePath = String(options.deliverySummaryTemplatePath || '').trim();
        this.deliveryFactsService = options.deliveryFactsService || new DeliveryFactsService({
            fsImpl: this.fs,
            pathImpl: this.path
        });
        this.maxCardBytes = Number(options.maxCardBytes || MAX_DOCUMENTATION_CARD_BYTES);
    }

    buildTaskCard(options = {}) {
        const documentStage = this._documentStage(options.documentStage);
        const stageSpec = this._stageSpec(documentStage);
        const projectPath = this._resolve(options.projectPath);
        const demandDir = this._resolve(options.demandDir);
        const codeDir = this._resolve(options.codeDir || this.path.join(demandDir, 'code'));
        if (!projectPath || !demandDir || !codeDir || !this._isSameOrChild(demandDir, projectPath)
            || !this._isSameOrChild(codeDir, demandDir)) {
            return { ok: false, reason: 'invalid_documentation_roots' };
        }

        const designPath = this._existingFile(options.designDocumentPath);
        const businessFactsPath = this._existingFile(options.businessFactsPath);
        const codeStatePath = this._existingFile(options.codeStatePath);
        const finalizeReceiptPath = this._existingFile(options.finalizeReceiptPath);
        const design = options.design && typeof options.design === 'object' ?
            options.design :
            this._readJson(designPath);
        const requiresCodeInputs = documentStage !== 'design';
        const requiresDesignFinalizeReceipt = documentStage === 'design';
        if (!designPath || !design
            || (requiresDesignFinalizeReceipt && !finalizeReceiptPath)
            || (requiresCodeInputs && (!businessFactsPath || !codeStatePath))) {
            return {
                ok: false,
                reason: 'required_documentation_input_missing',
                missing: [
                    !designPath ? 'design_json' : '',
                    requiresCodeInputs && !businessFactsPath ? 'business_facts' : '',
                    requiresCodeInputs && !codeStatePath ? 'code_state' : '',
                    requiresDesignFinalizeReceipt && !finalizeReceiptPath ? 'design_finalize_receipt' : ''
                ].filter(Boolean)
            };
        }

        const deliverySummaryTemplatePath = this._existingFile(
            options.deliverySummaryTemplatePath || this.deliverySummaryTemplatePath
        );
        if (!deliverySummaryTemplatePath) {
            return {
                ok: false,
                reason: 'required_delivery_summary_template_missing',
                missing: ['delivery_summary_document_template']
            };
        }
        const deliverySummaryTemplateRef = { path: deliverySummaryTemplatePath };

        const plan = options.designTddPlan && typeof options.designTddPlan === 'object' ?
            options.designTddPlan :
            null;
        const hasRestInterface = this._hasIntent(design, 'rest_interface') ||
            this._hasIntent(plan, 'rest_interface');
        const hasWorkflow = this._hasIntent(design, 'workflow_process') ||
            this._hasWorkflowContract(design) ||
            this._hasIntent(plan, 'workflow_process') ||
            this._hasWorkflowContract(plan);
        const requiresSql = this._requiresSql(design);
        const outputRoot = this.path.join(demandDir, 'delivery', 'generated');
        const manualRoot = this.path.join(demandDir, 'delivery', 'manual');
        const deliveryRuntimeDir = this.path.join(demandDir, 'delivery', '.runtime');
        const deliveryFactsPath = this._resolve(options.deliveryFactsPath || this.path.join(deliveryRuntimeDir, 'delivery-facts.json'));
        const documentationTaskCardPath = this._resolve(options.documentationTaskCardPath || this.path.join(deliveryRuntimeDir, 'documentation-task-card.json'));
        const interfaceRoot = this.path.join(outputRoot, '接口说明');
        const deliverySummaryPath = this.path.join(outputRoot, '交付说明.md');

        const refs = [];
        if (requiresDesignFinalizeReceipt) {
            this._addRef(refs, 'design_finalize_receipt', finalizeReceiptPath);
        }
        (Array.isArray(options.additionalInputRefs) ? options.additionalInputRefs : []).forEach(ref => {
            if (!ref || typeof ref !== 'object') { return; }
            const kind = String(ref.kind || 'additional_input').trim();
            if (!this._isReadableInputKind(kind)) { return; }
            this._addRef(refs, kind, ref.path, {
                fileKind: ref.fileKind,
                moduleId: ref.moduleId
            });
        });
        const previousDeliverySummaryPath = this._existingFile(deliverySummaryPath);
        if (previousDeliverySummaryPath) {
            this._addRef(refs, 'previous_delivery_summary', previousDeliverySummaryPath);
        }

        const fileEntries = requiresCodeInputs ? this._collectActualFileEntries(options) : [];
        for (const entry of fileEntries) {
            const refKind = this._inputKindForFileKind(entry.fileKind);
            if (!this._isReadableInputKind(refKind)) { continue; }
            this._addRef(refs, refKind, entry.path, {
                fileKind: entry.fileKind,
                moduleId: entry.moduleId
            });
        }

        const sqlPaths = this._collectSqlPaths({
            designDir: designPath ? this.path.dirname(designPath) : '',
            fileEntries
        });

        const workflowArtifacts = hasWorkflow ?
            this._collectWorkflowArtifacts(options.generatedArtifactsIndex) :
            [];
        const workflowPaths = workflowArtifacts.map(item => item.path);

        const missingKinds = [];
        if (requiresCodeInputs && requiresSql && sqlPaths.length === 0) { missingKinds.push('sql_artifact'); }
        if (hasWorkflow && workflowPaths.length === 0) { missingKinds.push('workflow_xml'); }
        if (documentStage !== 'design' && !previousDeliverySummaryPath) { missingKinds.push('previous_delivery_summary'); }
        let templateRef = null;
        if (hasRestInterface && requiresCodeInputs) {
            const restStylePath = this._existingFile(options.restInterfaceStyleContractPath);
            if (restStylePath) { this._addRef(refs, 'rest_style_contract', restStylePath); }
            else { missingKinds.push('rest_style_contract'); }

            const templatePath = this._existingFile(options.templatePath || this.templatePath);
            if (templatePath) { templateRef = { path: templatePath }; }
            else { missingKinds.push('interface_document_template'); }

            const restSources = refs.filter(ref => ref.kind === 'rest_source');
            if (restSources.length === 0) { missingKinds.push('rest_source'); }
        }

        const interfacePlan = hasRestInterface && requiresCodeInputs ?
            this._buildInterfaceOutputs(design, fileEntries, interfaceRoot) :
            { outputs: [], expectedOperationCount: 0, missingSourceOperationKeys: [], conflicts: [] };
        const interfaceOutputs = templateRef ? interfacePlan.outputs : [];
        interfaceOutputs.forEach(output => {
            const previousInterfacePath = this._existingFile(output.path);
            if (previousInterfacePath) { this._addRef(refs, 'previous_interface_document', previousInterfacePath); }
        });

        const factsResult = this.deliveryFactsService.buildOrReuse({
            documentStage,
            projectPath,
            demandDir,
            demandName: this.path.basename(demandDir),
            deliveryFactsPath,
            design,
            designDocumentPath: designPath,
            designMarkdownPath: options.designMarkdownPath || this.path.join(demandDir, 'design', '设计文档.md'),
            requirementStoriesPath: options.requirementStoriesPath || this.path.join(demandDir, 'demand', 'stories.json'),
            requirementRulePoolPath: options.requirementRulePoolPath || this.path.join(demandDir, 'demand', 'rule-pool.json'),
            businessFactsPath,
            codeStatePath,
            finalizeReceiptPath: requiresDesignFinalizeReceipt ? finalizeReceiptPath : '',
            materializedFiles: options.materializedFiles,
            generatedArtifactsIndex: options.generatedArtifactsIndex,
            additionalInputRefs: options.additionalInputRefs,
            sqlPaths,
            workflowPaths,
            workflowArtifacts
        });
        if (factsResult.ok !== true) {
            return {
                ok: false,
                reason: 'delivery_facts_unavailable',
                details: factsResult
            };
        }
        const deliveryFacts = factsResult.facts && typeof factsResult.facts === 'object'
            ? factsResult.facts
            : {};
        const hasWorkflowExternalMethods = hasWorkflow && (
            (Array.isArray(deliveryFacts.workflowEvents) && deliveryFacts.workflowEvents.length > 0)
            || (Array.isArray(deliveryFacts.workflowExternalMethods) && deliveryFacts.workflowExternalMethods.length > 0)
            || Number(deliveryFacts.sectionCounts && deliveryFacts.sectionCounts.workflowEvents || 0) > 0
            || Number(deliveryFacts.sectionCounts && deliveryFacts.sectionCounts.workflowExternalMethods || 0) > 0
        );
        this._addRef(refs, 'delivery_facts', factsResult.path);
        (Array.isArray(deliveryFacts.partRefs) ? deliveryFacts.partRefs : [])
            .forEach(ref => this._addRef(refs, 'delivery_facts', ref.path));
        const inputRefs = this._dedupeRefs(refs);
        if (hasRestInterface && requiresCodeInputs && interfacePlan.expectedOperationCount === 0) {
            missingKinds.push('rest_operation_contract');
        }
        if (hasRestInterface && requiresCodeInputs && interfacePlan.missingSourceOperationKeys.length > 0) {
            missingKinds.push('rest_source');
        }
        if (hasRestInterface && requiresCodeInputs && interfacePlan.conflicts.length > 0) {
            missingKinds.push('rest_contract_conflict');
        }

        const card = {
                schemaVersion: DOCUMENTATION_CARD_SCHEMA_VERSION,
                requiredInNormalFlow: true,
                blocksStageCompletion: false,
                title: stageSpec.title,
                documentStage,
                documentStatus: stageSpec.status,
                instruction: `${stageSpec.instruction} 只读取 documentationTaskCardRef、deliveryFactsRef、inputRefs、deliverySummaryTemplateRef 与 templateRef 的精确路径；deliveryFactsRef 含 partRefs 时，按 section、index 逐段读取 inputRefs 列出的 delivery_facts，完成一章再读下一章。禁止搜索工程，也不得读取未列入白名单的设计JSON、SQL、Story或规则池。缺失内容按阶段写“计划生成/未发现/未生成”，不要猜“无”。文档仅供人读，不改变正式阶段状态。`,
                deliverySummaryTemplateRef,
                ...(templateRef ? { templateRef } : {}),
                deliveryFactsRef: { path: factsResult.path },
                documentationTaskCardRef: { path: documentationTaskCardPath },
                sourceHash: factsResult.sourceHash,
                inputRefs,
                missingKinds: Array.from(new Set(missingKinds)),
                outputRoot,
                manualRoot,
                deliverySummaryPath,
                ...(previousDeliverySummaryPath ? { previousDeliverySummaryRef: { path: previousDeliverySummaryPath } } : {}),
                rewriteMode: previousDeliverySummaryPath ? 'revise_existing_document' : 'create_from_template',
                deliverySummarySections: [
                    '更新说明',
                    '脚本更新',
                    '菜单及页面地址',
                    '代码项',
                    '系统参数',
                    '配置文件',
                    '模块角色配置',
                    ...(hasWorkflow ? ['工作流配置'] : []),
                    ...(hasWorkflowExternalMethods
                        ? ['工作流事件配置', '工作流外部方法配置']
                        : [])
                ],
                pageAddressRule: '只输出去掉 src/main/webapp 前缀和 .html 后缀的运行地址，并使用反斜杠，例如 perpage\\schemeresource\\schemeresourceadd；不要展示页面源码路径。',
                configurationRule: 'deliveryFacts.stories 中 configuration_only 的 Story 是现有平台配置交付；按其验收、不变量和 codingFactHandoff 在现有代码项、模块角色配置、菜单及页面地址章节保留配置要求，菜单只登记事实中的实际管理入口，门户页面不注册管理菜单。未实际配置或验证权限时写“待配置/未验证”，不能把说明文档生成当作配置完成，也不新增管理页面。',
                sqlStatusRule: documentStage === 'design'
                    ? (sqlPaths.length > 0
                        ? '卡片已提供实际SQL路径，写精确路径和“已生成、未执行”；不得写成已执行或已验证。'
                        : '尚未由design-to-sql生成时写“计划生成”，不得编造路径或写成已交付。')
                    : 'SQL 文件存在时写“已生成、未执行”；存在脚本义务但缺失时写“未生成”。',
                ...(hasWorkflow ? {
                    workflowStatusRule: '按 deliveryFacts.workflowArtifacts 写工作流名称、关联Story/功能、发起人、节点与操作、主要流转、MIS XML和Workflow XML精确路径，状态固定为“已生成、未导入”；存在外部方法时，按 deliveryFacts.workflowEvents 写事件名称、事件来源、关联操作、事件类型、处理方法和业务效果，按 deliveryFacts.workflowExternalMethods 为每个方法写表单主记录（方法名称、方法排序号、类全路径、方法备注、返回类型）及其紧邻的参数明细（序、参数名称、参数描述、加密、参数类型、参数值、参数值描述、参数排序号、解析、相关数据），并保留变更类型、Story/触发操作、注册方式、源码路径和业务效果等交付关联信息；没有事实来源的表单字段写“未登记”，不要猜；Coder 不修改 XML。'
                } : {}),
                stageRules: stageSpec.rules,
                ...(hasWorkflow ? {
                    conditionalSectionTemplates: {
                        workflow: '## 8. 工作流配置\n\n| 工作流名称 | 关联 Story/功能 | 发起人 | 节点与主要操作 | 主要流转 | MIS XML | Workflow XML | 状态 |\n|---|---|---|---|---|---|---|---|\n| <流程名称> | <Story/功能> | <发起角色> | <节点：操作> | <起点→节点→终点> | `<实际 MIS XML 精确路径>` | `<实际 Workflow XML 精确路径>` | 已生成、未导入 |',
                        ...(hasWorkflowExternalMethods ? {
                            workflowEvents: '## 9. 工作流事件配置\n\n| 事件名称 | 事件来源 | 关联操作 | 事件类型 | 处理方法 | 业务效果 |\n|---|---|---|---|---|---|\n| <事件名称> | <操作> | <操作名称> | <操作后> | `<方法名>` | <业务效果> |',
                            workflowExternalMethods: '## 10. 工作流外部方法配置\n\n每个外部方法单独成块，方法主记录与参数明细一起输出；不要再生成独立的“外部方法参数映射”章节。主记录按外部方法配置表单填写，参数明细按表单列表填写；表单“参数名称/排序号”输入框只是新增参数的录入控件，实际交付以参数明细行为准。\n\n### 方法：<方法名称>\n\n| 方法名称 | 方法排序号 | 类全路径 | 方法备注 | 返回类型 |\n|---|---:|---|---|---|\n| <方法名称> | <方法排序号> | `<完整 ServiceInternal 类名>` | <方法备注> | <String/实际返回类型> |\n\n| 变更类型 | Story/触发操作 | 注册方式 | Java 文件路径 | 业务效果 |\n|---|---|---|---|---|\n| <新增/调整> | <Story/操作> | <@OutJarMethod> | `<实际 Java 文件路径>` | <业务效果> |\n\n#### 参数明细\n\n| 序 | 参数名称 | 参数描述 | 加密 | 参数类型 | 参数值 | 参数值描述 | 参数排序号 | 解析 | 相关数据 |\n|---:|---|---|---|---|---|---|---:|---|---|\n| 1 | <参数名称> | <参数描述> | <0/未登记> | <String/实际类型> | `<实际表达式或值>` | <参数值说明/未登记> | <0/实际值> | <未登记> | <未登记> |'
                        } : {})
                    }
                } : {}),
                ...(hasRestInterface && requiresCodeInputs ? { interfaceRoot, interfaceOutputs } : {}),
                existingGeneratedFiles: this._listFiles(outputRoot).slice(0, 200),
                writableRoots: [outputRoot],
                conditionalSections: {
                    workflow: hasWorkflow,
                    workflowEvents: hasWorkflowExternalMethods,
                    workflowExternalMethods: hasWorkflowExternalMethods,
                    restInterface: hasRestInterface
                },
                allowedNextActions: [
                    documentStage === 'design'
                        ? 'generate_design_delivery_draft'
                        : 'generate_coder_delivery_draft'
                ],
                onFailureNextAction: 'report_documentation_warning_then_continue_stage',
                forbiddenActions: [
                    'search_project_for_documentation_inputs',
                    'write_outside_delivery_generated',
                    'modify_delivery_manual',
                    'treat_markdown_as_stage_receipt'
                ],
                failureMode: `warning_only_${documentStage}_stage_remains_successful`
        };
        const persisted = this._persistDocumentationCard(documentationTaskCardPath, card);
        if (!persisted.ok) {
            return {
                ok: false,
                reason: 'documentation_task_card_unavailable',
                details: persisted
            };
        }
        return { ok: true, card: persisted.card };
    }

    _documentStage(value = '') {
        const stage = String(value || 'coder').trim().toLowerCase();
        return ['design', 'coder'].includes(stage) ? stage : 'coder';
    }

    _stageSpec(stage = 'coder') {
        if (stage === 'design') {
            return {
                title: '生成交付说明设计稿',
                status: '设计稿',
                instruction: '根据最终设计事实生成第一版。未施工的代码和接口必须写“计划”或“计划生成”；卡片提供的SQL写“已生成、未执行”，工作流XML写“已生成、未导入”。',
                rules: [
                    '文档顶部标记“文档状态：设计稿”。',
                    '页面、表和接口只描述设计义务；工作流存在时必须使用设计阶段已生成的XML实际路径，没有相应需求时完全省略。',
                    '卡片提供实际SQL路径时写“已生成、未执行”；这只说明辅助脚本已生成，不表示已执行或已验证。',
                    'Design阶段不生成依赖实际Rest源码的接口详细说明。'
                ]
            };
        }
        return {
            title: '生成交付说明实现稿',
            status: '实现稿',
            instruction: '以设计稿为底稿，用实际代码、SQL、Workflow XML、Coder 状态和实施计划替换计划描述；验证结果以实际命令输出为准。',
            rules: [
                '文档顶部标记“文档状态：实现稿”。',
                '实际产物存在时写精确路径；应有但缺失写“未生成/未发现”。',
                '只有存在实际Rest源码时才生成接口详细说明。'
            ]
        };
    }

    _isReadableInputKind(kind = '') {
        return new Set([
            'previous_delivery_summary',
            'rest_source',
            'rest_style_contract',
            'previous_interface_document',
            'delivery_facts',
            'workflow_artifacts_receipt',
            'workflow_xml',
            'design_finalize_receipt'
        ]).has(String(kind || '').trim().toLowerCase());
    }

    _persistDocumentationCard(filePath = '', card = {}) {
        const resolved = this._resolve(filePath);
        if (!resolved) return { ok: false, errorCode: 'DOCUMENTATION_CARD_PATH_MISSING' };
        const existing = this._readJson(resolved);
        if (existing && existing.schemaVersion === DOCUMENTATION_CARD_SCHEMA_VERSION
            && existing.sourceHash === card.sourceHash
            && this._isSafeDocumentationCard(existing)
            && JSON.stringify(existing.inputRefs) === JSON.stringify(card.inputRefs)) {
            return { ok: true, reused: true, path: resolved, card: existing };
        }
        const serialized = JSON.stringify(card, null, 2);
        const byteLength = Buffer.byteLength(serialized, 'utf8');
        if (byteLength > this.maxCardBytes) {
            return {
                ok: false,
                errorCode: 'DOCUMENTATION_CARD_TOO_LARGE',
                message: `documentation task card 超过 ${this.maxCardBytes} 字节预算：${byteLength}`,
                path: resolved,
                byteLength,
                maxBytes: this.maxCardBytes
            };
        }
        const temporary = `${resolved}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
        try {
            this.fs.mkdirSync(this.path.dirname(resolved), { recursive: true });
            this.fs.writeFileSync(temporary, `${serialized}\n`, 'utf8');
            this.fs.renameSync(temporary, resolved);
            return { ok: true, reused: false, path: resolved, card };
        } catch (error) {
            try { if (this.fs.existsSync(temporary)) this.fs.unlinkSync(temporary); } catch (_) {}
            return {
                ok: false,
                errorCode: 'DOCUMENTATION_CARD_WRITE_FAILED',
                message: `documentation task card 原子写入失败：${error.message}`,
                path: resolved
            };
        }
    }

    _isSafeDocumentationCard(card = {}) {
        if (!card || typeof card !== 'object' || !card.deliveryFactsRef || !card.documentationTaskCardRef) {
            return false;
        }
        return Array.isArray(card.inputRefs)
            && card.inputRefs.every(ref => ref && this._isReadableInputKind(ref.kind));
    }

    _collectActualFileEntries(options = {}) {
        const entries = [];
        const add = (candidate = {}) => {
            const fileKind = String(candidate.fileKind || candidate.kind || '').trim();
            const filePath = this._existingFile(candidate.targetFile || candidate.resolvedPath || candidate.path);
            if (!fileKind || !filePath) { return; }
            entries.push({
                fileKind,
                path: filePath,
                moduleId: String(candidate.moduleId || '').trim()
            });
        };
        (Array.isArray(options.materializedFiles) ? options.materializedFiles : []).forEach(add);
        this._walk(options.designTddPlan, value => {
            if (value && typeof value === 'object' && !Array.isArray(value) && value.fileKind) { add(value); }
        });
        const seen = new Set();
        return entries.filter(entry => {
            const key = this._normalize(entry.path);
            if (!key || seen.has(key)) { return false; }
            seen.add(key);
            return true;
        });
    }

    _collectSqlPaths({ designDir = '', fileEntries = [] } = {}) {
        const values = [];
        for (const entry of fileEntries) {
            const kind = String(entry.fileKind || '').trim().toLowerCase();
            if ((kind === 'sql' || kind === 'ddl') && this._existingFile(entry.path)) { values.push(this._resolve(entry.path)); }
        }
        if (designDir) {
            ['init-import.sql', 'init-import-oracle.sql', 'init-import-dm.sql'].forEach(name => {
                const candidate = this._existingFile(this.path.join(designDir, name));
                if (candidate) { values.push(candidate); }
            });
        }
        return Array.from(new Set(values));
    }

    _collectWorkflowArtifacts(index = null) {
        const artifacts = index && Array.isArray(index.artifacts) ? index.artifacts : [];
        const seen = new Set();
        return artifacts
            .filter(item => /^workflow_/i.test(String(item && item.kind || '')))
            .map(item => ({ ...item, path: this._existingFile(item && item.path) }))
            .filter(item => {
                const key = this._normalize(item.path);
                if (!key || seen.has(key)) return false;
                seen.add(key);
                return true;
            });
    }

    _buildInterfaceOutputs(design = {}, fileEntries = [], interfaceRoot = '') {
        const restSources = (Array.isArray(fileEntries) ? fileEntries : [])
            .filter(entry => ['rest', 'restcontroller'].includes(
                String(entry && entry.fileKind || '').trim().toLowerCase()
            ));
        const outputs = [];
        const missingSourceOperationKeys = [];
        const conflicts = [];
        let expectedOperationCount = 0;
        const groups = new Map();
        this._collectRestContractRecords(design).forEach(record => {
            const existing = groups.get(record.identity);
            if (!existing) {
                groups.set(record.identity, {
                    ...record,
                    sourceNames: new Set(record.sourceNames),
                    conflict: false
                });
                return;
            }
            record.sourceNames.forEach(name => existing.sourceNames.add(name));
            if (this._restContractFingerprint(existing.contract) !== this._restContractFingerprint(record.contract)) {
                existing.conflict = true;
                conflicts.push({
                    identity: record.identity,
                    entityKey: existing.entityKey,
                    message: '同一 REST 稳定身份的正式合同与 codingHandoff 不等价，未自动合并。'
                });
            }
        });

        groups.forEach(group => {
            if (group.conflict) return;
            const sourceRef = this._resolveRestSource(group, restSources);
            const contract = group.contract;
            const basePath = String(contract.basePath || '').trim();
            for (const operation of (Array.isArray(contract.operations) ? contract.operations : [])) {
                if (!operation || typeof operation !== 'object') { continue; }
                const operationKey = this._safeSlug(operation.operationKey || operation.methodName || 'operation');
                expectedOperationCount += 1;
                if (!sourceRef) {
                    missingSourceOperationKeys.push(`${group.entityKey}.${operationKey}`);
                    continue;
                }
                outputs.push({
                    entityKey: group.entityKey,
                    operationKey,
                    sourceRef,
                    basePath,
                    methodName: String(operation.methodName || '').trim(),
                    operationPath: String(operation.path || '').trim(),
                    httpMethod: String(operation.httpMethod || '').trim(),
                    purpose: String(operation.purpose || '').trim(),
                    requestShape: String(operation.requestShape || '').trim(),
                    responseShape: String(operation.responseShape || '').trim(),
                    path: this.path.join(interfaceRoot, `${group.entityKey}--${operationKey}接口说明.md`)
                });
            }
        });
        const seen = new Set();
        return {
            expectedOperationCount,
            missingSourceOperationKeys: Array.from(new Set(missingSourceOperationKeys)),
            conflicts,
            outputs: outputs.filter(output => {
                const key = this._normalize(output.path);
                if (seen.has(key)) { return false; }
                seen.add(key);
                return true;
            })
        };
    }

    _collectRestContractRecords(root = {}) {
        const records = [];
        const seen = new Set();
        const visit = (value, parent = {}) => {
            if (!value || typeof value !== 'object' || seen.has(value)) return;
            seen.add(value);
            const scene = String(value.constructionSceneKey || value.sceneIntent || parent.scene || '').trim();
            const contract = value.restContract;
            const inheritedSourceNames = parent.sourceNames instanceof Set ? parent.sourceNames : new Set();
            const sourceNames = new Set([
                ...inheritedSourceNames,
                ...this._restSourceNames(value.fileSet),
                ...this._restSourceNames(value.fileSeeds),
                ...this._restSourceNames(value.files)
            ]);
            const identityValue = value.entityKey || value.businessObjectKey || value.moduleId
                || value.entityName || parent.identityValue || '';
            const identity = String(identityValue || '').trim().toLowerCase()
                || `rest_interface:${String(contract && contract.basePath || '').trim().toLowerCase()}`;
            const entityKey = this._safeSlug(identityValue || parent.entityKey || contract && contract.basePath || 'rest_interface');
            if (contract && typeof contract === 'object' && !Array.isArray(contract) && scene === 'rest_interface') {
                records.push({
                    identity,
                    entityKey,
                    moduleId: String(value.moduleId || parent.moduleId || '').trim(),
                    sourceNames,
                    contract
                });
            }
            const nextParent = {
                scene,
                identityValue,
                entityKey,
                moduleId: String(value.moduleId || parent.moduleId || '').trim(),
                sourceNames
            };
            if (Array.isArray(value)) value.forEach(item => visit(item, parent));
            else Object.values(value).forEach(item => visit(item, nextParent));
        };
        visit(root);
        return records;
    }

    _restSourceNames(values = []) {
        return array(values).flatMap(item => {
            if (typeof item === 'string') return [this.path.basename(item).toLowerCase()];
            if (!item || typeof item !== 'object') return [];
            const kind = String(item.fileKind || item.kind || '').trim().toLowerCase();
            if (kind && !['rest', 'restcontroller'].includes(kind)) return [];
            return [item.fileName, item.targetFile, item.resolvedPath, item.path]
                .map(value => String(value || '').trim())
                .filter(Boolean)
                .map(value => this.path.basename(value).toLowerCase());
        }).filter(Boolean);
    }

    _restContractFingerprint(contract = {}) {
        const operations = array(contract.operations).map(operation => ({
            operationKey: String(operation && operation.operationKey || '').trim(),
            methodName: String(operation && operation.methodName || '').trim(),
            path: String(operation && operation.path || '').trim(),
            httpMethod: String(operation && operation.httpMethod || '').trim().toUpperCase(),
            purpose: String(operation && operation.purpose || '').trim(),
            requestShape: String(operation && operation.requestShape || '').trim(),
            responseShape: String(operation && operation.responseShape || '').trim()
        })).sort((left, right) => left.operationKey.localeCompare(right.operationKey));
        return stableStringify({
            basePath: String(contract.basePath || '').trim(),
            operations
        });
    }

    _resolveRestSource(group = {}, restSources = []) {
        const sourceNames = group.sourceNames instanceof Set ? group.sourceNames : new Set();
        const moduleMatches = restSources.filter(entry => !group.moduleId
            || String(entry && entry.moduleId || '').trim() === group.moduleId);
        const candidates = moduleMatches.length > 0 ? moduleMatches : restSources;
        const named = candidates.filter(entry => sourceNames.has(
            this.path.basename(String(entry && entry.path || '')).toLowerCase()
        ));
        if (named.length > 0) return named[0].path;
        return candidates.length === 1 ? candidates[0].path : '';
    }

    _hasIntent(root, expected = '') {
        let found = false;
        this._walk(root, value => {
            if (found || !value || typeof value !== 'object' || Array.isArray(value)) { return; }
            const intent = String(value.sceneIntent || value.constructionSceneKey || '').trim();
            if (intent === expected) { found = true; }
            if (expected === 'workflow_process'
                && !['', 'none'].includes(String(value.workflowMode || '').trim())) { found = true; }
        });
        return found;
    }

    _hasWorkflowContract(root) {
        let found = false;
        this._walk(root, value => {
            if (found || !value || typeof value !== 'object' || Array.isArray(value)) { return; }
            const contract = value.workflowContract;
            if (contract && typeof contract === 'object' && Object.keys(contract).length > 0) { found = true; }
        });
        return found;
    }

    _requiresSql(design = {}) {
        const databaseDesign = design && design.databaseDesign;
        if (databaseDesign && Array.isArray(databaseDesign.tables) &&
            databaseDesign.tables.some(table => table && table.reuse !== true)) { return true; }
        let required = false;
        this._walk(design, value => {
            if (required || !value || typeof value !== 'object' || Array.isArray(value)) { return; }
            if (value.linkedTable && String(value.linkedTable.kind || '').trim() === 'new') { required = true; }
        });
        return required;
    }

    _inputKindForFileKind(fileKind = '') {
        const kind = String(fileKind || '').trim().toLowerCase();
        if (kind === 'htmlpage') { return 'html_page'; }
        if (kind === 'rest' || kind === 'restcontroller') { return 'rest_source'; }
        if (kind === 'sql' || kind === 'ddl') { return 'sql_artifact'; }
        if (kind.includes('config')) { return 'configuration_file'; }
        if (kind.includes('systemparam')) { return 'system_parameter_file'; }
        if (kind.includes('modulerole')) { return 'module_role_file'; }
        return 'actual_delivery_file';
    }

    _addRef(refs = [], kind = '', filePath = '', extra = {}) {
        const resolved = this._existingFile(filePath);
        if (!kind || !resolved) { return; }
        const ref = { kind, path: resolved };
        if (extra.fileKind) { ref.fileKind = String(extra.fileKind); }
        if (extra.moduleId) { ref.moduleId = String(extra.moduleId); }
        refs.push(ref);
    }

    _dedupeRefs(refs = []) {
        const seen = new Set();
        return refs.filter(ref => {
            const key = `${ref.kind}|${this._normalize(ref.path)}`;
            if (!ref.path || seen.has(key)) { return false; }
            seen.add(key);
            return true;
        });
    }

    _listFiles(root = '') {
        const resolvedRoot = this._resolve(root);
        if (!resolvedRoot || !this.fs.existsSync(resolvedRoot)) { return []; }
        const out = [];
        const visit = current => {
            for (const entry of this.fs.readdirSync(current, { withFileTypes: true })) {
                const child = this.path.join(current, entry.name);
                if (entry.isDirectory()) { visit(child); }
                else if (entry.isFile()) { out.push(this._resolve(child)); }
            }
        };
        try { visit(resolvedRoot); } catch (_) { return []; }
        return out.sort();
    }

    _walk(value, visitor, seen = new Set()) {
        if (!value || typeof value !== 'object' || seen.has(value)) { return; }
        seen.add(value);
        visitor(value);
        if (Array.isArray(value)) { value.forEach(item => this._walk(item, visitor, seen)); }
        else { Object.values(value).forEach(item => this._walk(item, visitor, seen)); }
    }

    _readJson(filePath = '') {
        if (!filePath) { return null; }
        try { return JSON.parse(this.fs.readFileSync(filePath, 'utf-8')); } catch (_) { return null; }
    }

    _existingFile(filePath = '') {
        const resolved = this._resolve(filePath);
        if (!resolved) { return ''; }
        try { return this.fs.existsSync(resolved) && this.fs.statSync(resolved).isFile() ? resolved : ''; } catch (_) { return ''; }
    }

    _safeSlug(value = '') {
        const slug = String(value || '').trim().replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').toLowerCase();
        return slug || 'item';
    }

    _resolve(value = '') {
        const text = String(value || '').trim();
        return text ? this.path.resolve(text) : '';
    }

    _normalize(value = '') {
        const resolved = this._resolve(value).replace(/\\/g, '/');
        return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
    }

    _isSameOrChild(candidate = '', root = '') {
        const child = this._normalize(candidate);
        const parent = this._normalize(root);
        return Boolean(child && parent && (child === parent || child.startsWith(`${parent}/`)));
    }
}

module.exports = DesignTddDeliveryDocumentationService;
