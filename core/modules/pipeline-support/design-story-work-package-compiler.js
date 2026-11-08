/* eslint-disable */

function array(value) {
    return Array.isArray(value) ? value : [];
}

function uniqueStrings(values = []) {
    return Array.from(new Set(array(values).map(item => String(item || '').trim()).filter(Boolean)));
}

class DesignStoryWorkPackageCompiler {
    compileEntity({
        constructionSceneKey = '',
        pageComposition = null,
        constructionBindings = [],
        entityKey = '',
        storyIds = [],
        renderConstructionScene = null,
        renderPageSurface = null
    } = {}) {
        const normalizedStoryIds = uniqueStrings(storyIds).map(item => item.toUpperCase());
        const normalizedBindings = array(constructionBindings).map(binding => ({
            storyId: String(binding && binding.storyId || '').trim().toUpperCase(),
            constructionSceneKey: String(binding && binding.constructionSceneKey || '').trim(),
            bindingKind: String(binding && binding.bindingKind || '').trim(),
            ...(binding && binding.querySurface && typeof binding.querySurface === 'object'
                ? { querySurface: JSON.parse(JSON.stringify(binding.querySurface)) }
                : {})
        })).filter(binding => binding.storyId);
        const sceneStoryIds = uniqueStrings(normalizedBindings
            .filter(binding => binding.constructionSceneKey === String(constructionSceneKey || '').trim())
            .map(binding => binding.storyId));
        const serviceStoryIds = uniqueStrings(normalizedBindings.map(binding => binding.storyId));
        const pageStoryIds = uniqueStrings(pageComposition && pageComposition.storyIds).map(item => item.toUpperCase());
        const renderers = [{ source: 'constructionScene', render: renderConstructionScene }];
        if (pageComposition && typeof pageComposition === 'object') {
            renderers.push({ source: 'pageComposition', render: renderPageSurface });
        }
        const merged = [];
        const seen = new Set();
        renderers.forEach(({ source, render }) => {
            const rendered = typeof render === 'function' ? array(render()) : [];
            rendered.forEach(file => {
                if (!file || typeof file !== 'object') return;
                const key = `${String(file.fileKind || '').trim()}:${String(file.resolvedPath || file.fileName || '').trim()}:${String(file.subType || '').trim()}`;
                if (!key || seen.has(key)) return;
                seen.add(key);
                let assignedStoryIds = sceneStoryIds.length > 0 ? sceneStoryIds : normalizedStoryIds.slice(0, 1);
                if (source === 'pageComposition') assignedStoryIds = pageStoryIds;
                else if (['Entity', 'ServiceApi', 'ServiceInternal', 'ServiceImpl'].includes(String(file.fileKind || '').trim())) {
                    assignedStoryIds = serviceStoryIds.length > 0 ? serviceStoryIds : normalizedStoryIds;
                } else if (['Action', 'HtmlPage'].includes(String(file.fileKind || '').trim()) && pageStoryIds.length > 0) {
                    assignedStoryIds = pageStoryIds;
                }
                if (assignedStoryIds.length === 0) return;
                merged.push({
                    ...file,
                    objectKey: String(entityKey || '').trim(),
                    storyIds: assignedStoryIds,
                    projectionSource: source,
                    managedProjection: true
                });
            });
        });
        return merged;
    }

    groupByStory(fileSet = []) {
        const grouped = {};
        array(fileSet).forEach(file => {
            uniqueStrings(file && file.storyIds).forEach(rawStoryId => {
                const storyId = rawStoryId.toUpperCase();
                if (!grouped[storyId]) grouped[storyId] = [];
                grouped[storyId].push({ ...file });
            });
        });
        return grouped;
    }
}

module.exports = DesignStoryWorkPackageCompiler;
