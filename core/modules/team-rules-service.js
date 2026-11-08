/**
 * TeamRulesService — 团队规则索引检索（B 方案 / Node 实现）
 *
 * 设计：
 *  - 管理员侧：用 Python 工具 `knowledge-inbox build-sqlite` 构建 knowledge.sqlite，
 *    然后 `knowledge-inbox publish` 推到内网 GitLab 团队知识库。
 *  - 使用者侧：vscode 插件按"规范保存路径"自动 sparse-checkout 到
 *    `{rulesPath}/.knowledge_repo`（默认只拉根 knowledge.sqlite，不下载源 .md）。
 *    MCP 主进程把 KNOWLEDGE_REPO_PATH 注入子进程，本服务本地查询 knowledge.sqlite，
 *    搜索阶段不发起 HTTP。
 *  - getRule 全文获取走在线 GitLab raw URL（remoteBaseUrl 由插件配置注入），
 *    不写盘、不依赖本地源 .md，确保喂给 LLM 的是完整原文（含 frontmatter 与
 *    pre-H2 引言段）。HTTP 失败时回退本地 fs，再短期回退 index.json chunk 重建。
 *  - SQLite FTS 搜索返回 article-level 结果，保持 team_rules_search 既有字段形状。
 *  - index.json 仅作为旧索引回退和 getRule chunk 重建兜底，后续可随 rollout 移除。
 */

'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { spawnSync } = require('child_process');
const { URL } = require('url');

const SQLITE_FUSE_TIMEOUT_MS = 30000;
const SQLITE_SEARCH_TIMEOUT_MS = 30000;

// jieba 是惰性加载，避免在不需要时增加启动开销
let _jiebaInstance = null;
function getJieba() {
    if (_jiebaInstance) return _jiebaInstance;
    const runtimeRequire = module && typeof module.require === 'function'
        ? module.require.bind(module)
        : null;
    if (runtimeRequire) {
        try {
            const { Jieba } = runtimeRequire('@node-rs/jieba');
            const { dict } = runtimeRequire('@node-rs/jieba/dict');
            _jiebaInstance = Jieba.withDict(dict);
            return _jiebaInstance;
        } catch (_) {
            // Native jieba is optional for packaged/webpack runtime; fallback keeps search usable.
        }
    }
    _jiebaInstance = { cut: fallbackCut };
    return _jiebaInstance;
}

function fallbackCut(text) {
    const value = String(text || '').trim();
    if (!value) return [];
    if (!/[\u4e00-\u9fff]/u.test(value)) return [value];
    const chars = Array.from(value);
    if (chars.length <= 2) return [value];
    const tokens = new Set([value]);
    for (let i = 0; i < chars.length; i += 2) {
        const token = chars.slice(i, i + 2).join('');
        if (token) tokens.add(token);
    }
    for (let i = 0; i < chars.length - 1; i += 1) {
        tokens.add(chars.slice(i, i + 2).join(''));
    }
    return Array.from(tokens);
}

function _pythonCandidates() {
    const out = [];
    const seen = new Set();
    function add(command, args = []) {
        const cmd = String(command || '').trim();
        if (!cmd) return;
        const key = [cmd, ...args].join('\u0000').toLowerCase();
        if (seen.has(key)) return;
        seen.add(key);
        out.push({ command: cmd, args });
    }
    add(process.env.EPOINT_PYTHON_PATH || '');
    add(process.env.PYTHON || '');
    add('python');
    if (process.platform === 'win32') {
        add('py', ['-3']);
    }
    add('python3');
    return out;
}

function _formatPythonAttempt(candidate, result = {}) {
    const commandText = [candidate.command, ...(candidate.args || [])].join(' ');
    const pieces = [];
    if (result.error) {
        pieces.push(result.error.code || result.error.message || String(result.error));
    }
    if (result.status !== undefined && result.status !== null) {
        pieces.push(`exit=${result.status}`);
    }
    const stderr = String(result.stderr || '').trim();
    const stdout = String(result.stdout || '').trim();
    if (stderr) pieces.push(`stderr=${stderr.slice(0, 300)}`);
    if (stdout) pieces.push(`stdout=${stdout.slice(0, 300)}`);
    return `${commandText}: ${pieces.join(' | ') || 'no diagnostic output'}`;
}

function _runPythonInline(script, scriptArgs = [], options = {}) {
    const attempts = [];
    let lastResult = null;
    for (const candidate of _pythonCandidates()) {
        const result = spawnSync(
            candidate.command,
            [...(candidate.args || []), '-c', script, ...scriptArgs],
            options
        );
        result.pythonCommand = [candidate.command, ...(candidate.args || [])].join(' ');
        if (!result.error && result.status === 0) {
            return result;
        }
        attempts.push(_formatPythonAttempt(candidate, result));
        lastResult = result;
    }
    const error = new Error('all python candidates failed');
    error.code = 'PYTHON_SUBPROCESS_FAILED';
    return {
        error,
        status: lastResult && lastResult.status,
        stdout: lastResult && lastResult.stdout || '',
        stderr: attempts.join('\n'),
        pythonCommand: ''
    };
}

function _pythonFailureDetail(result = {}) {
    const pieces = [];
    if (result.error) {
        pieces.push(result.error.code || result.error.message || String(result.error));
    }
    const stderr = String(result.stderr || '').trim();
    const stdout = String(result.stdout || '').trim();
    if (stderr) pieces.push(stderr.slice(0, 800));
    if (stdout) pieces.push(`stdout=${stdout.slice(0, 800)}`);
    return pieces.join(' | ') || 'no diagnostic output from python subprocess';
}

class TeamRulesService {
    constructor(rulesRepoPath, opts = {}) {
        this.rulesRepoPath = rulesRepoPath;
        this.indexFileName = opts.indexFileName || 'knowledge.sqlite';
        this.indexPath = path.join(rulesRepoPath, this.indexFileName);
        this.jsonIndexPath = path.join(rulesRepoPath, 'index.json');
        this.remoteBaseUrl = _normalizeRemoteBase(opts.remoteBaseUrl);
        this.remoteBranch = (opts.remoteBranch && String(opts.remoteBranch).trim()) || 'main';
        this.remoteToken = opts.remoteToken || null;
        this.remoteTimeoutMs = Number.isFinite(opts.remoteTimeoutMs) && opts.remoteTimeoutMs > 0 ? opts.remoteTimeoutMs : 5000;
        this._cache = null;
    }

    _loadActiveConfigFromSharedFile() {
        try {
            const rulesPath = path.dirname(this.rulesRepoPath);
            const activeConfigPath = path.join(rulesPath, 'active_knowledge.json');
            if (fs.existsSync(activeConfigPath)) {
                const content = fs.readFileSync(activeConfigPath, 'utf8');
                const config = JSON.parse(content);
                if (config && config.gitUrl) {
                    this.remoteBaseUrl = _normalizeRemoteBase(config.gitUrl);
                    this.remoteBranch = (config.branch && String(config.branch).trim()) || 'main';
                }
            }
        } catch (e) {
            // ignore
        }
    }

    /**
     * 路径优先级（与 rulesGitSync 的 sparse 模板对齐）：
     *   1. {repo}/.index/knowledge.{base,today}.sqlite —— 当前结构，admin 侧 publish 推到 .index/ 子目录
     *   2. {repo}/knowledge.{base,today}.sqlite        —— 旧结构兼容（早期版本直接放仓库根）
     * 任一组配齐 base 文件即视为命中；fused 产物始终落到 this.indexPath（仓库根），保持下游读取入口稳定。
     */
    _ensureSqliteFused() {
        const rulesRepoPath = this.rulesRepoPath;
        const indexPath = this.indexPath;
        const candidates = [
            {
                base: path.join(rulesRepoPath, '.index', 'knowledge.base.sqlite'),
                today: path.join(rulesRepoPath, '.index', 'knowledge.today.sqlite'),
            },
            {
                base: path.join(rulesRepoPath, 'knowledge.base.sqlite'),
                today: path.join(rulesRepoPath, 'knowledge.today.sqlite'),
            },
        ];
        const layout = candidates.find((c) => fs.existsSync(c.base));
        if (!layout) return;

        const baseFile = layout.base;
        const todayFile = layout.today;
        const tmpFile = path.join(rulesRepoPath, 'knowledge.sqlite.fuse.tmp');

        const baseStat = fs.statSync(baseFile).mtimeMs;
        const todayStat = fs.existsSync(todayFile) ? fs.statSync(todayFile).mtimeMs : 0;
        const indexStat = fs.existsSync(indexPath) ? fs.statSync(indexPath).mtimeMs : 0;

        if (fs.existsSync(indexPath) && indexStat >= baseStat && indexStat >= todayStat) {
            return; // 已经是最新的，不需要重新物理拼装
        }

        const fuseScript = `
import os
import shutil
import sqlite3
from pathlib import Path

base_path = Path(r"${baseFile.replace(/\\/g, '\\\\')}")
today_path = Path(r"${todayFile.replace(/\\/g, '\\\\')}")
index_path = Path(r"${indexPath.replace(/\\/g, '\\\\')}")
tmp_path = Path(r"${tmpFile.replace(/\\/g, '\\\\')}")

try:
    if base_path.exists():
        shutil.copy2(base_path, tmp_path)

    conn = sqlite3.connect(tmp_path)
    try:
        conn.execute("CREATE TABLE IF NOT EXISTS chunks_fts(chunk_id TEXT PRIMARY KEY, file_path TEXT, title TEXT, summary TEXT, category TEXT, tags TEXT, chunk_text TEXT, search_text TEXT);")
        conn.execute("CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY, value TEXT);")

        today_has_changes = False
        if today_path.exists():
            today_check = sqlite3.connect(today_path)
            try:
                row = today_check.execute("SELECT COUNT(*) FROM chunks_fts").fetchone()
                chunk_count = row[0] if row else 0
                row = today_check.execute("SELECT COUNT(*) FROM metadata WHERE key LIKE 'deleted:%' OR key LIKE 'hash:%'").fetchone()
                meta_count = row[0] if row else 0
                today_has_changes = chunk_count > 0 or meta_count > 0
            finally:
                today_check.close()

        if today_has_changes:
            conn.execute("ATTACH DATABASE ? AS today_db", (str(today_path),))
            # 物理清除删除标志
            conn.execute("DELETE FROM chunks_fts WHERE file_path IN (SELECT SUBSTR(key, 9) FROM today_db.metadata WHERE key LIKE 'deleted:%')")
            conn.execute("DELETE FROM metadata WHERE key IN (SELECT 'hash:' || SUBSTR(key, 9) FROM today_db.metadata WHERE key LIKE 'deleted:%')")
            # 物理清除并合入增量数据
            conn.execute("DELETE FROM chunks_fts WHERE file_path IN (SELECT file_path FROM today_db.chunks_fts)")
            conn.execute("DELETE FROM metadata WHERE key IN (SELECT key FROM today_db.metadata WHERE key LIKE 'hash:%')")
            conn.execute("INSERT INTO chunks_fts SELECT * FROM today_db.chunks_fts")
            conn.execute("INSERT OR REPLACE INTO metadata SELECT * FROM today_db.metadata WHERE key LIKE 'hash:%'")
            conn.execute("DETACH DATABASE today_db")
        conn.commit()
    finally:
        conn.close()

    if tmp_path.exists():
        if index_path.exists():
            os.unlink(index_path)
        os.rename(tmp_path, index_path)
except Exception as e:
    if tmp_path.exists():
        try: os.unlink(tmp_path)
        except: pass
`;

        _runPythonInline(fuseScript, [], { windowsHide: true, timeout: SQLITE_FUSE_TIMEOUT_MS });
    }

    /**
     * 搜索团队规则索引。
     *
     * @param {string} query - 自然语言查询
     * @param {object} [opts]
     * @param {number} [opts.topK=5]
     * @param {string} [opts.category] - 可选分类过滤
     * @returns {{ query, results: Array, stats: { query_ms, candidate_count, returned_count } }}
     */
    search(query, opts = {}) {
        this._loadActiveConfigFromSharedFile();
        const topK = Number.isInteger(opts.topK) && opts.topK >= 0 ? opts.topK : 5;
        const category = opts.category || null;
        const start = Date.now();

        const sqliteResult = this._searchSqlite(query, { topK, category, start });
        if (sqliteResult && sqliteResult.ok) {
            return sqliteResult.payload;
        }
        if (sqliteResult && sqliteResult.sqlitePresent) {
            const detail = sqliteResult.errorDetail || '';
            const isBufferIssue = detail.includes('output too large');
            return {
                query: query || '',
                results: [],
                stats: {
                    query_ms: Date.now() - start,
                    candidate_count: 0,
                    returned_count: 0,
                },
                error: isBufferIssue
                    ? 'team rules search output exceeded buffer limit; try a more specific query or reduce top_k'
                    : 'team rules SQLite index is unavailable or unhealthy; resync the team knowledge repo',
                errorDetail: detail,
            };
        }

        const indexFile = this._loadIndex();
        if (!indexFile) {
            return {
                query: query || '',
                results: [],
                stats: {
                    query_ms: Date.now() - start,
                    candidate_count: 0,
                    returned_count: 0,
                },
            };
        }

        const queryTokens = _tokenizeQuery(query);
        const candidateEntries = category
            ? indexFile.entries.filter((e) => e.category === category)
            : indexFile.entries;

        if (queryTokens.length === 0 || candidateEntries.length === 0) {
            return {
                query: query || '',
                results: [],
                stats: {
                    query_ms: Date.now() - start,
                    candidate_count: candidateEntries.length,
                    returned_count: 0,
                },
            };
        }

        const documentFrequency = _buildDocumentFrequency(candidateEntries);
        const queryCounts = _countOccurrences(queryTokens);

        // 1. chunk-level scoring
        const chunkResults = [];
        for (const entry of candidateEntries) {
            const { score, matchedTerms, termHits } = _scoreEntry(
                entry,
                queryTokens,
                queryCounts,
                documentFrequency,
                candidateEntries.length,
            );
            if (score <= 0) continue;
            chunkResults.push({
                file_path: entry.file_path,
                title: entry.title,
                summary: entry.summary,
                category: entry.category,
                tags: Array.isArray(entry.tags) ? entry.tags.slice() : [],
                chunk_id: entry.chunk_id,
                score,
                matched_terms: matchedTerms,
                term_hits: termHits,
                evidence_text: entry.chunk_text || '',
            });
        }

        // 2. article-level aggregation: keep best chunk per file_path
        const byFile = new Map();
        for (const r of chunkResults) {
            const cur = byFile.get(r.file_path);
            if (!cur) {
                byFile.set(r.file_path, {
                    file_path: r.file_path,
                    title: r.title,
                    summary: r.summary,
                    category: r.category,
                    tags: r.tags,
                    primary_chunk_id: r.chunk_id,
                    score: r.score,
                    matched_terms: r.matched_terms.slice(),
                    term_hits: Object.assign({}, r.term_hits),
                    evidence_text: r.evidence_text,
                });
                continue;
            }
            // Merge matched terms (union)
            for (const t of r.matched_terms) {
                if (!cur.matched_terms.includes(t)) cur.matched_terms.push(t);
            }
            // Merge term_hits (max)
            for (const t of Object.keys(r.term_hits)) {
                cur.term_hits[t] = Math.max(cur.term_hits[t] || 0, r.term_hits[t]);
            }
            // Use the highest-scoring chunk's snippet/title/score
            if (r.score > cur.score) {
                cur.score = r.score;
                cur.primary_chunk_id = r.chunk_id;
                cur.evidence_text = r.evidence_text;
                cur.title = r.title;
                cur.summary = r.summary;
            }
        }

        const ranked = Array.from(byFile.values())
            .sort((a, b) => {
                if (b.score !== a.score) return b.score - a.score;
                return a.file_path.localeCompare(b.file_path);
            })
            .slice(0, topK)
            .map((item) => ({
                file_path: item.file_path,
                title: item.title,
                category: item.category,
                tags: item.tags,
                score: Number(item.score.toFixed(4)),
                primary_chunk_id: item.primary_chunk_id,
                matched_terms: item.matched_terms,
                term_hits: item.term_hits,
                evidence_text: item.evidence_text,
                summary: item.summary,
                explanation: _buildExplanation(item.matched_terms),
            }));

        return {
            query,
            results: ranked,
            stats: {
                query_ms: Date.now() - start,
                candidate_count: byFile.size,
                returned_count: ranked.length,
            },
        };
    }

    /**
     * 读取一个规则文件的全文。
     *
     * 优先级（喂给 LLM 必须是完整原文，不丢 pre-H2 引言段）：
     *   1) **remote**：HTTP 拉 `{remoteBaseUrl}/-/raw/{branch}/{file_path}`。
     *      源 .md 永远在 GitLab 上，不依赖本地是否 sparse-checkout 过源文件。
     *   2) **file**：管理员显式把源 .md 推到了 .knowledge_repo（混合模式），
     *      remote 配置缺失或网络不通时直接 fs 读。
     *   3) **index**：兜底，从同 file_path 的所有 chunk 重建。会丢失
     *      pre-H2 引言段，仅用于 remote 不可用且本地无源 .md 的极端情况。
     *
     * @param {string} filePath - 相对于规则仓库根的路径，如 "rules/code-review.md"
     * @returns {Promise<{ ok: boolean, file_path?: string, title?: string, category?: string, tags?: string[], content?: string, raw_markdown?: string, source?: 'remote' | 'file' | 'index', error?: string }>}
     */
    async getRule(filePath) {
        this._loadActiveConfigFromSharedFile();
        if (!filePath || typeof filePath !== 'string') {
            return { ok: false, error: 'file_path is required' };
        }

        // Path traversal protection — index 重建路径走的是 file_path 字符串本身，
        // 所以仍然要先做 path traversal 防御
        const root = path.resolve(this.rulesRepoPath);
        const candidate = path.resolve(this.rulesRepoPath, filePath);
        if (!candidate.startsWith(root + path.sep) && candidate !== root) {
            return { ok: false, error: `path traversal not allowed: ${filePath}` };
        }
        // 额外防护：路径段不允许 .. 或绝对路径前缀，防 remote URL 构造时被绕过
        if (filePath.split(/[\\/]/).some((seg) => seg === '..' || /^[a-zA-Z]:$/.test(seg))) {
            return { ok: false, error: `invalid file_path: ${filePath}` };
        }

        // Strategy 1: remote HTTP (preferred — 完整原文，含 frontmatter 与 pre-H2 引言段)
        if (this.remoteBaseUrl) {
            const remote = await this._fetchRemote(filePath);
            if (remote.ok) {
                const { metadata, body } = _parseFrontmatter(remote.text);
                return {
                    ok: true,
                    file_path: filePath,
                    title: metadata.title || _extractFirstHeading(body) || path.basename(filePath, path.extname(filePath)),
                    category: metadata.category || path.dirname(filePath).split(/[\\/]/).filter(Boolean).pop() || 'uncategorized',
                    tags: Array.isArray(metadata.tags) ? metadata.tags : [],
                    content: body.trim(),
                    raw_markdown: remote.text,
                    source: 'remote',
                };
            }
            // remote 4xx/5xx/网络错误 → fall through 到本地 fs 兜底
        }

        // Strategy 2: local filesystem (混合模式 — 管理员把源 .md 也推到了 .knowledge_repo)
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
            const raw = fs.readFileSync(candidate, 'utf8');
            const { metadata, body } = _parseFrontmatter(raw);
            return {
                ok: true,
                file_path: filePath,
                title: metadata.title || _extractFirstHeading(body) || path.basename(filePath, path.extname(filePath)),
                category: metadata.category || path.dirname(filePath).split(/[\\/]/).filter(Boolean).pop() || 'uncategorized',
                tags: Array.isArray(metadata.tags) ? metadata.tags : [],
                content: body.trim(),
                raw_markdown: raw,
                source: 'file',
            };
        }

        // Strategy 3: rebuild from index chunks (last resort — 会丢 pre-H2 引言段)
        // 优先从 SQLite 全文检索库中直接拼装还原规则全文
        const sqliteChunksResult = this._getRuleFromSqlite(filePath);
        if (sqliteChunksResult && sqliteChunksResult.ok) {
            return sqliteChunksResult.payload;
        }

        const indexFile = this._loadIndex();
        if (!indexFile) {
            return { ok: false, error: `rule not found and no index available: ${filePath}` };
        }

        const fileChunks = indexFile.entries.filter((e) => e.file_path === filePath);
        if (fileChunks.length === 0) {
            return { ok: false, error: `rule file not found in index: ${filePath}` };
        }

        // chunk_id format: "<file_path>#<N>" — extract N for stable ordering
        const sorted = fileChunks
            .map((e) => ({ entry: e, order: _extractChunkOrder(e.chunk_id) }))
            .sort((a, b) => a.order - b.order)
            .map(({ entry }) => entry);

        const meta = sorted[0];
        const title = meta.title
            || path.basename(filePath, path.extname(filePath));
        const category = meta.category
            || path.dirname(filePath).split(/[\\/]/).filter(Boolean).pop()
            || 'uncategorized';
        const tags = Array.isArray(meta.tags) ? meta.tags.slice() : [];

        const bodyParts = sorted.map((e) => (e.chunk_text || '').trim()).filter(Boolean);
        const content = `# ${title}\n\n${bodyParts.join('\n\n')}`.trim();

        return {
            ok: true,
            file_path: filePath,
            title,
            category,
            tags,
            content,
            raw_markdown: content,
            source: 'index',
        };
    }

    /**
     * Fetch a single rule's raw markdown from the GitLab raw URL.
     * Returns { ok: true, text } on 200; { ok: false, status, error } otherwise.
     * Never throws — caller relies on graceful fallback.
     */
    _fetchRemote(filePath) {
        const url = this._buildRemoteUrl(filePath);
        return new Promise((resolve) => {
            let settled = false;
            const settle = (v) => { if (!settled) { settled = true; resolve(v); } };
            try {
                const parsed = new URL(url);
                const lib = parsed.protocol === 'https:' ? https : http;
                const headers = { 'Accept': 'text/plain, */*' };
                if (this.remoteToken) headers['PRIVATE-TOKEN'] = this.remoteToken;
                const req = lib.get(url, { headers, timeout: this.remoteTimeoutMs }, (res) => {
                    const chunks = [];
                    res.on('data', (c) => chunks.push(c));
                    res.on('end', () => {
                        const text = Buffer.concat(chunks).toString('utf8');
                        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
                            settle({ ok: true, text });
                        } else {
                            settle({ ok: false, status: res.statusCode, error: `HTTP ${res.statusCode}` });
                        }
                    });
                    res.on('error', (err) => settle({ ok: false, error: String(err && err.message || err) }));
                });
                req.on('timeout', () => { req.destroy(new Error('timeout')); });
                req.on('error', (err) => settle({ ok: false, error: String(err && err.message || err) }));
            } catch (err) {
                settle({ ok: false, error: String(err && err.message || err) });
            }
        });
    }

    /**
     * Construct a GitLab raw URL: {base}/-/raw/{branch}/{path}
     * Each path segment is URI-encoded.
     */
    _buildRemoteUrl(filePath) {
        const base = this.remoteBaseUrl.replace(/\/+$/, '');
        const branch = encodeURIComponent(this.remoteBranch);
        const segs = filePath.split(/[\\/]/).filter(Boolean).map(encodeURIComponent);
        return `${base}/-/raw/${branch}/${segs.join('/')}`;
    }

    /**
     * 强制重新加载索引（清空缓存）。
     */
    invalidateCache() {
        this._cache = null;
    }

    _getRuleFromSqlite(filePath) {
        const sqlitePath = this._resolveSqliteIndexPath();
        if (!sqlitePath) {
            return { ok: false };
        }
        const script = `
import json
import sqlite3
import sys
from pathlib import Path
from urllib.parse import quote

index_path = Path(sys.argv[1])
file_path = sys.argv[2]

if not index_path.exists():
    sys.stdout.buffer.write(json.dumps({'ok': False, 'error': 'database not found'}).encode('utf-8'))
    sys.exit(0)

def chunk_order(chunk_id):
    if not chunk_id:
        return 0
    idx = chunk_id.rfind('#')
    if idx == -1:
        return 0
    try:
        return int(chunk_id[idx+1:])
    except:
        return 0

db_uri = f"file:{quote(index_path.resolve().as_posix(), safe='/:')}?mode=ro"
try:
    with sqlite3.connect(db_uri, uri=True) as conn:
        conn.row_factory = sqlite3.Row
        rows = conn.execute(
            "SELECT chunk_id, title, category, tags, chunk_text FROM chunks_fts WHERE file_path = ?;",
            (file_path,)
        ).fetchall()
except Exception as e:
    sys.stdout.buffer.write(json.dumps({'ok': False, 'error': str(e)}).encode('utf-8'))
    sys.exit(0)

if not rows:
    sys.stdout.buffer.write(json.dumps({'ok': False, 'error': 'no chunks found for this file'}).encode('utf-8'))
    sys.exit(0)

sorted_rows = sorted(rows, key=lambda r: chunk_order(r['chunk_id']))
meta = sorted_rows[0]
title = meta['title'] or Path(file_path).stem
category = meta['category'] or 'uncategorized'
tags = [t for t in (meta['tags'] or '').split() if t]

body_parts = [r['chunk_text'].strip() for r in sorted_rows if r['chunk_text']]
content = f"# {title}\\n\\n" + "\\n\\n".join(body_parts)

payload = {
    'ok': True,
    'file_path': file_path,
    'title': title,
    'category': category,
    'tags': tags,
    'content': content.strip(),
    'raw_markdown': content.strip(),
    'source': 'sqlite'
}
sys.stdout.buffer.write(json.dumps(payload, ensure_ascii=False).encode('utf-8'))
`;
        const result = _runPythonInline(script, [sqlitePath, filePath || ''], {
            encoding: 'utf8',
            windowsHide: true,
            timeout: 5000,
            maxBuffer: 10 * 1024 * 1024,
        });
        if (result.error || result.status !== 0) {
            return { ok: false, error: _pythonFailureDetail(result) };
        }
        try {
            const parsed = JSON.parse(result.stdout || '{}');
            if (parsed.ok) {
                return { ok: true, payload: parsed };
            }
            return { ok: false };
        } catch (_) {
            return { ok: false };
        }
    }

    _searchSqlite(query, opts = {}) {
        const sqlitePath = this._resolveSqliteIndexPath();
        if (!sqlitePath) {
            return { ok: false, sqlitePresent: false };
        }
        const topK = Number.isInteger(opts.topK) && opts.topK >= 0 ? opts.topK : 5;
        const category = opts.category || null;
        const start = Number.isFinite(opts.start) ? opts.start : Date.now();
        const script = `
import json
import re
import sqlite3
import sys
from pathlib import Path
from urllib.parse import quote

index_path = Path(sys.argv[1])
query = sys.argv[2]
top_k = int(sys.argv[3])
category = sys.argv[4] or None

def terms(value):
    parts = []
    current = []
    current_kind = None
    for ch in value.lower():
        if ch.isascii() and (ch.isalnum() or ch == '_'):
            kind = 'latin'
        elif '\\u4e00' <= ch <= '\\u9fff':
            kind = 'cjk'
        else:
            kind = None
        if kind is None:
            if current:
                parts.append(''.join(current))
                current = []
                current_kind = None
            continue
        if current and kind != current_kind:
            parts.append(''.join(current))
            current = []
        current.append(ch)
        current_kind = kind
    if current:
        parts.append(''.join(current))
    stopwords = {
        '的', '了', '和', '或', '及', '与', '在', '是', '有', '到', '中', '为', '被',
        '方法', '问题', '异常', '错误', '请求', '参数', '相关', '确认', '正确',
        '出现', '处理', '排查', '服务', '系统', '页面', '功能',
        '没有', '找到', '找不', '不到',
        'a', 'an', 'the', 'of', 'from', 'to', 'in', 'on', 'for', 'with', 'by',
        'and', 'or', 'is', 'are', 'was', 'were', 'end'
    }
    out = []
    for part in parts:
        if any('\\u4e00' <= ch <= '\\u9fff' for ch in part):
            if len(part) > 1 and part not in stopwords:
                out.append(part)
            if len(part) > 2:
                out.extend(
                    token for token in (part[i:i + 2] for i in range(0, len(part), 2))
                    if len(token) > 1 and token not in stopwords
                )
        else:
            if len(part) > 1 and part not in stopwords:
                out.append(part)
    return [part for part in dict.fromkeys(out) if part]

def term_weight(term):
    if any('\\u4e00' <= ch <= '\\u9fff' for ch in term):
        return 1.0 + min(len(term), 8) / 2.0
    if len(term) >= 12:
        return 6.0
    if len(term) >= 6:
        return 3.0
    return 1.5

def phrase(term):
    return '"' + term.replace('"', '""') + '"'

MAX_EVIDENCE_CHARS = 1600

def trim_evidence(text, matched_terms, max_chars=MAX_EVIDENCE_CHARS):
    """优先截取命中词附近窗口；找不到命中词时取前 max_chars 字。"""
    if not text or len(text) <= max_chars:
        return text or ''
    # 尝试找第一个命中词的位置，取其前后窗口
    best_pos = -1
    for term in matched_terms:
        pos = text.lower().find(term.lower())
        if pos >= 0:
            best_pos = pos
            break
    if best_pos >= 0:
        half = max_chars // 2
        start = max(0, best_pos - half)
        end = start + max_chars
        if end > len(text):
            end = len(text)
            start = max(0, end - max_chars)
        snippet = text[start:end]
        prefix = '…' if start > 0 else ''
        suffix = '…' if end < len(text) else ''
        return prefix + snippet + suffix
    # 没找到命中词（理论上不太可能），取前 max_chars
    return text[:max_chars] + ('…' if len(text) > max_chars else '')

def norm(value):
    return (value or '').lower()

def compact(value):
    return ''.join(ch for ch in norm(value) if ch.isalnum() or '\\u4e00' <= ch <= '\\u9fff')

def field_terms(value, query_terms):
    value_norm = norm(value)
    value_compact = compact(value)
    return [
        term for term in query_terms
        if term in value_norm or compact(term) in value_compact
    ]

def query_phrases(value, query_terms):
    phrases = []
    raw = (value or '').strip()
    if raw:
        phrases.append(raw.lower())
    joined = ''.join(query_terms)
    if len(joined) >= 4:
        phrases.append(joined)
    if len(query_terms) >= 2:
        for i in range(len(query_terms) - 1):
            pair = ''.join(query_terms[i:i + 2])
            if len(pair) >= 4:
                phrases.append(pair)
    return [p for p in dict.fromkeys(phrases) if len(p) >= 4]

def extract_date(*values):
    text = ' '.join(v or '' for v in values)
    matches = []
    for m in re.findall(r'(20\\d{2})[-_/年.]?(0[1-9]|1[0-2])', text):
        matches.append(f'{m[0]}-{m[1]}')
    for m in re.findall(r'(20\\d{2})', text):
        matches.append(f'{m}-00')
    return max(matches) if matches else None

def is_recency_term(value):
    lowered = norm(value)
    if lowered in {'最新', '近期', '最近', '今年', '本月'}:
        return True
    return bool(re.fullmatch(r'20\\d{2}(?:[-_/年.]?(?:0[1-9]|1[0-2]))?', lowered))

def recency_intent(value):
    lowered = norm(value)
    return any(token in lowered for token in ['最新', '近期', '最近', '今年', '本月', '2024', '2025', '2026'])

def add_reason(reasons, reason):
    if reason and reason not in reasons:
        reasons.append(reason)

def rerank_item(item, query, query_terms):
    title = item.get('title') or ''
    file_path = item.get('file_path') or ''
    summary = item.get('summary') or ''
    tags = ' '.join(item.get('tags') or [])
    body = item.get('evidence_text') or ''
    fields = {
        'title': title,
        'path': file_path,
        'summary': summary,
        'tags': tags,
        'body': body,
    }
    match_fields = []
    reasons = []
    score = float(item.get('score') or 0)
    effective_terms = [term for term in query_terms if not is_recency_term(term)] or query_terms
    matched = [
        term for term in list(dict.fromkeys(item.get('matched_terms') or []))
        if not is_recency_term(term)
    ]

    for field, value in fields.items():
        field_matched = field_terms(value, effective_terms)
        if field_matched:
            match_fields.append(field)
            if field == 'title':
                score += 20 + 7 * len(field_matched)
                add_reason(reasons, '标题命中查询词')
            elif field == 'path':
                score += 14 + 5 * len(field_matched)
                add_reason(reasons, '路径命中查询词')
            elif field in ('summary', 'tags'):
                score += 9 + 2 * len(field_matched)
                add_reason(reasons, '摘要/标签命中查询词')

    phrase_matches = []
    title_path_compact = compact(title + ' ' + file_path)
    all_compact = compact(' '.join(fields.values()))
    for phrase_value in query_phrases(query, effective_terms):
        c_phrase = compact(phrase_value)
        if not c_phrase:
            continue
        if c_phrase in title_path_compact:
            phrase_matches.append(phrase_value)
            score += 35
            add_reason(reasons, '标题/路径命中完整短语')
        elif c_phrase in all_compact:
            phrase_matches.append(phrase_value)
            score += 12
            add_reason(reasons, '正文命中完整短语')
    phrase_matches = list(dict.fromkeys(phrase_matches))

    title_path_terms = set(field_terms(title + ' ' + file_path, effective_terms))
    if len(title_path_terms) >= 2:
        score += 22 + 5 * len(title_path_terms)
        add_reason(reasons, '标题/路径命中完整短语')

    coverage_count = len(set(matched))
    total_terms = max(len(set(effective_terms)), 1)
    if coverage_count:
        score += (coverage_count / total_terms) * 12
    if coverage_count == total_terms:
        score += 10
        add_reason(reasons, '覆盖全部查询词')
    elif coverage_count >= 2:
        add_reason(reasons, f'覆盖 {coverage_count}/{total_terms} 个查询词')

    rare_terms = [
        term for term in matched
        if len(term) >= 6 or any(ch.isdigit() for ch in term) or any(ch.isascii() and ch.isalpha() for ch in term)
    ]
    if rare_terms:
        score += min(len(rare_terms), 3) * 8
        add_reason(reasons, '命中长词/编号等高区分度关键词')

    if set(match_fields) == {'body'} and coverage_count <= 1:
        score -= 15
        add_reason(reasons, '仅正文命中少量泛词，已降权')

    extracted_date = extract_date(file_path, title, summary)
    if extracted_date and recency_intent(query):
        year = int(extracted_date[:4])
        month = int(extracted_date[5:7])
        score += max(0, year - 2020) * 30 + max(0, month) * 2
        add_reason(reasons, '命中最新/近期意图')

    item['score'] = round(score, 4)
    item['match_fields'] = match_fields
    item['phrase_matches'] = phrase_matches
    item['coverage'] = f'{coverage_count}/{total_terms}'
    item['extracted_date'] = extracted_date
    item['rerank_reasons'] = reasons
    item['explanation'] = '；'.join(reasons) if reasons else item.get('explanation', '')
    return item

query_terms = terms(query)
if not index_path.exists() or not query_terms:
    sys.stdout.buffer.write(json.dumps({'query': query, 'results': [], 'stats': {'candidate_count': 0, 'returned_count': 0}} , ensure_ascii=False).encode('utf-8'))
    sys.exit(0)
match_query = ' OR '.join(phrase(term) for term in query_terms)
sql = '''
    SELECT chunk_id, file_path, title, summary, category, tags, chunk_text
    FROM chunks_fts
    WHERE chunks_fts MATCH ?
'''
params = [match_query]
if category:
    sql += ' AND category = ?'
    params.append(category)
db_uri = f"file:{quote(index_path.resolve().as_posix(), safe='/:')}?mode=ro"
with sqlite3.connect(db_uri, uri=True) as conn:
    conn.row_factory = sqlite3.Row
    rows = conn.execute(sql, params).fetchall()
by_file = {}
for row in rows:
    text = ' '.join([row['title'] or '', row['summary'] or '', row['tags'] or '', row['chunk_text'] or '']).lower()
    matched = [term for term in query_terms if term in text]
    if not matched:
        continue
    title_summary = ' '.join([row['title'] or '', row['summary'] or '', row['tags'] or '']).lower()
    term_hits = {term: text.count(term) for term in matched}
    score = float(sum(min(term_hits[term], 3) * term_weight(term) for term in matched))
    score += len(set(matched)) * 2.0
    score += sum(term_weight(term) for term in matched if term in title_summary)
    current = by_file.get(row['file_path'])
    item = {
        'file_path': row['file_path'],
        'title': row['title'],
        'category': row['category'],
        'tags': [tag for tag in (row['tags'] or '').split() if tag],
        'score': score,
        'primary_chunk_id': row['chunk_id'],
        'matched_terms': matched,
        'term_hits': term_hits,
        'evidence_text': row['chunk_text'] or '',
        'summary': row['summary'] or '',
        'explanation': '该文章被召回，因为命中了查询中的关键词“' + '、'.join(matched) + '”。',
    }
    if current is None or item['score'] > current['score']:
        by_file[row['file_path']] = item
    else:
        for term in matched:
            if term not in current['matched_terms']:
                current['matched_terms'].append(term)
            current['term_hits'][term] = max(current['term_hits'].get(term, 0), term_hits[term])
reranked = [rerank_item(item, query, query_terms) for item in by_file.values()]
ranked = sorted(reranked, key=lambda item: (-item['score'], item['file_path']))[:top_k]
for item in ranked:
    item['score'] = round(float(item.get('score') or 0), 4)
    # 只对最终 topK 结果截断 evidence，聚合阶段保留完整文本用于打分
    item['evidence_text'] = trim_evidence(item['evidence_text'], item['matched_terms'])
    item['summary'] = (item.get('summary') or '')[:300]
sys.stdout.buffer.write(json.dumps({'query': query, 'results': ranked, 'stats': {'candidate_count': len(by_file), 'returned_count': len(ranked)}}, ensure_ascii=False).encode('utf-8'))
`;
        const result = _runPythonInline(script, [sqlitePath, query || '', String(topK), category || ''], {
            encoding: 'utf8',
            windowsHide: true,
            timeout: SQLITE_SEARCH_TIMEOUT_MS,
            maxBuffer: 10 * 1024 * 1024,
        });
        if (result.error || result.status !== 0) {
            const errMsg = _pythonFailureDetail(result);
            const isBufferOverflow = errMsg.includes('ENOBUFS') || errMsg.includes('maxBuffer');
            return {
                ok: false,
                sqlitePresent: true,
                errorDetail: isBufferOverflow
                    ? 'query output too large (exceeded maxBuffer); results truncation may be needed'
                    : `python subprocess failed: ${errMsg}`,
            };
        }
        try {
            const parsed = JSON.parse(result.stdout || '{}');
            const results = Array.isArray(parsed.results)
                ? parsed.results.map((item) => Object.assign({}, item, {
                    matched_terms: Array.isArray(item.matched_terms) ? item.matched_terms : [],
                    explanation: _buildExplanation(Array.isArray(item.matched_terms) ? item.matched_terms : []),
                }))
                : [];
            return {
                ok: true,
                sqlitePresent: true,
                payload: {
                    query: parsed.query || query || '',
                    results,
                    stats: {
                        query_ms: Date.now() - start,
                        candidate_count: parsed.stats && Number.isInteger(parsed.stats.candidate_count) ? parsed.stats.candidate_count : 0,
                        returned_count: parsed.stats && Number.isInteger(parsed.stats.returned_count) ? parsed.stats.returned_count : 0,
                    },
                },
            };
        } catch (_) {
            return { ok: false, sqlitePresent: true };
        }
    }

    _resolveSqliteIndexPath() {
        this._ensureSqliteFused();
        if (fs.existsSync(this.indexPath) && path.extname(this.indexPath) === '.sqlite') {
            return this.indexPath;
        }
        const candidates = [
            path.join(this.rulesRepoPath, '.index', 'knowledge.base.sqlite'),
            path.join(this.rulesRepoPath, 'knowledge.base.sqlite'),
        ];
        return candidates.find((p) => fs.existsSync(p) && path.extname(p) === '.sqlite') || null;
    }

    /**
     * Lazy-load the index file with mtime-based cache invalidation.
     * Returns null if the file doesn't exist or is malformed.
     */
    _loadIndex() {
        const jsonPath = this.indexPath.endsWith('.json') ? this.indexPath : this.jsonIndexPath;
        if (!fs.existsSync(jsonPath)) {
            return null;
        }
        const stat = fs.statSync(jsonPath);
        if (this._cache && this._cache.path === jsonPath && this._cache.mtime === stat.mtimeMs) {
            return this._cache.indexFile;
        }
        try {
            const raw = fs.readFileSync(jsonPath, 'utf8');
            const indexFile = JSON.parse(raw);
            if (!indexFile || !Array.isArray(indexFile.entries)) {
                return null;
            }
            this._cache = {
                path: jsonPath,
                mtime: stat.mtimeMs,
                indexFile,
            };
            return indexFile;
        } catch (e) {
            return null;
        }
    }
}

// ===== Helpers =====

/**
 * Tokenize a query string into lowercase tokens.
 * Mirrors git-rules-mcp/query_engine.py:tokenize_query.
 *
 * Strategy:
 *  - Normalize whitespace and lowercase
 *  - Split into latin/digit runs and CJK runs via regex
 *  - For each run, run jieba.cut and keep non-empty tokens
 */
function _tokenizeQuery(query) {
    if (!query || typeof query !== 'string') return [];
    const normalized = query.trim().split(/\s+/).join(' ').toLowerCase();
    if (!normalized) return [];

    const tokenPattern = /[a-z0-9_]+|[\u4e00-\u9fff]+/gi;
    const matches = normalized.match(tokenPattern) || [];

    const jieba = getJieba();
    const tokens = [];
    for (const part of matches) {
        const cuts = jieba.cut(part);
        for (const c of cuts) {
            const t = (c || '').trim().toLowerCase();
            if (t) tokens.push(t);
        }
    }
    return tokens;
}

function _countOccurrences(tokens) {
    const out = {};
    for (const t of tokens) {
        out[t] = (out[t] || 0) + 1;
    }
    return out;
}

/**
 * Build the document frequency table over the candidate entries.
 * df[token] = number of entries that contain `token` in their word_counts.
 */
function _buildDocumentFrequency(entries) {
    const df = {};
    for (const entry of entries) {
        const wc = entry.word_counts || {};
        for (const token of Object.keys(wc)) {
            df[token] = (df[token] || 0) + 1;
        }
    }
    return df;
}

/**
 * Score a single index entry against the query.
 * Mirrors git-rules-mcp/query_engine.py:_score_entry.
 */
function _scoreEntry(entry, queryTokens, queryCounts, documentFrequency, totalDocuments) {
    let score = 0;
    const matchedTerms = [];
    const termHits = {};
    const seen = new Set();

    const wc = entry.word_counts || {};
    for (const token of queryTokens) {
        if (seen.has(token)) continue;
        seen.add(token);
        const entryCount = wc[token] || 0;
        if (entryCount === 0) continue;
        const queryCount = queryCounts[token] || 0;
        const df = documentFrequency[token] || 0;
        const idf = Math.log((1 + totalDocuments) / (1 + df)) + 1.0;
        score += entryCount * queryCount * idf;
        matchedTerms.push(token);
        termHits[token] = entryCount;
    }
    return { score, matchedTerms, termHits };
}

function _buildExplanation(matchedTerms) {
    if (!matchedTerms || matchedTerms.length === 0) return '';
    return `该文章被召回，因为命中了查询中的关键词"${matchedTerms.join('、')}"。`;
}

/**
 * Parse trailing "#<N>" from a chunk_id like "rules/code-review.md#3".
 * Returns 0 if the suffix is missing or non-numeric so chunks without
 * an explicit order still sort stably to the front.
 */
function _extractChunkOrder(chunkId) {
    if (!chunkId || typeof chunkId !== 'string') return 0;
    const idx = chunkId.lastIndexOf('#');
    if (idx === -1) return 0;
    const n = Number.parseInt(chunkId.slice(idx + 1), 10);
    return Number.isFinite(n) ? n : 0;
}

/**
 * Minimal frontmatter parser (no YAML dependency).
 * Returns { metadata: {}, body: string }.
 * Recognizes:
 *   ---
 *   title: ...
 *   category: ...
 *   tags: [a, b, c]   OR   tags:\n  - a\n  - b
 *   ---
 *   <body>
 */
function _parseFrontmatter(raw) {
    if (!raw.startsWith('---\n') && !raw.startsWith('---\r\n')) {
        return { metadata: {}, body: raw };
    }
    const lines = raw.split(/\r?\n/);
    let endIdx = -1;
    for (let i = 1; i < lines.length; i++) {
        if (lines[i] === '---') {
            endIdx = i;
            break;
        }
    }
    if (endIdx === -1) return { metadata: {}, body: raw };

    const metadata = {};
    let i = 1;
    while (i < endIdx) {
        const line = lines[i];
        const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/.exec(line);
        if (m) {
            const key = m[1];
            const valRaw = m[2].trim();
            if (valRaw === '') {
                // Multi-line list (tags:\n  - a\n  - b)
                const list = [];
                let j = i + 1;
                while (j < endIdx && /^\s*-\s+/.test(lines[j])) {
                    list.push(lines[j].replace(/^\s*-\s+/, '').trim());
                    j++;
                }
                metadata[key] = list;
                i = j;
                continue;
            } else if (valRaw.startsWith('[') && valRaw.endsWith(']')) {
                // Inline list: [a, b, c]
                metadata[key] = valRaw
                    .slice(1, -1)
                    .split(',')
                    .map((s) => s.trim())
                    .filter(Boolean);
            } else {
                // Strip surrounding quotes if present
                metadata[key] = valRaw.replace(/^['"]|['"]$/g, '');
            }
        }
        i++;
    }

    const body = lines.slice(endIdx + 1).join('\n');
    return { metadata, body };
}

function _extractFirstHeading(body) {
    if (!body) return null;
    const lines = body.split(/\r?\n/);
    for (const line of lines) {
        const m = /^#\s+(.+)$/.exec(line.trim());
        if (m) return m[1].trim();
    }
    return null;
}

/**
 * 把用户配置的 GitLab 基地址归一化成可用于 raw URL 拼接的根。
 * 处理：
 *   - 空值返回 null
 *   - 去尾部斜杠
 *   - 去 .git 后缀（git clone url 与 web url 可互转）
 *   - 保留 protocol/host/path 的其他部分
 */
function _normalizeRemoteBase(input) {
    if (!input || typeof input !== 'string') return null;
    let s = input.trim();
    if (!s) return null;
    s = s.replace(/\/+$/, '');
    if (s.toLowerCase().endsWith('.git')) s = s.slice(0, -4);
    s = s.replace(/\/+$/, '');
    return s || null;
}

module.exports = TeamRulesService;
module.exports.TeamRulesService = TeamRulesService;
