/* eslint-disable */
const fs = require('fs');
const path = require('path');
const PipelineUtils = require('../pipeline-utils');

class FrameworkVersionService {
    constructor(options = {}) {
        this.bucketOptions = Array.isArray(options.bucketOptions) ? [...options.bucketOptions] : [];
        this.framework = String(options.framework || 'management').trim() || 'management';
        this.choiceMap = options.choiceMap && typeof options.choiceMap === 'object'
            ? { ...options.choiceMap }
            : {
                1: '950及以上',
                2: '950以下',
                '950+': '950及以上',
                '950以上': '950及以上',
                '950及上': '950及以上',
                '950plus': '950及以上',
                '950-': '950以下'
            };
        this.getProjectStructurePaths = options.getProjectStructurePaths;
        this.ensureDirectoryExists = options.ensureDirectoryExists;
    }

    getOptions() {
        return [...this.bucketOptions];
    }

    extractInput(userIntent = '') {
        const text = String(userIntent || '').trim();
        const explicitMatch = text.match(/(?:框架(?:版本)?档位|版本桶|versionBucket|frameworkVersionBucket|bucket)\s*[:：=]?\s*(950及以上|950以下|950\+|950以上|950及上|950-|[12])/iu);
        const directBucketMatch = text.match(/(950及以上|950以下|950\+|950以上|950及上|950-)/u);
        const looseChoiceMatch = text.match(/(?:^|[\r\n])\s*([12])(?=\s*(?:[,，、]|\s|$))/u);
        const candidate = explicitMatch
            ? explicitMatch[1]
            : (directBucketMatch
                ? directBucketMatch[1]
                : (looseChoiceMatch ? looseChoiceMatch[1] : text));
        return PipelineUtils.resolveFiniteChoiceInput(
            candidate,
            this.bucketOptions,
            this.choiceMap
        );
    }

    writeBucket(projectPath, versionBucket, source = 'user-input') {
        const paths = this._getPaths(projectPath);
        this._ensureDir(paths.structureDir);
        const frameworkVersionEvidence = this.detectFrameworkVersion(projectPath);
        const payload = {
            framework: this.framework,
            versionBucket,
            source,
            evidence: frameworkVersionEvidence.ok ? frameworkVersionEvidence : null,
            updatedAt: new Date().toISOString()
        };
        fs.writeFileSync(paths.frameworkBucketPath, JSON.stringify(payload, null, 2), 'utf-8');
        return { path: paths.frameworkBucketPath, payload };
    }

    validateBucket(projectPath) {
        const paths = this._getPaths(projectPath);
        const frameworkVersionEvidence = this.detectFrameworkVersion(projectPath);
        if (!fs.existsSync(paths.frameworkBucketPath)) {
            return {
                ok: false,
                message: `FRAMEWORK_VERSION_BUCKET_MISSING: ${paths.frameworkBucketPath}`,
                path: paths.frameworkBucketPath,
                bucketSource: 'missing',
                frameworkVersionEvidence,
                suggestedBucket: frameworkVersionEvidence.suggestedBucket || ''
            };
        }

        let payload = null;
        try {
            payload = JSON.parse(fs.readFileSync(paths.frameworkBucketPath, 'utf-8'));
        } catch (error) {
            return {
                ok: false,
                message: `FRAMEWORK_VERSION_BUCKET_PARSE_ERROR: ${error.message}`,
                path: paths.frameworkBucketPath,
                bucketSource: 'parse-error',
                frameworkVersionEvidence,
                suggestedBucket: frameworkVersionEvidence.suggestedBucket || ''
            };
        }

        const normalized = PipelineUtils.resolveFrameworkVersionBucketPayload(payload, this.bucketOptions);
        const versionBucket = normalized.versionBucket;
        if (!this.bucketOptions.includes(versionBucket)) {
            return {
                ok: false,
                message: PipelineUtils.buildFrameworkVersionBucketInvalidMessage(payload, this.bucketOptions),
                path: paths.frameworkBucketPath,
                payload,
                bucketSource: 'invalid-file',
                frameworkVersionEvidence,
                suggestedBucket: frameworkVersionEvidence.suggestedBucket || ''
            };
        }

        const normalizedFramework = String(payload && payload.framework || this.framework).trim() || this.framework;
        if (normalized.sourceKey !== 'versionBucket' || normalizedFramework !== this.framework) {
            const rewriteResult = this.writeBucket(projectPath, versionBucket);
            payload = rewriteResult.payload;
        }

        return {
            ok: true,
            path: paths.frameworkBucketPath,
            payload,
            framework: String(payload.framework || this.framework).trim() || this.framework,
            versionBucket,
            bucketSource: 'existing-file',
            frameworkVersionEvidence,
            suggestedBucket: frameworkVersionEvidence.suggestedBucket || ''
        };
    }

    prepareBucket(projectPath, userIntent = '') {
        const explicitBucket = this.extractInput(userIntent);
        const validation = this.validateBucket(projectPath);
        if (explicitBucket) {
            if (validation.ok && validation.versionBucket === explicitBucket) {
                return {
                    ok: true,
                    source: 'existing',
                    framework: validation.framework,
                    versionBucket: validation.versionBucket,
                    path: validation.path,
                    bucketSource: validation.bucketSource || 'existing-file',
                    frameworkVersionEvidence: validation.frameworkVersionEvidence,
                    suggestedBucket: validation.suggestedBucket || ''
                };
            }
            const writeResult = this.writeBucket(projectPath, explicitBucket);
            return {
                ok: true,
                source: 'user-input',
                framework: writeResult.payload.framework,
                versionBucket: explicitBucket,
                path: writeResult.path,
                bucketSource: 'user-input',
                frameworkVersionEvidence: writeResult.payload.evidence || this.detectFrameworkVersion(projectPath),
                suggestedBucket: explicitBucket
            };
        }

        if (!validation.ok) {
            const projectContextResult = this.detectFromProjectContext(projectPath);
            if (projectContextResult.ok) {
                const writeResult = this.writeBucket(projectPath, projectContextResult.versionBucket, 'project-context');
                return {
                    ok: true,
                    source: 'project-context',
                    framework: writeResult.payload.framework,
                    versionBucket: projectContextResult.versionBucket,
                    path: writeResult.path,
                    bucketSource: 'project-context',
                    frameworkVersionEvidence: writeResult.payload.evidence || this.detectFrameworkVersion(projectPath),
                    suggestedBucket: projectContextResult.versionBucket,
                    projectContextFrameVersion: projectContextResult.frameVersion
                };
            }
            return {
                ok: false,
                needsInput: true,
                path: validation.path,
                options: this.getOptions(),
                message: validation.message,
                bucketSource: validation.bucketSource || 'missing',
                frameworkVersionEvidence: validation.frameworkVersionEvidence,
                suggestedBucket: validation.suggestedBucket || ''
            };
        }

        return {
            ok: true,
            source: 'existing',
            framework: validation.framework,
            versionBucket: validation.versionBucket,
            path: validation.path,
            bucketSource: validation.bucketSource || 'existing-file',
            frameworkVersionEvidence: validation.frameworkVersionEvidence,
            suggestedBucket: validation.suggestedBucket || ''
        };
    }

    detectFromProjectContext(projectPath) {
        const root = String(projectPath || '').trim();
        if (!root || !fs.existsSync(root)) {
            return { ok: false, source: 'project-context', message: 'PROJECT_PATH_MISSING' };
        }
        const candidates = [
            path.join(root, '_docs', 'project-context.md'),
            path.join(root, 'docs', '_docs', 'project-context.md')
        ];
        for (const filePath of candidates) {
            if (!fs.existsSync(filePath)) continue;
            let text = '';
            try { text = fs.readFileSync(filePath, 'utf-8'); } catch (_) { continue; }
            const frontmatterMatch = text.match(/^---\s*[\r\n]+([\s\S]*?)[\r\n]+---/);
            if (!frontmatterMatch) continue;
            const frontmatter = frontmatterMatch[1];
            const frameVersionMatch = frontmatter.match(/frame_version\s*[:：=]?\s*["']?(\S+?)["']?\s*$/m);
            if (!frameVersionMatch) continue;
            const frameVersion = String(frameVersionMatch[1]).trim();
            const versionBucket = String(frameVersion) === '95' || String(frameVersion) === '950' || String(frameVersion).startsWith('950')
                ? '950及以上'
                : '950以下';
            const sourcePath = path.relative(root, filePath).replace(/\\/g, '/') || '_docs/project-context.md';
            return {
                ok: true,
                source: 'project-context',
                frameVersion,
                versionBucket,
                sourcePath
            };
        }
        return { ok: false, source: 'project-context', message: 'PROJECT_CONTEXT_FRAME_VERSION_NOT_FOUND' };
    }

    detectFrameworkVersion(projectPath) {
        const root = String(projectPath || '').trim();
        if (!root || !fs.existsSync(root)) {
            return { ok: false, source: 'pom.xml', message: 'PROJECT_PATH_MISSING' };
        }
        const ignored = new Set(['.git', '.svn', '.idea', '.settings', 'target', 'bin', 'out', 'dist', 'node_modules', 'docs', '_docs', '.knowledge', '.agents', PipelineUtils.AI_WORKSPACE_DIR_NAME]);
        const pomFiles = [];
        const walk = currentDir => {
            if (pomFiles.length >= 120) return;
            let entries = [];
            try { entries = fs.readdirSync(currentDir, { withFileTypes: true }); } catch (_) { return; }
            for (const entry of entries) {
                if (pomFiles.length >= 120) break;
                if (ignored.has(entry.name)) continue;
                const fullPath = path.join(currentDir, entry.name);
                if (entry.isDirectory()) {
                    walk(fullPath);
                    continue;
                }
                if (entry.isFile() && entry.name === 'pom.xml') pomFiles.push(fullPath);
            }
        };
        walk(root);
        pomFiles.sort((left, right) => {
            const leftDepth = path.relative(root, left).split(path.sep).length;
            const rightDepth = path.relative(root, right).split(path.sep).length;
            return leftDepth - rightDepth || left.localeCompare(right);
        });

        for (const pomPath of pomFiles) {
            let text = '';
            try { text = fs.readFileSync(pomPath, 'utf-8'); } catch (_) { text = ''; }
            const exact = text.match(/<epoint[-._]?frame[-._]?version>\s*([^<]+?)\s*<\/epoint[-._]?frame[-._]?version>/i);
            const generic = exact || text.match(/<([A-Za-z0-9_.-]*frame[A-Za-z0-9_.-]*version)>\s*([^<]+?)\s*<\/\1>/i);
            if (!generic) continue;
            const propertyName = exact ? 'epoint-frame-version' : String(generic[1] || '').trim();
            const version = String(exact ? exact[1] : generic[2] || '').trim();
            if (!version) continue;
            const sourcePath = path.relative(root, pomPath).replace(/\\/g, '/') || 'pom.xml';
            return {
                ok: true,
                source: 'pom.xml',
                propertyName,
                version,
                sourcePath,
                suggestedBucket: this.inferBucketFromVersion(version)
            };
        }
        return { ok: false, source: 'pom.xml', message: 'FRAMEWORK_VERSION_NOT_FOUND' };
    }

    inferBucketFromVersion(version = '') {
        const match = String(version || '').match(/(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
        if (!match) return '';
        const current = [
            Number(match[1] || 0),
            Number(match[2] || 0),
            Number(match[3] || 0)
        ];
        const target = [9, 5, 0];
        for (let index = 0; index < target.length; index += 1) {
            if (current[index] > target[index]) return '950及以上';
            if (current[index] < target[index]) return '950以下';
        }
        return '950及以上';
    }

    _getPaths(projectPath) {
        if (typeof this.getProjectStructurePaths !== 'function') {
            throw new Error('FRAMEWORK_VERSION_SERVICE_PATH_RESOLVER_MISSING');
        }
        return this.getProjectStructurePaths(projectPath);
    }

    _ensureDir(dirPath) {
        if (typeof this.ensureDirectoryExists === 'function') {
            this.ensureDirectoryExists(dirPath);
            return;
        }
        fs.mkdirSync(dirPath, { recursive: true });
    }
}

module.exports = FrameworkVersionService;
