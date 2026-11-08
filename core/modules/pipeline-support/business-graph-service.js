/* eslint-disable */

const fs = require('fs');
const path = require('path');

class BusinessGraphService {
    constructor(options = {}) {
        this.readJsonSafe = typeof options.readJsonSafe === 'function'
            ? options.readJsonSafe
            : filePath => {
                try { return JSON.parse(fs.readFileSync(filePath, 'utf-8')); } catch (_) { return null; }
            };
        this.writeJsonArtifact = typeof options.writeJsonArtifact === 'function'
            ? options.writeJsonArtifact
            : (filePath, payload) => {
                const dir = path.dirname(filePath);
                if (dir && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
                fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf-8');
            };
        this.refreshGraphExternal = typeof options.refreshGraphExternal === 'function'
            ? options.refreshGraphExternal
            : null;
    }

    ensureGraph(projectPath, outputPath, options = {}) {
        const forceRefresh = options.forceRefresh === true;
        const existing = !forceRefresh ? this.validateGraph(outputPath) : { ok: false };
        if (existing.ok) return { ok: true, source: 'global-cache', path: outputPath, payload: existing.payload };

        if (this.refreshGraphExternal) {
            try {
                this.refreshGraphExternal(projectPath, options);
            } catch (error) {
                return {
                    ok: false,
                    recoverable: true,
                    source: 'external-generator',
                    path: outputPath,
                    message: `BUSINESS_GRAPH_GENERATE_FAILED: ${error.message}`
                };
            }
        }

        const regenerated = this.validateGraph(outputPath);
        if (!regenerated.ok) {
            return {
                ok: false,
                recoverable: true,
                source: 'external-generator',
                path: outputPath,
                message: regenerated.message
            };
        }
        return { ok: true, source: forceRefresh ? 'forced-refresh' : 'rebuilt', path: outputPath, payload: regenerated.payload };
    }

    validateGraph(filePath) {
        if (!filePath || !fs.existsSync(filePath)) {
            return { ok: false, recoverable: true, message: `BUSINESS_GRAPH_MISSING: ${filePath || 'EMPTY'}` };
        }
        const payload = this.readJsonSafe(filePath);
        if (!payload || typeof payload !== 'object') return { ok: false, recoverable: true, message: 'BUSINESS_GRAPH_INVALID: payload empty' };
        if (!Array.isArray(payload.businessBlocks)) return { ok: false, recoverable: true, message: 'BUSINESS_GRAPH_INVALID: businessBlocks missing' };
        if (!Array.isArray(payload.anchors)) return { ok: false, recoverable: true, message: 'BUSINESS_GRAPH_INVALID: anchors missing' };
        if (!this._hasEffectiveBusinessGraphContent(payload)) return { ok: false, recoverable: true, message: 'BUSINESS_GRAPH_EMPTY: businessBlocks/anchors contain no effective project facts' };
        const policy = payload.buildPolicy && typeof payload.buildPolicy === 'object' ? payload.buildPolicy : {};
        if (policy.storesSourceText !== false) return { ok: false, recoverable: true, message: 'BUSINESS_GRAPH_INVALID: storesSourceText must be false' };
        return { ok: true, payload };
    }

    loadGraph(filePath) {
        const validation = this.validateGraph(filePath);
        if (!validation.ok) return validation;
        return { ok: true, payload: validation.payload };
    }

    loadIndex(filePath) {
        if (!filePath || !fs.existsSync(filePath)) return { ok: false, message: `BUSINESS_GRAPH_INDEX_MISSING: ${filePath || 'EMPTY'}` };
        const payload = this.readJsonSafe(filePath);
        if (!payload || typeof payload !== 'object') return { ok: false, message: 'BUSINESS_GRAPH_INDEX_INVALID: payload empty' };
        if (!Array.isArray(payload.businessBlocks)) return { ok: false, message: 'BUSINESS_GRAPH_INDEX_INVALID: businessBlocks missing' };
        return { ok: true, payload };
    }

    loadAssetIndex(filePath) {
        if (!filePath || !fs.existsSync(filePath)) return { ok: false, message: `ASSET_INDEX_MISSING: ${filePath || 'EMPTY'}` };
        const payload = this.readJsonSafe(filePath);
        if (!payload || typeof payload !== 'object') return { ok: false, message: 'ASSET_INDEX_INVALID: payload empty' };
        if (!Array.isArray(payload.assetIndex)) return { ok: false, message: 'ASSET_INDEX_INVALID: assetIndex missing' };
        return { ok: true, payload };
    }

    ensureEntityGraph(projectPath, outputPath, options = {}) {
        const forceRefresh = options.forceRefresh === true;
        const existing = !forceRefresh ? this.validateEntityGraph(outputPath) : { ok: false };
        if (existing.ok) return { ok: true, source: 'global-cache', path: outputPath, payload: existing.payload };

        if (this.refreshGraphExternal) {
            try {
                this.refreshGraphExternal(projectPath, options);
            } catch (error) {
                return {
                    ok: false,
                    recoverable: true,
                    source: 'external-generator',
                    path: outputPath,
                    message: `ENTITY_GRAPH_GENERATE_FAILED: ${error.message}`
                };
            }
        }

        const regenerated = this.validateEntityGraph(outputPath);
        if (!regenerated.ok) {
            return {
                ok: false,
                recoverable: true,
                source: 'external-generator',
                path: outputPath,
                message: regenerated.message
            };
        }
        return { ok: true, source: forceRefresh ? 'forced-refresh' : 'rebuilt', path: outputPath, payload: regenerated.payload };
    }

    validateEntityGraph(filePath) {
        if (!filePath || !fs.existsSync(filePath)) {
            return { ok: false, recoverable: true, message: `ENTITY_GRAPH_MISSING: ${filePath || 'EMPTY'}` };
        }
        const payload = this.readJsonSafe(filePath);
        if (!payload || typeof payload !== 'object') return { ok: false, recoverable: true, message: 'ENTITY_GRAPH_INVALID: payload empty' };
        if (!payload.entityGraph || typeof payload.entityGraph !== 'object') return { ok: false, recoverable: true, message: 'ENTITY_GRAPH_INVALID: entityGraph missing' };
        if (!Array.isArray(payload.entityGraph.nodes)) return { ok: false, recoverable: true, message: 'ENTITY_GRAPH_INVALID: nodes missing' };
        if (!Array.isArray(payload.entityGraph.edges)) return { ok: false, recoverable: true, message: 'ENTITY_GRAPH_INVALID: edges missing' };
        if (!this._hasEffectiveEntityGraphContent(payload)) return { ok: false, recoverable: true, message: 'ENTITY_GRAPH_EMPTY: entityGraph.nodes contain no effective project facts' };
        return { ok: true, payload };
    }

    _hasEffectiveBusinessGraphContent(payload = {}) {
        const blocks = Array.isArray(payload.businessBlocks) ? payload.businessBlocks : [];
        const anchors = Array.isArray(payload.anchors) ? payload.anchors : [];
        if (anchors.some(anchor => anchor && typeof anchor === 'object' && String(anchor.path || anchor.ownerPath || anchor.sourcePath || anchor.kind || '').trim())) {
            return true;
        }
        return blocks.some(block => {
            if (!block || typeof block !== 'object') return false;
            if (String(block.businessKey || block.summary || block.sourcePath || block.ownerPath || '').trim()) return true;
            return ['aliases', 'examplePhrases', 'methods', 'files', 'anchors'].some(key => {
                const value = block[key];
                return Array.isArray(value) && value.some(item => String(item && typeof item === 'object' ? (item.path || item.name || item.value || item.label || '') : item || '').trim());
            });
        });
    }

    _hasEffectiveEntityGraphContent(payload = {}) {
        const graph = payload.entityGraph && typeof payload.entityGraph === 'object' ? payload.entityGraph : {};
        const nodes = Array.isArray(graph.nodes) ? graph.nodes : [];
        return nodes.some(node => {
            if (!node || typeof node !== 'object') return false;
            return String(node.entityName || node.tableName || node.id || node.path || node.sourcePath || '').trim()
                || (Array.isArray(node.fields) && node.fields.length > 0)
                || (Array.isArray(node.keywords) && node.keywords.some(item => String(item || '').trim()));
        });
    }

    loadEntityGraph(filePath) {
        const validation = this.validateEntityGraph(filePath);
        if (!validation.ok) return validation;
        return { ok: true, payload: validation.payload };
    }

    loadEntityGraphIndex(filePath) {
        if (!filePath || !fs.existsSync(filePath)) return { ok: false, message: `ENTITY_GRAPH_INDEX_MISSING: ${filePath || 'EMPTY'}` };
        const payload = this.readJsonSafe(filePath);
        if (!payload || typeof payload !== 'object') return { ok: false, message: 'ENTITY_GRAPH_INDEX_INVALID: payload empty' };
        if (!Array.isArray(payload.nodes)) return { ok: false, message: 'ENTITY_GRAPH_INDEX_INVALID: nodes missing' };
        return { ok: true, payload };
    }

    syncRequirementFeedback(graphPath, feedback = {}) {
        const graphState = this.loadGraph(graphPath);
        if (!graphState.ok) return graphState;
        const payload = graphState.payload;
        const currentNeed = String(feedback.currentNeed || '').trim();
        const businessCandidates = Array.isArray(feedback.businessCandidates) ? feedback.businessCandidates : [];
        const matchedRules = Array.isArray(feedback.matchedRules) ? feedback.matchedRules : [];
        const businessKeys = this._dedupe(businessCandidates.map(item => item && item.businessKey));
        const normalizedPhrases = this._dedupe([
            currentNeed,
            ...businessCandidates.flatMap(item => [
                ...(Array.isArray(item && item.aliases) ? item.aliases : []),
                String(item && item.summary || '')
            ])
        ]);
        const plannedEntry = {
            currentNeed,
            normalizedPhrases: normalizedPhrases.slice(0, 12),
            businessKeys,
            matchedRules: matchedRules.slice(0, 12),
            updatedAt: new Date().toISOString()
        };
        const planned = Array.isArray(payload.plannedFeatureRefs) ? payload.plannedFeatureRefs : [];
        const deduped = [
            plannedEntry,
            ...planned.filter(item => this._plannedFeedbackKey(item) !== this._plannedFeedbackKey(plannedEntry))
        ].slice(0, 80);
        payload.plannedFeatureRefs = deduped;
        this.writeJsonArtifact(graphPath, payload);
        return { ok: true, payload };
    }

    syncVerifiedFeedback(graphPath, feedback = {}) {
        const graphState = this.loadGraph(graphPath);
        if (!graphState.ok) return graphState;
        const payload = graphState.payload;
        const currentNeed = String(feedback.currentNeed || '').trim();
        const businessKeys = this._dedupe(feedback.businessKeys || []);
        const phrases = this._dedupe(feedback.verifiedPhrases || []);
        const verifiedEntry = {
            currentNeed,
            businessKeys,
            verifiedPhrases: phrases.slice(0, 12),
            updatedAt: new Date().toISOString()
        };
        const verified = Array.isArray(payload.verifiedPhrases) ? payload.verifiedPhrases : [];
        payload.verifiedPhrases = [
            verifiedEntry,
            ...verified.filter(item => this._plannedFeedbackKey(item) !== this._plannedFeedbackKey(verifiedEntry))
        ].slice(0, 80);
        const blocks = Array.isArray(payload.businessBlocks) ? payload.businessBlocks : [];
        blocks.forEach(block => {
            if (!businessKeys.includes(String(block.businessKey || '').trim())) return;
            const aliases = this._dedupe([...(block.aliases || []), ...phrases]);
            const examples = this._dedupe([...(block.examplePhrases || []), ...phrases]);
            block.aliases = aliases.slice(0, 12);
            block.examplePhrases = examples.slice(0, 8);
        });
        this.writeJsonArtifact(graphPath, payload);
        return { ok: true, payload };
    }

    search(graphPayload, intentSignals = {}, options = {}) {
        const graph = graphPayload && typeof graphPayload === 'object' ? graphPayload : {};
        const blocks = Array.isArray(graph.businessBlocks) ? graph.businessBlocks : [];
        const signals = this._normalizeSignals(intentSignals);
        const entityNames = this._dedupe(options.entityNames || []);
        let results = blocks.map(block => this._scoreBlock(block, signals))
            .filter(item => this._matchBusinessCandidateToEntities(item, entityNames))
            .filter(item => item.score > 0)
            .sort((a, b) => b.score - a.score || String(a.businessKey).localeCompare(String(b.businessKey)));
        if (results.length === 0 && entityNames.length > 0) {
            results = blocks.map(block => this._scoreBlock(block, signals))
                .filter(item => item.score > 0)
                .sort((a, b) => b.score - a.score || String(a.businessKey).localeCompare(String(b.businessKey)));
        }
        const limit = Number(options.limit || 5);
        return {
            ok: true,
            signals,
            candidates: results.slice(0, Math.max(1, limit)),
            assetCandidates: this.searchAssets(graph, signals, { limit: Number(options.assetLimit || 8) }).candidates,
            referenceAnchors: []
        };
    }

    searchAssets(graphPayload, intentSignals = {}, options = {}) {
        const graph = graphPayload && typeof graphPayload === 'object' ? graphPayload : {};
        const assets = Array.isArray(graph.assetIndex) ? graph.assetIndex : [];
        const signals = this._normalizeSignals(intentSignals);
        const businessKeys = this._dedupe(options.businessKeys || []);
        const candidates = assets.map(asset => this._scoreAsset(asset, signals))
            .filter(item => businessKeys.length === 0 || businessKeys.includes(String(item.businessKey || '').trim()))
            .filter(item => item.score > 0)
            .sort((a, b) => b.score - a.score || String(a.assetId).localeCompare(String(b.assetId)));
        const limit = Number(options.limit || 8);
        return { ok: true, signals, candidates: candidates.slice(0, Math.max(1, limit)) };
    }

    searchAssetIndex(assetIndexPayload, intentSignals = {}, options = {}) {
        return this.searchAssets(assetIndexPayload, intentSignals, options);
    }

    searchEntities(entityGraphPayload, intentSignals = {}, options = {}) {
        const graph = entityGraphPayload && typeof entityGraphPayload === 'object' ? entityGraphPayload.entityGraph : null;
        const nodes = Array.isArray(graph && graph.nodes) ? graph.nodes : [];
        const signals = this._normalizeSignals(intentSignals);
        const candidates = nodes.map(node => this._scoreEntityNode(node, signals))
            .filter(item => item.score > 0)
            .sort((a, b) => b.score - a.score || String(a.entityName).localeCompare(String(b.entityName)));
        const limit = Number(options.limit || 3);
        return {
            ok: true,
            signals,
            candidates: candidates.slice(0, Math.max(1, limit)),
            entityReasons: candidates.slice(0, Math.max(1, limit)).map(item => ({
                entityId: item.id,
                matchedEvidence: item.matchedEvidence || [],
                candidateReasons: item.candidateReasons || {}
            }))
        };
    }

    expandEntityImpact(entityGraphPayload, entityCandidates = [], options = {}) {
        const graph = entityGraphPayload && typeof entityGraphPayload === 'object' ? entityGraphPayload.entityGraph : null;
        const nodes = Array.isArray(graph && graph.nodes) ? graph.nodes : [];
        const edges = Array.isArray(graph && graph.edges) ? graph.edges : [];
        const nodeMap = new Map(nodes.map(node => [String(node.id || '').trim(), node]));
        const seedIds = this._dedupe((Array.isArray(entityCandidates) ? entityCandidates : []).map(item => item && item.id));
        const items = [];
        const seen = new Set();
        const maxItems = Number(options.limit || 8);

        seedIds.forEach(entityId => {
            const node = nodeMap.get(entityId);
            if (!node) return;
            const key = `${entityId}::primary`;
            if (!seen.has(key)) {
                seen.add(key);
                items.push({
                    entityId,
                    entityName: node.entityName || '',
                    tableName: node.tableName || '',
                    tableDisplayName: node.tableDisplayName || '',
                    role: node.role || 'master',
                    relationType: 'primary',
                    relatedTo: '',
                    confidence: 1,
                    evidence: ['主实体候选']
                });
            }
            edges.forEach(edge => {
                const from = String(edge && edge.from || '').trim();
                const to = String(edge && edge.to || '').trim();
                if (from !== entityId && to !== entityId) return;
                const otherId = from === entityId ? to : from;
                const otherNode = nodeMap.get(otherId);
                if (!otherNode) return;
                const relationKey = `${otherId}::${edge.type}::${entityId}`;
                if (seen.has(relationKey)) return;
                seen.add(relationKey);
                items.push({
                    entityId: otherId,
                    entityName: otherNode.entityName || '',
                    tableName: otherNode.tableName || '',
                    tableDisplayName: otherNode.tableDisplayName || '',
                    role: otherNode.role || 'master',
                    relationType: String(edge.type || '').trim() || 'related',
                    relatedTo: from === entityId ? entityId : to,
                    confidence: Number(edge.confidence || 0),
                    evidence: Array.isArray(edge.evidence) ? edge.evidence.slice(0, 4) : []
                });
            });
        });

        return {
            ok: true,
            items: items.slice(0, Math.max(1, maxItems))
        };
    }

    deriveIntentSignals(userIntent = '', analysis = {}) {
        const rawTerms = this._tokenizeMixedText(userIntent);
        const normalized = analysis && typeof analysis === 'object' ? analysis : {};
        const metadata = normalized.metadata_inventory && typeof normalized.metadata_inventory === 'object'
            ? normalized.metadata_inventory
            : {};
        const entityChain = normalized.entity_service_api_chain && typeof normalized.entity_service_api_chain === 'object'
            ? normalized.entity_service_api_chain
            : {};
        const aspectEntries = Array.isArray(normalized.rule_coverage_aspects) ? normalized.rule_coverage_aspects : [];
        const analysisTerms = this._dedupe([
            ...(Array.isArray(normalized.rule_match_terms) ? normalized.rule_match_terms : []),
            ...aspectEntries.flatMap(item => Array.isArray(item && item.match_terms) ? item.match_terms : []),
            ...(Array.isArray(metadata.code_items) ? metadata.code_items : []),
            ...(Array.isArray(metadata.sys_params) ? metadata.sys_params : []),
            ...(Array.isArray(metadata.role_permissions) ? metadata.role_permissions : []),
            ...(Array.isArray(metadata.ui_controls) ? metadata.ui_controls : []),
            ...(Array.isArray(entityChain.entities) ? entityChain.entities : []),
            ...(Array.isArray(entityChain.services) ? entityChain.services : []),
            ...(Array.isArray(entityChain.apis) ? entityChain.apis : []),
            ...(Array.isArray(entityChain.reusable_assets) ? entityChain.reusable_assets : [])
        ]);

        const featureKeys = this._dedupe([
            ...aspectEntries.map(item => String(item && (item.aspect_key || item.aspectKey || '')).trim()).filter(Boolean),
            ...(Array.isArray(metadata.code_items) && metadata.code_items.length > 0 ? ['code_item'] : []),
            ...(Array.isArray(metadata.sys_params) && metadata.sys_params.length > 0 ? ['sys_param'] : []),
            ...(Array.isArray(metadata.role_permissions) && metadata.role_permissions.length > 0 ? ['role_permission'] : []),
            ...(
                ((Array.isArray(entityChain.apis) && entityChain.apis.length > 0)
                || (Array.isArray(entityChain.reusable_assets) && entityChain.reusable_assets.length > 0))
                    ? ['api_reuse']
                    : []
            )
        ]);

        return {
            businessTerms: rawTerms,
            analysisTerms,
            featureKeys,
            operationKeys: [],
            uiKeys: [],
            dataKeys: [],
            ruleTerms: analysisTerms,
            assetTokens: this._dedupe([...rawTerms, ...analysisTerms])
        };
    }

    _scoreEntityNode(node, signals) {
        const id = String(node && node.id || '').trim();
        const keywords = Array.isArray(node && node.keywords) ? node.keywords : [];
        const keywordTokenSet = new Set(keywords.flatMap(item => this._tokenizeMixedText(item)));
        const reasons = {
            naturalLanguageHits: [],
            anchorHits: [],
            consistencyHits: []
        };
        let nlScore = 0;
        let anchorScore = 0;
        let consistencyScore = 0;
        const hit = (terms, weight, label, bucket = 'nl') => {
            (Array.isArray(terms) ? terms : []).forEach(term => {
                if (this._isSyntheticSystemSignalTerm(term)) return;
                this._tokenizeMixedText(term).filter(token => !this._isGenericSignalToken(token) && !this._isSyntheticSystemSignalTerm(token)).forEach(token => {
                    if (keywordTokenSet.has(token)) {
                        if (bucket === 'anchor') {
                            anchorScore += weight;
                            reasons.anchorHits.push(`${label}「${term}」命中实体关键词`);
                        } else if (bucket === 'consistency') {
                            consistencyScore += weight;
                            reasons.consistencyHits.push(`${label}「${term}」与实体名/表名一致`);
                        } else {
                            nlScore += weight;
                            reasons.naturalLanguageHits.push(`${label}「${term}」命中表中文名/表名/实体类名`);
                        }
                    }
                });
            });
        };
        const quickNaturalLanguageMode = signals.semanticLaneMode === 'quick_natural_language';
        hit(signals.businessTerms, 18, '业务语义', 'nl');
        if (!quickNaturalLanguageMode) {
            hit(signals.analysisTerms, 14, '分析词', 'anchor');
            hit(signals.assetTokens, 10, '资产词', 'consistency');
        }

        nlScore = Math.min(45, nlScore);
        anchorScore = Math.min(35, anchorScore);
        consistencyScore = Math.min(20, consistencyScore);
        const score = Math.min(100, nlScore + anchorScore + consistencyScore);
        return {
            id,
            entityName: String(node && node.entityName || '').trim(),
            tableName: String(node && node.tableName || '').trim(),
            tableDisplayName: String(node && node.tableDisplayName || '').trim(),
            role: String(node && node.role || 'master').trim() || 'master',
            sourceFile: String(node && node.sourceFile || '').trim(),
            moduleName: String(node && node.moduleName || '').trim(),
            summary: String(node && node.summary || '').trim(),
            keywords: keywords.slice(0, 3),
            fields: Array.isArray(node && node.fields) ? node.fields.slice(0, 12) : [],
            score,
            confidence: Number((score / 100).toFixed(2)),
            nlScore,
            anchorScore,
            consistencyScore,
            matchedEvidence: this._dedupe([
                ...reasons.naturalLanguageHits,
                ...reasons.anchorHits,
                ...reasons.consistencyHits
            ]).slice(0, 8),
            candidateReasons: {
                naturalLanguageHits: this._dedupe(reasons.naturalLanguageHits).slice(0, 4),
                anchorHits: this._dedupe(reasons.anchorHits).slice(0, 4),
                consistencyHits: this._dedupe(reasons.consistencyHits).slice(0, 4)
            }
        };
    }

    validateCodeMethodReuse(context = {}) {
        const projectPath = String(context.projectPath || '').trim();
        const graphPath = String(context.graphPath || '').trim();
        const manifest = context.manifest && typeof context.manifest === 'object' ? context.manifest : {};
        const fileContents = Array.isArray(context.fileContents) ? context.fileContents : [];
        const graphState = this.loadGraph(graphPath);
        if (!graphState.ok) return { ok: false, issues: [graphState.message] };

        const serviceFiles = fileContents.filter(item => this._isServiceFile(item));
        if (!serviceFiles.length) return { ok: true, issues: [] };

        const methodUsage = this._normalizeMethodUsage(manifest);
        const globalIssues = [];
        if (!methodUsage.length) {
            globalIssues.push('SERVICE_METHOD_BUSINESS_ANCHOR_MISSING: 本步涉及 ServiceApi/ServiceImpl，manifest.methodUsage 必须声明复用或新增方法的业务块、接口/实现与原因');
        }
        methodUsage.forEach(usage => {
            if (!/^(reuse_existing_method|add_method)$/i.test(usage.decision)) {
                globalIssues.push(`SERVICE_METHOD_BUSINESS_ANCHOR_MISSING: methodUsage.decision 只能是 reuse_existing_method 或 add_method -> ${JSON.stringify(usage)}`);
            }
            if (!usage.businessKey || !usage.methodName) {
                globalIssues.push(`SERVICE_METHOD_BUSINESS_ANCHOR_MISSING: methodUsage 必须包含 businessKey 与 methodName -> ${JSON.stringify(usage)}`);
            }
            if (usage.decision === 'add_method' && !usage.reason) {
                globalIssues.push(`SERVICE_METHOD_BUSINESS_ANCHOR_MISSING: add_method 必须说明已有方法为何不能覆盖 -> ${usage.methodName}`);
            }
        });

        const matchedBlocks = this._matchBlocksForFiles(graphState.payload, serviceFiles, projectPath);
        if (!matchedBlocks.length) return { ok: globalIssues.length === 0, issues: globalIssues };

        const issues = [...globalIssues];
        matchedBlocks.forEach(block => {
            const availableMethods = Array.isArray(block.availableMethods) ? block.availableMethods : [];
            if (!availableMethods.length) return;
            const blockUsage = methodUsage.filter(item => item.businessKey === block.businessKey);
            if (!blockUsage.length) {
                issues.push(`EXISTING_SERVICE_METHOD_REUSE_REQUIRED: ${block.businessKey} 已存在可复用方法，请在 manifest.methodUsage 中声明 reuse_existing_method 或说明 add_method 原因`);
                return;
            }
            blockUsage.forEach(usage => {
                if (usage.decision === 'add_method' && this._hasSimilarExistingMethod(usage.methodName, availableMethods)) {
                    issues.push(`EXISTING_SERVICE_METHOD_REUSE_REQUIRED: ${block.businessKey}.${usage.methodName} 与已有方法职责相近，必须优先复用/扩展已有方法`);
                }
            });
            const hasImplAdd = blockUsage.some(item => item.decision === 'add_method' && /impl|serviceimpl/i.test(`${item.ownerKind || ''}${item.ownerName || ''}`));
            const hasApiBinding = blockUsage.some(item => item.interfaceName || item.serviceApi || /api|interface/i.test(`${item.ownerKind || ''}${item.ownerName || ''}`));
            if (hasImplAdd && !hasApiBinding) {
                issues.push(`SERVICE_API_IMPL_METHOD_MISMATCH: ${block.businessKey} 新增 Impl 方法必须同步声明对应 ServiceApi/接口方法`);
            }
        });

        return { ok: issues.length === 0, issues };
    }

    _matchBlocksForFiles(graph, files, projectPath) {
        const blocks = Array.isArray(graph.businessBlocks) ? graph.businessBlocks : [];
        const normalize = value => this._normalizeComparablePath(value, projectPath);
        return blocks.filter(block => {
            const paths = [
                ...(Array.isArray(block.anchors) ? block.anchors.map(item => item.path) : []),
                ...(Array.isArray(block.serviceApis) ? block.serviceApis.map(item => item.sourceFile) : []),
                ...(Array.isArray(block.serviceImpls) ? block.serviceImpls.map(item => item.sourceFile) : [])
            ].map(normalize).filter(Boolean);
            if (!paths.length) return false;
            return files.some(file => paths.includes(normalize(file.path || file.absolutePath || '')));
        });
    }

    _isServiceFile(item = {}) {
        const text = `${item.type || ''} ${item.path || ''} ${item.absolutePath || ''}`.toLowerCase();
        return /serviceapi|serviceimpl|\/api\/|\/impl\/|service\.java|serviceimpl\.java/.test(text.replace(/\\/g, '/'));
    }

    _normalizeMethodUsage(manifest = {}) {
        const usage = Array.isArray(manifest.methodUsage)
            ? manifest.methodUsage
            : (Array.isArray(manifest.serviceMethodUsage) ? manifest.serviceMethodUsage : []);
        return usage.map(item => ({
            decision: String(item.decision || item.action || '').trim(),
            businessKey: String(item.businessKey || '').trim(),
            methodName: String(item.methodName || item.name || '').trim(),
            ownerKind: String(item.ownerKind || '').trim(),
            ownerName: String(item.ownerName || item.service || '').trim(),
            interfaceName: String(item.interfaceName || item.serviceApi || '').trim(),
            serviceApi: String(item.serviceApi || '').trim(),
            reason: String(item.reason || '').trim()
        })).filter(item => item.decision || item.businessKey || item.methodName);
    }

    _hasSimilarExistingMethod(methodName = '', availableMethods = []) {
        const op = this._methodOperation(methodName);
        if (!op) return false;
        return availableMethods.some(item => this._methodOperation(item.name) === op);
    }

    _methodOperation(methodName = '') {
        const lower = String(methodName || '').trim().toLowerCase();
        if (!lower) return '';
        if (/^(find|get|query|select|load|list|page)/.test(lower)) return 'query';
        if (/^(save|insert|add|create)/.test(lower)) return 'save';
        if (/^(update|edit|modify)/.test(lower)) return 'update';
        if (/^(delete|remove)/.test(lower)) return 'delete';
        if (/^(sync|import)/.test(lower)) return 'sync';
        if (/^export/.test(lower)) return 'export';
        if (/^(count|total|stat)/.test(lower)) return 'count';
        return '';
    }

    _scoreBlock(block, signals) {
        const businessKey = String(block.businessKey || '').trim();
        const naturalLanguageSet = new Set(this._tokenizeMixedText([
            ...(Array.isArray(block.aliases) ? block.aliases : []),
            String(block.summary || ''),
            ...(Array.isArray(block.examplePhrases) ? block.examplePhrases : []),
            ...(Array.isArray(block.capabilityPhrases) ? block.capabilityPhrases : [])
        ].join(' ')));
        const anchorSet = new Set([
            ...(block.tokens || []),
            ...(block.assetTokens || []),
            ...this._tokenizeMixedText(businessKey),
            ...this._tokenizeMixedText((Array.isArray(block.primaryEntities) ? block.primaryEntities : []).join(' ')),
            ...this._tokenizeMixedText((Array.isArray(block.primaryActions) ? block.primaryActions : []).join(' '))
        ]);
        const reasons = {
            naturalLanguageHits: [],
            anchorHits: [],
            consistencyHits: []
        };
        let nlScore = 0;
        let anchorScore = 0;
        let consistencyScore = 0;
        const quickNaturalLanguageMode = signals.semanticLaneMode === 'quick_natural_language';

        const hitNaturalLanguage = (terms, weight, label) => {
            (Array.isArray(terms) ? terms : []).forEach(term => {
                this._tokenizeMixedText(term).forEach(token => {
                    if (naturalLanguageSet.has(token) || businessKey.toLowerCase().includes(token)) {
                        nlScore += weight;
                        reasons.naturalLanguageHits.push(`${label}「${term}」命中业务描述`);
                    }
                });
            });
        };
        const hitAnchors = (terms, weight, label) => {
            (Array.isArray(terms) ? terms : []).forEach(term => {
                this._tokenizeMixedText(term).forEach(token => {
                    if (anchorSet.has(token) || businessKey.toLowerCase().includes(token)) {
                        anchorScore += weight;
                        reasons.anchorHits.push(`${label}「${term}」命中实体/方法/页面锚点`);
                    }
                });
            });
        };

        hitNaturalLanguage(signals.businessTerms, 16, '业务语义');
        if (!quickNaturalLanguageMode) {
            hitNaturalLanguage(signals.analysisTerms, 12, '分析词');
            hitNaturalLanguage(signals.dataKeys, 10, '数据词');
            hitNaturalLanguage(signals.uiKeys, 8, 'UI意图');
            hitAnchors(signals.analysisTerms, 12, '分析词');
            hitAnchors(signals.assetTokens, 8, '资产词');
        }
        hitAnchors(signals.businessTerms, 10, '业务语义');

        (signals.operationKeys || []).forEach(op => {
            const methodHit = (block.availableMethods || []).some(method => this._methodOperation(method.name) === op || String(method.name || '').toLowerCase().includes(op));
            const roleHit = (block.anchors || []).some(anchor => String(anchor.role || '').toLowerCase().includes(op) || (op === 'query' && anchor.role === 'list'));
            if (methodHit || roleHit) {
                anchorScore += 10;
                reasons.anchorHits.push(`操作意图「${op}」命中已有方法或页面角色`);
            }
        });

        const consistencyCorpus = this._tokenizeMixedText([
            ...(Array.isArray(block.aliases) ? block.aliases : []),
            String(block.summary || ''),
            ...(Array.isArray(block.examplePhrases) ? block.examplePhrases : []),
            ...(Array.isArray(block.capabilityPhrases) ? block.capabilityPhrases : []),
            ...(Array.isArray(block.primaryEntities) ? block.primaryEntities : []),
            ...(Array.isArray(block.entities) ? block.entities.flatMap(item => [
                item && item.entityName || '',
                item && item.tableName || '',
                item && item.summary || '',
                ...((item && Array.isArray(item.fields) ? item.fields : []).flatMap(field => [field && field.fieldName || '', field && field.columnName || '', field && field.comment || '']))
            ]) : []),
            ...(Array.isArray(block.availableMethods) ? block.availableMethods.flatMap(item => [item && item.name || '', item && item.summary || '', item && item.signature || '']) : [])
        ].join(' '));
        const consistencyTerms = quickNaturalLanguageMode
            ? this._dedupe(signals.businessTerms || [])
            : this._dedupe([
                ...(signals.analysisTerms || []),
                ...(signals.businessTerms || [])
            ]);
        consistencyTerms.forEach(term => {
            this._tokenizeMixedText(term).forEach(token => {
                if (consistencyCorpus.includes(token)) {
                    consistencyScore += 4;
                    reasons.consistencyHits.push(`${quickNaturalLanguageMode ? '业务语义' : '分析语义'}「${term}」在实体字段/方法摘要中有证据`);
                }
            });
        });
        if ((block.availableMethods || []).length > 0 && (!quickNaturalLanguageMode || nlScore + anchorScore + consistencyScore > 0)) {
            consistencyScore += 4;
            reasons.consistencyHits.push('存在现成 Service/API 方法，可用于复用校正');
        }
        const targetAnchors = this._suggestTargets(block);
        if (quickNaturalLanguageMode && nlScore + anchorScore + consistencyScore <= 0) {
            return {
                businessKey,
                score: 0,
                confidence: 0,
                nlScore: 0,
                anchorScore: 0,
                consistencyScore: 0,
                matchedEvidence: [],
                candidateReasons: { naturalLanguageHits: [], anchorHits: [], consistencyHits: [] },
                suggestedTargets: targetAnchors,
                availableMethods: (block.availableMethods || []).slice(0, 12),
                serviceApis: (block.serviceApis || []).slice(0, 8),
                serviceImpls: (block.serviceImpls || []).slice(0, 8),
                entities: (block.entities || []).slice(0, 8),
                aliases: (block.aliases || []).slice(0, 8),
                summary: String(block.summary || ''),
                examplePhrases: (block.examplePhrases || []).slice(0, 6),
                capabilityPhrases: (block.capabilityPhrases || []).slice(0, 6),
                primaryActions: (block.primaryActions || []).slice(0, 8),
                primaryEntities: (block.primaryEntities || []).slice(0, 8),
                naturalLanguageConfidence: Number(block.naturalLanguageConfidence || 0),
                naturalLanguageEvidence: (block.naturalLanguageEvidence || []).slice(0, 6),
                reuseFirstPolicy: block.reuseFirstPolicy || { enabled: false },
                referenceOnly: true
            };
        }
        if (targetAnchors.length > 0) {
            anchorScore += Math.min(18, targetAnchors.length * 3);
            reasons.anchorHits.push(`命中 ${targetAnchors.length} 个可落地目标文件`);
        }
        nlScore = Math.min(40, nlScore);
        anchorScore = Math.min(35, anchorScore);
        consistencyScore = Math.min(25, consistencyScore);
        const score = Math.min(100, nlScore + anchorScore + consistencyScore);
        return {
            businessKey,
            score,
            confidence: Number((score / 100).toFixed(2)),
            nlScore,
            anchorScore,
            consistencyScore,
            matchedEvidence: this._dedupe([
                ...reasons.naturalLanguageHits,
                ...reasons.anchorHits,
                ...reasons.consistencyHits
            ]).slice(0, 10),
            candidateReasons: {
                naturalLanguageHits: this._dedupe(reasons.naturalLanguageHits).slice(0, 6),
                anchorHits: this._dedupe(reasons.anchorHits).slice(0, 6),
                consistencyHits: this._dedupe(reasons.consistencyHits).slice(0, 6)
            },
            suggestedTargets: targetAnchors,
            availableMethods: (block.availableMethods || []).slice(0, 12),
            serviceApis: (block.serviceApis || []).slice(0, 8),
            serviceImpls: (block.serviceImpls || []).slice(0, 8),
            entities: (block.entities || []).slice(0, 8),
            aliases: (block.aliases || []).slice(0, 8),
            summary: String(block.summary || ''),
            examplePhrases: (block.examplePhrases || []).slice(0, 6),
            capabilityPhrases: (block.capabilityPhrases || []).slice(0, 6),
            primaryActions: (block.primaryActions || []).slice(0, 8),
            primaryEntities: (block.primaryEntities || []).slice(0, 8),
            naturalLanguageConfidence: Number(block.naturalLanguageConfidence || 0),
            naturalLanguageEvidence: (block.naturalLanguageEvidence || []).slice(0, 6),
            reuseFirstPolicy: block.reuseFirstPolicy || { enabled: false },
            referenceOnly: score < 60
        };
    }

    _matchBusinessCandidateToEntities(candidate, entityNames = []) {
        const normalizedEntityNames = this._dedupe(entityNames || []);
        if (normalizedEntityNames.length === 0) return true;
        const candidateEntityNames = this._dedupe([
            ...(Array.isArray(candidate && candidate.primaryEntities) ? candidate.primaryEntities : []),
            ...(Array.isArray(candidate && candidate.entities) ? candidate.entities.map(item => item && item.entityName) : [])
        ]);
        if (candidateEntityNames.length === 0) return false;
        return candidateEntityNames.some(name => normalizedEntityNames.includes(String(name || '').trim()));
    }

    _scoreAsset(asset, signals) {
        const tokenSet = new Set([
            ...(Array.isArray(asset.assetTokens) ? asset.assetTokens : []),
            ...this._tokenizeMixedText(asset.title || ''),
            ...this._tokenizeMixedText(asset.summary || ''),
            String(asset.businessKey || '').toLowerCase()
        ]);
        const reasons = {
            naturalLanguageHits: [],
            anchorHits: []
        };
        let nlScore = 0;
        let anchorScore = 0;
        const quickNaturalLanguageMode = signals.semanticLaneMode === 'quick_natural_language';
        const hit = (terms, weight, label, bucket) => {
            (Array.isArray(terms) ? terms : []).forEach(term => {
                this._tokenizeMixedText(term).forEach(token => {
                    if (tokenSet.has(token) || String(asset.businessKey || '').toLowerCase().includes(token)) {
                        if (bucket === 'anchor') {
                            anchorScore += weight;
                            reasons.anchorHits.push(`${label}「${term}」命中资产锚点`);
                        } else {
                            nlScore += weight;
                            reasons.naturalLanguageHits.push(`${label}「${term}」命中资产描述`);
                        }
                    }
                });
            });
        };
        hit(signals.businessTerms, 12, '业务语义', 'nl');
        if (!quickNaturalLanguageMode) {
            hit(signals.analysisTerms, 10, '分析词', 'nl');
            hit(signals.assetTokens, 10, '资产词', 'anchor');
            hit(signals.dataKeys, 8, '数据词', 'anchor');
            hit(signals.operationKeys, 6, '操作词', 'anchor');
        }
        nlScore = Math.min(40, nlScore);
        anchorScore = Math.min(35, anchorScore);
        const score = Math.min(100, nlScore + anchorScore);
        return {
            assetId: asset.assetId || '',
            assetType: asset.assetType || '',
            businessKey: asset.businessKey || '',
            title: asset.title || '',
            summary: asset.summary || '',
            sourcePath: asset.sourcePath || '',
            score,
            nlScore,
            anchorScore,
            matchedEvidence: this._dedupe([
                ...reasons.naturalLanguageHits,
                ...reasons.anchorHits
            ]).slice(0, 6),
            candidateReasons: {
                naturalLanguageHits: this._dedupe(reasons.naturalLanguageHits).slice(0, 4),
                anchorHits: this._dedupe(reasons.anchorHits).slice(0, 4)
            }
        };
    }

    _suggestTargets(block) {
        const order = { Action: 1, Rest: 2, ServiceApi: 3, ServiceImpl: 4, Entity: 5, HtmlPage: 6, Js: 7, Css: 8 };
        return (block.anchors || [])
            .filter(anchor => ['Action', 'Rest', 'ServiceApi', 'ServiceImpl', 'Entity', 'HtmlPage', 'Js', 'Css'].includes(anchor.kind))
            .sort((a, b) => (order[a.kind] || 99) - (order[b.kind] || 99) || String(a.path).localeCompare(String(b.path)))
            .slice(0, 12)
            .map(anchor => ({ kind: anchor.kind, role: anchor.role || '', path: anchor.path }));
    }

    _normalizeSignals(intentSignals = {}) {
        const semanticLaneMode = String(intentSignals && intentSignals.semanticLaneMode || '').trim();
        const quickNaturalLanguageMode = semanticLaneMode === 'quick_natural_language';
        const expandSignalTokens = items => this._dedupe((Array.isArray(items) ? items : [])
            .filter(item => !this._isSyntheticSystemSignalTerm(item))
            .flatMap(item => this._tokenizeMixedText(item))
            .filter(token => !this._isGenericSignalToken(token) && !this._isSyntheticSystemSignalTerm(token)));
        return {
            semanticLaneMode,
            businessTerms: expandSignalTokens([...(intentSignals.businessTerms || []), ...(intentSignals.dataKeys || [])]),
            scopeTerms: this._dedupe(intentSignals.scopeTerms || []),
            systemTerms: this._dedupe(intentSignals.systemTerms || []),
            analysisTerms: quickNaturalLanguageMode ? [] : expandSignalTokens(intentSignals.analysisTerms || []),
            featureKeys: this._dedupe(intentSignals.featureKeys || []),
            operationKeys: this._dedupe(intentSignals.operationKeys || []),
            uiKeys: this._dedupe(intentSignals.uiKeys || []),
            dataKeys: this._dedupe(intentSignals.dataKeys || []),
            ruleTerms: this._dedupe(intentSignals.ruleTerms || []),
            assetTokens: quickNaturalLanguageMode ? expandSignalTokens(intentSignals.businessTerms || []) : expandSignalTokens([
                ...(intentSignals.assetTokens || []),
                ...(intentSignals.businessTerms || []),
                ...(intentSignals.analysisTerms || []),
                ...(intentSignals.dataKeys || [])
            ])
        };
    }

    _isSyntheticSystemSignalTerm(value = '') {
        const normalized = String(value || '')
            .trim()
            .toLowerCase()
            .replace(/\s+/g, '')
            .replace(/[／\\]+/g, '/');
        if (!normalized) return false;
        return /^(项目历史api\/资产复用|项目历史api资产复用|接口\/api复用|接口api复用|api复用|项目资产复用|现成接口资产|历史接口|现成服务)$/.test(normalized);
    }

    _isGenericSignalToken(value = '') {
        const normalized = String(value || '').trim().toLowerCase();
        if (!normalized) return true;
        if (this._isSyntheticSystemSignalTerm(normalized)) return true;
        return /^(接口|api|接口api|service|服务|实体|实体类|domain|model|pojo|vo|dto|页面|前端|html|js|css|action|controller|rest|功能|需求|开发|实现|新增|增加|修改|调整|支持|只要|仅要|只需|仅需|需要|不需要|包含|包括|选项|两个|一个|一套|评分功能)$/.test(normalized);
    }

    _tokenizeMixedText(value) {
        const raw = String(value || '');
        const text = raw.toLowerCase();
        const ascii = [...text.matchAll(/[a-z0-9]{2,}/g)].map(item => item[0]);
        const chineseSegments = [...raw.matchAll(/[\u4e00-\u9fa5]{2,16}/g)].map(item => item[0]);
        const chinese = [];
        chineseSegments.forEach(segment => {
            chinese.push(segment);
            const maxWindow = Math.min(6, segment.length);
            for (let size = 2; size <= maxWindow; size += 1) {
                for (let index = 0; index + size <= segment.length; index += 1) {
                    chinese.push(segment.slice(index, index + size));
                }
            }
        });
        return this._dedupe([...ascii, ...chinese]).filter(item => item.length >= 2);
    }

    _normalizeComparablePath(value = '', projectPath = '') {
        let raw = String(value || '').replace(/\\/g, '/').trim();
        const root = String(projectPath || '').replace(/\\/g, '/').replace(/\/+$/, '');
        if (root && raw.toLowerCase().startsWith(root.toLowerCase())) raw = raw.slice(root.length).replace(/^\/+/, '');
        return raw.toLowerCase();
    }

    _dedupe(items) {
        return [...new Set((Array.isArray(items) ? items : []).map(item => String(item || '').trim()).filter(Boolean))];
    }

    _plannedFeedbackKey(item = {}) {
        const need = String(item.currentNeed || '').trim();
        const keys = this._dedupe(item.businessKeys || []).join('|');
        return `${need}::${keys}`;
    }
}

module.exports = BusinessGraphService;
