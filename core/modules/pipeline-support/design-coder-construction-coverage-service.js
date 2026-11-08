/* eslint-disable */

class DesignCoderConstructionCoverageService {
    validate(options = {}) {
        const design = options.designDocument && typeof options.designDocument === 'object'
            ? options.designDocument
            : {};
        const stories = this._stories(design);
        const entities = Array.isArray(design.businessEntities) ? design.businessEntities : [];
        const entityByKey = new Map(entities
            .map(entity => [String(entity && entity.entityKey || '').trim(), entity])
            .filter(([key]) => key));
        const coverage = new Map(stories.map(story => [story.storyId, []]));
        const issues = [];

        entities.forEach(entity => {
            const entityKey = String(entity && entity.entityKey || '').trim();
            const fileSet = Array.isArray(entity && entity.fileSet) ? entity.fileSet : [];
            const bindings = Array.isArray(entity && entity.constructionBindings) ? entity.constructionBindings : [];
            bindings.forEach((binding, index) => {
                const storyId = String(binding && binding.storyId || '').trim().toUpperCase();
                if (!coverage.has(storyId)) {
                    issues.push({
                        code: 'DESIGN_CODER_CONSTRUCTION_BINDING_STORY_UNKNOWN',
                        field: `businessEntities.${entityKey}.constructionBindings[${index}].storyId`,
                        storyId,
                        message: `施工绑定引用了未知 Story ${storyId || '(empty)'}。`
                    });
                    return;
                }
                const targetEntityKey = String(binding.targetEntityKey || entityKey).trim();
                if (!targetEntityKey || !entityByKey.has(targetEntityKey)) {
                    issues.push({
                        code: 'DESIGN_CODER_CONSTRUCTION_BINDING_TARGET_UNKNOWN',
                        field: `businessEntities.${entityKey}.constructionBindings[${index}].targetEntityKey`,
                        storyId,
                        message: `Story ${storyId} 的施工绑定目标 ${targetEntityKey || '(empty)'} 不存在。`
                    });
                    return;
                }
                const bindingKind = String(binding.bindingKind || '').trim();
                if (!bindingKind) {
                    issues.push({
                        code: 'DESIGN_CODER_CONSTRUCTION_BINDING_KIND_MISSING',
                        field: `businessEntities.${entityKey}.constructionBindings[${index}].bindingKind`,
                        storyId,
                        message: `Story ${storyId} 的施工绑定缺少 bindingKind。`
                    });
                    return;
                }
                if (bindingKind === 'configuration_only') {
                    if (entity.constructionSceneKey !== 'configuration_only' || entity.linkedTable?.kind !== 'none'
                        || entity.linkedTable?.needsPage === true || fileSet.length || binding.serviceBinding) {
                        issues.push({ code: 'DESIGN_CODER_CONFIGURATION_PROJECTION_CONFLICT',
                            field: `businessEntities.${entityKey}.constructionBindings[${index}]`, storyId,
                            message: `配置 Story ${storyId} 不得投影表、页面、代码文件或 Carrier Service。` });
                        return;
                    }
                    coverage.get(storyId).push({ entityKey, targetEntityKey, bindingKind });
                    return;
                }
                if (!String(binding.serviceBinding || '').trim()) {
                    issues.push({
                        code: 'DESIGN_CODER_CONSTRUCTION_SERVICE_BINDING_MISSING',
                        field: `businessEntities.${entityKey}.constructionBindings[${index}].serviceBinding`,
                        storyId,
                        message: `Story ${storyId} 没有绑定 Carrier Service。`
                    });
                    return;
                }
                const ownsFiles = ['owned_files', 'service_owner', 'rest_operation', 'job', 'statistics', 'service_only']
                    .includes(bindingKind);
                if (ownsFiles && fileSet.length === 0) {
                    issues.push({
                        code: 'DESIGN_CODER_CONSTRUCTION_OWNER_FILES_MISSING',
                        field: `businessEntities.${entityKey}.fileSet`,
                        storyId,
                        message: `Story ${storyId} 的 ${bindingKind} 绑定没有生成任何 owner 文件。`
                    });
                    return;
                }
                coverage.get(storyId).push({ entityKey, targetEntityKey, bindingKind });
            });
        });

        stories.forEach(story => {
            const existingEntries = story.existingAdjustment && Array.isArray(story.existingAdjustment.entryFiles)
                ? story.existingAdjustment.entryFiles
                : [];
            if (existingEntries.length > 0) {
                coverage.get(story.storyId).push({ bindingKind: 'existing_entry', count: existingEntries.length });
            }
            if (coverage.get(story.storyId).length === 0) {
                issues.push({
                    code: 'DESIGN_CODER_STORY_CONSTRUCTION_COVERAGE_MISSING',
                    field: `stories.${story.storyId}`,
                    storyId: story.storyId,
                    message: `Story ${story.storyId} 没有 owner 文件、Carrier patch、REST、Job、Workflow 或 Service-only 施工绑定。`
                });
            }
        });

        return issues.length > 0 ? {
            ok: false,
            status: 'blocked',
            actionMode: 'report_design_projection_defect',
            errorCode: 'DESIGN_CODER_CONSTRUCTION_COVERAGE_FAILED',
            message: '真实 Coder plan 可加载，但存在没有施工落点的 Story；这是 Builder 投影缺陷。',
            issues,
            allowedNextActions: ['report_design_projection_defect'],
            forbiddenActions: ['repair_business_answer', 'advance_to_coder']
        } : {
            ok: true,
            status: 'construction_coverage_valid',
            coverage: Object.fromEntries(coverage)
        };
    }

    _stories(design = {}) {
        const out = [];
        const seen = new Set();
        const push = story => {
            const storyId = String(story && (story.storyId || story.id) || '').trim().toUpperCase();
            if (!storyId || seen.has(storyId)) return;
            seen.add(storyId);
            out.push({ storyId, existingAdjustment: story && story.existingAdjustment });
        };
        if (Array.isArray(design.stories)) design.stories.forEach(push);
        if (out.length === 0) {
            (Array.isArray(design.businessEntities) ? design.businessEntities : [])
                .flatMap(entity => Array.isArray(entity && entity.relatedStories) ? entity.relatedStories : [])
                .forEach(push);
        }
        return out;
    }
}

module.exports = DesignCoderConstructionCoverageService;
