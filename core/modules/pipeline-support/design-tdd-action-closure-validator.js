const fs = require('fs');
const path = require('path');
const DesignTddRouteContractService = require('./design-tdd-route-contract-service');

function uniqueNonEmptyStrings(values = []) {
    const out = [];
    const seen = new Set();
    for (const value of (Array.isArray(values) ? values : [])) {
        const text = String(value || '').trim();
        if (!text || seen.has(text)) continue;
        seen.add(text);
        out.push(text);
    }
    return out;
}

class DesignTddActionClosureValidator {
    constructor(options = {}) {
        this.routeContractService = options.routeContractService || new DesignTddRouteContractService();
    }

    validate({ projectPath = '', codeDir = '' } = {}) {
        const normalizedProject = String(projectPath || '').trim() ? path.resolve(String(projectPath || '').trim()) : '';
        const normalizedCodeDir = String(codeDir || '').trim() ? path.resolve(String(codeDir || '').trim()) : '';
        const planJsonPath = path.join(normalizedCodeDir, 'design-tdd-plan.json');
        const businessFactsPath = path.join(normalizedCodeDir, 'business-facts.json');
        const planJson = this._readJson(planJsonPath);
        if (!planJson) {
            return { ok: true, skipped: true, reason: 'design-tdd-plan.json missing or invalid' };
        }

        const candidateFiles = this._collectCandidateFiles({
            normalizedProject,
            planJson,
            businessFacts: this._readJson(businessFactsPath) || {}
        });
        const htmlFiles = candidateFiles.filter(file => file.fileKind === 'HtmlPage' && this._isReadableFile(file.resolvedPath));
        const actionFiles = candidateFiles.filter(file => file.fileKind === 'Action' && this._isReadableFile(file.resolvedPath));
        if (htmlFiles.length === 0 || actionFiles.length === 0) {
            return { ok: true, checked: false, reason: 'no HtmlPage/Action candidate pair' };
        }

        return this.routeContractService.validate({
            projectPath: normalizedProject,
            candidateFiles,
            routeContracts: Array.isArray(planJson.routeContracts) ? planJson.routeContracts : null
        });
    }

    _collectCandidateFiles({ normalizedProject = '', planJson = {}, businessFacts = {} } = {}) {
        const out = [];
        const push = (file = {}) => {
            const fileKind = String(file && file.fileKind || '').trim();
            const rawPath = String(file && (file.resolvedPath || file.path || file.filePath) || '').trim();
            const resolvedPath = this._resolveInsideProject(normalizedProject, rawPath);
            if (!fileKind || !resolvedPath) return;
            out.push({
                fileKind,
                resolvedPath,
                moduleId: String(file && file.moduleId || '').trim(),
                subType: String(file && file.subType || '').trim()
            });
        };
        for (const moduleEntry of (Array.isArray(planJson.modulesOwnerFiles) ? planJson.modulesOwnerFiles : [])) {
            for (const ownerFile of (Array.isArray(moduleEntry && moduleEntry.ownerFiles) ? moduleEntry.ownerFiles : [])) {
                push({ ...ownerFile, moduleId: moduleEntry.moduleId || ownerFile.moduleId });
            }
        }
        const compositionModules = Array.isArray(planJson.skeletonComposition && planJson.skeletonComposition.modules)
            ? planJson.skeletonComposition.modules
            : [];
        for (const moduleEntry of compositionModules) {
            const moduleId = String(moduleEntry && moduleEntry.moduleId || '').trim();
            for (const unit of (Array.isArray(moduleEntry && moduleEntry.units) ? moduleEntry.units : [])) {
                for (const file of (Array.isArray(unit && unit.files) ? unit.files : [])) {
                    push({ ...file, moduleId: moduleId || file.moduleId });
                }
            }
        }
        for (const entry of (Array.isArray(planJson.existingUpdateTargets) ? planJson.existingUpdateTargets : [])) {
            push(entry);
        }
        for (const entry of (Array.isArray(businessFacts.historicalEntryFiles) ? businessFacts.historicalEntryFiles : [])) {
            push(entry);
        }
        const seen = new Set();
        return out.filter(file => {
            const key = `${file.fileKind}::${file.resolvedPath}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });
    }

    _collectFrontendCalls(htmlText = '') {
        const calls = [];
        const actionAttrRe = /\baction\s*=\s*["']([^"']+)["']/giu;
        let match;
        while ((match = actionAttrRe.exec(htmlText)) !== null) {
            const value = String(match[1] || '').trim();
            if (value && !this._isIgnoredActionValue(value)) {
                calls.push({ type: 'action_attr', raw: value });
            }
        }
        const executeRe = /\bepoint\.(?:execute|refresh)\s*\(\s*["']([^"']+)["']/giu;
        while ((match = executeRe.exec(htmlText)) !== null) {
            const value = String(match[1] || '').trim();
            if (value && !this._isIgnoredActionValue(value)) {
                calls.push({ type: 'epoint_call', raw: value });
            }
        }
        return uniqueNonEmptyStrings(calls.map(call => `${call.type}::${call.raw}`))
            .map(key => {
                const index = key.indexOf('::');
                return { type: key.slice(0, index), raw: key.slice(index + 2) };
            });
    }

    _collectActionMethods(actionFiles = []) {
        const out = new Map();
        for (const file of actionFiles) {
            const text = fs.readFileSync(file.resolvedPath, 'utf-8');
            const methods = new Set();
            const methodRe = /\bpublic\s+(?:<[^>]+>\s*)?(?:[\w$<>\[\],.?]+\s+)+([A-Za-z_$][\w$]*)\s*\(/gu;
            let match;
            while ((match = methodRe.exec(text)) !== null) {
                const methodName = String(match[1] || '').trim();
                if (methodName && methodName !== 'class' && methodName !== 'interface') methods.add(methodName);
            }
            out.set(file.resolvedPath, methods);
        }
        return out;
    }

    _methodNameFromCall(call = {}) {
        const raw = String(call.raw || '').trim();
        if (!raw) return '';
        const noQuery = raw.split('?')[0].split('#')[0].trim();
        const parts = noQuery.split('/').map(item => item.trim()).filter(Boolean);
        return parts.length > 0 ? parts[parts.length - 1] : noQuery;
    }

    _methodExists(methodName = '', actionMethods = new Map()) {
        const normalized = String(methodName || '').trim();
        if (!normalized) return true;
        for (const methods of actionMethods.values()) {
            if (methods.has(normalized)) return true;
        }
        return false;
    }

    _actionCandidateSummary(actionFiles = [], actionMethods = new Map()) {
        return actionFiles.map(file => ({
            path: file.resolvedPath,
            methods: Array.from(actionMethods.get(file.resolvedPath) || []).sort()
        }));
    }

    _isIgnoredActionValue(value = '') {
        const text = String(value || '').trim();
        if (!text) return true;
        if (/^(?:http|https|javascript|mailto):/iu.test(text)) return true;
        if (/^\$\{.*\}$/u.test(text)) return true;
        if (/[{}]/u.test(text)) return true;
        return false;
    }

    _readJson(filePath = '') {
        try {
            if (!filePath || !fs.existsSync(filePath)) return null;
            return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        } catch (_) {
            return null;
        }
    }

    _isReadableFile(filePath = '') {
        try {
            return filePath && fs.existsSync(filePath) && fs.statSync(filePath).isFile();
        } catch (_) {
            return false;
        }
    }

    _resolveInsideProject(projectPath = '', rawPath = '') {
        const root = String(projectPath || '').trim() ? path.resolve(String(projectPath || '').trim()) : '';
        const input = String(rawPath || '').trim();
        if (!root || !input || input.includes('\0')) return '';
        const resolved = path.isAbsolute(input) ? path.resolve(input) : path.resolve(root, input);
        return this._isSameOrChild(resolved, root) ? resolved : '';
    }

    _isSameOrChild(child = '', parent = '') {
        const c = path.resolve(child);
        const p = path.resolve(parent);
        return c === p || c.startsWith(p + path.sep);
    }
}

module.exports = DesignTddActionClosureValidator;
