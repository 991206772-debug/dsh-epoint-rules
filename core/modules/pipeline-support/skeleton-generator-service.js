/* eslint-disable */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const GateContractRegistry = require('./gate-contract-registry');

class SkeletonGeneratorService {
    constructor(options = {}) {
        this.pythonCommand = options.pythonCommand || 'python';
        this.scriptPath = this.resolveScriptPath(options.scriptPath);
        this.ruleService = options.ruleService || null;
        this.rulesPath = options.rulesPath || '';
    }

    resolveScriptPath(explicitPath = '') {
        const scriptName = path.join('skeleton_generator', 'run_skeleton_generator.py');
        const candidates = [
            explicitPath,
            path.join(__dirname, '..', '..', scriptName),
            path.join(__dirname, '..', 'mcp_tools', scriptName),
            path.join(process.cwd(), 'mcp_tools', scriptName)
        ].map(item => String(item || '').trim()).filter(Boolean);
        return candidates.find(item => fs.existsSync(item)) || candidates[candidates.length - 1];
    }

    /**
     * Strict materialize entry point for the design_tdd skeleton Builder.
     * Calls Python's run_strict_materialize with --strict flag.
     */
    strictMaterialize(options = {}) {
        const projectPath = String(options.projectPath || '').trim();
        const targetFile = String(options.targetFile || '').trim();
        const explicitRuleFilePath = String(options.ruleFilePath || '').trim();
        const sectionKey = String(options.sectionKey || '').trim();
        const fileKind = String(options.fileKind || '').trim();
        const action = String(options.action || 'create').trim().toLowerCase();
        const substitutions = options.substitutions || {};
        const outputDir = String(options.outputDir || '').trim();
        const versionBucket = String(options.versionBucket || '').trim();
        const framework = String(options.framework || '').trim();
        const rulesBaseDir = String(options.rulesBaseDir || '').trim();

        if (!projectPath) {
            return { ok: false, errors: ['SKELETON_PROJECT_PATH_MISSING: 缺少 projectPath'] };
        }
        if (!targetFile) {
            return { ok: false, errors: ['SKELETON_TARGET_FILE_MISSING: 缺少 targetFile'] };
        }
        if (!sectionKey) {
            return { ok: false, errors: ['SKELETON_SECTION_KEY_MISSING: 缺少 sectionKey'] };
        }
        if (!fileKind) {
            return { ok: false, errors: ['SKELETON_FILE_KIND_MISSING: 缺少 fileKind'] };
        }

        const inputDir = path.join(path.dirname(targetFile), '.skeleton-input');
        fs.mkdirSync(inputDir, { recursive: true });
        const inputPath = path.join(inputDir, 'strict-materialize-input.json');
        const mappings = GateContractRegistry.getSkeletonMappings
            ? GateContractRegistry.getSkeletonMappings()
            : {};
        const ruleAlias = String(options.ruleAlias || mappings.RULE_ALIAS_MAP && mappings.RULE_ALIAS_MAP[fileKind] || '').trim();
        const builtinRendererKind = new Set(['Rest', 'Job']).has(fileKind);
        const resolvedRule = this.resolveRuleFile(ruleAlias, versionBucket, {
            explicitRuleFilePath,
            rulesBaseDir,
            framework,
            projectPath
        });
        if (!resolvedRule.ruleFilePath && !builtinRendererKind) {
            return {
                ok: false,
                errors: [
                    [
                        'SKELETON_RULE_FILE_MISSING: 无法解析代码生成规则文件。',
                        `ruleAlias=${ruleAlias || 'EMPTY'}`,
                        `versionBucket=${versionBucket || 'EMPTY'}`,
                        `explicitRuleFilePath=${explicitRuleFilePath || 'EMPTY'}`,
                        `candidates=${resolvedRule.candidates.join(' | ') || 'EMPTY'}`
                    ].join(' ')
                ],
                diagnostics: resolvedRule
            };
        }
        const ruleFilePath = resolvedRule.ruleFilePath || '';
        const sectionTitleMap = ruleAlias && mappings.SECTION_TITLE_MAP ? mappings.SECTION_TITLE_MAP[ruleAlias] || {} : {};
        const resolvedSectionKey = sectionTitleMap[sectionKey] || sectionKey;
        const sectionKeyCandidates = this._buildSectionKeyCandidates(sectionKey, resolvedSectionKey, fileKind);
        const payload = {
            projectPath,
            targetFile,
            ruleFilePath,
            ruleAlias,
            sectionKey: resolvedSectionKey,
            sourceSectionKey: sectionKey,
            sectionKeyCandidates,
            fileKind,
            action,
            framework,
            versionBucket,
            substitutions,
            // P4 fileKind 后处理：让 Python 物化器拿到 moduleId + business-facts 路径，
            // 自动展开 Entity 业务字段 / ServiceImpl 转发方法等机械映射代码。
            // 缺这两个字段时 Python 端 silent skip，回退到原 AI_TODO 路径。
            moduleId: String(options.moduleId || '').trim(),
            businessFactsPath: String(options.businessFactsPath || '').trim(),
            ruleAliasMap: mappings.RULE_ALIAS_MAP || {},
            sectionTitleMap: mappings.SECTION_TITLE_MAP || {},
            skeletonEligibleFileKinds: mappings.SKELETON_ELIGIBLE_FILE_KINDS || [],
            placeholderSources: mappings.PLACEHOLDER_SOURCES || [],
            outputDir: outputDir || path.dirname(targetFile),
            ruleResolution: resolvedRule
        };
        fs.writeFileSync(inputPath, JSON.stringify(payload, null, 2), 'utf-8');
        try {
            const rawStdout = execFileSync(this.pythonCommand, [this.scriptPath, '--input', inputPath, '--strict'], {
                encoding: 'utf-8',
                timeout: Number(options.timeoutMs || 60000),
                env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
                maxBuffer: 10 * 1024 * 1024
            });
            const stdout = String(rawStdout || '').trim();
            const parsed = JSON.parse(stdout || '{}');
            return {
                ...parsed,
                inputPath
            };
        } catch (ex) {
            const stderrOut = ex.stderr ? String(ex.stderr).trim() : '';
            const stdoutOut = ex.stdout ? String(ex.stdout).trim() : '';
            const errorDetail = [stdoutOut, stderrOut].filter(Boolean).join('\n') || ex.message;
            return {
                ok: false,
                inputPath,
                errors: [`SKELETON_STRICT_MATERIALIZE_FAILED: ${errorDetail}`]
            };
        }
    }

    _buildSectionKeyCandidates(sectionKey, resolvedSectionKey, fileKind) {
        const candidates = [];
        const add = value => {
            const normalized = String(value || '').trim();
            if (normalized && !candidates.includes(normalized)) {
                candidates.push(normalized);
            }
        };
        add(resolvedSectionKey);
        add(sectionKey);
        const dedicatedSection = new Set([
            'ReuseQueryListAction',
            'ReuseQueryListHtmlPage',
            'StatisticsAction',
            'StatisticsHtmlPage',
            'WorkflowMyListAction',
            'WorkflowAction',
            'WorkflowMyListHtmlPage',
            'WorkflowHtmlPage'
        ]);
        if (dedicatedSection.has(String(sectionKey || '').trim()) || dedicatedSection.has(String(resolvedSectionKey || '').trim())) {
            if (String(sectionKey || '').trim() === 'StatisticsAction'
                || String(resolvedSectionKey || '').trim() === 'StatisticsAction') {
                add('ListAction');
            }
            if (String(sectionKey || '').trim() === 'StatisticsHtmlPage'
                || String(resolvedSectionKey || '').trim() === 'StatisticsHtmlPage') {
                add('列表页');
            }
            return candidates;
        }

        const aliasMap = {
            ServiceApi: ['Service接口', 'ServiceApi'],
            ServiceInternal: ['Service内部逻辑类', 'Service内部类', 'ServiceInternal'],
            ServiceImpl: ['Service实现类', 'ServiceImpl'],
            Entity: ['Entity'],
            Action: ['ListAction', 'AddAction', 'EditAction', 'DetailAction'],
            Rest: ['RestController', 'Rest'],
            Job: ['Job']
            // 注意：HtmlPage 不在 aliasMap 里——避免 4 个 subType 候选在同一份候选清单里
            // 同时存在，否则 sectionKey='edit' 时会误命中"列表页"（因为它在候选首位）。
            // HtmlPage 的精准匹配靠 SECTION_TITLE_MAP[ruleAlias][subType] = 中文标题，
            // 仅在某些 subType 跨版本桶有不同写法时（如 950- 用"修改页"，950+ 用"编辑页"）
            // 在下面追加 subType 级 alias。
        };
        (aliasMap[fileKind] || []).forEach(add);
        // HtmlPage edit 的版本桶差异：950+ 标题"编辑页"，950- 标题"修改页"。
        // SECTION_TITLE_MAP 里 edit→编辑页 是 950+ 的主标题；这里追加"修改页"作为兜底，
        // 让同一份代码可以无差别处理两个版本桶。
        if (fileKind === 'HtmlPage') {
            const subTypeAlias = {
                edit: ['修改页', '编辑页'],
                Edit: ['修改页', '编辑页'],
                // 中文 sectionKey 双向兼容：传"编辑页"时追加"修改页"，反之亦然
                '编辑页': ['修改页', '编辑页'],
                '修改页': ['编辑页', '修改页']
            };
            (subTypeAlias[sectionKey] || []).forEach(add);
            (subTypeAlias[resolvedSectionKey] || []).forEach(add);
        }
        return candidates;
    }

    /**
     * Resolve rule file path from gate contract mappings.
     * Returns rule file path or null if not found.
     */
    resolveRuleFile(ruleAlias, versionBucket, options = {}) {
        const normalizedAlias = String(ruleAlias || '').trim();
        const normalizedBucket = String(versionBucket || '').trim();
        const explicitRuleFilePath = String(options.explicitRuleFilePath || '').trim();
        const candidates = [];
        const seen = new Set();
        const pushCandidate = (candidate) => {
            const normalized = String(candidate || '').trim();
            if (!normalized) return;
            const resolved = path.resolve(normalized);
            if (seen.has(resolved)) return;
            seen.add(resolved);
            candidates.push(resolved);
        };
        const tryExistingFile = (candidate) => {
            pushCandidate(candidate);
            const resolved = path.resolve(String(candidate || '').trim());
            return fs.existsSync(resolved) && fs.statSync(resolved).isFile() ? resolved : '';
        };

        if (explicitRuleFilePath) {
            const explicit = tryExistingFile(explicitRuleFilePath);
            if (explicit) {
                return {
                    ok: true,
                    ruleFilePath: explicit,
                    ruleAlias: normalizedAlias,
                    versionBucket: normalizedBucket,
                    source: 'explicitRuleFilePath',
                    candidates
                };
            }
        }

        if (!normalizedAlias) {
            return {
                ok: false,
                ruleFilePath: '',
                ruleAlias: normalizedAlias,
                versionBucket: normalizedBucket,
                source: '',
                candidates
            };
        }

        const serviceResolved = this._resolveRuleFileFromRuleService(normalizedAlias, normalizedBucket, {
            projectPath: options.projectPath,
            framework: options.framework,
            candidates
        });
        if (serviceResolved) {
            return {
                ok: true,
                ruleFilePath: serviceResolved,
                ruleAlias: normalizedAlias,
                versionBucket: normalizedBucket,
                source: 'ruleService',
                candidates
            };
        }

        const baseDirs = this._collectRuleBaseDirs(options.rulesBaseDir);
        for (const baseDir of baseDirs) {
            const direct = this._resolveRuleFileFromBaseDir(normalizedAlias, normalizedBucket, baseDir, candidates);
            if (direct) {
                return {
                    ok: true,
                    ruleFilePath: direct,
                    ruleAlias: normalizedAlias,
                    versionBucket: normalizedBucket,
                    source: 'rulesBaseDir',
                    candidates
                };
            }
        }

        for (const baseDir of baseDirs) {
            const byMetadata = this._resolveRuleFileByMetadata(normalizedAlias, normalizedBucket, baseDir, candidates);
            if (byMetadata) {
                return {
                    ok: true,
                    ruleFilePath: byMetadata,
                    ruleAlias: normalizedAlias,
                    versionBucket: normalizedBucket,
                    source: 'metadataScan',
                    candidates
                };
            }
        }

        return {
            ok: false,
            ruleFilePath: '',
            ruleAlias: normalizedAlias,
            versionBucket: normalizedBucket,
            source: '',
            candidates
        };
    }

    _resolveRuleFileFromRuleService(ruleAlias, versionBucket, options = {}) {
        if (!this.ruleService) {
            return '';
        }
        const projectPath = options.projectPath;
        const framework = String(options.framework || '').trim();
        const candidates = Array.isArray(options.candidates) ? options.candidates : [];
        if (typeof this.ruleService.resolveVersionedRule === 'function') {
            try {
                const resolvedVersioned = this.ruleService.resolveVersionedRule({
                    alias: ruleAlias,
                    framework,
                    versionBucket,
                    projectPath
                });
                const rulePath = resolvedVersioned && resolvedVersioned.rule && resolvedVersioned.rule.path
                    ? path.resolve(resolvedVersioned.rule.path)
                    : '';
                if (rulePath) {
                    candidates.push(rulePath);
                    if (fs.existsSync(rulePath) && fs.statSync(rulePath).isFile()) {
                        return rulePath;
                    }
                }
            } catch (_) {
                // Fall through to generic rule lookup below.
            }
        }
        if (typeof this.ruleService.resolveRule !== 'function') {
            return '';
        }
        const refs = [
            versionBucket ? `${versionBucket}/${ruleAlias}` : '',
            ruleAlias
        ].filter(Boolean);
        const policies = ['system-only', 'mixed'];
        for (const ref of refs) {
            for (const sourcePolicy of policies) {
                try {
                    const resolved = this.ruleService.resolveRule(ref, { projectPath, sourcePolicy });
                    if (resolved && resolved.path) {
                        candidates.push(path.resolve(resolved.path));
                        if (fs.existsSync(resolved.path) && fs.statSync(resolved.path).isFile()) {
                            return path.resolve(resolved.path);
                        }
                    }
                } catch (_) {
                    continue;
                }
            }
        }
        return '';
    }

    _collectRuleBaseDirs(explicitRulesBaseDir = '') {
        const dirs = [
            explicitRulesBaseDir,
            this.rulesPath,
            process.env.EPOINT_CODER_RULES_PATH,
            process.env.EPOINT_RULES_PATH,
        ].map(item => String(item || '').trim()).filter(Boolean);
        const seen = new Set();
        return dirs
            .map(item => path.resolve(item))
            .filter(item => {
                if (seen.has(item)) return false;
                seen.add(item);
                return fs.existsSync(item) && fs.statSync(item).isDirectory();
            });
    }

    _resolveRuleFileFromBaseDir(ruleAlias, versionBucket, baseDir, candidates = []) {
        const suffixes = ['.md', '.mdc'];
        const dirs = [
            versionBucket ? path.join(baseDir, versionBucket) : '',
            versionBucket ? path.join(baseDir, '核心开发与架构规范', versionBucket) : '',
            path.join(baseDir, '核心开发与架构规范'),
            baseDir
        ].filter(Boolean);
        for (const dir of dirs) {
            for (const suffix of suffixes) {
                const found = this._tryRuleCandidate(path.join(dir, `${ruleAlias}${suffix}`), candidates);
                if (found) return found;
            }
        }
        return '';
    }

    _tryRuleCandidate(candidate, candidates = []) {
        const resolved = path.resolve(String(candidate || '').trim());
        if (!candidates.includes(resolved)) {
            candidates.push(resolved);
        }
        return fs.existsSync(resolved) && fs.statSync(resolved).isFile() ? resolved : '';
    }

    _resolveRuleFileByMetadata(ruleAlias, versionBucket, baseDir, candidates = []) {
        const walk = (dir) => {
            let items = [];
            try {
                items = fs.readdirSync(dir, { withFileTypes: true });
            } catch (_) {
                return '';
            }
            for (const item of items) {
                const filePath = path.join(dir, item.name);
                if (item.isDirectory()) {
                    const nested = walk(filePath);
                    if (nested) return nested;
                    continue;
                }
                if (!item.isFile() || !/\.(md|mdc)$/iu.test(item.name)) continue;
                candidates.push(path.resolve(filePath));
                try {
                    const content = fs.readFileSync(filePath, 'utf-8');
                    const aliasMatched = content.includes(`rule_alias: ${ruleAlias}`)
                        || path.basename(filePath, path.extname(filePath)) === ruleAlias;
                    const bucketMatched = !versionBucket
                        || content.includes(`version_bucket: ${versionBucket}`)
                        || filePath.includes(`${path.sep}${versionBucket}${path.sep}`);
                    if (aliasMatched && bucketMatched) {
                        return path.resolve(filePath);
                    }
                } catch (_) {
                    continue;
                }
            }
            return '';
        };
        return walk(baseDir);
    }
}

module.exports = SkeletonGeneratorService;
