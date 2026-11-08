/* eslint-disable */

/**
 * SkeletonManifestArchiveService
 *
 * Design TDD 新主线已不再把 skeleton-output-manifest.json 散落到源码目录。
 * 本服务保留历史类名，职责收敛为 skeleton-manifests-ledger.json 的写入与摘要：
 * - materialize 成功后 register(...) 直接登记骨架物化事实
 * - finalize 成功后 archive(...) 不移动文件，只返回 ledger 摘要供 receipt 留痕
 */

const fs = require('fs');
const path = require('path');

const LEDGER_FILE_NAME = 'skeleton-manifests-ledger.json';
const LEDGER_SCHEMA = 'skeleton-manifests-ledger/v2';

class SkeletonManifestArchiveService {
    register(args = {}) {
        const demandDir = String(args.demandDir || '').trim();
        const moduleId = String(args.moduleId || '').trim();
        const fileKind = String(args.fileKind || '').trim();
        const targetFile = String(args.targetFile || '').trim();
        const materializedFile = args.materializedFile && typeof args.materializedFile === 'object'
            ? args.materializedFile
            : {};
        const substitutionsSanitized = args.substitutionsSanitized && typeof args.substitutionsSanitized === 'object' && Object.keys(args.substitutionsSanitized).length > 0
            ? args.substitutionsSanitized
            : null;

        if (!demandDir || !targetFile || !fileKind) {
            return { ok: false, reason: 'missing_required_args' };
        }

        const codeDir = path.join(demandDir, 'code');
        const ledgerPath = path.join(codeDir, LEDGER_FILE_NAME);
        const ledger = this._readLedger(ledgerPath);
        const normalizedTarget = this._normalizeTarget(targetFile);
        const existingIndex = ledger.entries.findIndex(entry => this._normalizeTarget(entry.targetFile) === normalizedTarget);
        const record = {
            moduleId: moduleId || '',
            fileKind,
            targetFile,
            status: String(materializedFile.status || 'materialized').trim() || 'materialized',
            registeredAt: new Date().toISOString(),
            materializedAt: new Date().toISOString(),
            outputSha256: String(materializedFile.outputSha256 || '').trim(),
            methodNames: Array.isArray(materializedFile.methodNames) ? materializedFile.methodNames : [],
            methodSignatures: Array.isArray(materializedFile.methodSignatures) ? materializedFile.methodSignatures : []
        };
        [
            'rulePath',
            'ruleFilePath',
            'sectionKey',
            'sectionTitle',
            'templateFingerprint'
        ].forEach(key => {
            const value = String(materializedFile[key] || '').trim();
            if (value) record[key] = value;
        });
        if (Array.isArray(materializedFile.unresolvedPlaceholders) && materializedFile.unresolvedPlaceholders.length > 0) {
            record.unresolvedPlaceholders = materializedFile.unresolvedPlaceholders;
        }
        if (materializedFile.substitutionsApplied && typeof materializedFile.substitutionsApplied === 'object') {
            record.substitutionsApplied = materializedFile.substitutionsApplied;
        }
        if (materializedFile.substitutionsStripped && typeof materializedFile.substitutionsStripped === 'object') {
            record.substitutionsStripped = materializedFile.substitutionsStripped;
        }
        if (substitutionsSanitized) {
            record.substitutionsSanitized = substitutionsSanitized;
        }
        if (materializedFile.existingTarget === true) {
            record.existingTarget = true;
        }

        if (existingIndex >= 0) {
            ledger.entries[existingIndex] = record;
        } else {
            ledger.entries.push(record);
        }

        try {
            fs.mkdirSync(codeDir, { recursive: true });
            fs.writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2), 'utf-8');
        } catch (error) {
            return { ok: false, reason: 'ledger_write_failed', message: error.message };
        }
        return { ok: true, ledgerPath, written: true, entry: record };
    }

    archive(args = {}) {
        const demandDir = String(args.demandDir || '').trim();
        if (!demandDir) {
            return { ok: false, reason: 'missing_demand_dir', archived: [], missing: [], errors: [] };
        }
        const ledgerPath = path.join(demandDir, 'code', LEDGER_FILE_NAME);
        if (!fs.existsSync(ledgerPath)) {
            return {
                ok: true,
                ledgerPath,
                archived: [],
                missing: [],
                errors: [],
                note: 'no_ledger_found_skip_archive'
            };
        }
        const ledger = this._readLedger(ledgerPath);
        return {
            ok: true,
            ledgerPath,
            archived: [],
            missing: [],
            errors: [],
            mode: 'ledger_only_no_sidecar_manifest',
            materializedCount: ledger.entries.length,
            materializedFiles: ledger.entries.map(entry => ({
                moduleId: entry.moduleId || '',
                fileKind: entry.fileKind || '',
                targetFile: entry.targetFile || '',
                status: entry.status || ''
            }))
        };
    }

    _readLedger(ledgerPath) {
        if (fs.existsSync(ledgerPath)) {
            try {
                const parsed = JSON.parse(fs.readFileSync(ledgerPath, 'utf-8'));
                if (parsed && typeof parsed === 'object') {
                    return {
                        schemaVersion: LEDGER_SCHEMA,
                        entries: Array.isArray(parsed.entries) ? parsed.entries : []
                    };
                }
            } catch (_) {
                // 损坏的 ledger 视作空，但不删除原文件。
            }
        }
        return {
            schemaVersion: LEDGER_SCHEMA,
            entries: []
        };
    }

    _normalizeTarget(targetFile = '') {
        try {
            return path.resolve(String(targetFile || '').trim()).replace(/\\/g, '/').toLowerCase();
        } catch (_) {
            return String(targetFile || '').trim().replace(/\\/g, '/').toLowerCase();
        }
    }
}

module.exports = SkeletonManifestArchiveService;
