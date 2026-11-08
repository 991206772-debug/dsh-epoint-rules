/* eslint-disable */
const childProcess = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { removeFiles, removeEmpty, assertSafe, summary } = require('./stage-temporary-cleanup-service');

const RECEIPT_SCHEMA_VERSION = 'design-workflow-artifacts-receipt/v2';
const WORKFLOW_PARAMETER_CONSTANT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:/-]*$/;

class DesignWorkflowArtifactService {
    constructor(options = {}) {
        this.pythonCommand = options.pythonCommand || process.env.EPOINT_PYTHON_PATH || process.env.PYTHON || 'python';
        this.scriptPath = options.scriptPath || path.resolve(
            __dirname,
            '../../scripts/generate_workflow_artifacts.py'
        );
        this.now = typeof options.now === 'function' ? options.now : () => new Date().toISOString();
    }

    receiptPath(designDir = '') {
        return path.join(path.resolve(String(designDir || '').trim()), 'workflow-artifacts-receipt.json');
    }

    cleanupCompletedInputs({ designDir, design }) {
        const result = summary();
        try {
            const verified = this.validateReceipt({ designDir, design });
            if (!verified.ok || !verified.receiptValid || !verified.required) {
                return { ...result, skipped: '当前工作流产物及凭证尚未全部验证' };
            }
            const inputDir = path.join(designDir, '.runtime', 'workflow-artifact-input');
            assertSafe(designDir, inputDir);
            const statePath = path.join(designDir, '.runtime', 'design-workflow-state.json');
            const stateRaw = fs.readFileSync(statePath);
            const state = JSON.parse(stateRaw);
            if (state.currentPhase !== 'completed' || state.downstreamSyncPending) return result;
            const receiptRaw = fs.readFileSync(verified.receiptPath);
            assertSafe(designDir, verified.receipt.designJsonPath);
            const designRaw = fs.readFileSync(verified.receipt.designJsonPath);
            if (this._hashJson(JSON.parse(designRaw)) !== verified.receipt.designHash) return result;
            const projection = this._resolveWorkflowTasks(design);
            const shared = new Set(this._duplicates(projection.tasks.map(task => task.bizModule.toLowerCase())));
            const files = [];
            const inputs = new Map();
            for (const workflow of verified.receipt.workflows) {
                const task = projection.tasks.find(task => task.storyId === workflow.storyId && task.bizModule === workflow.bizModule);
                const expectedPath = path.join(inputDir, `${this._safeFileName(`${task.storyId || 'workflow'}-${task.bizModule}`)}.json`);
                if (path.resolve(workflow.inputPath) !== expectedPath) continue;
                assertSafe(inputDir, expectedPath);
                if (!fs.existsSync(expectedPath)) continue;
                const raw = fs.readFileSync(expectedPath);
                const outputRoot = shared.has(task.bizModule.toLowerCase())
                    ? path.join(designDir, 'generated-workflow', this._safeFileName(task.storyId.toLowerCase()))
                    : path.join(designDir, 'generated-workflow');
                if (this._hashJson(JSON.parse(raw)) !== this._hashJson(this._inputPacket(task, designDir, outputRoot))) continue;
                inputs.set(expectedPath, raw);
                files.push(expectedPath);
            }
            const guard = target => fs.readFileSync(statePath).equals(stateRaw)
                && fs.readFileSync(verified.receiptPath).equals(receiptRaw)
                && fs.readFileSync(verified.receipt.designJsonPath).equals(designRaw)
                && this.validateReceipt({ designDir, design }).receiptValid === true
                && fs.readFileSync(target).equals(inputs.get(target));
            removeFiles(inputDir, files, { guard, result });
            if (!result.skipped) removeEmpty(designDir, inputDir, result);
        } catch (error) {
            result.ok = false;
            result.errors.push({ message: String(error.message || error) });
        }
        const { removed, missing, ...compact } = result;
        return compact;
    }

    _inputPacket(task, designDir, outputRoot) {
        return { workflowTaskPacket: {
            storyId: task.storyId, bizModule: task.bizModule, designDir, outputRoot,
            workflowContract: task.contract, workflowExternalMethodSeeds: task.workflowExternalMethodSeeds,
            serviceInternalTypeName: task.serviceInternalTypeName, businessTable: task.table,
            businessColumns: task.table.businessColumns
        } };
    }

    materialize({ designDir = '', design = {}, designJsonPath = '' } = {}) {
        const resolvedDesignDir = path.resolve(String(designDir || '').trim());
        if (!designDir || !design || typeof design !== 'object') {
            return this._blocked('DESIGN_WORKFLOW_INPUT_MISSING', '工作流设计产物生成缺少 designDir 或最终设计合同。');
        }
        const projection = this._resolveWorkflowTasks(design);
        if (!projection.ok) return projection;
        const designHash = this._hashJson(design);
        const existing = this.validateReceipt({
            designDir: resolvedDesignDir,
            design,
            designHash
        });
        if (existing.ok && existing.receiptValid) {
            return {
                ...existing,
                generated: false,
                reused: true,
                results: existing.receipt.workflows || []
            };
        }

        if (projection.tasks.length === 0) {
            const receipt = {
                schemaVersion: RECEIPT_SCHEMA_VERSION,
                status: 'not_required',
                designHash,
                designJsonPath: path.resolve(String(designJsonPath || path.join(resolvedDesignDir, '设计文档.json')).trim()),
                generatedAt: this.now(),
                workflows: [],
                artifacts: []
            };
            const write = this._writeReceipt(this.receiptPath(resolvedDesignDir), receipt);
            if (!write.ok) return write;
            return {
                ok: true,
                required: false,
                generated: false,
                reused: false,
                receiptPath: write.path,
                receipt,
                artifacts: [],
                results: []
            };
        }

        if (!fs.existsSync(this.scriptPath)) {
            return this._blocked('DESIGN_WORKFLOW_GENERATOR_MISSING', `工作流 XML 生成器不存在：${this.scriptPath}`);
        }
        const sharedModules = new Set(this._duplicates(projection.tasks.map(task => task.bizModule.toLowerCase())));

        const inputDir = path.join(resolvedDesignDir, '.runtime', 'workflow-artifact-input');
        const outputRoot = path.join(resolvedDesignDir, 'generated-workflow');
        const results = [];
        const artifacts = [];
        for (const task of projection.tasks) {
            const safeIdentity = this._safeFileName(`${task.storyId || 'workflow'}-${task.bizModule}`);
            const inputPath = path.join(inputDir, `${safeIdentity}.json`);
            // Isolate independent processes without changing their shared business module or page URLs.
            const taskOutputRoot = sharedModules.has(task.bizModule.toLowerCase())
                ? path.join(outputRoot, this._safeFileName(task.storyId.toLowerCase()))
                : outputRoot;
            const packet = this._inputPacket(task, resolvedDesignDir, taskOutputRoot);
            try {
                fs.mkdirSync(inputDir, { recursive: true });
                fs.writeFileSync(inputPath, `${JSON.stringify(packet, null, 2)}\n`, 'utf-8');
                const stdout = childProcess.execFileSync(this.pythonCommand, [this.scriptPath, '--input', inputPath], {
                    encoding: 'utf-8',
                    timeout: 120000,
                    windowsHide: true,
                    env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' }
                });
                const parsed = JSON.parse(stdout);
                if (!parsed || parsed.ok !== true || !parsed.result) {
                    throw new Error(parsed && parsed.error || 'generator_returned_not_ok');
                }
                const generatedArtifacts = (Array.isArray(parsed.result.artifacts) ? parsed.result.artifacts : [])
                    .map(item => this._projectArtifact({ item, task }))
                    .filter(Boolean);
                const kinds = new Set(generatedArtifacts.map(item => item.kind));
                if (!kinds.has('workflow_mis_xml') || !kinds.has('workflow_process_xml')) {
                    throw new Error('generator_did_not_return_mis_and_workflow_xml');
                }
                artifacts.push(...generatedArtifacts);
                const generatedContract = generatedArtifacts.find(item => item && item.kind === 'workflow_process_xml') || {};
                results.push({
                    storyId: task.storyId,
                    processName: task.processName,
                    relatedFeature: task.relatedFeature,
                    initiator: task.initiator || '未明确',
                    bizModule: task.bizModule,
                    activities: generatedContract.activities || task.activities,
                    transitions: generatedContract.transitions || task.transitions,
                    workflowExternalMethodSeeds: generatedContract.workflowExternalMethodSeeds || task.workflowExternalMethodSeeds,
                    serviceInternalTypeName: generatedContract.serviceInternalTypeName || task.serviceInternalTypeName,
                    inputPath,
                    artifacts: generatedArtifacts
                });
            } catch (error) {
                return this._blocked(
                    'DESIGN_WORKFLOW_ARTIFACT_GENERATION_FAILED',
                    `${task.storyId || task.bizModule} 的工作流 XML 生成失败。`,
                    {
                        storyId: task.storyId,
                        bizModule: task.bizModule,
                        inputPath,
                        cause: String(error && (error.stderr || error.message) || error)
                    }
                );
            }
        }

        const receipt = {
            schemaVersion: RECEIPT_SCHEMA_VERSION,
            status: 'ready',
            designHash,
            designJsonPath: path.resolve(String(designJsonPath || path.join(resolvedDesignDir, '设计文档.json')).trim()),
            outputRoot,
            generatedAt: this.now(),
            workflows: results,
            artifacts
        };
        const write = this._writeReceipt(this.receiptPath(resolvedDesignDir), receipt);
        if (!write.ok) return write;
        return {
            ok: true,
            required: true,
            generated: true,
            reused: false,
            receiptPath: write.path,
            receipt,
            artifacts,
            results
        };
    }

    validateReceipt({ designDir = '', design = {}, designHash = '' } = {}) {
        const projection = this._resolveWorkflowTasks(design);
        if (!projection.ok) return projection;
        const required = projection.tasks.length > 0;
        const receiptPath = this.receiptPath(designDir);
        if (!fs.existsSync(receiptPath)) {
            if (!required) return { ok: true, required: false, receiptValid: false, receiptPath, artifacts: [] };
            return this._missingReceipt(receiptPath, '设计阶段尚未生成工作流 XML receipt。');
        }
        let receipt;
        try {
            receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf-8'));
        } catch (error) {
            return this._missingReceipt(receiptPath, `工作流 XML receipt 无法解析：${error.message}`);
        }
        const expectedHash = String(designHash || this._hashJson(design)).trim();
        if (receipt.schemaVersion !== RECEIPT_SCHEMA_VERSION || receipt.designHash !== expectedHash) {
            return this._missingReceipt(receiptPath, '工作流 XML receipt 与当前最终设计不一致，必须回到设计后置动作重新生成。', {
                expectedDesignHash: expectedHash,
                actualDesignHash: String(receipt.designHash || '')
            });
        }
        if (!required) {
            return {
                ok: true,
                required: false,
                receiptValid: receipt.status === 'not_required',
                receiptPath,
                receipt,
                artifacts: []
            };
        }
        const artifacts = Array.isArray(receipt.artifacts) ? receipt.artifacts : [];
        const missing = [];
        for (const task of projection.tasks) {
            for (const kind of ['workflow_mis_xml', 'workflow_process_xml']) {
                const artifact = artifacts.find(item => item && item.kind === kind
                    && String(item.storyId || '').toUpperCase() === String(task.storyId || '').toUpperCase()
                    && String(item.bizModule || '').toLowerCase() === String(task.bizModule || '').toLowerCase());
                if (!artifact || !this._isArtifactValid(artifact)) {
                    missing.push({ storyId: task.storyId, bizModule: task.bizModule, kind, path: artifact && artifact.path || '' });
                }
            }
        }
        if (receipt.status !== 'ready' || missing.length > 0) {
            return this._missingReceipt(receiptPath, '设计阶段工作流 XML 不完整或已被修改，必须重新执行设计后置生成。', { missing });
        }
        return {
            ok: true,
            required: true,
            receiptValid: true,
            receiptPath,
            receipt,
            artifacts
        };
    }

    _resolveWorkflowTasks(design = {}) {
        const businessEntities = Array.isArray(design.businessEntities) ? design.businessEntities : [];
        const legacyModules = Array.isArray(design.modules) ? design.modules : [];
        const owners = [...businessEntities, ...legacyModules];
        const tables = design && design.databaseDesign && Array.isArray(design.databaseDesign.tables)
            ? design.databaseDesign.tables
            : [];
        // 全局 ServiceInternal 索引：entityKey/objectKey/bizModule → FQCN 集合。
        // 两遍扫描：先索引所有 ServiceInternal 文件，再传播承载关系。
        // _serviceInternalTypeName 直接查索引，不需要 carriers/carriedByMap/same-entity 旁路。
        const serviceInternalIndex = new Map();
        const indexServiceInternal = (files, keys) => {
            (Array.isArray(files) ? files : []).forEach(file => {
                if (!file || typeof file !== 'object' || String(file.fileKind || '').trim() !== 'ServiceInternal') return;
                const relativeDir = String(file.relativeDir || '').trim().replace(/\\/gu, '/').replace(/^\/+|\/+$/gu, '');
                const fileName = String(file.fileName || '').trim();
                const resolvedPath = String(file.resolvedPath || '').trim().replace(/\\/gu, '/');
                const source = resolvedPath || (relativeDir && fileName ? `${relativeDir}/${fileName}` : '');
                const normalized = source.replace(/^.*?src\/main\/java\//u, '');
                if (!normalized || !normalized.endsWith('.java')) return;
                const fqn = normalized.slice(0, -5).replace(/\//gu, '.');
                keys.forEach(key => {
                    if (!serviceInternalIndex.has(key)) serviceInternalIndex.set(key, new Set());
                    serviceInternalIndex.get(key).add(fqn);
                });
            });
        };
        const carriedByMap = new Map();
        owners.forEach(owner => {
            const handoff = owner && owner.codingHandoff && typeof owner.codingHandoff === 'object'
                ? owner.codingHandoff
                : {};
            const carried = String(
                owner && owner.carriedByEntityKey
                || handoff.carriedByEntityKey
                || ''
            ).trim().toLowerCase();
            const keys = new Set([
                owner && owner.entityKey,
                owner && owner.objectKey,
                owner && owner.bizModule,
                handoff.objectKey,
                handoff.bizModule
            ].map(value => String(value || '').trim().toLowerCase()).filter(Boolean));
            indexServiceInternal(owner.fileSet, keys);
            indexServiceInternal(handoff.fileSet, keys);
            indexServiceInternal(handoff.fileSeeds, keys);
            if (carried) keys.forEach(key => { if (!carriedByMap.has(key)) carriedByMap.set(key, carried); });
        });
        // 第二遍：传播承载关系。被承载实体（如 authorization_workflow）的键
        // 继承承载实体（如 authorization）的 ServiceInternal FQCN。
        for (const [entityKey, carriedBy] of carriedByMap) {
            const carrierFqns = serviceInternalIndex.get(carriedBy);
            if (carrierFqns) {
                if (!serviceInternalIndex.has(entityKey)) serviceInternalIndex.set(entityKey, new Set());
                carrierFqns.forEach(fqn => serviceInternalIndex.get(entityKey).add(fqn));
            }
        }
        // 事前去重：先扫描所有 owner，找出已有编译版合同（含 workflowExternalMethodSeeds）的工作流身份。
        // 主循环遇到同身份的原始 workflowIntent 版本直接跳过，不产生重复合同。
        const compiledWorkflowIdentities = new Set();
        for (const owner of owners) {
            const handoff = owner && owner.codingHandoff && typeof owner.codingHandoff === 'object'
                ? owner.codingHandoff
                : {};
            const compiledSources = [
                ...(Array.isArray(owner.workflowContracts) ? owner.workflowContracts : []),
                ...(Array.isArray(handoff.workflowContracts) ? handoff.workflowContracts : []),
                owner.workflowContract,
                handoff.workflowContract
            ].filter(item => item && typeof item === 'object' && !Array.isArray(item)
                && Array.isArray(item.workflowExternalMethodSeeds)
                && item.workflowExternalMethodSeeds.length > 0);
            for (const c of compiledSources) {
                const sid = String(
                    c.storyId || c.sourceStoryId || owner.storyId
                    || (Array.isArray(owner.relatedStoryIds) ? owner.relatedStoryIds[0] : '')
                    || (Array.isArray(handoff.storyIds) ? handoff.storyIds[0] : '')
                    || ''
                ).trim().toUpperCase();
                const bm = String(c.bizModule || handoff.bizModule || owner.bizModule || handoff.pageName || '').trim();
                if (sid && bm) compiledWorkflowIdentities.add(`${sid}::${bm.toLowerCase()}`);
            }
        }
        const tasks = [];
        const tasksByIdentity = new Map();
        for (const owner of owners) {
            const handoff = owner && owner.codingHandoff && typeof owner.codingHandoff === 'object'
                ? owner.codingHandoff
                : {};
            for (const contract of this._workflowContracts(owner, handoff)) {
                const storyId = String(
                    contract.storyId || contract.sourceStoryId || owner.storyId
                    || (Array.isArray(owner.relatedStoryIds) ? owner.relatedStoryIds[0] : '')
                    || (Array.isArray(handoff.storyIds) ? handoff.storyIds[0] : '')
                    || ''
                ).trim().toUpperCase();
                const bizModule = String(contract.bizModule || handoff.bizModule || owner.bizModule || handoff.pageName || '').trim();
                if (!storyId || !bizModule) {
                    return this._blocked(
                        'DESIGN_WORKFLOW_IDENTITY_MISSING',
                        '工作流设计合同缺少 storyId 或 codingHandoff.bizModule，Builder 无法确定稳定输出身份。',
                        { storyId, bizModule }
                    );
                }
                const identity = `${storyId}::${bizModule.toLowerCase()}`;
                // 同一工作流已有编译版合同（含外部方法）时，跳过原始 workflowIntent 版本
                const hasExternalMethods = Array.isArray(contract.workflowExternalMethodSeeds)
                    && contract.workflowExternalMethodSeeds.length > 0;
                if (!hasExternalMethods && compiledWorkflowIdentities.has(identity)) {
                    continue;
                }
                const table = this._findBusinessTable({ tables, owner, handoff, contract });
                if (!table) {
                    return this._blocked(
                        'DESIGN_WORKFLOW_TABLE_PROJECTION_MISSING',
                        `${storyId} 缺少唯一工作流承载表，禁止 Builder 猜表。`,
                        { storyId, bizModule }
                    );
                }
                const processName = String(contract.processName || contract.name || '').trim();
                const task = {
                    owner,
                    contract,
                    storyId,
                    bizModule,
                    table,
                    processName,
                    relatedFeature: String(owner.businessObject || owner.moduleName || owner.entityName || '').trim(),
                    initiator: String(contract.initiator || contract.initiatorRole || contract.applicantRole || contract.starter || '').trim(),
                    activities: this._projectActivities(contract.activities),
                    transitions: this._projectTransitions(contract.transitions),
                    workflowExternalMethodSeeds: Array.isArray(contract.workflowExternalMethodSeeds)
                        ? JSON.parse(JSON.stringify(contract.workflowExternalMethodSeeds))
                        : [],
                    serviceInternalTypeName: this._serviceInternalTypeName({ owner, handoff, contract, serviceInternalIndex })
                };
                const parameterContract = this._validateWorkflowParameterContract([
                    ...((Array.isArray(contract.operationEvents) ? contract.operationEvents : [])
                        .filter(item => item && String(item.mode || '').trim().toLowerCase() === 'service_method')),
                    ...task.workflowExternalMethodSeeds
                ]);
                if (!parameterContract.ok) {
                    return this._blocked(
                        'DESIGN_WORKFLOW_PARAMETER_CONTRACT_INVALID',
                        `${storyId}/${bizModule} 的工作流外部方法参数合同不合法。`,
                        { storyId, bizModule, issues: parameterContract.issues }
                    );
                }
                if (task.workflowExternalMethodSeeds.length > 0 && !task.serviceInternalTypeName) {
                    return this._blocked(
                        'DESIGN_WORKFLOW_SERVICE_INTERNAL_TARGET_MISSING',
                        `${storyId}/${bizModule} 存在工作流外部方法，但没有唯一 ServiceInternal 文件路径，禁止猜包名。`,
                        { storyId, bizModule, allowedNextActions: ['repair_design_service_internal_file_projection'] }
                    );
                }
                const fingerprint = JSON.stringify({
                    tableName: task.table.tableName,
                    processName: task.processName,
                    initiator: task.initiator,
                    activities: task.activities,
                    transitions: task.transitions,
                    workflowExternalMethodSeeds: task.workflowExternalMethodSeeds,
                    serviceInternalTypeName: task.serviceInternalTypeName
                });
                const existing = tasksByIdentity.get(identity);
                if (existing) {
                    if (existing.fingerprint !== fingerprint) {
                        return this._blocked(
                            'DESIGN_WORKFLOW_CONTRACT_CONFLICT',
                            `${storyId}/${bizModule} 在 businessEntities 与 modules 中存在不等价的工作流合同，禁止 Builder 静默选取。`,
                            { storyId, bizModule }
                        );
                    }
                    continue;
                }
                tasksByIdentity.set(identity, { fingerprint, task });
                tasks.push(task);
            }
        }
        return { ok: true, tasks };
    }

    _validateWorkflowParameterContract(events = []) {
        const issues = [];
        (Array.isArray(events) ? events : []).forEach((event, eventIndex) => {
            if (!event || typeof event !== 'object') return;
            const mode = String(event.mode || 'service_method').trim().toLowerCase();
            if (mode !== 'service_method') return;
            (Array.isArray(event.parameters) ? event.parameters : []).forEach((parameter, parameterIndex) => {
                const source = String(parameter && parameter.source || '').trim();
                const value = String(parameter && parameter.value || '').trim();
                if (source === '$PVI_GUID') {
                    if (value) {
                        issues.push({
                            code: 'WORKFLOW_PARAMETER_PVI_VALUE_INVALID',
                            eventIndex,
                            parameterIndex,
                            parameterName: String(parameter && parameter.name || '').trim(),
                            message: '$PVI_GUID参数不应再携带自定义mpvalue。'
                        });
                    }
                    return;
                }
                if (source !== 'constant' || !WORKFLOW_PARAMETER_CONSTANT_PATTERN.test(value)) {
                    issues.push({
                        code: 'WORKFLOW_PARAMETER_SOURCE_OR_VALUE_INVALID',
                        eventIndex,
                        parameterIndex,
                        parameterName: String(parameter && parameter.name || '').trim(),
                        source,
                        value,
                        allowedSources: ['$PVI_GUID', 'constant'],
                        allowedPattern: WORKFLOW_PARAMETER_CONSTANT_PATTERN.source,
                        message: '参数来源只能是$PVI_GUID或ASCII稳定常量；不能把业务字段名或运行时表达式写入XML。'
                    });
                }
            });
        });
        return { ok: issues.length === 0, issues };
    }

    _workflowContracts(owner = {}, handoff = {}) {
        // 只从编译版合同（workflowContracts/workflowContract）收集候选。
        // 原始 workflowIntent 是故事上下文，不是合同；编译器保证有 workflowIntent 的 story
        // 一定有对应的编译版 workflowContract（含 operationEvents/workflowExternalMethodSeeds）。
        // 把原始 intent 也当候选会导致同一流程出现两个指纹不同的任务 → 冲突。
        const candidates = [
            ...(Array.isArray(owner.workflowContracts) ? owner.workflowContracts : []),
            ...(Array.isArray(handoff.workflowContracts) ? handoff.workflowContracts : []),
            owner.workflowContract,
            handoff.workflowContract
        ];
        const seen = new Set();
        return candidates.filter(item => {
            if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
            const { storyId, sourceStoryId, ...contract } = item;
            const key = JSON.stringify(contract);
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });
    }

    _serviceInternalTypeName({ owner = {}, handoff = {}, contract = {}, serviceInternalIndex = new Map() } = {}) {
        const explicit = String(
            contract.serviceInternalTypeName
            || owner.serviceInternalTypeName
            || handoff.serviceInternalTypeName
            || ''
        ).trim();
        if (explicit) return explicit;
        // 从全局索引按当前 owner 的全部身份键查找 ServiceInternal FQCN。
        // 覆盖：自身 entityKey/objectKey/bizModule、handoff 的同名键、carriedByEntityKey。
        const lookupKeys = [
            owner.entityKey, owner.objectKey, owner.bizModule,
            handoff.objectKey, handoff.bizModule,
            owner.carriedByEntityKey, handoff.carriedByEntityKey
        ].map(value => String(value || '').trim().toLowerCase()).filter(Boolean);
        const candidates = new Set();
        for (const key of lookupKeys) {
            const found = serviceInternalIndex.get(key);
            if (found) found.forEach(fqn => candidates.add(fqn));
        }
        return candidates.size === 1 ? [...candidates][0] : '';
    }

    _findBusinessTable({ tables = [], owner = {}, handoff = {}, contract = {} } = {}) {
        const normalize = value => String(value || '').trim().toLowerCase();
        const directWanted = new Set([
            owner.entityKey,
            owner.objectKey,
            handoff.objectKey,
            contract.objectKey,
            contract.entityKey,
            contract.entityName
        ].map(normalize).filter(Boolean));
        const carriedByEntityKeys = new Set([
            // workflow_process + linkedTable.kind=none 的设计事实：
            // 工作流实体本身没有表，必须挂靠到明确的主业务实体。
            owner.carriedByEntityKey,
            handoff.carriedByEntityKey,
            contract.carriedByEntityKey
        ].map(normalize).filter(Boolean));
        const carriedByModuleIds = new Set([
            // 兼容旧 modules/codingHandoff 投影；新 entity-first 设计优先使用
            // carriedByEntityKey，但不能让旧投影丢掉同一承载事实。
            owner.carriedByModuleId,
            handoff.carriedByModuleId,
            contract.carriedByModuleId
        ].map(normalize).filter(Boolean));
        const hasExplicitCarrier = carriedByEntityKeys.size > 0 || carriedByModuleIds.size > 0;
        const matches = tables.filter(table => {
            const identityValues = [
                table.objectKey,
                table.entityKey,
                table.entityName,
                table.bizModule
            ];
            const identityMatch = hasExplicitCarrier
                ? identityValues.some(value => carriedByEntityKeys.has(normalize(value)))
                : identityValues.some(value => directWanted.has(normalize(value)));
            const moduleMatch = Array.isArray(table.relatedModuleIds)
                && table.relatedModuleIds.some(value => carriedByModuleIds.has(normalize(value)));
            return identityMatch || moduleMatch;
        });
        const candidate = matches.length === 1
            ? matches[0]
            : (!hasExplicitCarrier && matches.length === 0 && tables.length === 1 ? tables[0] : null);
        const linkedTable = owner.linkedTable && owner.linkedTable.kind !== 'none' ? owner.linkedTable : null;
        const selected = hasExplicitCarrier ? candidate : candidate || linkedTable;
        if (!selected || !String(selected.tableName || '').trim()) return null;
        return {
            ...selected,
            businessColumns: Array.isArray(selected.businessColumns)
                ? selected.businessColumns
                : (Array.isArray(selected.columns) ? selected.columns : [])
        };
    }

    _projectActivities(values = []) {
        return (Array.isArray(values) ? values : []).map(item => ({
            key: String(item && (item.key || item.id) || '').trim(),
            name: String(item && (item.name || item.activityName) || '').trim(),
            actor: String(item && (item.actor || item.role) || '').trim(),
            ...(String(item && (item.handleUrl || item.pageUrl) || '').trim()
                ? { handleUrl: String(item.handleUrl || item.pageUrl).trim() } : {}),
            operations: (Array.isArray(item && item.operations) ? item.operations : []).map(operation => {
                if (operation && typeof operation === 'object' && !Array.isArray(operation)) {
                    return this._stripEmpty({
                        key: String(operation.key || operation.id || '').trim(),
                        name: String(operation.name || operation.operationName || operation.label || '').trim(),
                        semantic: String(operation.semantic || operation.actionType || operation.type || '').trim().toLowerCase(),
                        operationType: String(operation.operationType || '').trim(),
                        targetActivity: String(operation.targetActivity || operation.target || '').trim(),
                        requiresOpinion: operation.requiresOpinion === true || operation.isRequireOpinion === true,
                        checkMaterialSubmit: operation.checkMaterialSubmit === true || operation.isCheckMaterialSubmit === true
                    });
                }
                const name = String(operation || '').trim();
                return name ? { name } : {};
            }).filter(item => Object.keys(item).length > 0)
        }));
    }

    _projectTransitions(values = []) {
        return (Array.isArray(values) ? values : []).map(item => ({
            from: String(item && (item.from || item.fromActivity || item.source) || '').trim(),
            to: String(item && (item.to || item.toActivity || item.target) || '').trim(),
            condition: String(item && (item.condition || item.name || item.label) || '').trim()
        }));
    }

    _projectArtifact({ item = {}, task = {} } = {}) {
        const artifactPath = path.resolve(String(item.path || '').trim());
        if (!artifactPath || !fs.existsSync(artifactPath)) return null;
        const artifactKind = String(item.artifactKind || '').trim();
        const kind = artifactKind === 'mis_xml'
            ? 'workflow_mis_xml'
            : (artifactKind === 'workflow_xml' ? 'workflow_process_xml' : '');
        if (!kind) return null;
        return this._stripEmpty({
            storyId: task.storyId,
            processName: task.processName,
            relatedFeature: task.relatedFeature,
            initiator: task.initiator || '未明确',
            bizModule: task.bizModule,
            activities: Array.isArray(item.activities) ? item.activities : task.activities,
            transitions: Array.isArray(item.transitions) ? item.transitions : task.transitions,
            workflowExternalMethodSeeds: Array.isArray(item.workflowExternalMethodSeeds)
                ? item.workflowExternalMethodSeeds
                : task.workflowExternalMethodSeeds,
            serviceInternalTypeName: item.serviceInternalTypeName || task.serviceInternalTypeName,
            kind,
            artifactKind,
            path: artifactPath,
            sha256: this._hashFile(artifactPath),
            tableGuid: item.tableGuid,
            tableID: item.tableID,
            processGuid: item.processGuid,
            processVersionGuid: item.processVersionGuid,
            status: '已生成、未导入'
        });
    }

    _isArtifactValid(artifact = {}) {
        const artifactPath = String(artifact.path || '').trim();
        if (!artifactPath || !fs.existsSync(artifactPath)) return false;
        try {
            return fs.statSync(artifactPath).isFile()
                && fs.statSync(artifactPath).size > 0
                && String(artifact.sha256 || '') === this._hashFile(artifactPath);
        } catch (_) {
            return false;
        }
    }

    _writeReceipt(receiptPath = '', receipt = {}) {
        const temporary = `${receiptPath}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
        try {
            fs.mkdirSync(path.dirname(receiptPath), { recursive: true });
            fs.writeFileSync(temporary, `${JSON.stringify(receipt, null, 2)}\n`, 'utf-8');
            fs.renameSync(temporary, receiptPath);
            return { ok: true, path: receiptPath };
        } catch (error) {
            try { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); } catch (_) {}
            return this._blocked('DESIGN_WORKFLOW_RECEIPT_WRITE_FAILED', `工作流 XML receipt 写入失败：${receiptPath}`, {
                cause: String(error && error.message || error)
            });
        }
    }

    _missingReceipt(receiptPath = '', message = '', extra = {}) {
        return this._blocked('DESIGN_WORKFLOW_ARTIFACT_RECEIPT_INVALID', message, {
            receiptPath,
            allowedNextActions: ['rerun_design_prepare_context_to_restore_workflow_artifacts'],
            forbiddenActions: ['generate_workflow_xml_in_coder', 'generate_workflow_xml_in_skeleton'],
            ...extra
        });
    }

    _duplicates(values = []) {
        const seen = new Set();
        const duplicates = new Set();
        values.forEach(value => {
            if (seen.has(value)) duplicates.add(value);
            seen.add(value);
        });
        return Array.from(duplicates);
    }

    _safeFileName(value = '') {
        return String(value || 'workflow').replace(/[^A-Za-z0-9_-]/g, '_');
    }

    _hashJson(value = {}) {
        return `sha256:${crypto.createHash('sha256').update(JSON.stringify(value), 'utf-8').digest('hex')}`;
    }

    _hashFile(filePath = '') {
        return `sha256:${crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')}`;
    }

    _stripEmpty(value = {}) {
        const out = {};
        for (const [key, item] of Object.entries(value || {})) {
            if (item === undefined || item === null || item === '') continue;
            if (Array.isArray(item) && item.length === 0) continue;
            out[key] = item;
        }
        return out;
    }

    _blocked(errorCode, message, extra = {}) {
        return { ok: false, status: 'blocked', errorCode, message, ...extra };
    }
}

module.exports = DesignWorkflowArtifactService;
