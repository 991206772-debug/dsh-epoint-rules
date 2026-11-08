/* eslint-disable */

class WebsitePageRulesInputParser {
    constructor(owner) {
        this.owner = owner;
        return new Proxy(this, {
            get(target, prop, receiver) {
                if (prop in target) {
                    const value = Reflect.get(target, prop, receiver);
                    return typeof value === 'function' ? value.bind(receiver) : value;
                }
                const owner = target.owner || {};
                const value = owner[prop];
                return typeof value === 'function' ? value.bind(owner) : value;
            }
        });
    }

    extractLooseWebsiteAnchorTuple(text = '') {
        const normalized = String(text || '').trim();
        if (!normalized) return {};
        // 逗号分隔格式：wanttodo.html, lszwfw, hall, 950及以上
        const parts = normalized.split(/[,，]+/).map(p => p.trim()).filter(Boolean);
        if (parts.length < 3) return {};
        const htmlIndex = parts.findIndex(p => /\.html$/i.test(p));
        if (htmlIndex < 0) return {};
        const samplePage = parts[htmlIndex];
        // 在 html 后面的第一个有效 slug 作为 targetFolder
        const afterHtml = parts.slice(htmlIndex + 1).filter(p => !/^\d+$/.test(p) && !/950/i.test(p));
        if (afterHtml.length === 0) return { samplePage };
        const targetFolder = afterHtml[0];
        // 再后面一个作为 subPath（跳过框架档位）
        const subPathCandidates = afterHtml.slice(1).filter(p => !/^\d+$/.test(p) && !/950/i.test(p));
        let subPath = subPathCandidates[0] || '';
        if (subPath) {
            subPath = subPath.replace(/\\/g, '/').replace(/^\/+/, '');
            if (!subPath.endsWith('/')) subPath += '/';
        }
        const result = { samplePage, targetFolder };
        if (subPath) result.subPath = subPath;
        return result;
    }

    /** 标准化子路径：若末尾无斜杠则追加 */
    _normalizeSubPath(value = '') {
        const raw = String(value || '').trim().replace(/\\/g, '/').replace(/^\/+/, '');
        if (!raw) return '';
        return raw.endsWith('/') ? raw : raw + '/';
    }

    _tokenizeLooseAnchorParts(text = '') {
        return String(text || '')
            .split(/[,，]+/)
            .map(item => item.trim())
            .filter(Boolean);
    }

    _looksLikeFrameworkBucketToken(value = '') {
        const text = String(value || '').trim();
        return /950/i.test(text) || /^(?:1|2)$/.test(text);
    }

    _looksLikeHtmlToken(value = '') {
        return /\.html$/i.test(String(value || '').trim());
    }

    _looksLikePathToken(value = '') {
        return /[\\/]/.test(String(value || '').trim());
    }

    _looksLikeSlugToken(value = '') {
        return /^[A-Za-z0-9_-]{2,}$/.test(String(value || '').trim());
    }

    extractSamplePageInput(userIntent = '') {
        const text = String(userIntent || '').trim();
        if (!text) return '';
        // 标签格式优先
        const labeledMatch = text.match(/(?:基准参考页面|参考页面|样本页面|sample\s*page)\s*[:：]\s*([^\s'"]+?\.html)\b/i);
        if (labeledMatch) return labeledMatch[1].trim();
        // 松散紧凑格式
        const loose = this.extractLooseWebsiteAnchorTuple(text);
        if (loose.samplePage) return loose.samplePage;
        // 通用 html 文件匹配（不因框架档位短路）
        const htmlMatch = text.match(/([A-Za-z]:[^\s'"]+?\.html|[^\s'"]+?\.html)/i);
        return htmlMatch ? htmlMatch[1].trim() : '';
    }

    extractTargetFolderInput(userIntent = '') {
        const text = String(userIntent || '').trim();
        if (!text) return '';
        // 标签格式优先
        const labeledMatch = text.match(/(?:所属文件夹名|网站所属文件夹名|文件夹名|folder)\s*[:：]\s*([A-Za-z0-9_-]{2,})/i);
        if (labeledMatch) return labeledMatch[1].trim();
        // 松散紧凑格式
        const loose = this.extractLooseWebsiteAnchorTuple(text);
        if (loose.targetFolder) return loose.targetFolder;
        // 纯 slug 作为回退
        if (/[\\/]/.test(text) || /\.html\b/i.test(text)) return '';
        if (/^[A-Za-z0-9_-]{2,}$/.test(text)) return text;
        return '';
    }

    extractSubPathInput(userIntent = '') {
        const text = String(userIntent || '').trim();
        if (!text) return '';
        // 标签格式优先
        const labeledMatch = text.match(/(?:新页面子路径|子路径|页面子路径|sub\s*path)\s*[:：]\s*([A-Za-z0-9_./-]+\/?)/i);
        if (labeledMatch) {
            return this._normalizeSubPath(labeledMatch[1]);
        }
        // 松散紧凑格式
        const loose = this.extractLooseWebsiteAnchorTuple(text);
        if (loose.subPath) return loose.subPath;
        // 通用路径匹配
        if (/\.html\b/i.test(text)) return '';
        const pathMatch = text.match(/\b([A-Za-z0-9_-]+(?:\/[A-Za-z0-9_.-]+)+\/?)\b/);
        if (pathMatch) {
            return this._normalizeSubPath(pathMatch[1]);
        }
        return '';
    }

    extractWebsiteTripleAnchorInputs(userIntent = '', existing = {}) {
        const text = String(userIntent || '').trim();
        const existingSamplePages = Array.isArray(existing.samplePages)
            ? existing.samplePages.map(item => String(item || '').trim()).filter(Boolean)
            : [];
        const merged = {
            samplePage: String(existing.samplePage || '').trim(),
            samplePages: [...new Set(existingSamplePages)],
            targetFolder: String(existing.targetFolder || '').trim(),
            subPath: String(existing.subPath || '').trim()
        };
        const folderLabeled = /(?:所属文件夹名|网站所属文件夹名|文件夹名|folder)\s*[:：]/i.test(text);
        const subPathLabeled = /(?:新页面子路径|子路径|页面子路径|sub\s*path)\s*[:：]/i.test(text);
        const samplePage = this.extractSamplePageInput(text);
        const inlineSamplePages = [...text.matchAll(/([A-Za-z]:[^\s'"]+?\.html|[^\s'"]+?\.html)/gi)]
            .map(match => String(match[1] || match[0] || '')
                .replace(/^(?:基准参考页面|参考页面|样本页面|sample\s*page)\s*[:：]\s*/i, '')
                .trim())
            .filter(Boolean);
        const targetFolder = folderLabeled ? this.extractTargetFolderInput(text) : '';
        const subPath = subPathLabeled ? this.extractSubPathInput(text) : '';
        if (samplePage) merged.samplePage = samplePage;
        [...inlineSamplePages, samplePage].filter(Boolean).forEach(item => {
            if (!merged.samplePages.includes(item)) merged.samplePages.push(item);
        });
        if (targetFolder) merged.targetFolder = targetFolder;
        if (subPath) merged.subPath = subPath;
        const parts = this._tokenizeLooseAnchorParts(text)
            .filter(item => !this._looksLikeFrameworkBucketToken(item));
        if (parts.length > 0 || text) {
            const loose = this.extractLooseWebsiteAnchorTuple(text);
            if (!merged.samplePage && loose.samplePage) merged.samplePage = loose.samplePage;
            if (loose.samplePage && !merged.samplePages.includes(loose.samplePage)) merged.samplePages.push(loose.samplePage);
            if (!merged.targetFolder && loose.targetFolder) merged.targetFolder = loose.targetFolder;
            if (!merged.subPath && loose.subPath) merged.subPath = loose.subPath;

            const htmlToken = parts.find(item => this._looksLikeHtmlToken(item));
            const candidates = parts.filter(item => item !== htmlToken);
            const unresolved = ['samplePage', 'targetFolder'].filter(key => !merged[key]);
            if (unresolved.length === 1 && candidates.length === 1) {
                const only = candidates[0];
                if (unresolved[0] === 'targetFolder' && this._looksLikeSlugToken(only)) {
                    merged.targetFolder = only;
                }
            }
            if (!merged.targetFolder && !folderLabeled) {
                const folderCandidate = candidates.find(item => this._looksLikeSlugToken(item));
                if (folderCandidate) merged.targetFolder = folderCandidate;
            }
        }
        if (!merged.samplePage && merged.samplePages.length > 0) merged.samplePage = merged.samplePages[0];
        return {
            ...merged,
            missingKeys: ['samplePage', 'targetFolder'].filter(key => !merged[key])
        };
    }

    resolveContract(ruleContext = {}, options = {}) {
        const contractPath = String(ruleContext && ruleContext.pageRulesContractPath || '').trim();
        if (!contractPath) {
            return { ok: false, message: 'PAGE_RULES_FRONTEND_CONTRACT_MISSING' };
        }
        return this.validateContract(contractPath, options);
    }

}

module.exports = WebsitePageRulesInputParser;
