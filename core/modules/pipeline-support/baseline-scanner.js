/* eslint-disable */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const PipelineUtils = require('../pipeline-utils');

const DEFAULT_FALLBACK_ROOTS = {};

class BaselineScanner {
    constructor(options = {}) {
        this.getArtifactPaths = typeof options.getArtifactPaths === 'function'
            ? options.getArtifactPaths
            : () => ({});
        this.getProjectApiCatalogPaths = typeof options.getProjectApiCatalogPaths === 'function'
            ? options.getProjectApiCatalogPaths
            : () => ({});
        this.ensureDirectoryExists = typeof options.ensureDirectoryExists === 'function'
            ? options.ensureDirectoryExists
            : dirPath => {
                if (dirPath && !fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
                return dirPath;
            };
        this.resolveBaselineOutputPaths = typeof options.resolveBaselineOutputPaths === 'function'
            ? options.resolveBaselineOutputPaths
            : (artifactPath, customPaths = null) => {
                if (customPaths) return customPaths;
                return {
                    ...this.getArtifactPaths(artifactPath),
                    scanReportPath: path.join(artifactPath, '0_项目现状报告.md')
                };
            };
        this.getScriptCandidates = typeof options.getScriptCandidates === 'function'
            ? options.getScriptCandidates
            : () => [];
    }

    getFallbackRoots() {
        return { ...DEFAULT_FALLBACK_ROOTS };
    }

    getScanIgnoredDirNames() {
        return new Set([
            '.git', '.svn', '.idea', '.settings', '.vscode',
            '.claude', '.trae', '.codex', '.knowledge', '.agents',
            PipelineUtils.AI_WORKSPACE_DIR_NAME,
            'node_modules', 'target', 'bin', 'out', 'dist',
            'docs', '_docs', 'projectknowledge'
        ]);
    }

    isBusinessSourceRelativePath(relativePath, sourceRoot) {
        const normalized = String(relativePath || '').replace(/\\/g, '/').toLowerCase();
        return `/${normalized}`.includes(`/${String(sourceRoot || '').toLowerCase().replace(/\\/g, '/')}/`);
    }

    isBusinessJavaRelativePath(relativePath) {
        return this.isBusinessSourceRelativePath(relativePath, 'src/main/java');
    }

    isBusinessWebRelativePath(relativePath) {
        return this.isBusinessSourceRelativePath(relativePath, 'src/main/webapp');
    }

    resolveBaselineScriptPath(candidates = this.getScriptCandidates()) {
        for (const candidate of candidates) {
            if (fs.existsSync(candidate)) return candidate;
        }
        throw new Error(`找不到 generate_baseline_report.py 脚本。已尝试路径：\n- ${candidates.join('\n- ')}`);
    }

    sanitizeSnapshotData(snapshotData, projectPath) {
        if (!snapshotData || typeof snapshotData !== 'object') return snapshotData;
        const repaired = { ...snapshotData };
        const broken = value => typeof value === 'string' && value.includes('�');
        if (!repaired.root || broken(repaired.root)) repaired.root = projectPath;
        if (!repaired.product || broken(repaired.product)) repaired.product = path.basename(projectPath);
        if (!repaired.generator || broken(repaired.generator)) repaired.generator = 'python-baseline';
        return repaired;
    }

    parseSnapshotOutput(snapshotOutput, projectPath) {
        const raw = String(snapshotOutput || '').trim();
        if (!raw) throw new Error('基线脚本未返回有效快照内容。');
        try {
            return this.sanitizeSnapshotData(JSON.parse(raw), projectPath);
        } catch (_) {
            const jsonMatch = raw.match(/\{[\s\S]*\}$/);
            if (!jsonMatch) throw new Error(`无法从脚本输出中解析 JSON：${raw.slice(0, 200)}`);
            return this.sanitizeSnapshotData(JSON.parse(jsonMatch[0]), projectPath);
        }
    }

    collectBaselineSamples(projectPath) {
        const samples = { action: [], rest: [], service_api: [], service_impl: [], entity: [], job: [], web: [] };
        const ignored = this.getScanIgnoredDirNames();
        const pushUnique = (arr, item) => { if (!arr.includes(item)) arr.push(item); };
        const routeSample = (bucket, key, relativePath) => { if (bucket[key]) pushUnique(bucket[key], relativePath); };
        const isCommonServicePath = lowerPath => lowerPath.includes('/commonservice/') || lowerPath.includes('/com/epoint/commonservice/');
        const classifyJava = (entryName, lowerName, lowerPath) => {
            if (lowerName.endsWith('action.java') || lowerPath.includes('/action/')) return 'action';
            if (lowerName.includes('restcontroller') || lowerPath.includes('/rest/')) return 'rest';
            if (lowerPath.includes('/entity/')) return 'entity';
            if (lowerName.endsWith('serviceimpl.java') || lowerPath.includes('/impl/')) return 'service_impl';
            if ((/^I?[A-Z][A-Za-z0-9_]*Service\.java$/.test(entryName) || lowerPath.includes('/api/')) && !lowerPath.includes('/entity/')) return 'service_api';
            if (lowerName.endsWith('job.java') || lowerPath.includes('/job/')) return 'job';
            return null;
        };
        const walk = (currentDir, depth = 0) => {
            if (depth > 14) return;
            let entries = [];
            try { entries = fs.readdirSync(currentDir, { withFileTypes: true }); } catch (_) { return; }
            for (const entry of entries) {
                if (ignored.has(entry.name)) continue;
                const fullPath = path.join(currentDir, entry.name);
                if (entry.isDirectory()) {
                    walk(fullPath, depth + 1);
                    continue;
                }
                if (!entry.isFile()) continue;
                const relativePath = path.relative(projectPath, fullPath).replace(/\\/g, '/');
                const lowerPath = relativePath.toLowerCase();
                const lowerName = entry.name.toLowerCase();
                if (lowerName.endsWith('.html')) {
                    if (!this.isBusinessWebRelativePath(relativePath)) continue;
                    routeSample(samples, 'web', relativePath);
                    continue;
                }
                if (!lowerName.endsWith('.java') || !this.isBusinessJavaRelativePath(relativePath) || isCommonServicePath(lowerPath)) continue;
                const sampleType = classifyJava(entry.name, lowerName, lowerPath);
                if (!sampleType) continue;
                routeSample(samples, sampleType, relativePath);
            }
        };
        walk(projectPath);

        const merged = {};
        ['action', 'rest', 'service_api', 'service_impl', 'entity', 'job', 'web'].forEach(key => {
            merged[key] = [...samples[key]].sort();
        });
        return merged;
    }

    resolveBaselineRoot(samples, fallbackPath) {
        if (!samples || samples.length === 0) return fallbackPath;
        const first = samples[0];
        const idx = first.lastIndexOf('/');
        return idx >= 0 ? first.slice(0, idx + 1) : fallbackPath;
    }

    resolveProjectPagePath(projectPath) {
        let candidates = [];
        const ignored = this.getScanIgnoredDirNames();
        const walk = (currentDir, depth = 0) => {
            if (depth > 14) return;
            let entries = [];
            try { entries = fs.readdirSync(currentDir, { withFileTypes: true }); } catch (_) { return; }
            for (const entry of entries) {
                if (ignored.has(entry.name)) continue;
                const fullPath = path.join(currentDir, entry.name);
                if (entry.isDirectory()) {
                    walk(fullPath, depth + 1);
                    continue;
                }
                if (!entry.isFile() || entry.name !== 'epointframe.properties') continue;
                const relativePath = path.relative(projectPath, fullPath).replace(/\\/g, '/');
                if (!relativePath.endsWith('src/main/resources/epointframe.properties')) continue;
                let text = '';
                try { text = fs.readFileSync(fullPath, 'utf-8'); } catch (_) { continue; }
                const match = text.match(/^\s*projectPagePath\s*=\s*([^\r\n#]*)/m);
                const pagePath = String(match && match[1] || '').trim().replace(/^\/+|\/+$/g, '');
                if (!pagePath) continue;
                const modulePath = relativePath.slice(0, -'src/main/resources/epointframe.properties'.length).replace(/\/+$/g, '');
                const modulePrefix = modulePath ? `${modulePath}/` : '';
                candidates.push({
                    filePath: relativePath,
                    webRoot: `${modulePrefix}src/main/webapp/${pagePath}/{bizModule}/`
                });
            }
        };
        walk(projectPath);
        candidates = candidates.sort((left, right) => left.filePath.localeCompare(right.filePath));
        return candidates[0] || null;
    }

    buildFallbackSnapshot(projectPath, options = {}) {
        const samples = options.samples || this.collectBaselineSamples(projectPath);
        const fallbackRoots = options.fallbackRoots && typeof options.fallbackRoots === 'object'
            ? options.fallbackRoots
            : this.getFallbackRoots();
        const projectPagePath = this.resolveProjectPagePath(projectPath);
        return {
            root: projectPath,
            product: path.basename(projectPath),
            version: '未识别',
            generator: String(options.generator || 'js-fallback').trim() || 'js-fallback',
            paths: {
                action: this.resolveBaselineRoot(samples.action, fallbackRoots.action),
                rest: this.resolveBaselineRoot(samples.rest, fallbackRoots.rest),
                service_api: this.resolveBaselineRoot(samples.service_api, fallbackRoots.service_api),
                service_impl: this.resolveBaselineRoot(samples.service_impl, fallbackRoots.service_impl),
                entity: this.resolveBaselineRoot(samples.entity, fallbackRoots.entity),
                job: this.resolveBaselineRoot(samples.job, fallbackRoots.job),
                web: projectPagePath ? projectPagePath.webRoot : this.resolveBaselineRoot(samples.web, fallbackRoots.web)
            },
            ...(projectPagePath ? {
                diagnostics: {
                    webPathSource: 'epointframe.properties:projectPagePath',
                    projectPagePathFile: projectPagePath.filePath
                }
            } : {})
        };
    }

    buildFallbackReportContent(projectPath, snapshotData, options = {}) {
        const samples = options.samples || this.collectBaselineSamples(projectPath);
        const candidates = Array.isArray(options.candidates) ? options.candidates : [];
        const matched = String(options.matched || '').trim();
        const scriptError = options.scriptError || null;
        // REST §3 优先复用 Python --all-in-one 已落盘的 rest-interface-style.contract.json（事实真值），
        // 否则用调用方传进来的 restStyleContract（JS fallback 自扫的结果）。两条都没有再退到 unknown 文案。
        // 修这条是因为：Python 主路径写了正确事实（如 JsonUtils.zwdtRestReturn），但报告生成异常被吞，
        // fallback 兜底写报告时不读这份事实，自己再扫一次得 unknown，导致两份报告 REST return 不一致。
        let restStyleContract = options.restStyleContract && typeof options.restStyleContract === 'object'
            ? options.restStyleContract
            : null;
        let restSource = restStyleContract ? 'js-fallback-fast-rest-style' : '';
        const onDiskContractPath = path.join(projectPath, '.ai-workspace', 'project', 'rest-interface-style.contract.json');
        try {
            if (fs.existsSync(onDiskContractPath)) {
                const onDisk = JSON.parse(fs.readFileSync(onDiskContractPath, 'utf-8'));
                if (onDisk && typeof onDisk === 'object'
                    && String(onDisk.status || '').trim() === 'detected'
                    && String(onDisk.primaryReturnPattern || '').trim()) {
                    restStyleContract = onDisk;
                    restSource = (onDisk.policy && onDisk.policy.source)
                        ? String(onDisk.policy.source).trim()
                        : 'rest-interface-style.contract.json';
                }
            }
        } catch (_) {
            // 读取失败保持原值；不阻断报告生成
        }
        const restStatus = String(restStyleContract && restStyleContract.status || '').trim();
        const restPrimary = String(restStyleContract && restStyleContract.primaryReturnPattern || '').trim();
        const reportTitle = String(options.reportTitle || '# 项目现状报告').trim() || '# 项目现状报告';
        const extraNote = String(options.extraNote || '- 本报告用于沉淀工程导航契约，后续 requirement/design 直接引用契约，不再重复全文读取结构规范。').trim();
        return [
            reportTitle,
            '',
            '## 1. 项目概述',
            `- 项目根目录：\`${projectPath}\``,
            '- 报告定位：面向开发者与 AI 的项目画像；严格代码落点以 `.ai-workspace/project/工程导航契约.json` 为准。',
            scriptError ? `- 基线来源：Python 基线脚本失败，已自动回退到内置 JS 勘测器。失败原因：${scriptError.message}` : '- 基线来源：内置 JS 勘测器。',
            '',
            '## 2. 项目架构',
            '',
            '### 2.1 代码落点摘要',
            '> 这里是人读摘要；生成代码必须使用 `工程导航契约.json` 与 `2_生成文件清单.resolved.json` 的最终解析结果。',
            `- Action 根路径：\`${snapshotData.paths.action}\``,
            `- REST 根路径：\`${snapshotData.paths.rest}\``,
            `- Service 接口根路径：\`${snapshotData.paths.service_api}\``,
            `- Service 实现根路径：\`${snapshotData.paths.service_impl}\``,
            `- Entity 根路径：\`${snapshotData.paths.entity}\``,
            `- Job 根路径：\`${snapshotData.paths.job}\``,
            `- Web 根路径：\`${snapshotData.paths.web}\``,
            '',
            '### 2.2 真实样例',
            `- Action 示例：${samples.action.slice(0, 2).map(item => `\`${item}\``).join('、') || '未识别'}`,
            `- REST 示例：${samples.rest.slice(0, 2).map(item => `\`${item}\``).join('、') || '未识别'}`,
            `- Service 示例：${samples.service_impl.slice(0, 2).map(item => `\`${item}\``).join('、') || '未识别'}`,
            `- Entity 示例：${samples.entity.slice(0, 2).map(item => `\`${item}\``).join('、') || '未识别'}`,
            `- Job 示例：${samples.job.slice(0, 2).map(item => `\`${item}\``).join('、') || '未识别'}`,
            `- 页面示例：${samples.web.slice(0, 2).map(item => `\`${item}\``).join('、') || '未识别'}`,
            '',
            '## 3. REST 接口事实',
            restStatus === 'detected' && restPrimary
                ? `- REST return：\`${restPrimary}\`（来源：${restSource || 'rest-interface-style.contract.json'}）。`
                : '- REST return：`unknown`（未从 Controller 中确认统一 return 封装）。',
            '- Coder 必读契约：`.ai-workspace/project/rest-interface-style.contract.json`',
            '',
            '## 4. 自动勘测摘要',
            candidates.length > 0 ? `- 脚本候选路径：\n  - ${candidates.join('\n  - ')}` : '- 脚本候选路径：无',
            `- 实际命中脚本：${matched || '未命中（所有候选均不存在）'}`,
            '',
            '## 5. 流水线自动产物说明',
            '| 文件 | 作用 | 是否手改 |',
            '| --- | --- | --- |',
            '| `项目现状报告.md` | 人读项目摘要，帮助快速理解模块、落点、REST return 与关键资源 | 不手改 |',
            '| `工程导航契约.md` | 人读代码落点与命名契约 | 谨慎修订 |',
            '| `工程导航契约.json` | 代码落点、命名、页面根路径的机器执行契约 | 谨慎修订 |',
            '| `工程导航契约.compact.json` | 给 prompt / 阶段上下文使用的轻量契约 | 不手改 |',
            '| `框架版本档位.json` | 规则桶选择依据，记录 950 档位及来源证据 | 谨慎修订 |',
            '| `rest-interface-style.contract.json` | REST return/注解/接口风格事实契约，Coder 必读 | 不手改 |',
            '| `asset-index.json` | 项目资产检索数据库，只取 Top N 摘要，不全文进 prompt | 不手改 |',
            '| `business-graph.json` | 完整业务关系图数据库，只检索复用，不全文进 prompt | 一般不手改 |',
            '| `business-graph.index.json` | 业务图轻量索引，供需求/设计/quick 快速召回 | 不手改 |',
            '| `entity-graph.json` | 实体、表、字段、实体关系图数据库，只检索复用 | 一般不手改 |',
            '| `entity-graph.index.json` | 实体图轻量索引 | 不手改 |',
            '',
            '## 6. 已识别风险',
            extraNote || '- 无',
            '- REST return 未形成项目事实契约时，Coder 只能显式 fallback 到 REST 规范，不能把规范示例当作项目事实。',
            '- 若 fallback 结果与源码事实不一致，应优先修复 Python 基线脚本或工程导航契约。'
        ].join('\n');
    }

    detectRestReturnPatterns(text = '') {
        const source = String(text || '');
        const patterns = [];
        const helperReturnRe = /\breturn\s+([A-Z][A-Za-z0-9_]*(?:Utils?|Kit|Result|Response|Rest)?\.[A-Za-z0-9_]*(?:Return|Result|Success|Error|Ok|Fail|success|error|ok|fail))\s*\(/g;
        const looseReturnRe = /\b([A-Z][A-Za-z0-9_]*(?:Utils?|Kit|Result|Response|Rest)?\.[A-Za-z0-9_]*Return)\s*\(/g;
        let match = null;
        while ((match = helperReturnRe.exec(source)) !== null) patterns.push(match[1]);
        while ((match = looseReturnRe.exec(source)) !== null) patterns.push(match[1]);
        if (/\bResponseEntity\s*(?:<|\.)/.test(source) || /\breturn\s+ResponseEntity\b/.test(source)) {
            patterns.push('ResponseEntity');
        }
        if (/\breturn\s+(?:new\s+)?Result(?:\.|\s*\()/i.test(source)) {
            patterns.push('Result');
        }
        if (/\breturn\s+(?:new\s+)?(?:HashMap|Map)\b/.test(source)) {
            patterns.push('Map');
        }
        return [...new Set(patterns)];
    }

    isPrimaryRestHelperPattern(pattern = '') {
        const text = String(pattern || '').trim();
        return !!text && !['Map', 'Result', 'ResponseEntity'].includes(text) && text.includes('.');
    }

    parseRestReturnHelperPattern(pattern = '') {
        const text = String(pattern || '').trim();
        if (!this.isPrimaryRestHelperPattern(text)) return null;
        const parts = text.split('.');
        if (parts.length < 2) return null;
        const className = String(parts[0] || '').trim();
        const methodName = String(parts[1] || '').trim();
        if (!className || !methodName) return null;
        return { className, methodName };
    }

    findImportForSimpleClassInJava(projectPath, relPath, simpleClass) {
        const rawRel = String(relPath || '').trim();
        const rawClass = String(simpleClass || '').trim();
        if (!rawRel || !rawClass) return '';
        const fullPath = path.isAbsolute(rawRel) ? rawRel : path.join(projectPath, rawRel);
        let text = '';
        try { text = fs.readFileSync(fullPath, 'utf-8'); } catch (_) { return ''; }
        const importRe = new RegExp(`^\\s*import\\s+([A-Za-z_][\\w]*(?:\\.[A-Za-z_][\\w]*)*\\.${rawClass})\\s*;\\s*$`, 'm');
        const match = text.match(importRe);
        return match ? String(match[1] || '').trim() : '';
    }

    buildRestReturnHelper(projectPath, pattern, evidenceFiles = []) {
        const parsed = this.parseRestReturnHelperPattern(pattern);
        if (!parsed) return null;
        let importName = '';
        let sourceFile = '';
        for (const relPath of evidenceFiles || []) {
            importName = this.findImportForSimpleClassInJava(projectPath, relPath, parsed.className);
            if (importName) {
                sourceFile = String(relPath || '').trim();
                break;
            }
        }
        return {
            ...parsed,
            importName,
            sourceFile
        };
    }

    rankRestPatternEntries(entries = []) {
        return [...entries].sort((left, right) => {
            const leftPattern = String(left[0] || '');
            const rightPattern = String(right[0] || '');
            const leftRank = this.isPrimaryRestHelperPattern(leftPattern) ? 0 : 1;
            const rightRank = this.isPrimaryRestHelperPattern(rightPattern) ? 0 : 1;
            if (leftRank !== rightRank) return leftRank - rightRank;
            const countDelta = Number(right[1] || 0) - Number(left[1] || 0);
            if (countDelta !== 0) return countDelta;
            return leftPattern.localeCompare(rightPattern);
        });
    }

    readRestScanText(fullPath) {
        let text = '';
        try { text = fs.readFileSync(fullPath, 'utf-8'); } catch (_) { return ''; }
        if (text.length <= 600000) return text;
        const lines = text.split(/\r?\n/);
        const selected = new Set();
        const markerRe = /@(RestController|ResponseBody|RequestMapping|GetMapping|PostMapping|PutMapping|DeleteMapping|PatchMapping)\b|\breturn\b/i;
        lines.forEach((line, index) => {
            if (!markerRe.test(line)) return;
            const start = Math.max(0, index - 10);
            const end = Math.min(lines.length, index + 11);
            for (let i = start; i < end; i += 1) selected.add(i);
        });
        if (selected.size === 0) return text.slice(0, 600000);
        return [...selected].sort((a, b) => a - b).map(index => lines[index]).join('\n');
    }

    runRestStyleScript(scriptPath, projectPath) {
        const resolvedScriptPath = String(scriptPath || '').trim() || this.resolveBaselineScriptPath();
        const output = execFileSync('python', [resolvedScriptPath, '--root', projectPath, '--rest-style'], {
            encoding: 'utf-8',
            stdio: 'pipe',
            timeout: 30000,
            env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' }
        });
        const raw = String(output || '').trim();
        const jsonMatch = raw.match(/\{[\s\S]*\}$/);
        const payload = JSON.parse(jsonMatch ? jsonMatch[0] : raw);
        return {
            path: payload.restInterfaceStyleContractPath || '',
            contract: payload.contract && typeof payload.contract === 'object' ? payload.contract : null,
            source: 'python-rest-style'
        };
    }

    collectRestStyleContractFast(projectPath, options = {}) {
        const ignored = this.getScanIgnoredDirNames();
        const maxJavaFiles = Number.isInteger(options.maxJavaFiles) ? options.maxJavaFiles : 1200;
        const minPrimaryHits = Number.isInteger(options.minPrimaryHits) ? options.minPrimaryHits : 3;
        const maxEvidenceFiles = Number.isInteger(options.maxEvidenceFiles) ? options.maxEvidenceFiles : 6;
        const counter = new Map();
        const evidence = new Map();
        let scannedJavaFiles = 0;
        let scannedControllerFiles = 0;
        let stoppedEarly = false;
        const increment = (pattern, relPath) => {
            counter.set(pattern, Number(counter.get(pattern) || 0) + 1);
            const files = evidence.get(pattern) || [];
            if (!files.includes(relPath) && files.length < maxEvidenceFiles) files.push(relPath);
            evidence.set(pattern, files);
        };
        const topPattern = () => this.rankRestPatternEntries(counter.entries())[0] || null;
        const shouldStop = () => {
            const top = topPattern();
            if (!top) return false;
            const files = evidence.get(top[0]) || [];
            return top[1] >= minPrimaryHits && files.length >= Math.min(2, maxEvidenceFiles);
        };
        const walk = currentDir => {
            if (stoppedEarly || scannedJavaFiles >= maxJavaFiles) return;
            let entries = [];
            try { entries = fs.readdirSync(currentDir, { withFileTypes: true }); } catch (_) { return; }
            for (const entry of entries) {
                if (stoppedEarly || scannedJavaFiles >= maxJavaFiles) break;
                if (ignored.has(entry.name)) continue;
                const fullPath = path.join(currentDir, entry.name);
                if (entry.isDirectory()) {
                    walk(fullPath);
                    continue;
                }
                if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.java')) continue;
                const lowerName = entry.name.toLowerCase();
                const relPath = path.relative(projectPath, fullPath).replace(/\\/g, '/');
                if (!this.isBusinessJavaRelativePath(relPath)) continue;
                const likelyController = lowerName.includes('controller') || lowerName.includes('rest');
                scannedJavaFiles += 1;
                const text = this.readRestScanText(fullPath);
                if (!likelyController && !/@RestController|@ResponseBody|RequestMapping\s*\(/.test(text)) continue;
                scannedControllerFiles += 1;
                this.detectRestReturnPatterns(text).forEach(pattern => increment(pattern, relPath));
                if (shouldStop()) {
                    stoppedEarly = true;
                    break;
                }
            }
        };
        walk(projectPath);
        const ranked = this.rankRestPatternEntries(counter.entries());
        const primary = ranked.length > 0 ? ranked[0][0] : '';
        const primaryEvidence = primary ? (evidence.get(primary) || []).slice(0, 3) : [];
        return {
            generatedAt: new Date().toISOString(),
            projectPath,
            status: primary ? 'detected' : 'unknown',
            primaryReturnPattern: primary,
            returnHelper: primary ? this.buildRestReturnHelper(projectPath, primary, primaryEvidence) : null,
            returnPatterns: ranked.map(([pattern, count]) => {
                const patternEvidence = (evidence.get(pattern) || []).slice(0, 3);
                return {
                    pattern,
                    count,
                    evidenceFiles: patternEvidence,
                    returnHelper: this.buildRestReturnHelper(projectPath, pattern, patternEvidence)
                };
            }),
            evidenceFiles: primaryEvidence,
            policy: {
                detected: '已识别项目 REST 返回封装；生成 REST 代码必须使用 primaryReturnPattern。',
                unknown: '未识别项目 REST 返回封装；停止生成 REST 代码，先补齐 rest-interface-style.contract。'
            },
            diagnostics: {
                source: 'js-fast-rest-style-scan',
                scannedJavaFiles,
                scannedControllerFiles,
                stoppedEarly
            }
        };
    }

    writeFallbackRestStyleContract(paths, projectPath, scriptError = null) {
        const targetPath = paths && paths.restInterfaceStyleContractPath
            ? paths.restInterfaceStyleContractPath
            : (paths && paths.scanReportPath ? path.join(path.dirname(paths.scanReportPath), 'rest-interface-style.contract.json') : null);
        if (!targetPath) return null;
        this.ensureDirectoryExists(path.dirname(targetPath));
        let restStyleState = null;
        if (scriptError && scriptError.scriptPath) {
            try {
                restStyleState = this.runRestStyleScript(scriptError.scriptPath, projectPath);
            } catch (_) {
                restStyleState = null;
            }
        }
        const contract = restStyleState && restStyleState.contract
            ? restStyleState.contract
            : this.collectRestStyleContractFast(projectPath);
        contract.policy = {
            ...contract.policy,
            source: restStyleState && restStyleState.contract ? 'python-fast-rest-style' : 'js-fallback-fast-rest-style',
            message: contract.status === 'detected'
                ? '已快速命中项目 REST return 封装；REST 代码生成必须使用 primaryReturnPattern。'
                : '未从项目源码中确认统一 REST return 封装；停止生成 REST 代码，先补齐 rest-interface-style.contract。',
            projectPath
        };
        contract.diagnostics = {
            ...(contract.diagnostics || {}),
            ...(scriptError ? { pythonBaselineError: scriptError.message } : {})
        };
        fs.writeFileSync(targetPath, JSON.stringify(contract, null, 2), 'utf-8');
        return { path: targetPath, contract };
    }

    runAssetIndexLiteScript(scriptPath, projectPath) {
        const resolvedScriptPath = String(scriptPath || '').trim() || this.resolveBaselineScriptPath();
        const output = execFileSync('python', [resolvedScriptPath, '--root', projectPath, '--asset-index-lite'], {
            encoding: 'utf-8',
            stdio: 'pipe',
            timeout: 30000,
            env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' }
        });
        const raw = String(output || '').trim();
        const jsonMatch = raw.match(/\{[\s\S]*\}$/);
        return JSON.parse(jsonMatch ? jsonMatch[0] : raw);
    }

    extractMappingPaths(annotationText = '') {
        const paths = [];
        const source = String(annotationText || '');
        const mappingRe = /@(RequestMapping|GetMapping|PostMapping|PutMapping|DeleteMapping|PatchMapping)\s*(?:\(([\s\S]*?)\))?/g;
        let match = null;
        while ((match = mappingRe.exec(source)) !== null) {
            const args = match[2] || '';
            const pathMatch = args.match(/(?:value\s*=\s*|path\s*=\s*)?(?:\{\s*)?["']([^"']+)["']/);
            paths.push(pathMatch ? pathMatch[1].trim() : '');
        }
        return [...new Set(paths.filter(item => item !== null && item !== undefined))].slice(0, 8);
    }

    joinUrlPaths(...parts) {
        const clean = parts.map(item => String(item || '').trim().replace(/^\/+|\/+$/g, '')).filter(Boolean);
        return clean.length > 0 ? `/${clean.join('/')}` : '';
    }

    findMatchingBrace(text, openIndex, maxChars = 180000) {
        let depth = 0;
        let inString = '';
        let escaped = false;
        const endLimit = Math.min(text.length, openIndex + maxChars);
        for (let index = openIndex; index < endLimit; index += 1) {
            const ch = text[index];
            if (inString) {
                if (escaped) escaped = false;
                else if (ch === '\\') escaped = true;
                else if (ch === inString) inString = '';
                continue;
            }
            if (ch === '"' || ch === "'") {
                inString = ch;
                continue;
            }
            if (ch === '{') depth += 1;
            else if (ch === '}') {
                depth -= 1;
                if (depth <= 0) return index;
            }
        }
        return endLimit;
    }

    extractServiceCalls(text = '', limit = 8) {
        const calls = [];
        const seen = new Set();
        const callRe = /\b([a-z][A-Za-z0-9_]*(?:Service|Manager|Dao|Mapper))\.([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;
        let match = null;
        while ((match = callRe.exec(String(text || ''))) !== null) {
            const call = `${match[1]}.${match[2]}`;
            if (seen.has(call)) continue;
            seen.add(call);
            calls.push(call);
            if (calls.length >= limit) break;
        }
        return calls;
    }

    parseControllerMethodAssets(projectPath, fullPath, text) {
        const relPath = path.relative(projectPath, fullPath).replace(/\\/g, '/');
        const classMatch = String(text || '').match(/\b(?:public\s+)?(?:class|interface)\s+([A-Za-z_][A-Za-z0-9_]*)\b/);
        const className = classMatch ? classMatch[1] : path.basename(fullPath, '.java');
        const packageMatch = String(text || '').match(/^\s*package\s+([\w.]+)\s*;/m);
        const packageName = packageMatch ? packageMatch[1] : '';
        const classIndex = String(text || '').indexOf(className);
        const classPrefix = classIndex > 0 ? String(text || '').slice(0, classIndex) : String(text || '').slice(0, 5000);
        const classPaths = this.extractMappingPaths(classPrefix);
        const rootPaths = classPaths.length > 0 ? classPaths : [''];
        const methodRe = /((?:\s*@(RequestMapping|GetMapping|PostMapping|PutMapping|DeleteMapping|PatchMapping)\s*(?:\([^)]*\))?\s*)+)(?:public|protected|private)?\s*(?:static\s+)?(?:final\s+)?([A-Za-z0-9_<>\[\], ?.&]+?)\s+([A-Za-z_][A-Za-z0-9_]*)\s*\((.*?)\)\s*(?:throws\s+[^{]+)?\{/gs;
        const assets = [];
        let match = null;
        while ((match = methodRe.exec(String(text || ''))) !== null && assets.length < 40) {
            const annotations = match[1] || '';
            const returnType = String(match[3] || '').trim().replace(/\s+/g, ' ');
            const methodName = String(match[4] || '').trim();
            const paramsText = String(match[5] || '').trim().replace(/\s+/g, ' ');
            const bodyStart = methodRe.lastIndex - 1;
            const bodyEnd = this.findMatchingBrace(String(text || ''), bodyStart);
            const body = String(text || '').slice(bodyStart, bodyEnd + 1);
            const returnPatterns = this.detectRestReturnPatterns(body);
            const primary = this.rankRestPatternEntries(returnPatterns.map(item => [item, 1]))[0];
            const primaryReturnPattern = primary ? primary[0] : '';
            const methodPaths = this.extractMappingPaths(annotations);
            const urls = [...new Set(rootPaths.flatMap(root => (methodPaths.length > 0 ? methodPaths : ['']).map(item => this.joinUrlPaths(root, item))))].filter(Boolean).slice(0, 6);
            const serviceCalls = this.extractServiceCalls(body);
            const keywords = [...new Set([className, methodName, ...urls, ...serviceCalls, primaryReturnPattern, relPath].filter(Boolean))].slice(0, 16);
            let summary = `${className}.${methodName}`;
            if (urls[0]) summary += `；URL: ${urls[0]}`;
            if (primaryReturnPattern) summary += `；return: ${primaryReturnPattern}`;
            if (serviceCalls[0]) summary += `；调用: ${serviceCalls.slice(0, 3).join(', ')}`;
            assets.push({
                assetId: `api:${className}.${methodName}`,
                assetType: 'project_api_asset',
                title: `${className}.${methodName}`,
                summary: summary.slice(0, 300),
                intentKeywords: keywords,
                assetTokens: keywords.map(item => String(item).toLowerCase()).slice(0, 24),
                sourcePath: relPath,
                sourceFile: relPath,
                packageName,
                controllerName: className,
                methodName,
                signature: `${returnType} ${methodName}(${paramsText})`,
                urls,
                returnPattern: primaryReturnPattern,
                returnPatterns,
                serviceCalls,
                referencePolicy: 'context_only',
                matchLane: 'project_api_asset',
                reuseAdvice: '命中后优先复用现有 Controller/API 语义；代码落点仍以工程导航契约为准。',
                status: 'partial'
            });
        }
        return assets;
    }

    collectAssetIndexLiteFast(projectPath, options = {}) {
        const ignored = this.getScanIgnoredDirNames();
        const maxJavaFiles = Number.isInteger(options.maxJavaFiles) ? options.maxJavaFiles : 1200;
        const maxAssets = Number.isInteger(options.maxAssets) ? options.maxAssets : 200;
        const assetIndex = [];
        let scannedJavaFiles = 0;
        let scannedControllerFiles = 0;
        let stoppedEarly = false;
        const walk = currentDir => {
            if (stoppedEarly || scannedJavaFiles >= maxJavaFiles) return;
            let entries = [];
            try { entries = fs.readdirSync(currentDir, { withFileTypes: true }); } catch (_) { return; }
            for (const entry of entries) {
                if (stoppedEarly || scannedJavaFiles >= maxJavaFiles) break;
                if (ignored.has(entry.name)) continue;
                const fullPath = path.join(currentDir, entry.name);
                if (entry.isDirectory()) {
                    walk(fullPath);
                    continue;
                }
                if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.java')) continue;
                const relativePath = path.relative(projectPath, fullPath).replace(/\\/g, '/');
                if (!this.isBusinessJavaRelativePath(relativePath)) continue;
                scannedJavaFiles += 1;
                const text = this.readRestScanText(fullPath);
                const lowerName = entry.name.toLowerCase();
                if (!lowerName.includes('controller') && !lowerName.includes('rest') && !/@RestController|@ResponseBody|RequestMapping\s*\(/.test(text)) continue;
                scannedControllerFiles += 1;
                assetIndex.push(...this.parseControllerMethodAssets(projectPath, fullPath, text));
                if (assetIndex.length >= maxAssets) {
                    stoppedEarly = true;
                    assetIndex.length = maxAssets;
                    break;
                }
            }
        };
        walk(projectPath);
        return {
            generatedAt: new Date().toISOString(),
            projectPath,
            version: 2,
            source: 'js-asset-index-lite',
            assetIndex,
            stats: {
                assetIndexCount: assetIndex.length,
                scannedJavaFiles,
                scannedControllerFiles,
                stoppedEarly,
                status: stoppedEarly ? 'partial' : 'verified'
            }
        };
    }

    writeFallbackAssetIndexLite(projectPath, options = {}) {
        const structureDir = PipelineUtils.getProjectStructureDir(projectPath);
        this.ensureDirectoryExists(structureDir);
        const assetIndexPath = path.join(structureDir, 'asset-index.json');
        let existing = [];
        if (fs.existsSync(assetIndexPath)) {
            try {
                const payload = JSON.parse(fs.readFileSync(assetIndexPath, 'utf-8'));
                existing = Array.isArray(payload.assetIndex) ? payload.assetIndex.filter(item => item && typeof item === 'object') : [];
            } catch (_) {
                existing = [];
            }
        }
        const lite = this.collectAssetIndexLiteFast(projectPath, options);
        const merged = new Map();
        existing.forEach(item => { if (item.assetId) merged.set(item.assetId, item); });
        lite.assetIndex.forEach(item => { if (item.assetId) merged.set(item.assetId, item); });
        const payload = {
            ...lite,
            assetIndex: [...merged.values()].sort((left, right) => String(left.assetId || '').localeCompare(String(right.assetId || ''))),
            stats: {
                ...(lite.stats || {}),
                assetIndexCount: merged.size
            }
        };
        fs.writeFileSync(assetIndexPath, JSON.stringify(payload, null, 2), 'utf-8');
        return { assetIndexPath, assetIndexCount: String(merged.size), source: payload.source };
    }

    runApiCatalogScript(scriptPath, projectPath) {
        const resolvedScriptPath = String(scriptPath || '').trim() || this.resolveBaselineScriptPath();
        const apiPaths = this.getProjectApiCatalogPaths(projectPath);
        this.ensureDirectoryExists(apiPaths.ruleDir);
        execFileSync('python', [resolvedScriptPath, '--root', projectPath, '--api-catalog'], {
            encoding: 'utf-8',
            stdio: 'pipe',
            timeout: 600000,
            env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' }
        });
        return apiPaths;
    }

    runSnapshot(projectPath, options = {}) {
        const candidates = this.getScriptCandidates();
        let scriptPath = null;
        try {
            scriptPath = this.resolveBaselineScriptPath(candidates);
            const snapshotOutput = execFileSync('python', [scriptPath, '--root', projectPath, '--snapshot'], {
                encoding: 'utf-8',
                stdio: 'pipe',
                timeout: 600000,
                env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' }
            });
            return {
                ok: true,
                scriptPath,
                snapshotData: this.parseSnapshotOutput(snapshotOutput, projectPath),
                source: forceRefreshSource(options.forceRefresh, 'rebuilt')
            };
        } catch (error) {
            return {
                ok: true,
                scriptPath,
                snapshotData: this.buildFallbackSnapshot(projectPath, {
                    generator: String(options.fallbackGenerator || 'js-fallback').trim() || 'js-fallback'
                }),
                source: forceRefreshSource(options.forceRefresh, 'rebuilt-js-fallback'),
                fallback: true,
                error,
                candidates
            };
        }
    }

    runBaselineArtifacts(projectPath, artifactPath, customPaths = null, options = {}) {
        const paths = this.resolveBaselineOutputPaths(artifactPath, customPaths);
        const candidates = this.getScriptCandidates();
        let scriptPath = null;
        try {
            if (paths.scanReportPath) this.ensureDirectoryExists(path.dirname(paths.scanReportPath));
            scriptPath = this.resolveBaselineScriptPath(candidates);

            // --all-in-one：一次性产出 snapshot/报告/api-catalog/business-graph/entity-graph/REST 风格/asset-index
            // 复用同一份 records + scans_map，避免多次 Python 子进程重复 walk 全工程。
            // stdout 是 snapshot JSON，可直接喂给契约 JSON 真值。
            const snapshotOutput = execFileSync('python', [scriptPath, '--root', projectPath, '--all-in-one'], {
                encoding: 'utf-8',
                stdio: 'pipe',
                timeout: 600000,
                env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' }
            });
            const snapshotData = this.parseSnapshotOutput(snapshotOutput, projectPath);

            // --all-in-one 已经把人读报告写到 paths.scanReportPath；如果文件不存在或为空（脚本内部异常吞掉了），
            // 用 JS fallback 写一份兜底报告，不让 LLM 没东西可读
            let scanReportError = null;
            if (paths.scanReportPath) {
                let needsFallback = false;
                try {
                    if (!fs.existsSync(paths.scanReportPath) || fs.statSync(paths.scanReportPath).size < 100) {
                        needsFallback = true;
                    }
                } catch (_) {
                    needsFallback = true;
                }
                if (needsFallback) {
                    try {
                        const samples = this.collectBaselineSamples(projectPath);
                        const reportContent = this.buildFallbackReportContent(projectPath, snapshotData, {
                            samples,
                            candidates,
                            matched: scriptPath,
                            extraNote: '- --all-in-one 内部报告生成失败或为空，已使用 JS fallback 写人读报告；契约 JSON 仍来自 Python --snapshot 真值。'
                        });
                        fs.writeFileSync(paths.scanReportPath, reportContent, 'utf-8');
                    } catch (fbError) {
                        scanReportError = fbError;
                    }
                }
            }

            // --all-in-one 已经写了 rest-style / asset-index / api-catalog 产物；apiPaths 由调用方按既定路径解析
            const apiPaths = options.skipApiCatalog
                ? null
                : (typeof this.getProjectApiCatalogPaths === 'function' ? this.getProjectApiCatalogPaths(projectPath) : null);
            return {
                ok: true,
                snapshotData,
                paths,
                apiPaths,
                apiError: null,
                restStyleState: { source: 'python-all-in-one' },
                assetIndexLiteState: { source: 'python-all-in-one' },
                scriptPath,
                scanReportError
            };
        } catch (error) {
            if (scriptPath && error && typeof error === 'object') error.scriptPath = scriptPath;
            return this.runBaselineArtifactsFallback(projectPath, artifactPath, error, { candidates, matched: scriptPath }, customPaths, options);
        }
    }

    runBaselineArtifactsFallback(projectPath, artifactPath, scriptError = null, scriptContext = null, customPaths = null, options = {}) {
        const paths = this.resolveBaselineOutputPaths(artifactPath, customPaths);
        try {
            if (paths.scanReportPath) this.ensureDirectoryExists(path.dirname(paths.scanReportPath));
            const samples = this.collectBaselineSamples(projectPath);
            const candidates = scriptContext && Array.isArray(scriptContext.candidates) ? scriptContext.candidates : [];
            const matched = scriptContext && scriptContext.matched ? scriptContext.matched : null;
            const snapshotData = this.buildFallbackSnapshot(projectPath, {
                samples,
                generator: String(options.fallbackGenerator || 'js-fallback').trim() || 'js-fallback'
            });
            const restStyleState = this.writeFallbackRestStyleContract(paths, projectPath, scriptError);
            let assetIndexLiteState = null;
            if (scriptError && scriptError.scriptPath) {
                try {
                    assetIndexLiteState = this.runAssetIndexLiteScript(scriptError.scriptPath, projectPath);
                } catch (_) {
                    assetIndexLiteState = this.writeFallbackAssetIndexLite(projectPath);
                }
            } else {
                assetIndexLiteState = this.writeFallbackAssetIndexLite(projectPath);
            }
            if (options.writeFallbackReport !== false && paths.scanReportPath) {
                const reportContent = this.buildFallbackReportContent(projectPath, snapshotData, {
                    samples,
                    candidates,
                    matched,
                    scriptError,
                    restStyleContract: restStyleState && restStyleState.contract,
                    reportTitle: options.fallbackReportTitle,
                    extraNote: options.fallbackReportNote
                });
                fs.writeFileSync(paths.scanReportPath, reportContent, 'utf-8');
            }
            return { ok: true, snapshotData, paths, restStyleState, assetIndexLiteState };
        } catch (fallbackError) {
            return { ok: false, message: `❌ 项目基线脚本执行失败：${scriptError ? scriptError.message : '未知错误'}\nJS fallback 也失败：${fallbackError.message}` };
        }
    }
}

function forceRefreshSource(forceRefresh, baseLabel) {
    if (!forceRefresh) return baseLabel;
    if (baseLabel === 'rebuilt-js-fallback') return 'forced-refresh-js-fallback';
    return 'forced-refresh';
}

module.exports = BaselineScanner;
