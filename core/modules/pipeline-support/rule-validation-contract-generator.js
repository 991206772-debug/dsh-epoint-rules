/* eslint-disable */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const RuleValidationContract = require('../rule-validation-contract');

class RuleValidationContractGenerator {
    constructor(pipeline) {
        this.pipeline = pipeline || null;
    }

    buildForStage(options = {}) {
        const artifactFolder = String(options.artifactFolder || '').trim();
        const projectPath = String(options.projectPath || '').trim();
        const currentStep = options.currentStep || {};
        const stageKey = this._normalizeContractStageKey(options.stageKey || currentStep.type || 'design');
    const profileName = String(options.profileName || currentStep.profile || 'expert').trim() || 'expert';
        const outputPath = String(options.outputPath || path.join(artifactFolder, '.pipeline', 'ai-validation-contract.json')).trim();
        const generatedDir = String(options.generatedDir || path.join(artifactFolder, '.pipeline', 'generated-rule-contracts')).trim();
        const ruleNames = this._collectRuleNames(options);
        const entries = ruleNames.map(ruleName => this._loadRule(ruleName, projectPath)).filter(item => item.content);
        const ruleContracts = entries.map(entry => this.generateFromRule({
            ruleName: entry.ruleName,
            sourcePath: entry.sourcePath,
            content: entry.content,
            generatedDir
        }));
        const payload = this.mergeContracts({
            ruleContracts,
            profileName,
            stageKey,
            artifactFolder,
            projectPath,
            currentStep,
            explicitDesignContract: options.authoringPayload || options.authoringContract || null
        });
        payload.outputPath = outputPath;
        if (outputPath) this._writeJson(outputPath, payload);
        return payload;
    }

    generateFromRule(options = {}) {
        const ruleName = String(options.ruleName || '').trim() || '未命名规则';
        const sourcePath = String(options.sourcePath || '').trim();
        const content = String(options.content || '');
        const metadata = this._extractFrontMatter(content);
        const explicit = RuleValidationContract.parseValidationContract(content);
        if (explicit.ok) {
            return {
                ruleName,
                ruleAlias: metadata.rule_alias || metadata.ruleAlias || ruleName,
                sourcePath,
                sourceType: 'explicit_ai_validation_contract',
                contractStatus: 'active',
                explicit: true,
                contract: explicit.contract,
                rawYaml: explicit.rawYaml || '',
                evidence: [{
                    kind: 'explicit_contract',
                    sourceRule: ruleName,
                    sourcePath,
                    heading: 'AI Validation Contract',
                    matchPattern: 'fenced yaml'
                }]
            };
        }

        const generated = this._generateImplicitContract({ ruleName, sourcePath, content, metadata });
        const outputPath = this._writeGeneratedRuleContract(options.generatedDir, ruleName, generated);
        return { ...generated, outputPath };
    }

    mergeContracts(options = {}) {
        const ruleContracts = Array.isArray(options.ruleContracts) ? options.ruleContracts : [];
        const stageKey = this._normalizeContractStageKey(options.stageKey || 'design');
        const profileName = String(options.profileName || 'expert').trim() || 'expert';
        const explicitDesignContract = options.explicitDesignContract && options.explicitDesignContract.payload && typeof options.explicitDesignContract.payload === 'object'
            ? options.explicitDesignContract.payload
            : (options.explicitDesignContract && typeof options.explicitDesignContract === 'object' ? options.explicitDesignContract : {});
        const selectedKinds = this._selectedFileKinds(explicitDesignContract);
        const scopeGate = explicitDesignContract.scopeGate && typeof explicitDesignContract.scopeGate === 'object'
            ? explicitDesignContract.scopeGate
            : null;
        const technicalProjection = explicitDesignContract.technicalProjection && typeof explicitDesignContract.technicalProjection === 'object'
            ? explicitDesignContract.technicalProjection
            : null;
        const restOperationScope = explicitDesignContract.restOperationScope && typeof explicitDesignContract.restOperationScope === 'object'
            ? explicitDesignContract.restOperationScope
            : null;
        const entitySelection = explicitDesignContract.entitySelection && typeof explicitDesignContract.entitySelection === 'object'
            ? explicitDesignContract.entitySelection
            : null;
        const sectionEntries = [];
        const namingContracts = [];
        const ruleObligations = [];
        const generatedContracts = [];
        const explicitContracts = [];
        const debt = [];
        const conflicts = [];

        const pushSectionEntry = (entry = {}, source = {}) => {
            const normalized = this._normalizeSectionRequirement(entry, source);
            if (!normalized.code || !normalized.label) return;
            if (!this._entryAppliesToSelectedKinds(normalized, selectedKinds)) return;
            const key = `${normalized.code}::${normalized.label}`;
            const existing = sectionEntries.find(item => `${item.code}::${item.label}` === key);
            if (existing) {
                if (existing.sourceType !== normalized.sourceType) {
                    conflicts.push({
                        code: 'AI_VALIDATION_CONTRACT_DUPLICATE_REQUIREMENT',
                        requirementCode: normalized.code,
                        keptSource: existing.sourceRule,
                        ignoredSource: normalized.sourceRule
                    });
                }
                return;
            }
            sectionEntries.push(normalized);
        };

        ruleContracts.forEach(ruleContract => {
            if (!ruleContract) return;
            if (ruleContract.explicit) {
                explicitContracts.push(this._summarizeRuleContract(ruleContract));
                this._extractSectionRequirementsFromExplicitContract(ruleContract.contract, { profileName, stageKey })
                    .forEach(entry => pushSectionEntry(entry, {
                        ruleName: ruleContract.ruleName,
                        sourcePath: ruleContract.sourcePath,
                        sourceType: 'explicit',
                        evidence: ruleContract.evidence
                    }));
                return;
            }

            generatedContracts.push(this._summarizeRuleContract(ruleContract));
            if (ruleContract.contractStatus === 'active') {
                (Array.isArray(ruleContract.sectionRequirements) ? ruleContract.sectionRequirements : [])
                    .forEach(entry => pushSectionEntry(entry, {
                        ruleName: ruleContract.ruleName,
                        sourcePath: ruleContract.sourcePath,
                        sourceType: 'generated',
                        evidence: entry.evidence || ruleContract.evidence
                    }));
                namingContracts.push(...(Array.isArray(ruleContract.namingContracts) ? ruleContract.namingContracts : []));
            }
            ruleObligations.push(...(Array.isArray(ruleContract.ruleObligations) ? ruleContract.ruleObligations : []));
            if (ruleContract.contractStatus === 'blocked') {
                debt.push({
                    ruleName: ruleContract.ruleName,
                    sourcePath: ruleContract.sourcePath,
                    reason: ruleContract.blockedReason || '规则缺少可确定性编译的合同证据'
                });
            }
        });

        return {
            version: 1,
            generatedAt: new Date().toISOString(),
            source: 'RuleValidationContractGenerator',
            projectPath: String(options.projectPath || '').trim(),
            artifactFolder: String(options.artifactFolder || '').trim(),
            profileName,
            stageKey,
            selectedFileKinds: selectedKinds,
            ...(scopeGate ? { scopeGate } : {}),
            ...(technicalProjection ? { technicalProjection } : {}),
            ...(restOperationScope ? { restOperationScope } : {}),
            ...(entitySelection ? { entitySelection } : {}),
            explicitContracts,
            generatedContracts,
            sectionRequirements: {
                status: sectionEntries.length > 0 ? 'ready' : 'empty',
                source: 'explicit AI Validation Contract + generated active contracts',
                entries: sectionEntries
            },
            namingContracts,
            ruleObligations,
            debt,
            conflicts
        };
    }

    _generateImplicitContract({ ruleName, sourcePath, content, metadata }) {
        const templateEvidence = this._extractTemplateEvidence(content, ruleName, sourcePath);
        const directiveEvidence = this._extractDirectiveEvidence(content, ruleName, sourcePath);
        const tableRequirements = this._extractTableSectionRequirements(content, ruleName, sourcePath);
        const jsonRequirements = this._extractJsonSectionRequirements(content, ruleName, sourcePath);
        const namingContracts = templateEvidence
            .filter(item => item.templateStatus === 'active')
            .map(item => ({
                fileKind: item.fileKind,
                fileNamePattern: item.fileNamePattern,
                sourceRule: ruleName,
                sourcePath,
                contractStatus: 'active',
                evidence: item.evidence
            }));
        const sectionRequirements = [...tableRequirements, ...jsonRequirements];
        const activeEvidence = [...namingContracts, ...sectionRequirements].filter(item => item.evidence);
        const ruleObligations = directiveEvidence.map(item => ({
            ruleName,
            sourcePath,
            contractStatus: item.strong ? 'active' : 'draft',
            type: item.type,
            text: item.text,
            evidence: item.evidence
        }));
        const hasActive = activeEvidence.length > 0;
        const hasDraft = ruleObligations.length > 0 || templateEvidence.some(item => item.templateStatus === 'draft');
        const contractStatus = hasActive ? 'active' : (hasDraft ? 'draft' : 'blocked');
        return {
            ruleName,
            ruleAlias: metadata.rule_alias || metadata.ruleAlias || ruleName,
            category: metadata.category || '',
            sourcePath,
            sourceType: 'generated_ai_validation_contract',
            explicit: false,
            contractStatus,
            blockedReason: contractStatus === 'blocked' ? '未发现占位符模板、结构化表格、JSON 请求响应或明确必须/禁止语句' : '',
            namingContracts,
            sectionRequirements,
            ruleObligations,
            draftEvidence: templateEvidence.filter(item => item.templateStatus === 'draft'),
            evidence: [
                ...templateEvidence.map(item => item.evidence),
                ...directiveEvidence.map(item => item.evidence),
                ...sectionRequirements.map(item => item.evidence)
            ].filter(Boolean)
        };
    }

    _extractTemplateEvidence(content = '', ruleName = '', sourcePath = '') {
        const evidence = [];
        const lines = String(content || '').split(/\r?\n/);
        const seen = new Set();
        const pushPattern = (pattern, lineNumber, heading = '', matchPattern = 'template_pattern') => {
            const text = String(pattern || '').trim();
            if (!text || seen.has(text)) return;
            seen.add(text);
            const hasPlaceholder = /\{[^{}\s]+\}/.test(text);
            const fileKind = this._inferFileKindFromPattern(text);
            if (!fileKind) return;
            evidence.push({
                fileKind,
                fileNamePattern: path.basename(text.replace(/\\/g, '/')),
                rawPattern: text,
                templateStatus: hasPlaceholder ? 'active' : 'draft',
                evidence: {
                    sourceRule: ruleName,
                    sourcePath,
                    line: lineNumber,
                    heading,
                    matchedText: text,
                    matchPattern
                }
            });
        };
        let activeHeading = '';
        lines.forEach((line, index) => {
            const headingMatch = /^#{1,6}\s+(.+)$/.exec(String(line || '').trim());
            if (headingMatch) activeHeading = headingMatch[1].trim();
            const backtickMatches = [...String(line || '').matchAll(/`([^`]+\.(?:java|html|js|css|sql))`/ig)];
            backtickMatches.forEach(match => pushPattern(match[1], index + 1, activeHeading, 'backtick_file_template'));
            const rawMatches = [...String(line || '').matchAll(/(?:[\w./\\{}-]+(?:Gxh|gxh|I)?[\w{}-]*\.(?:java|html|js|css|sql))/ig)];
            rawMatches.forEach(match => pushPattern(match[1], index + 1, activeHeading, 'inline_file_template'));
        });
        return evidence.slice(0, 80);
    }

    _extractDirectiveEvidence(content = '', ruleName = '', sourcePath = '') {
        const lines = String(content || '').split(/\r?\n/);
        const result = [];
        let activeHeading = '';
        lines.forEach((line, index) => {
            const raw = String(line || '');
            const trimmed = raw.trim();
            const headingMatch = /^#{1,6}\s+(.+)$/.exec(trimmed);
            if (headingMatch) {
                activeHeading = headingMatch[1].trim();
                return;
            }
            if (!/(必须|禁止|严禁|不得|统一|只能|优先)/u.test(trimmed)) return;
            if (trimmed.length > 220) return;
            const type = /(禁止|严禁|不得)/u.test(trimmed) ? 'forbidden' : 'required';
            result.push({
                type,
                strong: /(必须|禁止|严禁|不得|只能)/u.test(trimmed),
                text: trimmed.replace(/^[-*>!\s]+/, ''),
                evidence: {
                    sourceRule: ruleName,
                    sourcePath,
                    line: index + 1,
                    heading: activeHeading,
                    matchedText: trimmed,
                    matchPattern: 'directive_keywords'
                }
            });
        });
        return result.slice(0, 60);
    }

    _extractTableSectionRequirements(content = '', ruleName = '', sourcePath = '') {
        const lines = String(content || '').split(/\r?\n/);
        const result = [];
        let activeHeading = '';
        let tableStart = 0;
        let buffer = [];
        const flush = endLine => {
            if (buffer.length < 2) {
                buffer = [];
                return;
            }
            const requirement = this._tableToRequirement(buffer, activeHeading, ruleName, sourcePath, tableStart, endLine);
            if (requirement) result.push(requirement);
            buffer = [];
        };
        lines.forEach((line, index) => {
            const trimmed = String(line || '').trim();
            const headingMatch = /^#{1,6}\s+(.+)$/.exec(trimmed);
            if (headingMatch) {
                flush(index);
                activeHeading = headingMatch[1].trim();
                return;
            }
            if (/^\|.*\|$/.test(trimmed)) {
                if (buffer.length === 0) tableStart = index + 1;
                buffer.push(trimmed);
                return;
            }
            flush(index);
        });
        flush(lines.length);
        return result;
    }

    _tableToRequirement(rows = [], heading = '', ruleName = '', sourcePath = '', startLine = 0, endLine = 0) {
        const headingText = String(heading || '');
        if (!/(公共字段|基础字段|表结构|接口格式|请求格式|响应格式)/u.test(headingText)) return null;
        if (!/(必须|规范|格式|字段|结构|接口|请求|响应)/u.test(headingText) && !rows.some(row => /(必须|禁止|严禁|不得|字段|节点|格式|结构)/u.test(row))) {
            return null;
        }
        const cells = rows
            .filter(row => !/^\|\s*-+/.test(row))
            .slice(1)
            .flatMap(row => row.split('|').map(cell => cell.trim()).filter(Boolean));
        const candidates = [...new Set(cells
            .map(cell => cell.replace(/`/g, '').trim())
            .filter(cell => /^[A-Za-z_][A-Za-z0-9_]*$/.test(cell))
            .filter(cell => !['VARCHAR', 'DATETIME', 'INT', 'TEXT', 'JSON'].includes(cell.toUpperCase())))];
        if (candidates.length === 0) return null;
        const code = /公共字段/u.test(headingText)
            ? 'GENERATED_DB_COMMON_FIELDS_REQUIRED'
            : (/基础字段|表结构/u.test(headingText) ? 'GENERATED_DB_BASE_FIELDS_REQUIRED' : 'GENERATED_SECTION_FIELDS_REQUIRED');
        return {
            code,
            label: headingText.replace(/\s*\(.+?\)\s*/g, '').trim(),
            type: 'document_mentions',
            sectionKeywords: [headingText, headingText.replace(/^\d+(?:\.\d+)?\s*/, '')].filter(Boolean),
            applyWhenFileKinds: /接口|请求|响应|REST/i.test(headingText) ? ['Rest'] : ['Entity', 'Sql'],
            requiredMentions: candidates.map(item => ({ label: item, candidates: [item], preferredExample: item })),
            requireTableLike: /字段|表结构/u.test(headingText),
            sourceType: 'generated',
            contractStatus: 'active',
            evidence: {
                sourceRule: ruleName,
                sourcePath,
                line: startLine,
                endLine,
                heading: headingText,
                matchedText: rows.join('\n').slice(0, 800),
                matchPattern: 'markdown_table_under_required_heading'
            }
        };
    }

    _extractJsonSectionRequirements(content = '', ruleName = '', sourcePath = '') {
        const blocks = this._extractFencedBlocks(content)
            .filter(block => ['json', 'javascript', 'js'].includes(String(block.language || '').toLowerCase()));
        const parsedBlocks = blocks
            .map(block => ({ block, value: this._parseJsonBlock(block.content) }))
            .filter(item => item.value !== null);
        if (parsedBlocks.length === 0) return [];
        const mentions = this._collectJsonMentions(parsedBlocks.map(item => item.value));
        if (mentions.length < 2) return [];
        const first = parsedBlocks[0].block || {};
        const joined = parsedBlocks.map(item => item.block.content).join('\n');
        const contextText = `${ruleName}\n${blocks.map(block => block.heading || '').join('\n')}\n${content}`;
        const heading = String(first.heading || '').trim();
        const label = heading || 'JSON 格式规范';
        const sectionKeywords = [...new Set([
            heading,
            heading.replace(/^\d+(?:\.\d+)?\s*/, ''),
            'JSON 格式规范'
        ].filter(Boolean))];
        const isRestLike = /(REST|接口|请求|响应|Controller|Action)/i.test(contextText);
        return [{
            code: isRestLike ? 'GENERATED_REST_JSON_FORMAT_REQUIRED' : 'GENERATED_JSON_FORMAT_REQUIRED',
            label,
            type: 'document_mentions',
            sectionKeywords,
            applyWhenFileKinds: isRestLike ? ['Rest'] : [],
            requiredMentions: mentions,
            requireTableLike: false,
            sourceType: 'generated',
            contractStatus: 'active',
            evidence: {
                sourceRule: ruleName,
                sourcePath,
                line: first.startLine || 0,
                heading,
                matchedText: joined.slice(0, 800),
                matchPattern: 'parseable_json_fenced_block'
            }
        }];
    }

    _parseJsonBlock(content = '') {
        const raw = String(content || '').trim();
        if (!raw) return null;
        const candidates = [raw];
        const firstObject = raw.indexOf('{');
        const lastObject = raw.lastIndexOf('}');
        if (firstObject >= 0 && lastObject > firstObject) candidates.push(raw.slice(firstObject, lastObject + 1));
        const firstArray = raw.indexOf('[');
        const lastArray = raw.lastIndexOf(']');
        if (firstArray >= 0 && lastArray > firstArray) candidates.push(raw.slice(firstArray, lastArray + 1));
        for (const candidate of candidates) {
            try {
                return JSON.parse(candidate);
            } catch (_) { }
        }
        return null;
    }

    _collectJsonMentions(values = []) {
        const mentions = [];
        const seen = new Set();
        const add = (label, candidates, preferredExample = '') => {
            const cleaned = [...new Set((Array.isArray(candidates) ? candidates : [])
                .map(item => String(item || '').trim())
                .filter(Boolean))];
            if (!label || cleaned.length === 0) return;
            const key = `${label}::${cleaned.join('|')}`;
            if (seen.has(key)) return;
            seen.add(key);
            mentions.push({ label, candidates: cleaned, preferredExample: preferredExample || cleaned[0] });
        };
        const walk = (value, pathParts = []) => {
            if (Array.isArray(value)) {
                if (pathParts.length > 0) {
                    const pathText = pathParts.join('.');
                    const key = pathParts[pathParts.length - 1];
                    add(`JSON 节点 ${pathText}`, [key, pathText, `"${key}"`], key);
                }
                value.slice(0, 3).forEach(item => walk(item, pathParts));
                return;
            }
            if (value && typeof value === 'object') {
                Object.keys(value).forEach(key => {
                    const nextPath = [...pathParts, key];
                    const pathText = nextPath.join('.');
                    add(`JSON 节点 ${pathText}`, [key, pathText, `"${key}"`], key);
                    walk(value[key], nextPath);
                });
                return;
            }
            if (pathParts.length === 0) return;
            const key = pathParts[pathParts.length - 1];
            const pathText = pathParts.join('.');
            const rendered = JSON.stringify(value);
            if (rendered === undefined) return;
            add(`JSON 值 ${pathText}=${String(value)}`, [
                `${pathText}=${String(value)}`,
                `"${key}": ${rendered}`,
                `${key}: ${String(value)}`
            ], `${pathText}=${String(value)}`);
        };
        values.forEach(value => walk(value, []));
        return mentions.slice(0, 80);
    }

    _extractFencedBlocks(content = '') {
        const lines = String(content || '').split(/\r?\n/);
        const blocks = [];
        let heading = '';
        let inFence = false;
        let language = '';
        let startLine = 0;
        let buffer = [];
        lines.forEach((line, index) => {
            const trimmed = String(line || '').trim();
            const headingMatch = /^#{1,6}\s+(.+)$/.exec(trimmed);
            if (!inFence && headingMatch) heading = headingMatch[1].trim();
            const fenceMatch = /^```\s*([A-Za-z0-9_-]*)\s*$/.exec(trimmed);
            if (fenceMatch && !inFence) {
                inFence = true;
                language = String(fenceMatch[1] || '').trim();
                startLine = index + 1;
                buffer = [];
                return;
            }
            if (fenceMatch && inFence) {
                blocks.push({ language, heading, startLine, content: buffer.join('\n') });
                inFence = false;
                language = '';
                startLine = 0;
                buffer = [];
                return;
            }
            if (inFence) buffer.push(line);
        });
        return blocks;
    }

    _extractSectionRequirementsFromExplicitContract(contract = {}, options = {}) {
        const stageKey = this._normalizeContractStageKey(options.stageKey || 'design');
        const profileName = String(options.profileName || 'expert').trim() || 'expert';
        const profileContract = RuleValidationContract.resolveContractProfile(contract, profileName);
        const candidates = [
            RuleValidationContract.resolveStageContract(contract, profileName, stageKey),
            profileContract && profileContract[stageKey],
            profileContract && profileContract.design,
            contract && contract.design,
            contract
        ].filter(item => item && typeof item === 'object' && !Array.isArray(item));
        const entries = [];
        candidates.forEach(candidate => {
            const source = candidate.designContract && typeof candidate.designContract === 'object'
                ? candidate.designContract
                : candidate;
            const list = source.section_requirements || source.sectionRequirements;
            if (Array.isArray(list)) entries.push(...list);
        });
        return entries;
    }

    _normalizeSectionRequirement(entry = {}, source = {}) {
        const record = entry && typeof entry === 'object' ? entry : {};
        const requiredMentions = Array.isArray(record.requiredMentions)
            ? record.requiredMentions
            : (Array.isArray(record.required_mentions) ? record.required_mentions : []);
        return {
            code: String(record.code || '').trim(),
            label: String(record.label || '').trim(),
            type: String(record.type || 'document_mentions').trim(),
            sectionKeywords: this._textArray(record.sectionKeywords || record.section_keywords),
            applyWhenFileKinds: this._textArray(record.applyWhenFileKinds || record.apply_when_file_kinds || record.fileKinds || record.file_kinds),
            requiredMentions: requiredMentions.map(item => this._normalizeMention(item)).filter(item => item.label || item.candidates.length > 0),
            requireTableLike: record.requireTableLike === true || record.require_table_like === true,
            contractStatus: record.contractStatus || 'active',
            sourceType: source.sourceType || record.sourceType || 'explicit',
            sourceRule: source.ruleName || record.sourceRule || '',
            sourcePath: source.sourcePath || record.sourcePath || '',
            evidence: record.evidence || source.evidence || null
        };
    }

    _normalizeMention(item = {}) {
        if (typeof item === 'string') return { label: item, candidates: [item], preferredExample: item };
        const record = item && typeof item === 'object' ? item : {};
        const label = String(record.label || record.name || '').trim();
        const candidates = [
            ...(Array.isArray(record.candidates) ? record.candidates : []),
            ...(Array.isArray(record.acceptableExamples) ? record.acceptableExamples : []),
            ...(Array.isArray(record.acceptable_examples) ? record.acceptable_examples : []),
            label
        ].map(value => String(value || '').trim()).filter(Boolean);
        return { label, candidates: [...new Set(candidates)], preferredExample: record.preferredExample || candidates[0] || label };
    }

    _entryAppliesToSelectedKinds(entry = {}, selectedKinds = []) {
        const applies = this._textArray(entry.applyWhenFileKinds).map(item => this._normalizeFileKind(item));
        if (applies.length === 0) return true;
        const selected = new Set((Array.isArray(selectedKinds) ? selectedKinds : []).map(item => this._normalizeFileKind(item)).filter(Boolean));
        if (selected.size === 0) return true;
        return applies.some(kind => selected.has(kind));
    }

    _selectedFileKinds(explicitDesignContract = {}) {
        const source = explicitDesignContract && explicitDesignContract.payload && typeof explicitDesignContract.payload === 'object'
            ? explicitDesignContract.payload
            : explicitDesignContract;
        const authoringKinds = Array.isArray(source && source.allowedFileKinds) ? source.allowedFileKinds : [];
        return [...new Set(authoringKinds.map(item => this._normalizeFileKind(item)).filter(Boolean))];
    }

    _collectRuleNames(options = {}) {
        const names = [];
        const push = value => {
            if (!value) return;
            if (typeof value === 'string') {
                const text = value.trim();
                if (text) names.push(text);
                return;
            }
            if (typeof value === 'object') {
                push(value.ruleName || value.ruleAlias || value.name || value.rule || value.id);
            }
        };
        const inputPack = options.stageInputPack || {};
        (Array.isArray(inputPack.currentRules) ? inputPack.currentRules : []).forEach(push);
        (Array.isArray(inputPack.inheritedRuleObligations) ? inputPack.inheritedRuleObligations : []).forEach(push);
        return [...new Set(names.map(name => String(name || '').trim()).filter(Boolean))];
    }

    _loadRule(ruleName = '', projectPath = '') {
        const name = String(ruleName || '').trim();
        if (!name) return { ruleName: '', sourcePath: '', content: '' };
        let sourcePath = '';
        if (this.pipeline && this.pipeline.ruleService && typeof this.pipeline.ruleService.resolveRule === 'function') {
            try {
                const resolved = this.pipeline.ruleService.resolveRule(name, { projectPath });
                if (resolved && resolved.path) sourcePath = resolved.path;
            } catch (_) { }
        }
        if (sourcePath && fs.existsSync(sourcePath) && fs.statSync(sourcePath).isFile()) {
            return { ruleName: name, sourcePath, content: fs.readFileSync(sourcePath, 'utf-8') };
        }
        if (this.pipeline && this.pipeline.ruleService && typeof this.pipeline.ruleService.getRuleContent === 'function') {
            try {
                return { ruleName: name, sourcePath, content: this.pipeline.ruleService.getRuleContent(name) || '' };
            } catch (_) { }
        }
        return { ruleName: name, sourcePath, content: '' };
    }

    _inferFileKindFromPattern(pattern = '') {
        const text = String(pattern || '').replace(/\\/g, '/');
        const base = path.basename(text).toLowerCase();
        if (base.endsWith('.html')) return 'HtmlPage';
        if (base.endsWith('.js')) return 'Js';
        if (base.endsWith('.css')) return 'Css';
        if (base.endsWith('.sql')) return 'Sql';
        if (!base.endsWith('.java')) return '';
        if (/restcontroller/i.test(text) || /\/rest\//i.test(text)) return 'Rest';
        if (/action/i.test(text) || /\/action\//i.test(text)) return 'Action';
        if (/serviceimpl/i.test(text)) return 'ServiceImpl';
        if (/IGxh|I\{/.test(text) || /\/api\/(?!entity)/i.test(text)) return 'ServiceApi';
        if (/\/impl\//i.test(text) && /service/i.test(text)) return 'ServiceInternal';
        if (/entity/i.test(text)) return 'Entity';
        return 'Java';
    }

    _normalizeFileKind(value = '') {
        const raw = String(value || '').trim();
        if (!raw) return '';
        if (this.pipeline && typeof this.pipeline._normalizeDesignFileType === 'function') {
            return this.pipeline._normalizeDesignFileType(raw) || raw;
        }
        return raw;
    }

    _extractFrontMatter(content = '') {
        const text = String(content || '').replace(/^\uFEFF/, '');
        if (!text.startsWith('---')) return {};
        const endIndex = text.indexOf('\n---', 3);
        if (endIndex === -1) return {};
        const frontMatter = text.slice(3, endIndex).split(/\r?\n/);
        const metadata = {};
        frontMatter.forEach(line => {
            const match = /^([A-Za-z0-9_-]+)\s*:\s*(.*?)\s*$/.exec(String(line || ''));
            if (match) metadata[match[1]] = match[2].replace(/^['"]|['"]$/g, '').trim();
        });
        return metadata;
    }

    _normalizeContractStageKey(stageKey = '') {
        const raw = String(stageKey || '').trim();
        if (/design/u.test(raw)) return 'design';
        if (/code/u.test(raw)) return 'code';
        if (/review/u.test(raw)) return 'review';
        if (/requirement/u.test(raw)) return 'requirement_spec';
        return raw || 'design';
    }

    _textArray(value = []) {
        if (!Array.isArray(value)) return value ? [String(value).trim()].filter(Boolean) : [];
        return value.map(item => String(item || '').trim()).filter(Boolean);
    }

    _summarizeRuleContract(ruleContract = {}) {
        return {
            ruleName: ruleContract.ruleName || '',
            ruleAlias: ruleContract.ruleAlias || '',
            sourcePath: ruleContract.sourcePath || '',
            sourceType: ruleContract.sourceType || '',
            contractStatus: ruleContract.contractStatus || '',
            explicit: ruleContract.explicit === true,
            outputPath: ruleContract.outputPath || '',
            evidenceCount: Array.isArray(ruleContract.evidence) ? ruleContract.evidence.length : 0
        };
    }

    _writeGeneratedRuleContract(generatedDir = '', ruleName = '', payload = {}) {
        const dir = String(generatedDir || '').trim();
        if (!dir) return '';
        const fileName = `${this._safeFileName(ruleName)}.${this._hashText(ruleName).slice(0, 8)}.json`;
        const outputPath = path.join(dir, fileName);
        this._writeJson(outputPath, payload);
        return outputPath;
    }

    _safeFileName(value = '') {
        return String(value || 'rule').replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').replace(/\s+/g, '_').slice(0, 80) || 'rule';
    }

    _hashText(value = '') {
        return crypto.createHash('sha256').update(String(value || '')).digest('hex');
    }

    _writeJson(filePath = '', payload = {}) {
        if (!filePath) return '';
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf-8');
        return filePath;
    }
}

module.exports = RuleValidationContractGenerator;
