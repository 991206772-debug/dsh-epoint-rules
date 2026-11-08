const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SCHEMA_VERSION = 'design-tdd-generated-artifacts/v1';

function normalizePath(value = '') {
    if (!value) return '';
    const resolved = path.resolve(String(value || '').trim());
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function uniqueStrings(values = []) {
    const out = [];
    const seen = new Set();
    for (const value of values) {
        const text = String(value || '').trim();
        if (!text) continue;
        const key = normalizePath(text) || text;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(text);
    }
    return out;
}

class DesignTddGeneratedArtifactsService {
    constructor(options = {}) {
        this.now = typeof options.now === 'function' ? options.now : () => new Date().toISOString();
    }

    indexPath(codeDir = '') {
        return path.join(path.resolve(String(codeDir || '').trim()), 'work-slices', 'generated-artifacts.json');
    }

    recordFromSpecialistResult({ codeDir = '', result = {}, source = 'design_tdd_skeleton_materialize' } = {}) {
        const artifacts = this.extractFromSpecialistResult({ codeDir, result, source });
        if (artifacts.length === 0) {
            return { ok: true, changed: false, indexPath: this.indexPath(codeDir), artifactCount: 0, artifacts: [] };
        }
        return this.writeMerged({ codeDir, artifacts });
    }

    rebuildFromCodeState({ codeDir = '' } = {}) {
        return this.load({ codeDir });
    }

    load({ codeDir = '' } = {}) {
        const indexPath = this.indexPath(codeDir);
        if (!fs.existsSync(indexPath)) {
            return {
                ok: true,
                exists: false,
                indexPath,
                value: this._emptyIndex({ codeDir })
            };
        }
        try {
            const parsed = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
            const value = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
                ? parsed
                : this._emptyIndex({ codeDir });
            value.schemaVersion = value.schemaVersion || SCHEMA_VERSION;
            value.codeDir = value.codeDir || path.resolve(String(codeDir || '').trim());
            value.artifacts = Array.isArray(value.artifacts) ? value.artifacts : [];
            return { ok: true, exists: true, indexPath, value };
        } catch (error) {
            return {
                ok: false,
                exists: true,
                indexPath,
                errorCode: 'DESIGN_TDD_GENERATED_ARTIFACTS_INDEX_INVALID',
                message: `生成辅助产物索引无法解析：${indexPath}`,
                cause: String(error && error.message || error)
            };
        }
    }

    writeMerged({ codeDir = '', artifacts = [] } = {}) {
        const indexPath = this.indexPath(codeDir);
        const existing = this.load({ codeDir });
        if (!existing.ok) return existing;
        const now = this.now();
        const merged = new Map();
        for (const artifact of existing.value.artifacts || []) {
            const normalized = normalizePath(artifact && artifact.path);
            if (!normalized) continue;
            merged.set(normalized, { ...artifact });
        }
        for (const artifact of artifacts) {
            const normalized = normalizePath(artifact && artifact.path);
            if (!normalized) continue;
            const previous = merged.get(normalized) || {};
            merged.set(normalized, this._stripEmpty({
                ...previous,
                ...artifact,
                artifactId: previous.artifactId || artifact.artifactId || this._artifactId(artifact),
                createdAt: previous.createdAt || now,
                updatedAt: now
            }));
        }
        const index = {
            schemaVersion: SCHEMA_VERSION,
            codeDir: path.resolve(String(codeDir || '').trim()),
            generatedAt: existing.value.generatedAt || now,
            updatedAt: now,
            artifacts: Array.from(merged.values()).sort((left, right) =>
                String(left.path || '').localeCompare(String(right.path || ''))
            )
        };
        try {
            fs.mkdirSync(path.dirname(indexPath), { recursive: true });
            fs.writeFileSync(indexPath, `${JSON.stringify(index, null, 2)}\n`, 'utf-8');
            return {
                ok: true,
                changed: true,
                indexPath,
                artifactCount: index.artifacts.length,
                artifacts: index.artifacts,
                value: index
            };
        } catch (error) {
            return {
                ok: false,
                indexPath,
                errorCode: 'DESIGN_TDD_GENERATED_ARTIFACTS_INDEX_WRITE_FAILED',
                message: `生成辅助产物索引写入失败：${indexPath}`,
                cause: String(error && error.message || error)
            };
        }
    }

    extractFromSpecialistResult({ codeDir = '', result = {}, source = '' } = {}) {
        const storyId = String(result.storyId || '').trim().toUpperCase();
        const consumerSkill = String(result.consumerSkill || '').trim();
        const summary = String(result.summary || '').trim();
        const files = uniqueStrings([
            ...(Array.isArray(result.touchedFiles) ? result.touchedFiles : []),
            ...this._coverageFiles(result.coverageChecklist)
        ]);
        return files
            .map(filePath => this._toGeneratedArtifact({
                codeDir,
                filePath,
                storyId,
                consumerSkill,
                summary,
                source
            }))
            .filter(Boolean);
    }

    buildCard({ codeDir = '', index = null } = {}) {
        const loaded = index && typeof index === 'object'
            ? { ok: true, exists: true, indexPath: this.indexPath(codeDir), value: index }
            : this.load({ codeDir });
        if (!loaded.ok) {
            return {
                title: '生成辅助产物索引异常',
                indexPath: loaded.indexPath,
                artifactCount: 0,
                artifacts: [],
                errorCode: loaded.errorCode,
                message: loaded.message
            };
        }
        const artifacts = Array.isArray(loaded.value.artifacts) ? loaded.value.artifacts : [];
        if (artifacts.length === 0) return null;
        return {
            title: '生成辅助产物',
            indexPath: loaded.indexPath,
            artifactCount: artifacts.length,
            artifacts: artifacts.map(item => this._stripEmpty({
                storyId: item.storyId,
                consumerSkill: item.consumerSkill,
                kind: item.kind,
                fileName: item.fileName,
                path: item.path,
                summary: item.summary
            }))
        };
    }

    buildReceiptExtra({ codeDir = '', index = null } = {}) {
        const loaded = index && typeof index === 'object'
            ? { ok: true, exists: true, indexPath: this.indexPath(codeDir), value: index }
            : this.load({ codeDir });
        if (!loaded.ok) return null;
        const artifacts = Array.isArray(loaded.value.artifacts) ? loaded.value.artifacts : [];
        if (artifacts.length === 0) return null;
        return {
            indexPath: loaded.indexPath,
            artifactCount: artifacts.length,
            artifacts: artifacts.map(item => this._stripEmpty({
                artifactId: item.artifactId,
                storyId: item.storyId,
                consumerSkill: item.consumerSkill,
                kind: item.kind,
                fileName: item.fileName,
                path: item.path,
                source: item.source,
                summary: item.summary
            }))
        };
    }

    validateWorkflowArtifacts({ facts = {}, index = null } = {}) {
        const contracts = Array.isArray(facts && facts.businessFacts && facts.businessFacts.workflowContracts)
            ? facts.businessFacts.workflowContracts
            : [];
        if (contracts.length === 0) return { ok: true, requiredArtifacts: [] };
        const artifacts = index && Array.isArray(index.artifacts) ? index.artifacts : [];
        const requiredArtifacts = [];
        const missing = [];
        for (const contract of contracts) {
            const storyId = String(contract && (contract.storyId || contract.sourceStoryId) || '').trim().toUpperCase();
            const matches = artifacts.filter(item => {
                if (!item || !/^workflow_(mis|process)_xml$/u.test(String(item.kind || ''))) return false;
                return !storyId || String(item.storyId || '').trim().toUpperCase() === storyId;
            });
            for (const kind of ['workflow_mis_xml', 'workflow_process_xml']) {
                const artifact = matches.find(item => String(item.kind || '') === kind);
                const artifactPath = artifact && String(artifact.path || '').trim();
                let exists = false;
                try {
                    exists = Boolean(artifactPath && fs.existsSync(artifactPath) && fs.statSync(artifactPath).size > 0);
                } catch (_) {
                    exists = false;
                }
                if (!exists) {
                    missing.push({ storyId, kind, path: artifactPath || '' });
                    continue;
                }
                requiredArtifacts.push({
                    key: `workflow.${storyId || 'global'}.${kind}`,
                    type: 'text',
                    path: path.resolve(artifactPath)
                });
            }
        }
        if (missing.length > 0) {
            return {
                ok: false,
                status: 'blocked',
                errorCode: 'DESIGN_TDD_WORKFLOW_ARTIFACT_MISSING',
                message: '存在Workflow需求，但设计阶段生成的MIS/Workflow XML未完整落盘。',
                missing,
                allowedNextActions: ['rerun_design_prepare_context_to_restore_workflow_artifacts']
            };
        }
        return { ok: true, requiredArtifacts };
    }

    appendReportSection({ reportPath = '', codeDir = '', index = null } = {}) {
        const loaded = index && typeof index === 'object'
            ? { ok: true, exists: true, indexPath: this.indexPath(codeDir), value: index }
            : this.load({ codeDir });
        if (!loaded.ok) return loaded;
        const artifacts = Array.isArray(loaded.value.artifacts) ? loaded.value.artifacts : [];
        if (artifacts.length === 0 || !reportPath || !fs.existsSync(reportPath)) {
            return { ok: true, changed: false, indexPath: loaded.indexPath, artifactCount: artifacts.length };
        }
        const markerStart = '<!-- design-tdd-generated-artifacts:start -->';
        const markerEnd = '<!-- design-tdd-generated-artifacts:end -->';
        const section = this._renderReportSection({ artifacts, markerStart, markerEnd });
        const original = fs.readFileSync(reportPath, 'utf-8');
        const pattern = new RegExp(`${this._escapeRegExp(markerStart)}[\\s\\S]*?${this._escapeRegExp(markerEnd)}\\n?`, 'm');
        const next = pattern.test(original)
            ? original.replace(pattern, section)
            : `${original.replace(/\s*$/u, '\n\n')}${section}`;
        if (next === original) return { ok: true, changed: false, indexPath: loaded.indexPath, artifactCount: artifacts.length };
        fs.writeFileSync(reportPath, next, 'utf-8');
        return { ok: true, changed: true, indexPath: loaded.indexPath, artifactCount: artifacts.length };
    }

    _toGeneratedArtifact({ codeDir = '', filePath = '', storyId = '', consumerSkill = '', summary = '', source = '' } = {}) {
        const resolved = path.resolve(String(filePath || '').trim());
        const kind = this._detectKind({ codeDir, filePath: resolved });
        if (!kind) return null;
        const artifact = this._stripEmpty({
            artifactId: this._artifactId({ kind, path: resolved, storyId, consumerSkill }),
            kind,
            storyId,
            consumerSkill,
            path: resolved,
            fileName: path.basename(resolved),
            source: source || 'design_tdd_skeleton_materialize',
            summary
        });
        return artifact;
    }

    _detectKind({ codeDir = '', filePath = '' } = {}) {
        const normalizedFile = normalizePath(filePath).replace(/\\/g, '/');
        const workflowRoot = normalizePath(path.join(String(codeDir || ''), 'generated-workflow')).replace(/\\/g, '/');
        const designWorkflowRoot = normalizePath(path.join(
            path.dirname(String(codeDir || '')),
            'design',
            'generated-workflow'
        )).replace(/\\/g, '/');
        if (!normalizedFile || ![workflowRoot, designWorkflowRoot].some(root =>
            root && normalizedFile.startsWith(`${root}/`))) return '';
        const fileName = path.basename(filePath).toLowerCase();
        if (fileName.endsWith('-mis.xml')) return 'workflow_mis_xml';
        if (fileName.endsWith('-workflow.xml')) return 'workflow_process_xml';
        if (fileName.endsWith('.xml')) return 'workflow_auxiliary_xml';
        return 'generated_file';
    }

    _coverageFiles(coverageChecklist = []) {
        const out = [];
        if (!Array.isArray(coverageChecklist)) return out;
        for (const item of coverageChecklist) {
            if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
            if (!Array.isArray(item.files)) continue;
            out.push(...item.files);
        }
        return out;
    }

    _emptyIndex({ codeDir = '' } = {}) {
        return {
            schemaVersion: SCHEMA_VERSION,
            codeDir: path.resolve(String(codeDir || '').trim()),
            generatedAt: '',
            updatedAt: '',
            artifacts: []
        };
    }

    _renderReportSection({ artifacts = [], markerStart = '', markerEnd = '' } = {}) {
        const lines = [];
        lines.push(`${markerStart}\n`);
        lines.push('## Generated Artifacts');
        lines.push('');
        lines.push('| storyId | kind | fileName | path |');
        lines.push('| --- | --- | --- | --- |');
        for (const item of artifacts) {
            lines.push(`| ${this._md(item.storyId)} | ${this._md(item.kind)} | ${this._md(item.fileName)} | ${this._md(item.path)} |`);
        }
        lines.push('');
        lines.push(`${markerEnd}\n`);
        return lines.join('\n');
    }

    _artifactId(artifact = {}) {
        const basis = [
            artifact.storyId,
            artifact.consumerSkill,
            artifact.kind,
            normalizePath(artifact.path)
        ].join('|');
        return `artifact-${crypto.createHash('sha256').update(basis, 'utf-8').digest('hex').slice(0, 16)}`;
    }

    _md(value = '') {
        return String(value || '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
    }

    _escapeRegExp(value = '') {
        return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
}

module.exports = DesignTddGeneratedArtifactsService;
