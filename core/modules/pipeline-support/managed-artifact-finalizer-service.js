/* eslint-disable */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const ProjectionTransactionService = require('./design-tdd-projection-transaction-service');

/**
 * ManagedArtifactFinalizerService
 *
 * 通用阶段产物收口服务：只接收 stage wrapper 已解析好的固定路径产物清单，
 * 不从文件名、项目结构或 LLM 文案中推导可写范围。
 */
class ManagedArtifactFinalizerService {
    constructor(options = {}) {
        this.now = typeof options.now === 'function' ? options.now : () => new Date().toISOString();
        this.transactionService = options.transactionService || new ProjectionTransactionService();
    }

    sha256(content = '') {
        return `sha256:${crypto.createHash('sha256').update(String(content || ''), 'utf8').digest('hex')}`;
    }

    finalize(options = {}) {
        const stageKey = String(options.stageKey || 'stage').trim() || 'stage';
        const actionMode = String(options.actionMode || 'write_final_artifacts_by_fixed_paths').trim();
        const rootDir = this._resolveRootDir(options.rootDir || options.demandDir);
        if (!rootDir) {
            return this._blocked('MANAGED_ARTIFACT_ROOT_DIR_MISSING', '缺少 rootDir/demandDir，无法执行受控产物落盘。', {
                actionMode
            });
        }

        const receiptPath = String(options.receiptPath || '').trim()
            ? path.resolve(String(options.receiptPath || '').trim())
            : '';
        if (receiptPath && !this._isSameOrChildPath(receiptPath, rootDir)) {
            return this._blocked('MANAGED_ARTIFACT_RECEIPT_OUT_OF_ROOT', `finalize receipt 不在授权根目录内：${receiptPath}`, {
                actionMode,
                invalid: [{ key: 'receipt', path: receiptPath, reason: 'outside_root' }]
            });
        }

        const normalized = this._normalizeArtifacts(options.artifacts, rootDir, { requirePayload: true });
        if (!normalized.ok) {
            return this._blocked('MANAGED_ARTIFACT_PAYLOAD_INVALID', '最终产物 payload 或固定路径不完整。', {
                actionMode,
                missing: normalized.missing,
                invalid: normalized.invalid,
                allowedNextActions: options.allowedNextActions || [],
                forbiddenActions: options.forbiddenActions || []
            });
        }

        const hashMismatch = normalized.artifacts.find(artifact => artifact.expectedHash
            && artifact.expectedHash !== artifact.expectedPayloadHash);
        if (hashMismatch) {
            return this._blocked('MANAGED_ARTIFACT_EXPECTED_HASH_MISMATCH', `产物 ${hashMismatch.key} 与上游凭证 hash 不一致。`, {
                actionMode,
                invalid: [{
                    key: hashMismatch.key,
                    path: hashMismatch.path,
                    reason: 'expected_hash_mismatch',
                    expectedHash: hashMismatch.expectedHash,
                    actualHash: hashMismatch.expectedPayloadHash
                }],
                allowedNextActions: options.allowedNextActions || [],
                forbiddenActions: options.forbiddenActions || []
            });
        }

        if (options.atomic === true && receiptPath) {
            return this._finalizeAtomic(options, normalized.artifacts, rootDir, receiptPath);
        }

        try {
            for (const artifact of normalized.artifacts) {
                fs.mkdirSync(path.dirname(artifact.path), { recursive: true });
                fs.writeFileSync(artifact.path, artifact.content, 'utf-8');
            }
        } catch (error) {
            return this._blocked('MANAGED_ARTIFACT_WRITE_FAILED', '最终产物写盘失败。', {
                actionMode,
                cause: String(error && error.message || error),
                allowedNextActions: options.writeFailureNextActions || options.allowedNextActions || [],
                forbiddenActions: options.forbiddenActions || []
            });
        }

        const verifyResult = this.verifyRequiredArtifacts({
            rootDir,
            artifacts: normalized.artifacts.map(artifact => ({
                key: artifact.key,
                path: artifact.path,
                type: artifact.type,
                allowEmpty: artifact.allowEmpty,
                expectedHash: artifact.expectedHash,
                hashMode: artifact.hashMode
            })),
            actionMode
        });
        if (verifyResult.ok !== true) {
            return {
                ...verifyResult,
                allowedNextActions: options.verifyFailureNextActions || options.allowedNextActions || [],
                forbiddenActions: options.forbiddenActions || []
            };
        }

        let receipt = null;
        if (receiptPath) {
            receipt = {
                schemaVersion: 'managed-artifact-finalizer/v1',
                ok: true,
                status: 'ready',
                stageKey,
                actionMode,
                generatedAt: this.now(),
                rootDir,
                artifacts: normalized.artifacts.map(artifact => ({
                    key: artifact.key,
                    type: artifact.type,
                    path: artifact.path,
                    contentHash: artifact.contentHash,
                    actualHash: artifact.hashMode === 'json_logical'
                        ? artifact.expectedPayloadHash
                        : artifact.contentHash,
                    expectedHash: artifact.expectedHash || '',
                    hashMode: artifact.hashMode || 'content'
                })),
                extra: options.receiptExtra && typeof options.receiptExtra === 'object'
                    ? options.receiptExtra
                    : {}
            };
            try {
                fs.mkdirSync(path.dirname(receiptPath), { recursive: true });
                fs.writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, 'utf-8');
            } catch (error) {
                return this._blocked('MANAGED_ARTIFACT_RECEIPT_WRITE_FAILED', `最终产物已写入，但 finalize receipt 写入失败：${receiptPath}`, {
                    actionMode,
                    cause: String(error && error.message || error),
                    allowedNextActions: options.writeFailureNextActions || options.allowedNextActions || [],
                    forbiddenActions: options.forbiddenActions || []
                });
            }
        }

        return {
            ok: true,
            status: 'ready',
            actionMode,
            written: this._buildWrittenMap(normalized.artifacts),
            artifacts: normalized.artifacts.map(artifact => ({
                key: artifact.key,
                path: artifact.path,
                type: artifact.type,
                contentHash: artifact.contentHash
            })),
            receipt: receiptPath ? { written: true, path: receiptPath } : null,
            allowedNextActions: Array.isArray(options.allowedNextActions) ? options.allowedNextActions : [],
            forbiddenActions: Array.isArray(options.forbiddenActions) ? options.forbiddenActions : []
        };
    }

    _finalizeAtomic(options, artifacts, rootDir, receiptPath) {
        try {
            const transactionRoot = path.join(path.dirname(receiptPath), '.projection-tx');
            fs.mkdirSync(transactionRoot, { recursive: true });
            const stagingDir = fs.mkdtempSync(path.join(transactionRoot, 'finalize-'));
            const files = artifacts.map((artifact, index) => ({ path: artifact.path,
                newPath: path.join(stagingDir, `artifact-${index}${artifact.type === 'json' ? '.json' : '.txt'}`) }));
            const stagedReceipt = path.join(stagingDir, 'receipt.json');
            const result = this.finalize({ ...options, atomic: false, receiptPath: stagedReceipt,
                artifacts: artifacts.map((artifact, index) => ({ ...artifact, path: files[index].newPath,
                    payload: artifact.type === 'json' ? JSON.parse(artifact.content) : artifact.content })) });
            if (!result.ok) return result;
            const receipt = JSON.parse(fs.readFileSync(stagedReceipt, 'utf8'));
            receipt.artifacts.forEach((artifact, index) => { artifact.path = artifacts[index].path; });
            fs.writeFileSync(stagedReceipt, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
            files.push({ path: receiptPath, newPath: stagedReceipt });
            const published = this.transactionService.publishFiles({ rootDir, stagingDir, files });
            if (!published.ok) return published;
            return { ...result, written: this._buildWrittenMap(artifacts),
                artifacts: result.artifacts.map((artifact, index) => ({ ...artifact, path: artifacts[index].path })),
                receipt: { written: true, path: receiptPath } };
        } catch (error) {
            return this._blocked('MANAGED_ARTIFACT_WRITE_FAILED', '最终产物未更新，旧有效产物保留。',
                { cause: error.message, machineRecoverable: true, stopLockRequired: false });
        }
    }

    verifyRequiredArtifacts(options = {}) {
        const actionMode = String(options.actionMode || 'verify_required_artifacts').trim();
        const rootDir = this._resolveRootDir(options.rootDir || options.demandDir);
        if (!rootDir) {
            return this._blocked('MANAGED_ARTIFACT_ROOT_DIR_MISSING', '缺少 rootDir/demandDir，无法验证受控产物。', {
                actionMode
            });
        }

        const normalized = this._normalizeArtifacts(options.artifacts, rootDir, { requirePayload: false });
        const missing = Array.isArray(normalized.missing) ? normalized.missing.slice() : [];
        const invalid = Array.isArray(normalized.invalid) ? normalized.invalid.slice() : [];
        const verified = [];
        if (normalized.ok) {
            for (const artifact of normalized.artifacts) {
                if (!fs.existsSync(artifact.path)) {
                    missing.push({ key: artifact.key, path: artifact.path, reason: 'file_missing' });
                    continue;
                }
                let content = '';
                try {
                    content = fs.readFileSync(artifact.path, 'utf-8');
                } catch (error) {
                    invalid.push({
                        key: artifact.key,
                        path: artifact.path,
                        reason: 'read_failed',
                        cause: String(error && error.message || error)
                    });
                    continue;
                }
                if (artifact.allowEmpty !== true && !String(content || '').trim()) {
                    invalid.push({ key: artifact.key, path: artifact.path, reason: 'empty_file' });
                    continue;
                }
                let parsedJson = null;
                if (artifact.type === 'json') {
                    try {
                        parsedJson = JSON.parse(content);
                    } catch (error) {
                        invalid.push({
                            key: artifact.key,
                            path: artifact.path,
                            reason: 'json_parse_failed',
                            cause: String(error && error.message || error)
                        });
                        continue;
                    }
                }
                if (artifact.expectedHash) {
                    const actualHash = artifact.hashMode === 'json_logical' && artifact.type === 'json'
                        ? this.sha256(JSON.stringify(parsedJson))
                        : this.sha256(content);
                    if (actualHash !== artifact.expectedHash) {
                        invalid.push({
                            key: artifact.key,
                            path: artifact.path,
                            reason: 'hash_mismatch',
                            expectedHash: artifact.expectedHash,
                            actualHash
                        });
                        continue;
                    }
                }
                verified.push({
                    key: artifact.key,
                    path: artifact.path,
                    type: artifact.type,
                    contentHash: this.sha256(content)
                });
            }
        }

        if (missing.length > 0 || invalid.length > 0) {
            return this._blocked('MANAGED_ARTIFACT_VERIFY_FAILED', '最终产物反读校验失败。', {
                actionMode,
                missing,
                invalid
            });
        }

        return {
            ok: true,
            status: 'ready',
            actionMode,
            verified
        };
    }

    verifyAndWriteReceipt(options = {}) {
        const stageKey = String(options.stageKey || 'stage').trim() || 'stage';
        const actionMode = String(options.actionMode || 'verify_final_artifacts_by_fixed_paths').trim();
        const rootDir = this._resolveRootDir(options.rootDir || options.demandDir);
        if (!rootDir) {
            return this._blocked('MANAGED_ARTIFACT_ROOT_DIR_MISSING', '缺少 rootDir/demandDir，无法验证受控产物。', {
                actionMode
            });
        }
        const receiptPath = String(options.receiptPath || '').trim()
            ? path.resolve(String(options.receiptPath || '').trim())
            : '';
        if (!receiptPath) {
            return this._blocked('MANAGED_ARTIFACT_RECEIPT_PATH_MISSING', '缺少 receiptPath，无法写入最终产物验证凭证。', {
                actionMode
            });
        }
        if (!this._isSameOrChildPath(receiptPath, rootDir)) {
            return this._blocked('MANAGED_ARTIFACT_RECEIPT_OUT_OF_ROOT', `finalize receipt 不在授权根目录内：${receiptPath}`, {
                actionMode,
                invalid: [{ key: 'receipt', path: receiptPath, reason: 'outside_root' }]
            });
        }

        const verifyResult = this.verifyRequiredArtifacts({
            rootDir,
            artifacts: options.artifacts,
            actionMode
        });
        if (verifyResult.ok !== true) {
            return {
                ...verifyResult,
                allowedNextActions: options.verifyFailureNextActions || options.allowedNextActions || [],
                forbiddenActions: options.forbiddenActions || []
            };
        }

        const receipt = {
            schemaVersion: 'managed-artifact-finalizer/v1',
            ok: true,
            status: 'ready',
            mode: 'verify_existing_artifacts',
            stageKey,
            actionMode,
            generatedAt: this.now(),
            rootDir,
            artifacts: verifyResult.verified.map(artifact => ({
                key: artifact.key,
                type: artifact.type,
                path: artifact.path,
                contentHash: artifact.contentHash
            })),
            extra: options.receiptExtra && typeof options.receiptExtra === 'object'
                ? options.receiptExtra
                : {}
        };
        try {
            fs.mkdirSync(path.dirname(receiptPath), { recursive: true });
            fs.writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, 'utf-8');
        } catch (error) {
            return this._blocked('MANAGED_ARTIFACT_RECEIPT_WRITE_FAILED', `最终产物已验证，但 finalize receipt 写入失败：${receiptPath}`, {
                actionMode,
                cause: String(error && error.message || error),
                allowedNextActions: options.writeFailureNextActions || options.allowedNextActions || [],
                forbiddenActions: options.forbiddenActions || []
            });
        }

        return {
            ok: true,
            status: 'ready',
            actionMode,
            verified: verifyResult.verified,
            receipt: { written: true, path: receiptPath },
            allowedNextActions: Array.isArray(options.allowedNextActions) ? options.allowedNextActions : [],
            forbiddenActions: Array.isArray(options.forbiddenActions) ? options.forbiddenActions : []
        };
    }

    _normalizeArtifacts(artifacts, rootDir, options = {}) {
        const requirePayload = options.requirePayload === true;
        const missing = [];
        const invalid = [];
        const normalized = [];
        if (!Array.isArray(artifacts) || artifacts.length === 0) {
            return {
                ok: false,
                missing: [{ key: 'artifacts', reason: 'empty_artifact_list' }],
                invalid: []
            };
        }

        artifacts.forEach((artifact, index) => {
            const key = String(artifact && artifact.key || '').trim();
            const type = String(artifact && artifact.type || '').trim().toLowerCase();
            const artifactPath = String(artifact && artifact.path || '').trim();
            const label = key || `artifact_${index + 1}`;
            if (!key) {
                invalid.push({ key: label, reason: 'key_missing' });
            }
            if (!artifactPath) {
                missing.push({ key: label, reason: 'path_missing' });
                return;
            }
            const resolvedPath = path.resolve(artifactPath);
            if (!this._isSameOrChildPath(resolvedPath, rootDir)) {
                invalid.push({ key: label, path: resolvedPath, reason: 'outside_root' });
                return;
            }
            if (!['json', 'text'].includes(type)) {
                invalid.push({ key: label, path: resolvedPath, reason: 'unsupported_type', type });
                return;
            }

            if (!requirePayload) {
                normalized.push({
                    key: label,
                    path: resolvedPath,
                    type,
                    allowEmpty: artifact && artifact.allowEmpty === true,
                    expectedHash: String(artifact && artifact.expectedHash || '').trim(),
                    hashMode: String(artifact && artifact.hashMode || (type === 'json' ? 'json_logical' : 'content')).trim()
                });
                return;
            }

            const hasPayload = Object.prototype.hasOwnProperty.call(artifact || {}, 'payload');
            const rawPayload = hasPayload ? artifact.payload : artifact && artifact.content;
            if (!hasPayload && !Object.prototype.hasOwnProperty.call(artifact || {}, 'content')) {
                missing.push({ key: label, path: resolvedPath, reason: 'payload_missing' });
                return;
            }

            const prepared = this._serializeArtifactPayload(label, resolvedPath, type, rawPayload, artifact || {});
            if (!prepared.ok) {
                invalid.push(prepared.issue);
                return;
            }
            normalized.push(prepared.artifact);
        });

        return {
            ok: missing.length === 0 && invalid.length === 0,
            missing,
            invalid,
            artifacts: normalized
        };
    }

    _serializeArtifactPayload(key, artifactPath, type, rawPayload, source) {
        const allowEmpty = source.allowEmpty === true;
        let content = '';
        if (type === 'json') {
            try {
                content = JSON.stringify(rawPayload, null, 2);
            } catch (error) {
                return {
                    ok: false,
                    issue: {
                        key,
                        path: artifactPath,
                        reason: 'json_serialize_failed',
                        cause: String(error && error.message || error)
                    }
                };
            }
            if (typeof content !== 'string') {
                return {
                    ok: false,
                    issue: { key, path: artifactPath, reason: 'json_payload_not_serializable' }
                };
            }
        } else {
            if (typeof rawPayload !== 'string') {
                return {
                    ok: false,
                    issue: { key, path: artifactPath, reason: 'text_payload_must_be_string' }
                };
            }
            content = rawPayload;
        }

        if (allowEmpty !== true && !String(content || '').trim()) {
            return {
                ok: false,
                issue: { key, path: artifactPath, reason: 'payload_empty' }
            };
        }
        if (!content.endsWith('\n')) content += '\n';

        const expectedHash = String(source.expectedHash || '').trim();
        const hashMode = String(source.hashMode || (type === 'json' ? 'json_logical' : 'content')).trim();
        const hashSource = Object.prototype.hasOwnProperty.call(source, 'hashSource')
            ? source.hashSource
            : (hashMode === 'json_logical' && type === 'json' ? JSON.stringify(rawPayload) : content);

        return {
            ok: true,
            artifact: {
                key,
                path: artifactPath,
                type,
                allowEmpty,
                content,
                contentHash: this.sha256(content),
                expectedHash,
                expectedPayloadHash: this.sha256(hashSource),
                hashMode
            }
        };
    }

    _buildWrittenMap(artifacts = []) {
        const written = {};
        for (const artifact of artifacts) {
            if (!artifact || !artifact.key) continue;
            written[`${artifact.key}Path`] = artifact.path;
        }
        return written;
    }

    _resolveRootDir(rootDir) {
        const value = String(rootDir || '').trim();
        if (!value) return '';
        return path.resolve(value);
    }

    _isSameOrChildPath(child, parent) {
        const resolvedChild = path.resolve(String(child || ''));
        const resolvedParent = path.resolve(String(parent || ''));
        const childKey = process.platform === 'win32' ? resolvedChild.toLowerCase() : resolvedChild;
        const parentKey = process.platform === 'win32' ? resolvedParent.toLowerCase() : resolvedParent;
        return childKey === parentKey || childKey.startsWith(parentKey + path.sep);
    }

    _blocked(errorCode, message, extra = {}) {
        return {
            ok: false,
            status: 'blocked',
            errorCode,
            message,
            ...extra
        };
    }
}

module.exports = ManagedArtifactFinalizerService;
