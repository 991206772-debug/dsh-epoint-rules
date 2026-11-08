/* eslint-disable */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function sha256File(filePath) {
    try {
        if (!fs.existsSync(filePath)) return null;
        return `sha256:${crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')}`;
    } catch (_) {
        return null;
    }
}

function isChild(candidate, root) {
    const rel = path.relative(path.resolve(root), path.resolve(candidate));
    return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}

class ProjectionTransactionService {
    discardStaging({ stagingDir = '', managedRoots = [] } = {}) {
        const dir = path.resolve(stagingDir);
        if (path.basename(path.dirname(dir)) !== '.projection-tx'
            || !managedRoots.some(root => isChild(dir, root) && path.resolve(root) !== dir)) return false;
        if (!fs.existsSync(dir)) return true;
        const safeTree = target => {
            if (fs.lstatSync(target).isSymbolicLink()) return false;
            return !fs.statSync(target).isDirectory() || fs.readdirSync(target)
                .every(name => safeTree(path.join(target, name)));
        };
        try {
            let parent = dir;
            const root = path.resolve(managedRoots.find(item => isChild(dir, item)));
            while (true) {
                if (fs.lstatSync(parent).isSymbolicLink()) return false;
                if (path.relative(root, parent) === '') break;
                parent = path.dirname(parent);
            }
            if (!safeTree(dir)) return false;
            fs.rmSync(dir, { recursive: true, force: true });
            return true;
        } catch (_) { return false; }
    }

    cleanOrphanedStaging({ rootDir = '', transactionRoot = '' } = {}) {
        const root = path.resolve(rootDir);
        const txRoot = path.resolve(transactionRoot);
        if (txRoot !== path.join(root, '.projection-tx') || !fs.existsSync(txRoot) || fs.lstatSync(root).isSymbolicLink()
            || fs.lstatSync(txRoot).isSymbolicLink()) return;
        const candidates = fs.readdirSync(txRoot, { withFileTypes: true })
            .filter(entry => entry.isDirectory() && /^(?:plan|coder-material)-/.test(entry.name))
            .map(entry => path.join(txRoot, entry.name));
        if (!candidates.length) return;
        const hasJournal = dir => fs.readdirSync(dir, { withFileTypes: true }).some(entry =>
            entry.isSymbolicLink() || entry.name === 'projection-transaction.json'
                || (entry.isDirectory() && hasJournal(path.join(dir, entry.name))));
        const liveOwner = dir => {
            const match = path.basename(dir).match(/^(?:plan|coder-material)-(\d+)-/);
            if (!match) return false;
            try { process.kill(Number(match[1]), 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
        };
        try {
            if (candidates.some(dir => hasJournal(dir) || liveOwner(dir))) return;
            const references = [];
            const collect = value => {
                if (typeof value === 'string' && path.isAbsolute(value.split('#')[0])) references.push(path.resolve(value.split('#')[0]));
                else if (Array.isArray(value)) value.forEach(collect);
                else if (value && typeof value === 'object') Object.values(value).forEach(collect);
            };
            const read = dir => {
                for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                    if (entry.isSymbolicLink() || entry.name === '.projection-tx') continue;
                    const target = path.join(dir, entry.name);
                    if (entry.isDirectory()) read(target);
                    else if (entry.isFile() && entry.name.endsWith('.json')) collect(JSON.parse(fs.readFileSync(target, 'utf8')));
                }
            };
            read(root);
            for (const dir of candidates) {
                if (!references.some(ref => isChild(ref, dir))) this.discardStaging({ stagingDir: dir, managedRoots: [root] });
            }
        } catch (_) { /* Unreadable references cannot prove an orphan safe to delete. */ }
    }

    recoverPending({ managedRoots = [], transactionRoot = '' } = {}) {
        const root = path.resolve(String(transactionRoot || '').trim());
        const results = [];
        if (!root || !fs.existsSync(root)) return { ok: true, status: 'none', results };
        let entries;
        try { entries = fs.readdirSync(root, { withFileTypes: true }); }
        catch (error) { return this._blocked('FRAMEWORK_PROJECTION_TRANSACTION_RECOVERY_DEFECT', '无法读取待恢复事务目录。', { cause: String(error.message || error) }); }
        for (const entry of entries) {
            if (!entry.isDirectory()) continue;
            const transactionPath = path.join(root, entry.name, 'projection-transaction.json');
            if (!fs.existsSync(transactionPath)) continue;
            const recovered = this.recover({ managedRoots, transactionPath });
            results.push({ transactionPath, ...recovered });
            if (!recovered.ok) return { ...recovered, results };
        }
        return { ok: true, status: results.length ? 'recovered' : 'none', results };
    }

    publishFiles({ rootDir, stagingDir, files = [], oldRevision = '', newRevision = '' }) {
        const targets = files.map((file, index) => {
            const beforePath = path.join(stagingDir, 'before', `${index}.bak`);
            const oldExists = fs.existsSync(file.path);
            if (oldExists) {
                fs.mkdirSync(path.dirname(beforePath), { recursive: true });
                fs.copyFileSync(file.path, beforePath);
            }
            return { path: file.path, oldExists, oldHash: oldExists ? sha256File(file.path) : null,
                beforePath: oldExists ? beforePath : '', newExists: Boolean(file.newPath),
                newPath: file.newPath || '', newHash: file.newPath ? sha256File(file.newPath) : null };
        });
        const prepared = this.prepare({ managedRoots: [rootDir], transactionDir: stagingDir,
            targets, oldRevision, newRevision });
        if (!prepared.ok) return prepared;
        const result = this.apply({ transactionPath: prepared.transactionPath });
        if (!result.ok) {
            const recovery = this.recover({ managedRoots: [rootDir], transactionPath: prepared.transactionPath });
            return { ...result, recovery, machineRecoverable: recovery.ok === true, stopLockRequired: recovery.ok !== true };
        }
        return this.recover({ managedRoots: [rootDir], transactionPath: prepared.transactionPath });
    }

    prepare({ managedRoots = [], transactionDir = '', targets = [], oldRevision = '', newRevision = '' } = {}) {
        const roots = managedRoots.map(item => path.resolve(String(item || '').trim())).filter(Boolean);
        const normalizedTargets = [];
        for (const raw of Array.isArray(targets) ? targets : []) {
            const target = {
                path: path.resolve(String(raw && raw.path || '').trim()),
                oldExists: raw && raw.oldExists === true,
                newExists: raw && raw.newExists === true,
                oldHash: raw && raw.oldHash ? String(raw.oldHash) : null,
                newHash: raw && raw.newHash ? String(raw.newHash) : null,
                beforePath: raw && raw.beforePath ? path.resolve(String(raw.beforePath)) : '',
                newPath: raw && raw.newPath ? path.resolve(String(raw.newPath)) : ''
            };
            if (!target.path || !roots.some(root => isChild(target.path, root))) return this._blocked('FRAMEWORK_PROJECTION_TRANSACTION_RECOVERY_DEFECT', `事务目标越出 managedRoots：${target.path}`);
            if (!target.oldExists && !target.newExists) return this._blocked('FRAMEWORK_PROJECTION_TRANSACTION_RECOVERY_DEFECT', `事务目标 oldExists/newExists 不能同时为 false：${target.path}`);
            if (target.oldExists && (!target.oldHash || !target.beforePath)) return this._blocked('FRAMEWORK_PROJECTION_TRANSACTION_RECOVERY_DEFECT', `旧文件事务缺少 oldHash/beforePath：${target.path}`);
            if (target.oldExists && !fs.existsSync(target.path)) return this._blocked('FRAMEWORK_PROJECTION_TRANSACTION_RECOVERY_DEFECT', `oldExists=true 但正式文件不存在：${target.path}`);
            if (target.oldExists && sha256File(target.path) !== target.oldHash) return this._blocked('FRAMEWORK_PROJECTION_TRANSACTION_RECOVERY_DEFECT', `正式文件 oldHash 不匹配：${target.path}`);
            if (target.oldExists && (!fs.existsSync(target.beforePath) || sha256File(target.beforePath) !== target.oldHash)) {
                return this._blocked('FRAMEWORK_PROJECTION_TRANSACTION_RECOVERY_DEFECT', `before-image 缺失或 hash 不符：${target.path}`);
            }
            if (target.newExists && (!target.newHash || !target.newPath)) return this._blocked('FRAMEWORK_PROJECTION_TRANSACTION_RECOVERY_DEFECT', `新文件事务缺少 newHash/newPath：${target.path}`);
            if (target.newPath && !isChild(target.newPath, roots.find(root => isChild(target.path, root)) || roots[0])) return this._blocked('FRAMEWORK_PROJECTION_TRANSACTION_RECOVERY_DEFECT', `newPath 越出 managedRoots：${target.newPath}`);
            if (target.newExists && (!fs.existsSync(target.newPath) || sha256File(target.newPath) !== target.newHash)) {
                return this._blocked('FRAMEWORK_PROJECTION_TRANSACTION_RECOVERY_DEFECT', `new-image 缺失或 hash 不符：${target.path}`);
            }
            normalizedTargets.push(target);
        }
        const dir = path.resolve(String(transactionDir || '').trim());
        if (!dir || !roots.some(root => isChild(dir, root))) return this._blocked('FRAMEWORK_PROJECTION_TRANSACTION_RECOVERY_DEFECT', '事务目录越出 managedRoots。');
        try {
            fs.mkdirSync(dir, { recursive: true });
            const commitId = `projection_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`;
            const transactionPath = path.join(dir, 'projection-transaction.json');
            const journal = {
                schemaVersion: 'design-tdd-projection-transaction/v1',
                commitId,
                status: 'prepared',
                oldRevision: String(oldRevision || ''),
                newRevision: String(newRevision || ''),
                targets: normalizedTargets,
                managedRoots: roots
            };
            fs.writeFileSync(transactionPath, `${JSON.stringify(journal, null, 2)}\n`, 'utf-8');
            return { ok: true, status: 'prepared', commitId, transactionPath, journal };
        } catch (error) {
            return this._blocked('FRAMEWORK_PROJECTION_TRANSACTION_PREPARE_FAILED', 'WAL 写入失败。', { cause: String(error.message || error) });
        }
    }

    apply({ transactionPath = '' } = {}) {
        const targetPath = path.resolve(String(transactionPath || '').trim());
        if (!targetPath || !fs.existsSync(targetPath)) return this._blocked('FRAMEWORK_PROJECTION_TRANSACTION_NOT_FOUND', '找不到 projection-transaction.json。');
        let journal;
        try { journal = JSON.parse(fs.readFileSync(targetPath, 'utf-8')); } catch (error) {
            return this._blocked('FRAMEWORK_PROJECTION_TRANSACTION_RECOVERY_DEFECT', 'projection-transaction.json 无法解析。', { cause: String(error.message || error) });
        }
        if (!['prepared', 'applying'].includes(String(journal.status || ''))) return this._blocked('FRAMEWORK_PROJECTION_TRANSACTION_RECOVERY_DEFECT', '事务状态不是 prepared/applying。');
        journal.status = 'applying';
        fs.writeFileSync(targetPath, `${JSON.stringify(journal, null, 2)}\n`, 'utf-8');
        try {
            for (const item of journal.targets || []) {
                if (item.newExists) {
                    if (!item.newPath || !fs.existsSync(item.newPath) || sha256File(item.newPath) !== item.newHash) {
                        return this._blocked('FRAMEWORK_PROJECTION_TRANSACTION_RECOVERY_DEFECT', `new-image 缺失或 hash 不符：${item.path}`);
                    }
                    fs.mkdirSync(path.dirname(item.path), { recursive: true });
                    fs.copyFileSync(item.newPath, item.path);
                } else if (fs.existsSync(item.path)) {
                    if (item.oldExists && item.oldHash && sha256File(item.path) !== item.oldHash) {
                        return this._blocked('FRAMEWORK_PROJECTION_TRANSACTION_RECOVERY_DEFECT', `删除目标已被外部修改，拒绝误删：${item.path}`);
                    }
                    fs.rmSync(item.path, { force: true });
                }
                if (!this._matchesState(item, true)) return this._blocked('FRAMEWORK_PROJECTION_TRANSACTION_RECOVERY_DEFECT', `事务写盘后 newHash 不匹配：${item.path}`);
            }
            journal.status = 'committed';
            fs.writeFileSync(targetPath, `${JSON.stringify(journal, null, 2)}\n`, 'utf-8');
            return { ok: true, status: 'committed', commitId: journal.commitId, transactionPath: targetPath };
        } catch (error) {
            return this._blocked('FRAMEWORK_PROJECTION_TRANSACTION_APPLY_FAILED', 'WAL 应用失败。', { cause: String(error.message || error), transactionPath: targetPath });
        }
    }

    recover({ managedRoots = [], transactionPath = '' } = {}) {
        const targetPath = path.resolve(String(transactionPath || '').trim());
        if (!targetPath || !fs.existsSync(targetPath)) return { ok: true, status: 'none' };
        let journal;
        try {
            journal = JSON.parse(fs.readFileSync(targetPath, 'utf-8'));
        } catch (error) {
            return this._blocked('FRAMEWORK_PROJECTION_TRANSACTION_RECOVERY_DEFECT', 'projection-transaction.json 无法解析。', { cause: String(error.message || error) });
        }
        const roots = managedRoots.map(item => path.resolve(String(item || '').trim())).filter(Boolean);
        if (!Array.isArray(journal.targets) || journal.targets.some(item => !roots.some(root => isChild(item.path, root))
            || (item.newPath && !roots.some(root => isChild(item.newPath, root)))
            || (item.beforePath && !roots.some(root => isChild(item.beforePath, root))))) {
            return this._blocked('FRAMEWORK_PROJECTION_TRANSACTION_RECOVERY_DEFECT', 'WAL 目标越出当前 managedRoots。');
        }
        for (const item of journal.targets) {
            if ((!item.oldExists && !item.newExists)
                || (item.oldExists && (!item.oldHash || !item.beforePath || !fs.existsSync(item.beforePath) || sha256File(item.beforePath) !== item.oldHash))
                || (item.newExists && (!item.newHash || !item.newPath || !fs.existsSync(item.newPath) || sha256File(item.newPath) !== item.newHash))) {
                return this._blocked('FRAMEWORK_PROJECTION_TRANSACTION_RECOVERY_DEFECT', `WAL before/new 证据缺失或 hash 不符：${item.path}`);
            }
        }
        if (journal.status === 'committed') {
            if (!journal.targets.every(item => this._matchesState(item, true))) {
                return this._blocked('FRAMEWORK_PROJECTION_TRANSACTION_RECOVERY_DEFECT', '已提交 WAL 的正式目标 hash 不一致，拒绝清理。');
            }
            try { fs.rmSync(targetPath, { force: true }); } catch (_) {}
            this.discardStaging({ stagingDir: path.dirname(targetPath), managedRoots: roots });
            return { ok: true, status: 'cleaned', commitId: journal.commitId };
        }
        const targets = journal.targets;
        const allNew = targets.every(item => this._matchesState(item, true));
        if (allNew) {
            journal.status = 'committed';
            try {
                fs.writeFileSync(targetPath, `${JSON.stringify(journal, null, 2)}\n`, 'utf-8');
                fs.rmSync(targetPath, { force: true });
            } catch (_) {}
            this.discardStaging({ stagingDir: path.dirname(targetPath), managedRoots: roots });
            return { ok: true, status: 'completed', commitId: journal.commitId };
        }
        for (const item of targets) {
            const restored = this._restoreTarget(item);
            if (!restored.ok) return restored;
        }
        try { fs.rmSync(targetPath, { force: true }); } catch (_) {}
        this.discardStaging({ stagingDir: path.dirname(targetPath), managedRoots: roots });
        return { ok: true, status: 'rolled_back', commitId: journal.commitId };
    }

    _matchesState(item, newState) {
        const exists = fs.existsSync(item.path);
        const expectedExists = newState ? item.newExists : item.oldExists;
        const expectedHash = newState ? item.newHash : item.oldHash;
        if (exists !== expectedExists) return false;
        if (!exists) return true;
        return !expectedHash || sha256File(item.path) === expectedHash;
    }

    _restoreTarget(item) {
        const exists = fs.existsSync(item.path);
        if (exists && item.oldExists && item.oldHash) {
            const currentHash = sha256File(item.path);
            const matchesOld = currentHash === item.oldHash;
            const matchesNew = item.newExists && item.newHash && currentHash === item.newHash;
            if (!matchesOld && !matchesNew) {
                return this._blocked('FRAMEWORK_PROJECTION_TRANSACTION_RECOVERY_DEFECT', `正式文件已被外部修改，拒绝覆盖：${item.path}`);
            }
        }
        if (exists && !item.oldExists && item.newExists && item.newHash && sha256File(item.path) !== item.newHash) {
            return this._blocked('FRAMEWORK_PROJECTION_TRANSACTION_RECOVERY_DEFECT', `正式文件已被外部修改，拒绝覆盖：${item.path}`);
        }
        if (!item.oldExists) {
            if (!exists) return { ok: true };
            if (item.newHash && sha256File(item.path) !== item.newHash) return this._blocked('FRAMEWORK_PROJECTION_TRANSACTION_RECOVERY_DEFECT', `新文件已被外部修改，拒绝误删：${item.path}`);
            try { fs.rmSync(item.path, { force: true }); return { ok: true }; } catch (error) {
                return this._blocked('FRAMEWORK_PROJECTION_TRANSACTION_RECOVERY_DEFECT', `新文件回滚失败：${item.path}`, { cause: String(error.message || error) });
            }
        }
        if (exists && item.oldHash && sha256File(item.path) === item.oldHash) return { ok: true };
        if (!item.beforePath || !fs.existsSync(item.beforePath) || sha256File(item.beforePath) !== item.oldHash) {
            return this._blocked('FRAMEWORK_PROJECTION_TRANSACTION_RECOVERY_DEFECT', `before-image 缺失或 hash 不符：${item.path}`);
        }
        try {
            fs.mkdirSync(path.dirname(item.path), { recursive: true });
            fs.copyFileSync(item.beforePath, item.path);
            if (sha256File(item.path) !== item.oldHash) return this._blocked('FRAMEWORK_PROJECTION_TRANSACTION_RECOVERY_DEFECT', `旧文件恢复 hash 不符：${item.path}`);
            return { ok: true };
        } catch (error) {
            return this._blocked('FRAMEWORK_PROJECTION_TRANSACTION_RECOVERY_DEFECT', `旧文件回滚失败：${item.path}`, { cause: String(error.message || error) });
        }
    }

    _blocked(errorCode, message, extra = {}) {
        return { ok: false, status: 'blocked', errorCode, message, ...extra };
    }
}

module.exports = ProjectionTransactionService;
