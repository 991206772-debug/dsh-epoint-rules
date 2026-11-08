/**
 * Design Placement Resolver Service（entity-first）
 *
 * Builder-owned: 在 design_prepare_context 末相执行文件命名解析。
 *
 * entity 重构后：Builder._buildEntityFileSet 已经把每个 entity 的 12 件套
 * resolvedPath 直接派生好（消费 navigationContract.rulePlacementContract.rules[]
 * 中的 relativeDirPattern + fileNamePattern + variants）。本 service 只需要
 * 把 businessEntities[].fileSet 收集成 resolvedEntities[] 透传给下游
 * design_prepare_context 自动封存即可，不再做二次模板渲染。
 *
 * 历史 module-first 形态：本 service 自己解析 fileSeeds/htmlPages 模板。
 */
'use strict';

class DesignPlacementResolverService {

    /**
     * @param {object} machineDesignJson - normalized design JSON（entity-first）
     * @param {object} navigationContract - full navigation contract（保留入参签名兼容，本实现不再消费）
     * @returns {{ ok: boolean, resolvedEntities?: Array, issues?: Array }}
     */
    resolve(machineDesignJson = {}, navigationContract = {}) {
        const entities = Array.isArray(machineDesignJson.businessEntities)
            ? machineDesignJson.businessEntities
            : [];

        const resolvedEntities = [];
        const issues = [];

        for (const entity of entities) {
            const entityKey = String(entity && entity.entityKey || '').trim();
            if (!entityKey) continue;
            // carriedByEntityKey 或 reuse 表 entity 没有自有 fileSet（Builder 已派生为 []）
            const fileSet = Array.isArray(entity.fileSet) ? entity.fileSet : [];
            if (fileSet.length === 0) continue;

            const resolvedFiles = [];
            for (const file of fileSet) {
                const fileKind = String(file && file.fileKind || '').trim();
                if (!fileKind) continue;
                const resolvedPath = String(file.resolvedPath || '').trim();
                if (!resolvedPath) {
                    issues.push({
                        entityKey,
                        fileKind,
                        code: 'PLACEMENT_RESOLVED_PATH_MISSING',
                        message: `entity ${entityKey} fileSet[fileKind=${fileKind}] 缺少 resolvedPath（Builder 应已派生）`
                    });
                    continue;
                }
                resolvedFiles.push({
                    fileKind,
                    ...(file.subType ? { subType: file.subType } : {}),
                    operation: file.operation || 'create',
                    resolvedPath,
                    ...(file.fileName ? { resolvedFileName: file.fileName } : {}),
                    contractSource: 'businessEntities[].fileSet (Builder-derived from navigationContract.rulePlacementContract)',
                    evidenceRef: entityKey
                });
            }

            if (resolvedFiles.length > 0) {
                resolvedEntities.push({ entityKey, resolvedFiles });
            }
        }

        if (issues.length > 0) {
            return {
                ok: false,
                status: 'blocked',
                actionMode: 'upstream_design_repair',
                errorCode: 'DESIGN_PLACEMENT_RESOLUTION_FAILED',
                message: `文件命名解析失败，共 ${issues.length} 个问题。businessEntities[].fileSet[].resolvedPath 应由 Builder 派生填充；缺失说明 Builder 内部派生失败。`,
                issues,
                allowedNextActions: ['repair_design_document_json', 'rerun_design_prepare_context'],
                forbiddenActions: ['write_design_document_json_directly']
            };
        }

        return { ok: true, resolvedEntities };
    }
}

module.exports = DesignPlacementResolverService;
