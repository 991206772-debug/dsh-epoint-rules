/* eslint-disable */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// Only names and payloads produced by DesignWorkflowService are eligible.
const CONTENT_NAME = /^(?:structure|detail|page)-(?:card|story-evidence|objectProfiles|relations|pageCandidates|storyEvidenceRefs|codingFactCandidateRows|workflowOperationCandidates|relatedStoryIds|model|revision-answers)-[a-f0-9]{24}\.json$/;
const CONTENT_SCHEMAS = new Set(['design-decision-card/v3', 'design-detail-card/v4', 'design-page-card/v1',
    'design-story-evidence/v1', 'design-page-object-profiles/v1', 'design-page-evidence/v1',
    'design-detail-evidence/v1', 'design-canonical-model/v1']);

function isChild(target, root) {
    const relative = path.relative(path.resolve(root), path.resolve(target));
    return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function assertSafe(root, target) {
    if (!isChild(target, root)) throw new Error('清理目标不在当前受管目录内');
    // Also check ancestors above root: a linked .ai-workspace must not redirect deletion.
    for (let current = path.resolve(target); ; current = path.dirname(current)) {
        try {
            if (fs.lstatSync(current).isSymbolicLink()) throw new Error('清理路径包含符号链接');
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
        if (path.dirname(current) === current) break;
    }
}

function summary() {
    return { ok: true, removed: [], missing: [], errors: [], removedFiles: 0, removedBytes: 0 };
}

function removeFiles(root, files, { guard = () => true, result = summary() } = {}) {
    for (const target of files) {
        try {
            assertSafe(root, target);
            if (!guard(target)) { result.skipped = '清理前状态或引用资料已变化'; break; }
            if (!fs.existsSync(target)) { result.missing.push(target); continue; }
            const stat = fs.lstatSync(target);
            if (!stat.isFile()) throw new Error('清理目标不是普通文件');
            fs.unlinkSync(target);
            result.removed.push(target);
            result.removedFiles++;
            result.removedBytes += stat.size;
        } catch (error) {
            result.ok = false;
            result.errors.push({ path: target, message: String(error.message || error) });
        }
    }
    return result;
}

function removeEmpty(root, directory, result) {
    try {
        assertSafe(root, directory);
        if (fs.existsSync(directory) && fs.lstatSync(directory).isDirectory() && !fs.readdirSync(directory).length) {
            fs.rmdirSync(directory);
        }
    } catch (error) {
        result.ok = false;
        result.errors.push({ path: directory, message: String(error.message || error) });
    }
}

class StageTemporaryCleanupService {
    cleanDesign({ resolved, isCompleted }) {
        const result = summary();
        try {
            assertSafe(resolved.demandDir, resolved.runtimeDir);
            assertSafe(resolved.demandDir, resolved.workflowStatePath);
            assertSafe(resolved.demandDir, resolved.finalizeReceiptPath);
            assertSafe(resolved.demandDir, resolved.designJsonPath);
            const stateRaw = fs.readFileSync(resolved.workflowStatePath);
            const state = JSON.parse(stateRaw);
            if (state.currentPhase !== 'completed' || state.downstreamSyncPending || !isCompleted()) {
                return { ...result, skipped: '设计未完成或后续资料尚未同步' };
            }
            const candidates = new Map();
            for (const name of fs.readdirSync(resolved.runtimeDir)) {
                if (!CONTENT_NAME.test(name)) continue;
                const target = path.join(resolved.runtimeDir, name);
                assertSafe(resolved.runtimeDir, target);
                if (!fs.lstatSync(target).isFile()) continue;
                const raw = fs.readFileSync(target);
                let value;
                try { value = JSON.parse(raw); } catch (_) { continue; }
                const revision = name.includes('-revision-answers-') && Array.isArray(value.rows)
                    && ['replace_affected_page_rows', 'patch_by_stable_row_key'].includes(value.submissionMode);
                if (!CONTENT_SCHEMAS.has(value.schemaVersion) && !revision) continue;
                // A similarly named unknown file is not an owned content-addressed artifact.
                const digest = crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 24);
                if (!revision && !name.endsWith(`-${digest}.json`)) continue;
                candidates.set(target, { raw, value });
            }
            const snapshots = new Map([[resolved.workflowStatePath, stateRaw]]);
            const retained = new Set();
            const references = new Set();
            const collect = (value, source, key = '') => {
                if (Array.isArray(value)) return value.forEach(item => collect(item, source, key));
                if (value && typeof value === 'object') return Object.entries(value).forEach(([k, v]) => collect(v, source, k));
                if (typeof value !== 'string') return;
                const text = value.split('#')[0];
                const ref = path.isAbsolute(text) ? path.resolve(text)
                    : /(?:refs?|paths?)$/i.test(key) && /\.json$/i.test(text) ? path.resolve(path.dirname(source), text) : '';
                if (!ref || !isChild(ref, resolved.demandDir)) return;
                references.add(ref);
                if (candidates.has(ref)) {
                    if (retained.has(ref)) return;
                    retained.add(ref);
                    const candidate = candidates.get(ref);
                    snapshots.set(ref, candidate.raw);
                    collect(candidate.value, ref);
                } else if (CONTENT_NAME.test(path.basename(ref)) && !fs.existsSync(ref)) {
                    throw new Error(`引用分片缺失，保留恢复资料：${ref}`);
                }
            };
            const scan = directory => {
                for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
                    if (entry.name === '.projection-tx') continue;
                    const target = path.join(directory, entry.name);
                    assertSafe(resolved.demandDir, target);
                    if (entry.isDirectory()) scan(target);
                    else if (entry.isFile() && entry.name.endsWith('.json') && !candidates.has(target)) {
                        const raw = fs.readFileSync(target);
                        if (snapshots.has(target) && !raw.equals(snapshots.get(target))) {
                            throw new Error('清理前状态已变化，保留恢复资料');
                        }
                        snapshots.set(target, raw);
                        collect(JSON.parse(raw), target);
                    }
                }
            };
            // Fixed recovery files, formal receipts, and downstream navigation are roots.
            // Stale candidates are not roots; only reachable shards retain their successors.
            scan(resolved.demandDir);
            const guard = target => isCompleted() && Array.from(snapshots).every(([file, raw]) =>
                fs.existsSync(file) && fs.readFileSync(file).equals(raw))
                && (!candidates.has(target) || fs.readFileSync(target).equals(candidates.get(target).raw));
            const stale = Array.from(candidates.keys()).filter(file => !retained.has(file));
            removeFiles(resolved.runtimeDir, stale, { result, guard });
            if (!result.skipped) this._cleanFinalizeCopies(resolved, references, guard, result);
            return result;
        } catch (error) {
            result.ok = false;
            result.errors.push({ message: String(error.message || error) });
            return result;
        }
    }

    _cleanFinalizeCopies(resolved, references, guard, result) {
        const root = path.join(resolved.designDir, '.projection-tx');
        assertSafe(resolved.demandDir, root);
        if (!fs.existsSync(root)) return;
        const formalReceipt = fs.readFileSync(resolved.finalizeReceiptPath);
        const receipt = JSON.parse(formalReceipt);
        for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
            if (!entry.isDirectory() || !/^finalize-[A-Za-z0-9]{6}$/.test(entry.name)) continue;
            const directory = path.join(root, entry.name);
            try {
                assertSafe(root, directory);
                if (Array.from(references).some(ref => ref === directory || isChild(ref, directory))) continue;
                const receiptPath = path.join(directory, 'receipt.json');
                assertSafe(root, receiptPath);
                if (!fs.existsSync(receiptPath) || !fs.readFileSync(receiptPath).equals(formalReceipt)) continue;
                const expected = receipt.artifacts.map((artifact, index) => ({ artifact,
                    file: path.join(directory, `artifact-${index}${artifact.type === 'json' ? '.json' : '.txt'}`) }));
                const allowed = new Set(['receipt.json', 'before', ...expected.map(item => path.basename(item.file))]);
                if (fs.readdirSync(directory).some(name => !allowed.has(name))) continue;
                const files = [];
                let proven = true;
                for (const { artifact, file } of expected) {
                    assertSafe(resolved.demandDir, artifact.path);
                    assertSafe(root, file);
                    const formal = fs.readFileSync(artifact.path);
                    const hash = `sha256:${crypto.createHash('sha256').update(formal).digest('hex')}`;
                    if (hash !== artifact.contentHash || (fs.existsSync(file) && !fs.readFileSync(file).equals(formal))) {
                        proven = false; break;
                    }
                    if (fs.existsSync(file)) files.push(file);
                }
                const before = path.join(directory, 'before');
                assertSafe(root, before);
                if (fs.existsSync(before)) {
                    if (!fs.lstatSync(before).isDirectory()) proven = false;
                    else for (const name of fs.readdirSync(before)) {
                        const file = path.join(before, name);
                        assertSafe(root, file);
                        if (!/^(?:0|[1-9]\d*)\.bak$/.test(name) || Number(name.split('.')[0]) > expected.length
                            || !fs.lstatSync(file).isFile()) { proven = false; break; }
                        files.push(file);
                    }
                }
                if (!proven) continue;
                const errorCount = result.errors.length;
                const copies = new Map([...files, receiptPath].map(file => [file, fs.readFileSync(file)]));
                const copyGuard = target => guard(target) && fs.readFileSync(target).equals(copies.get(target));
                removeFiles(root, files, { guard: copyGuard, result });
                // Keep the commit proof until every other copy is removed, so failed deletion is retryable.
                if (result.skipped || result.errors.length !== errorCount) continue;
                removeFiles(root, [receiptPath], { guard: copyGuard, result });
                removeEmpty(root, before, result);
                removeEmpty(root, directory, result);
            } catch (error) {
                result.ok = false;
                result.errors.push({ path: directory, message: String(error.message || error) });
            }
        }
        removeEmpty(resolved.designDir, root, result);
    }
}

module.exports = { StageTemporaryCleanupService, removeFiles, removeEmpty, assertSafe, summary };
