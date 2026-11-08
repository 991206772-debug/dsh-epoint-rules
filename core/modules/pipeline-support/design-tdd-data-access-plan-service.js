const fs = require('fs');
const path = require('path');

class DesignTddDataAccessPlanService {
    constructor(options = {}) {
        this.readJsonSafe = typeof options.readJsonSafe === 'function'
            ? options.readJsonSafe
            : DesignTddDataAccessPlanService._readJsonSafe;
        this.refreshReuseIndex = typeof options.refreshReuseIndex === 'function'
            ? options.refreshReuseIndex
            : null;
        this._reuseIndexPreparation = null;
    }

    static _readJsonSafe(filePath) {
        try {
            return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        } catch (_) {
            return null;
        }
    }

    buildPlans({ projectPath = '', designDocument = {}, modulePlans = [], filePlan = [], constructionBindings = [] } = {}) {
        const normalizedProject = String(projectPath || '').trim();
        const tables = designDocument && designDocument.databaseDesign && Array.isArray(designDocument.databaseDesign.tables)
            ? designDocument.databaseDesign.tables
            : [];
        const modulesById = new Map();
        for (const mod of (Array.isArray(designDocument && designDocument.modules) ? designDocument.modules : [])) {
            const moduleId = String(mod && mod.moduleId || '').trim();
            if (moduleId && !modulesById.has(moduleId)) modulesById.set(moduleId, mod);
        }
        const filesByModule = new Map();
        for (const file of (Array.isArray(filePlan) ? filePlan : [])) {
            const moduleId = String(file && file.moduleId || '').trim();
            if (!moduleId) continue;
            if (!filesByModule.has(moduleId)) filesByModule.set(moduleId, []);
            filesByModule.get(moduleId).push(file);
        }

        const plansByModuleId = {};
        for (const modulePlan of (Array.isArray(modulePlans) ? modulePlans : [])) {
            const moduleId = String(modulePlan && modulePlan.moduleId || '').trim();
            if (!moduleId) continue;
            const ownerFiles = filesByModule.get(moduleId) || [];
            const queryOnly = this._hasQueryOnlyList(ownerFiles, modulePlan);
            const carrierServiceBindings = this._carrierServiceBindings({
                moduleId,
                modulePlan,
                constructionBindings
            });
            const statisticsAnalysis = String(modulePlan && modulePlan.constructionSceneKey || '').trim() === 'statistics_analysis';
            if (!queryOnly && !statisticsAnalysis && carrierServiceBindings.length === 0) {
                continue;
            }
            const carriedByModuleId = String(modulePlan && modulePlan.carriedByModuleId || '').trim();
            if (carriedByModuleId) {
                const carriedPlan = this._buildCarriedServicePlan({
                    projectPath: normalizedProject,
                    moduleId,
                    modulePlan,
                    ownerFiles,
                    queryOnly,
                    carrierServiceBindings,
                    carrierModuleId: carriedByModuleId,
                    carrierModulePlan: (Array.isArray(modulePlans) ? modulePlans : [])
                        .find(item => String(item && item.moduleId || '').trim() === carriedByModuleId) || {},
                    carrierOwnerFiles: filesByModule.get(carriedByModuleId) || [],
                    tables
                });
                if (carriedPlan) plansByModuleId[moduleId] = carriedPlan;
                continue;
            }
            if (statisticsAnalysis) {
                const statisticsPlan = this._buildStatisticsSourcePlan({
                    projectPath: normalizedProject,
                    moduleId,
                    modulePlan,
                    ownerFiles
                });
                if (statisticsPlan) plansByModuleId[moduleId] = statisticsPlan;
                continue;
            }
            const module = modulesById.get(moduleId) || {};
            const relatedTables = this._tablesForStableIdentity(tables, moduleId, modulePlan, module);
            const reuseTables = relatedTables.filter(table => this._isReuseTable(table));
            if (reuseTables.length === 0) continue;
            plansByModuleId[moduleId] = this._buildReuseQueryPlan({
                projectPath: normalizedProject,
                moduleId,
                module,
                modulePlan,
                ownerFiles,
                tables: reuseTables
            });
        }
        return {
            schemaVersion: 'design-tdd-data-access-plans/v1',
            plansByModuleId,
            plans: Object.values(plansByModuleId)
        };
    }

    _buildStatisticsSourcePlan({ projectPath = '', moduleId = '', modulePlan = {}, ownerFiles = [] } = {}) {
        const serviceKinds = ['ServiceApi', 'ServiceInternal', 'ServiceImpl'];
        const filesByKind = new Map(serviceKinds.map(fileKind => [
            fileKind,
            (Array.isArray(ownerFiles) ? ownerFiles : []).filter(file =>
                String(file && file.fileKind || '').trim() === fileKind
            )
        ]));
        const invalidFileKinds = serviceKinds.filter(fileKind => (filesByKind.get(fileKind) || []).length !== 1);
        const serviceApiFile = (filesByKind.get('ServiceApi') || [])[0];
        const serviceInternalFile = (filesByKind.get('ServiceInternal') || [])[0];
        const serviceImplFile = (filesByKind.get('ServiceImpl') || [])[0];
        const serviceApiPath = this._normalizeProjectRelativePath(projectPath, serviceApiFile && serviceApiFile.resolvedPath);
        const serviceInternalPath = this._normalizeProjectRelativePath(projectPath, serviceInternalFile && serviceInternalFile.resolvedPath);
        const serviceImplPath = this._normalizeProjectRelativePath(projectPath, serviceImplFile && serviceImplFile.resolvedPath);
        const fallbackEntityName = this._wrapGxhName(modulePlan && modulePlan.entityName);
        const entityClassName = fallbackEntityName || '';
        const serviceInterface = this._classNameFromSource(serviceApiPath)
            || (entityClassName ? `I${entityClassName}Service` : '');
        const serviceInternalClassName = this._classNameFromSource(serviceInternalPath)
            || (entityClassName ? `${entityClassName}Service` : '');
        const serviceImplClassName = this._classNameFromSource(serviceImplPath)
            || (entityClassName ? `${entityClassName}ServiceImpl` : '');
        if (invalidFileKinds.length > 0 || !serviceInterface || !serviceInternalClassName || !serviceImplClassName) {
            return {
                planId: `DAP-${moduleId}`,
                moduleId,
                mode: 'blocked',
                accessType: 'statistics_sources',
                serviceOnly: true,
                noEntity: true,
                invalidFileKinds: [
                    ...invalidFileKinds,
                    ...(!serviceInterface ? ['ServiceApiName'] : []),
                    ...(!serviceInternalClassName ? ['ServiceInternalName'] : []),
                    ...(!serviceImplClassName ? ['ServiceImplName'] : [])
                ],
                errorCode: 'DESIGN_TDD_STATISTICS_SERVICE_ONLY_PROJECTION_MISSING',
                message: `统计模块 ${moduleId} 没有唯一的 ServiceApi/ServiceInternal/ServiceImpl 只读统计 Service 投影，禁止让 Coder 猜 Service 或来源表。`,
                defectOwner: 'Builder',
                allowedNextActions: ['fix_builder_projection_then_rerun_design_tdd_build_plan']
            };
        }

        const sources = [];
        const seenSources = new Set();
        const contracts = this._normalizeStatisticsContracts(
            modulePlan && modulePlan.statisticsContracts,
            modulePlan && modulePlan.statisticsContract
        );
        contracts.forEach(contract => {
            (Array.isArray(contract && contract.dataSources) ? contract.dataSources : []).forEach(source => {
                if (!source || typeof source !== 'object' || Array.isArray(source)) return;
                const tableName = String(source.tableName || '').trim();
                if (!tableName) return;
                const role = String(source.role || '').trim().toLowerCase();
                const sourceName = String(source.sourceName || source.tableComment || tableName).trim();
                const key = `${tableName.toUpperCase()}::${role}`;
                if (seenSources.has(key)) return;
                seenSources.add(key);
                sources.push({
                    tableName,
                    ...(role ? { role } : {}),
                    ...(sourceName ? { sourceName } : {})
                });
            });
        });
        const servicePath = serviceApiPath || serviceInternalPath || serviceImplPath;
        const servicePackage = this._resolveJavaPackage(projectPath, servicePath);
        const internalPackage = this._resolveJavaPackage(projectPath, serviceInternalPath);
        const implPackage = this._resolveJavaPackage(projectPath, serviceImplPath);
        const fieldName = this._deriveFieldName(serviceInterface);
        return {
            planId: `DAP-${moduleId}`,
            moduleId,
            mode: 'statistics_source',
            accessType: 'statistics_sources',
            serviceOnly: true,
            noEntity: true,
            sources,
            service: {
                interfaceName: serviceInterface,
                fieldName,
                ...(serviceApiPath ? { sourcePath: serviceApiPath } : {}),
                ...(servicePackage ? { packageName: servicePackage } : {})
            },
            serviceInternal: {
                className: serviceInternalClassName,
                ...(serviceInternalPath ? { sourcePath: serviceInternalPath } : {}),
                ...(internalPackage ? { packageName: internalPackage } : {})
            },
            serviceImpl: {
                className: serviceImplClassName,
                ...(serviceImplPath ? { sourcePath: serviceImplPath } : {}),
                ...(implPackage ? { packageName: implPackage } : {})
            },
            queryMethod: {
                methodName: 'queryStatisticsData',
                callShapeMode: 'service_condition_page',
                callShape: `${fieldName}.queryStatisticsData(params, first, pageSize)`,
                argumentContract: this._queryConditionArgumentContract()
            },
            owner: {
                entityName: String(modulePlan && modulePlan.entityName || '').trim(),
                pageName: String(modulePlan && (modulePlan.pageName || modulePlan.pagename) || '').trim(),
                bizModule: String(modulePlan && modulePlan.bizModule || '').trim(),
                domain: String(modulePlan && modulePlan.domain || '').trim()
            },
            note: '统计页没有业务 Carrier 时，Builder 为本模块生成 serviceOnly/noEntity 的 Service 三层；sources 只读来自 statisticsContract.dataSources，不生成来源表 Entity、DDL 或 CRUD。'
        };
    }

    _normalizeStatisticsContracts(value = [], fallback = null) {
        const raw = [];
        if (Array.isArray(value)) {
            value.forEach(item => {
                if (item && typeof item === 'object' && !Array.isArray(item)) raw.push(item);
            });
        } else if (value && typeof value === 'object' && !Array.isArray(value)) {
            raw.push(value);
        }
        if (raw.length === 0 && fallback && typeof fallback === 'object' && !Array.isArray(fallback)) {
            raw.push(fallback);
        }
        return raw;
    }

    _buildCarriedServicePlan({ projectPath = '', moduleId = '', modulePlan = {}, ownerFiles = [], queryOnly = false, carrierServiceBindings = [], carrierModuleId = '', carrierModulePlan = {}, carrierOwnerFiles = [], tables = [] } = {}) {
        const carrierFiles = Array.isArray(carrierOwnerFiles) ? carrierOwnerFiles : [];
        const entityFiles = carrierFiles.filter(file => String(file && file.fileKind || '').trim() === 'Entity');
        const serviceApiFiles = carrierFiles.filter(file => String(file && file.fileKind || '').trim() === 'ServiceApi');
        const serviceInternalFiles = carrierFiles.filter(file => String(file && file.fileKind || '').trim() === 'ServiceInternal');
        const entityFile = entityFiles[0];
        const serviceApiFile = serviceApiFiles[0];
        const entityPath = this._normalizeProjectRelativePath(projectPath, entityFile && entityFile.resolvedPath);
        const servicePath = this._normalizeProjectRelativePath(projectPath, serviceApiFile && serviceApiFile.resolvedPath);
        const entityClassName = this._classNameFromSource(entityPath) || this._wrapGxhName(carrierModulePlan && carrierModulePlan.entityName);
        const serviceInterface = this._classNameFromSource(servicePath) || (entityClassName ? `I${entityClassName}Service` : '');
        const carrierServiceMode = carrierServiceBindings.length > 0;
        const accessType = carrierServiceMode ? 'carried_rest_service' : 'carried_query_list';
        const errorCode = carrierServiceMode ?
            'DESIGN_TDD_REST_CARRIER_SERVICE_PROJECTION_MISSING' :
            'DESIGN_TDD_CARRIED_QUERY_ACCESS_PLAN_MISSING';
        if (entityFiles.length !== 1 || serviceApiFiles.length !== 1 ||
            (carrierServiceMode && serviceInternalFiles.length !== 1) ||
            !entityClassName || !serviceInterface) {
            return {
                planId: `DAP-${moduleId}`,
                moduleId,
                mode: 'blocked',
                accessType,
                queryOnly,
                carriedByModuleId: carrierModuleId,
                errorCode,
                message: `${carrierServiceMode ? 'REST' : 'query-only'} 模块 ${moduleId} 声明由 ${carrierModuleId} 承载，但承载模块无法唯一定位 Entity 和 ServiceApi owner 文件，禁止生成本模块幽灵 Service 或让 Coder 猜接口。`,
                invalidFileKinds: [
                    ...(entityFiles.length === 1 ? [] : ['Entity']),
                    ...(serviceApiFiles.length === 1 ? [] : ['ServiceApi']),
                    ...(!carrierServiceMode || serviceInternalFiles.length === 1 ? [] : ['ServiceInternal'])
                ],
                defectOwner: 'Builder',
                allowedNextActions: [
                    'rerun_design_tdd_build_plan_after_carrier_service_ready'
                ]
            };
        }
        const storyIds = this._uniqueStrings(carrierServiceMode ?
            carrierServiceBindings.map(binding => binding && binding.storyId) :
            [
                ...(Array.isArray(ownerFiles) ? ownerFiles : []).flatMap(file => Array.isArray(file && file.storyIds) ? file.storyIds : []),
                modulePlan && modulePlan.storyId
            ]).map(storyId => storyId.toUpperCase());
        const carrierTables = this._tablesForStableIdentity(tables, carrierModuleId, carrierModulePlan, {});
        const primaryTable = carrierTables[0] || {};
        const fieldIntent = this._buildReuseQueryFieldIntent({ ...modulePlan, codingFactHandoff: modulePlan.codingFactHandoff || [] }, carrierTables);
        let note = 'Builder 从 carriedByModuleId 确认本查询入口复用承载模块的 Entity/Service，不得按当前查询模块名称生成同名 Service。';
        if (String(modulePlan && modulePlan.constructionSceneKey || '').trim() === 'statistics_analysis') {
            note = 'Builder 从 carriedByModuleId 确认统计报表读取承载模块数据；统计入口只生成 Action/HtmlPage，统计方法归承载模块 Service 扩展，禁止为统计入口生成幽灵 Entity/CRUD Service。';
        }
        if (carrierServiceMode) {
            note = 'Builder 从 rest_operation 的 carrier_service 绑定机械确认 REST 读取承载模块 Entity/Service；这些文件只作为受管只读证据暴露给 REST Story，不得生成同名幽灵 Service。';
        }
        return {
            planId: `DAP-${moduleId}`,
            moduleId,
            mode: 'carried_service',
            accessType,
            queryOnly,
            carriedByModuleId: carrierModuleId,
            ...(storyIds.length > 0 ? { storyIds } : {}),
            ...(carrierServiceMode ? {
                serviceBinding: 'carrier_service',
                targetEntityKeys: this._uniqueStrings(carrierServiceBindings.map(binding => binding && binding.targetEntityKey))
            } : {}),
            table: {
                tableName: String(primaryTable.tableName || '').trim(),
                tableComment: String(primaryTable.tableComment || '').trim(),
                entityName: entityClassName,
                ...(entityPath ? { sourcePath: entityPath } : {})
            },
            entity: {
                className: entityClassName,
                ...(entityPath ? { sourcePath: entityPath } : {}),
                ...(this._resolveJavaPackage(projectPath, entityPath) ? { packageName: this._resolveJavaPackage(projectPath, entityPath) } : {})
            },
            service: {
                interfaceName: serviceInterface,
                fieldName: this._deriveFieldName(serviceInterface),
                methodName: 'paginatorList',
                ...(servicePath ? { sourcePath: servicePath } : {}),
                ...(this._resolveJavaPackage(projectPath, servicePath) ? { packageName: this._resolveJavaPackage(projectPath, servicePath) } : {})
            },
            queryMethod: {
                methodName: 'paginatorList',
                callShapeMode: 'service_condition_page',
                callShape: `${this._deriveFieldName(serviceInterface)}.paginatorList(sql.getMap(), first, pageSize)`,
                argumentContract: this._queryConditionArgumentContract()
            },
            owner: {
                entityName: String(modulePlan && modulePlan.entityName || '').trim(),
                pageName: String(modulePlan && (modulePlan.pageName || modulePlan.pagename) || '').trim(),
                bizModule: String(modulePlan && modulePlan.bizModule || '').trim(),
                domain: String(modulePlan && modulePlan.domain || '').trim()
            },
            ...(fieldIntent ? { fieldIntent } : {}),
            note
        };
    }

    _carrierServiceBindings({ moduleId = '', modulePlan = {}, constructionBindings = [] } = {}) {
        if (String(modulePlan && modulePlan.constructionSceneKey || '').trim() !== 'rest_interface') {
            return [];
        }
        if (!String(modulePlan && modulePlan.carriedByModuleId || '').trim()) {
            return [];
        }
        return (Array.isArray(constructionBindings) ? constructionBindings : []).filter(binding => {
            const ownerMatches = String(binding && binding.moduleId || '').trim() === String(moduleId || '').trim();
            const bindingKind = String(binding && binding.bindingKind || '').trim();
            const serviceBinding = String(binding && binding.serviceBinding || '').trim();
            return ownerMatches && bindingKind === 'rest_operation' && serviceBinding === 'carrier_service';
        });
    }

    _hasQueryOnlyList(ownerFiles = [], modulePlan = {}) {
        const hasQueryOnlyFile = (Array.isArray(ownerFiles) ? ownerFiles : []).some(file => {
            const kind = String(file && file.fileKind || '').trim();
            const subType = String(file && file.subType || '').trim().toLowerCase();
            return file && file.queryOnly === true && (kind === 'Action' || kind === 'HtmlPage') && (!subType || subType === 'list');
        });
        if (hasQueryOnlyFile) return true;
        const scene = String(modulePlan && modulePlan.constructionSceneKey || '').trim().toLowerCase();
        if (['query_result_entry', 'query_only', 'query_list'].includes(scene)) return true;
        return (modulePlan && modulePlan.queryOnly === true)
            || String(modulePlan && modulePlan.capability || '').trim().toLowerCase() === 'query';
    }

    _tablesForStableIdentity(tables = [], moduleId = '', modulePlan = {}, module = {}) {
        const normalizedModuleId = String(moduleId || '').trim();
        const direct = (Array.isArray(tables) ? tables : []).filter(table => {
            const related = Array.isArray(table && table.relatedModuleIds) ? table.relatedModuleIds : [];
            return related.map(item => String(item || '').trim()).includes(normalizedModuleId);
        });
        if (direct.length > 0) return direct;

        const objectKey = String(
            modulePlan && modulePlan.objectKey
            || module && module.objectKey
            || module && module.entityKey
            || module && module.codingHandoff && module.codingHandoff.objectKey
            || ''
        ).trim();
        if (!objectKey) return [];
        return (Array.isArray(tables) ? tables : [])
            .filter(table => String(table && table.objectKey || '').trim() === objectKey);
    }

    _isReuseTable(table = {}) {
        if (!table || typeof table !== 'object') return false;
        return table.reuse === true
            || String(table.kind || '').trim() === 'reuse'
            || !!String(table.reuseSourceFile || '').trim()
            || (Array.isArray(table.reusedApis) && table.reusedApis.length > 0)
            || (Array.isArray(table.reuseDirHints) && table.reuseDirHints.length > 0);
    }

    _buildReuseQueryPlan({ projectPath = '', moduleId = '', module = {}, modulePlan = {}, ownerFiles = [], tables = [] } = {}) {
        const primaryTable = tables[0] || {};
        const reuseSourceFile = String(primaryTable.reuseSourceFile || '').trim();
        const entityClassName = String(primaryTable.entityName || '').trim()
            || this._classNameFromSource(reuseSourceFile)
            || this._wrapGxhName(modulePlan && modulePlan.entityName);
        const entitySourcePath = this._normalizeProjectRelativePath(projectPath, reuseSourceFile);
        const entityPackage = this._resolveJavaPackage(projectPath, entitySourcePath);
        const reusedApis = this._uniqueStrings(primaryTable.reusedApis || []);
        const fieldIntent = this._buildReuseQueryFieldIntent(module, tables);
        const basePlan = {
            planId: `DAP-${moduleId}`,
            moduleId,
            accessType: 'reuse_query_list',
            queryOnly: true,
            table: {
                tableName: String(primaryTable.tableName || '').trim(),
                tableComment: String(primaryTable.tableComment || '').trim(),
                ...(entityClassName ? { entityName: entityClassName } : {}),
                ...(entitySourcePath ? { reuseSourceFile: entitySourcePath } : {})
            },
            tables: tables.map(table => ({
                tableName: String(table && table.tableName || '').trim(),
                tableComment: String(table && table.tableComment || '').trim(),
                ...(table && table.reuse === true ? { reuse: true } : {}),
                ...(table && table.reuseSourceFile ? { reuseSourceFile: this._normalizeProjectRelativePath(projectPath, table.reuseSourceFile) } : {}),
                ...(Array.isArray(table && table.reusedApis) && table.reusedApis.length > 0 ? { reusedApis: this._uniqueStrings(table.reusedApis) } : {})
            })),
            entity: {
                className: entityClassName,
                ...(entityPackage ? { packageName: entityPackage } : {}),
                ...(entitySourcePath ? { sourcePath: entitySourcePath } : {})
            },
            owner: {
                entityName: String(modulePlan && modulePlan.entityName || '').trim(),
                pageName: String(modulePlan && (modulePlan.pageName || modulePlan.pagename) || '').trim(),
                bizModule: String(modulePlan && modulePlan.bizModule || '').trim(),
                domain: String(modulePlan && modulePlan.domain || '').trim()
            },
            ...(fieldIntent ? { fieldIntent } : {})
        };

        if (reusedApis.length > 0) {
            return {
                ...basePlan,
                mode: 'existing_service',
                reusedApis,
                note: '设计阶段已确认复用查询 API；Coder 必须按 reusedApis 精确读源/规范，不得编造同名 CRUD Service。'
            };
        }

        const serviceResolution = this._resolvePagingService(projectPath, primaryTable);
        const hasEntityEvidence = this._hasReuseEntityEvidence(primaryTable);
        if (!serviceResolution.ok && (!hasEntityEvidence || serviceResolution.status === 'ambiguous')) {
            return {
                ...basePlan,
                mode: 'blocked',
                errorCode: serviceResolution.errorCode || 'DESIGN_TDD_REUSE_INDEX_REFRESH_FAILED',
                message: serviceResolution.message || '复用 Service 索引刷新失败，无法确认项目中是否已有可复用 Service；禁止误生成新 Service。',
                defectOwner: 'Builder',
                allowedNextActions: [
                    'fix_reuse_index_refresh_then_rerun_design_tdd_build_plan'
                ]
            };
        }
        const indexRefreshWarning = !serviceResolution.ok || serviceResolution.indexRefresh
            ? {
                errorCode: serviceResolution.errorCode
                    || serviceResolution.indexRefresh && serviceResolution.indexRefresh.errorCode
                    || 'DESIGN_TDD_REUSE_INDEX_REFRESH_FAILED',
                message: serviceResolution.message
                    || serviceResolution.indexRefresh && serviceResolution.indexRefresh.message
                    || '轻量复用索引刷新失败，已使用复用表来源证据继续生成只读 Service。',
                status: serviceResolution.status || serviceResolution.indexRefresh && serviceResolution.indexRefresh.status || 'refresh_failed'
            }
            : null;
        const genericService = serviceResolution.service;
        if (genericService) {
            const genericCall = genericService.callShapeMode === 'generic_entity_class';
            const callShape = genericCall
                ? `${genericService.fieldName}.${genericService.methodName}(${entityClassName}.class, sql.getMap(), first, pageSize)`
                : `${genericService.fieldName}.${genericService.methodName}(sql.getMap(), first, pageSize)`;
            return {
                ...basePlan,
                mode: genericCall ? 'generic_service' : 'existing_service',
                ...(genericCall ? {} : { reusedApis: [`${genericService.interfaceName}.${genericService.methodName}`] }),
                service: genericService,
                queryMethod: {
                    methodName: genericService.methodName,
                    callShapeMode: genericService.callShapeMode,
                    callShape,
                    argumentContract: this._queryConditionArgumentContract()
                },
                ...(indexRefreshWarning ? { indexRefreshWarning } : {}),
                note: genericCall
                    ? 'Builder 先刷新 scan 复用索引，再从索引和接口源码确认存在 Class<T> + Map + first/pageSize 的通用分页查询服务。'
                    : 'Builder 先刷新 scan 复用索引，再按当前复用表关联的历史调用确认已有分页 Service；Coder 必须按 reusedApis 精确读取源码。'
            };
        }

        if (this._hasReuseEntityEvidence(primaryTable)) {
            const generatedService = this._generatedReuseServiceDescriptor({
                projectPath,
                entityClassName,
                entitySourcePath,
                ownerFiles
            });
            if (generatedService) {
                return {
                    ...basePlan,
                    mode: 'generated_service',
                    serviceOnly: true,
                    noEntity: true,
                    entity: {
                        ...basePlan.entity,
                        generated: false,
                        source: 'reuse_table_evidence'
                    },
                    service: generatedService.service,
                    serviceInternal: generatedService.serviceInternal,
                    serviceImpl: generatedService.serviceImpl,
                    queryMethod: {
                        methodName: 'paginatorList',
                        callShapeMode: 'service_condition_page',
                        callShape: `${generatedService.service.fieldName}.paginatorList(sql.getMap(), first, pageSize)`,
                        argumentContract: this._queryConditionArgumentContract()
                    },
                    ...(indexRefreshWarning ? { indexRefreshWarning } : {}),
                    note: '复用表已确认实体/表来源但没有可复用 API；Builder 生成只读查询 Service 三层，Action 统一调用 paginatorList，不生成 Entity、DDL 或普通 CRUD。'
                };
            }
        }

        return {
            ...basePlan,
            mode: 'blocked',
            errorCode: 'DESIGN_TDD_REUSE_QUERY_ACCESS_PLAN_MISSING',
            message: '复用表 query-only 列表缺少可执行查询依据：未找到 reusedApis、通用分页 Service 或复用实体/表来源证据。请先让 scan 产出 reuseSourceFile/reuseDirHints/columns；证据齐全后 Builder 会生成只读查询 Service。',
            defectOwner: 'Builder',
            allowedNextActions: [
                'rerun_project_scan_to_refresh_code_reuse_index',
                'repair_coder_projection_after_query_access_evidence_ready'
            ]
        };
    }

    _hasReuseEntityEvidence(table = {}) {
        if (!table || typeof table !== 'object') return false;
        const sourceFile = String(table.reuseSourceFile || '').trim();
        const dirHints = this._uniqueStrings(table.reuseDirHints || []);
        const columns = Array.isArray(table.columns) ? table.columns.filter(item => item && typeof item === 'object') : [];
        return Boolean(sourceFile || dirHints.length > 0 || columns.length > 0);
    }

    _generatedReuseServiceDescriptor({ projectPath = '', entityClassName = '', entitySourcePath = '', ownerFiles = [] } = {}) {
        const files = Array.isArray(ownerFiles) ? ownerFiles : [];
        const fileByKind = kind => files.find(file => String(file && file.fileKind || '').trim() === kind) || {};
        const entityBase = String(entityClassName || '').trim();
        if (!entityBase) return null;
        const fallbackEntityName = entityBase.startsWith('Gxh') ? entityBase : `Gxh${entityBase}`;
        const fallbackNames = {
            serviceInterface: `I${fallbackEntityName}Service`,
            serviceInternal: `${fallbackEntityName}Service`,
            serviceImpl: `${fallbackEntityName}ServiceImpl`
        };
        const serviceApiFile = fileByKind('ServiceApi');
        const serviceInternalFile = fileByKind('ServiceInternal');
        const serviceImplFile = fileByKind('ServiceImpl');
        const serviceApiPath = this._normalizeProjectRelativePath(projectPath, serviceApiFile.resolvedPath);
        const serviceInternalPath = this._normalizeProjectRelativePath(projectPath, serviceInternalFile.resolvedPath);
        const serviceImplPath = this._normalizeProjectRelativePath(projectPath, serviceImplFile.resolvedPath);
        const serviceInterface = this._classNameFromSource(serviceApiPath) || fallbackNames.serviceInterface;
        const serviceInternalClassName = this._classNameFromSource(serviceInternalPath) || fallbackNames.serviceInternal;
        const serviceImplClassName = this._classNameFromSource(serviceImplPath) || fallbackNames.serviceImpl;
        const servicePath = serviceApiPath || serviceInternalPath || serviceImplPath;
        const servicePackage = this._resolveJavaPackage(projectPath, servicePath);
        const internalPackage = this._resolveJavaPackage(projectPath, serviceInternalPath);
        const implPackage = this._resolveJavaPackage(projectPath, serviceImplPath);
        return {
            service: {
                interfaceName: serviceInterface,
                fieldName: this._deriveFieldName(serviceInterface),
                methodName: 'paginatorList',
                ...(serviceApiPath ? { sourcePath: serviceApiPath } : {}),
                ...(servicePackage ? { packageName: servicePackage } : {})
            },
            serviceInternal: {
                className: serviceInternalClassName,
                ...(serviceInternalPath ? { sourcePath: serviceInternalPath } : {}),
                ...(internalPackage ? { packageName: internalPackage } : {})
            },
            serviceImpl: {
                className: serviceImplClassName,
                ...(serviceImplPath ? { sourcePath: serviceImplPath } : {}),
                ...(implPackage ? { packageName: implPackage } : {})
            },
            entitySourcePath
        };
    }

    /**
     * 设计阶段复用表查询的轻量索引准备。
     *
     * 只执行 code-reuse-index（Service/Action/route）扫描，不重建完整项目基线。
     * 同一轮 Builder 调用内复用准备结果；下一轮调用 forceRefresh=true 时重新执行。
     */
    prepareReuseIndex(projectPath = '', { forceRefresh = false } = {}) {
        const root = String(projectPath || '').trim();
        const indexPath = path.join(root, '.ai-workspace', 'project', 'code-reuse-index.json');
        const receiptPath = path.join(root, '.ai-workspace', 'project', 'code-reuse-index-receipt.json');
        if (!this.refreshReuseIndex) {
            const state = { ok: true, status: 'not_configured', indexPath, receiptPath };
            this._reuseIndexPreparation = { projectPath: root, state };
            return state;
        }
        if (!forceRefresh && this._reuseIndexPreparation && this._reuseIndexPreparation.projectPath === root) {
            return this._reuseIndexPreparation.state;
        }
        if (!root) {
            const state = {
                ok: false,
                status: 'refresh_failed',
                errorCode: 'DESIGN_TDD_REUSE_INDEX_PROJECT_PATH_MISSING',
                message: '复用表查询需要 projectPath 才能执行轻量复用索引刷新。',
                indexPath,
                receiptPath
            };
            this._reuseIndexPreparation = { projectPath: root, state };
            return state;
        }
        let result;
        try {
            result = this.refreshReuseIndex(root);
        } catch (error) {
            result = { ok: false, message: String(error && error.message || error) };
        }
        const refreshMessage = String(result && (result.message || result.reason) || '').trim();
        const ok = !!(result && result.ok === true && fs.existsSync(indexPath) && fs.existsSync(receiptPath));
        const state = ok
            ? {
                ok: true,
                status: 'refreshed',
                indexPath,
                receiptPath,
                refreshReceipt: result.refreshReceipt || { written: true, path: receiptPath }
            }
            : {
                ok: false,
                status: 'refresh_failed',
                errorCode: 'DESIGN_TDD_REUSE_INDEX_REFRESH_FAILED',
                message: refreshMessage
                    ? `轻量复用索引刷新失败：${refreshMessage}`
                    : '轻量复用索引刷新未产出 code-reuse-index.json 和 receipt，无法确认项目中是否已有 Service。',
                indexPath,
                receiptPath
            };
        this._reuseIndexPreparation = { projectPath: root, state };
        return state;
    }

    resetReuseIndexPreparation() {
        this._reuseIndexPreparation = null;
    }

    _resolvePagingService(projectPath = '', table = {}) {
        const preparation = this.prepareReuseIndex(projectPath);
        const indexPath = preparation.indexPath
            || path.join(String(projectPath || ''), '.ai-workspace', 'project', 'code-reuse-index.json');
        const indexed = this._resolvePagingServiceFromIndex(projectPath, table, indexPath);
        if (preparation.ok) return indexed;

        // 轻量刷新失败不等于项目没有 Service。若磁盘上仍有上一轮可验证索引，
        // 先使用这份旧索引；若旧索引也没有命中，再由上层依据复用表来源证据
        // 决定是否生成只读 Service，避免把“索引暂时不可用”变成整单阻断。
        if (indexed && indexed.service) {
            return {
                ...indexed,
                status: 'stale_index_fallback',
                indexRefresh: preparation
            };
        }
        if (indexed && indexed.status === 'ambiguous') {
            return {
                ...indexed,
                indexRefresh: preparation,
                message: `轻量复用索引刷新失败，旧索引仍命中多个可分页 Service：${indexed.message || ''}`
            };
        }
        return {
            ...preparation,
            status: 'refresh_failed_no_service_match',
            indexPath,
            service: null,
            fallback: 'reuse_table_evidence'
        };
    }

    _resolvePagingServiceFromIndex(projectPath = '', table = {}, indexPath = '') {
        const resolvedIndexPath = indexPath
            || path.join(String(projectPath || ''), '.ai-workspace', 'project', 'code-reuse-index.json');
        const index = this.readJsonSafe(resolvedIndexPath);
        if (!index || typeof index !== 'object') {
            return { ok: true, status: 'not_found', indexPath: resolvedIndexPath, service: null };
        }
        const services = this._collectIndexedServices(index);
        const targetedServices = this._selectServicesForTable(index, services, projectPath, table);
        const candidates = targetedServices.length > 0 ? targetedServices : services;
        const validServices = [];
        for (const svc of candidates) {
            if (svc.sourceKind && svc.sourceKind !== 'project_source') continue;
            const sourcePath = this._normalizeProjectRelativePath(projectPath, svc.sourcePath);
            const absolute = this._resolveProjectFile(projectPath, sourcePath);
            if (!absolute || !fs.existsSync(absolute)) continue;
            let text = '';
            try {
                text = fs.readFileSync(absolute, 'utf-8');
            } catch (_) {
                continue;
            }
            const method = this._extractPagingMethod(text);
            if (!method) continue;
            const packageName = svc.packageName || this._extractPackageName(text);
            validServices.push({
                interfaceName: svc.interfaceName,
                fieldName: svc.fieldName || this._deriveFieldName(svc.interfaceName),
                sourceKind: 'project_source',
                sourcePath,
                ...(packageName ? { packageName } : {}),
                methodName: method.methodName,
                methodSignature: method.signature,
                callShapeMode: method.callShapeMode
            });
        }
        if (validServices.length === 0) {
            return { ok: true, status: 'not_found', indexPath: resolvedIndexPath, service: null };
        }
        if (validServices.length > 1) {
            return {
                ok: false,
                status: 'ambiguous',
                errorCode: 'DESIGN_TDD_REUSE_SERVICE_AMBIGUOUS',
                message: `刷新后的复用索引命中多个可分页 Service（${validServices.map(item => `${item.interfaceName}.${item.methodName}`).join('、')}），无法安全判断当前复用表应使用哪一个；请在设计中填写 reusedApis[]。`,
                candidates: validServices.map(item => ({
                    interfaceName: item.interfaceName,
                    methodName: item.methodName,
                    sourcePath: item.sourcePath
                })),
                indexPath: resolvedIndexPath
            };
        }
        return { ok: true, status: 'found', indexPath: resolvedIndexPath, service: validServices[0] };
    }

    // 保留公开方法名，供 Builder/历史调用者读取详细解析结果。
    resolvePagingService(projectPath = '', table = {}) {
        return this._resolvePagingService(projectPath, table);
    }

    _findGenericPagingService(projectPath = '', table = {}) {
        const resolved = this._resolvePagingService(projectPath, table);
        return resolved.ok ? resolved.service : null;
    }

    _collectIndexedServices(index = {}) {
        const services = [];
        const addService = svc => {
            const interfaceName = String(svc && (svc.interfaceName || svc.ownerName) || '').trim();
            const sourcePath = String(svc && svc.sourcePath || '').trim();
            if (!interfaceName || !sourcePath) return;
            const existing = services.find(item => item.interfaceName === interfaceName && item.sourcePath === sourcePath);
            if (existing) return existing;
            const entry = {
                interfaceName,
                sourcePath,
                packageName: String(svc && svc.packageName || '').trim(),
                sourceKind: String(svc && svc.sourceKind || 'project_source').trim(),
                fieldName: String(svc && svc.fieldName || '').trim(),
                entityNames: Array.isArray(svc && svc.entityNames) ? svc.entityNames : [],
                tableNames: Array.isArray(svc && svc.tableNames) ? svc.tableNames : []
            };
            services.push(entry);
            return entry;
        };
        for (const svc of (Array.isArray(index.serviceInterfaces) ? index.serviceInterfaces : [])) addService(svc);
        for (const slice of (Array.isArray(index.actionMethodSlices) ? index.actionMethodSlices : [])) {
            for (const call of (Array.isArray(slice && slice.directCalls) ? slice.directCalls : [])) {
                if (String(call && call.callType || '').trim() !== 'injected_service') continue;
                addService({
                    interfaceName: call.ownerName,
                    fieldName: call.fieldName,
                    sourcePath: call.sourcePath,
                    sourceKind: call.sourceKind
                });
            }
        }
        return services;
    }

    _selectServicesForTable(index = {}, services = [], projectPath = '', table = {}) {
        const tableName = String(table && table.tableName || '').trim().toLowerCase();
        const entityName = String(table && table.entityName || '').trim().toLowerCase();
        const sourcePath = this._normalizeProjectRelativePath(projectPath, table && table.reuseSourceFile || '').toLowerCase();
        if (!tableName && !entityName && !sourcePath) return [];
        const matchedNames = new Set();
        const matchesEntity = entity => {
            const candidateTable = String(entity && entity.tableName || '').trim().toLowerCase();
            const candidateName = String(entity && entity.entityName || '').trim().toLowerCase();
            const candidatePath = String(entity && entity.sourcePath || '').replace(/\\/g, '/').toLowerCase();
            return (tableName && candidateTable === tableName)
                || (entityName && candidateName === entityName)
                || (sourcePath && candidatePath === sourcePath);
        };
        for (const svc of services) {
            if ((Array.isArray(svc.tableNames) && svc.tableNames.some(name => String(name || '').trim().toLowerCase() === tableName))
                || (Array.isArray(svc.entityNames) && svc.entityNames.some(name => String(name || '').trim().toLowerCase() === entityName))) {
                matchedNames.add(`${svc.interfaceName}::${svc.sourcePath}`);
            }
        }
        for (const slice of (Array.isArray(index && index.actionMethodSlices) ? index.actionMethodSlices : [])) {
            const related = Array.isArray(slice && slice.relatedEntities) ? slice.relatedEntities : [];
            if (!related.some(matchesEntity)) continue;
            for (const call of (Array.isArray(slice && slice.directCalls) ? slice.directCalls : [])) {
                if (String(call && call.callType || '').trim() !== 'injected_service') continue;
                const ownerName = String(call && call.ownerName || '').trim();
                const callPath = String(call && call.sourcePath || '').trim();
                services.forEach(svc => {
                    if (svc.interfaceName === ownerName && (!callPath || svc.sourcePath === callPath)) {
                        matchedNames.add(`${svc.interfaceName}::${svc.sourcePath}`);
                    }
                });
            }
        }
        return services.filter(svc => matchedNames.has(`${svc.interfaceName}::${svc.sourcePath}`));
    }

    _queryConditionArgumentContract() {
        return {
            parameter: 'Map<String,Object> 查询条件',
            objectSource: 'SqlConditionUtil sql = new SqlConditionUtil();',
            mapSource: 'sql.getMap()',
            callSequence: [
                '按 Story 筛选字段补 sql.eq/like/ge/lt/in/setOrder*',
                '调用分页/查询 Service 时传 sql.getMap()'
            ],
            forbiddenAlternatives: [
                '不要 new HashMap 手搓查询条件',
                '不要手拼 %xxx% 表达 like 语义'
            ],
            positiveExample: 'SqlConditionUtil sql = new SqlConditionUtil(); service.paginatorList(sql.getMap(), first, pageSize);'
        };
    }

    _extractPagingMethod(text = '') {
        const compact = String(text || '').replace(/\s+/g, ' ');
        const genericMatch = compact.match(/(<\s*T\s+extends\s+BaseEntity\s*>\s*)?PageData\s*<\s*T\s*>\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(\s*Class\s*<\s*T\s*>\s+[A-Za-z_][A-Za-z0-9_]*\s*,\s*Map\s*<\s*String\s*,\s*Object\s*>\s+[A-Za-z_][A-Za-z0-9_]*\s*,\s*int\s+[A-Za-z_][A-Za-z0-9_]*\s*,\s*int\s+[A-Za-z_][A-Za-z0-9_]*/);
        if (genericMatch) return {
            methodName: genericMatch[2],
            signature: genericMatch[0].trim(),
            callShapeMode: 'generic_entity_class'
        };
        const domainMatch = compact.match(/PageData\s*<\s*[^>]+>\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(\s*Map\s*<\s*String\s*,\s*(?:Object|String)\s*>\s+[A-Za-z_][A-Za-z0-9_]*\s*,\s*int\s+[A-Za-z_][A-Za-z0-9_]*\s*,\s*int\s+[A-Za-z_][A-Za-z0-9_]*/);
        if (domainMatch) return {
            methodName: domainMatch[1],
            signature: domainMatch[0].trim(),
            callShapeMode: 'service_condition_page'
        };
        return null;
    }

    _extractGenericPaginatorMethod(text = '') {
        const method = this._extractPagingMethod(text);
        if (!method || method.callShapeMode !== 'generic_entity_class') return null;
        return {
            methodName: method.methodName,
            signature: method.signature
        };
    }

    _buildReuseQueryFieldIntent(module = {}, tables = []) {
        const labels = {
            displayLabels: [],
            queryLabels: [],
            detailLabels: []
        };
        const pushLabels = (key, values = []) => {
            labels[key] = this._uniqueStrings([...(labels[key] || []), ...values]);
        };
        const texts = this._collectModuleBusinessFactTexts(module);
        for (const text of texts) {
            pushLabels('displayLabels', this._extractLabelsAfterPrefix(text, ['列表展示字段', '展示字段', '列表字段', '导出字段']));
            pushLabels('queryLabels', this._extractLabelsAfterPrefix(text, ['筛选条件', '查询条件', '检索条件']));
            pushLabels('detailLabels', this._extractLabelsAfterPrefix(text, ['详情展示', '详情字段', '查看详情字段']));
        }
        const hasAny = Object.values(labels).some(arr => arr.length > 0);
        if (!hasAny) return null;
        const sourceFields = this._uniqueStrings((Array.isArray(tables) ? tables : []).flatMap(table =>
            (Array.isArray(table && table.columns) ? table.columns : [])
                .map(col => col && col.name)
        ));
        return {
            ...labels,
            requiresSourceFieldMapping: true,
            mappingOwner: 'coder',
            evidenceRequired: 'Coder 必须先读取 dataAccessPlan.entity.sourcePath/reuseSourceFile 指向的复用实体源码，再把业务中文字段映射到真实字段；不能映射的字段不得编造数据库字段。',
            ...(sourceFields.length > 0 ? { sourceFieldCandidates: sourceFields } : {})
        };
    }

    _collectModuleBusinessFactTexts(module = {}) {
        const out = [];
        const push = value => {
            const text = String(value || '').trim();
            if (text) out.push(text);
        };
        push(module && module.userStory);
        push(module && module.description);
        (Array.isArray(module && module.invariants) ? module.invariants : []).forEach(push);
        const ac = module && module.acceptanceCriteria && typeof module.acceptanceCriteria === 'object'
            ? module.acceptanceCriteria
            : {};
        ['happyPath', 'exception', 'boundary'].forEach(group => {
            (Array.isArray(ac[group]) ? ac[group] : []).forEach(item => {
                if (item && typeof item === 'object') {
                    push(item.scenario);
                    push(item.given);
                    push(item.when);
                    push(item.then);
                } else {
                    push(item);
                }
            });
        });
        (Array.isArray(module && module.codingFactHandoff) ? module.codingFactHandoff : []).forEach(item => {
            if (!item || typeof item !== 'object') return;
            push(item.description);
            (Array.isArray(item.confirmedFacts) ? item.confirmedFacts : []).forEach(push);
        });
        return out;
    }

    _extractLabelsAfterPrefix(text = '', prefixes = []) {
        const normalizedText = String(text || '').trim();
        if (!normalizedText) return [];
        const escapedPrefixes = (Array.isArray(prefixes) ? prefixes : [])
            .map(prefix => String(prefix || '').trim())
            .filter(Boolean)
            .map(prefix => prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
        if (escapedPrefixes.length === 0) return [];
        const pattern = new RegExp(`(?:^|[\\s；;。])(?:${escapedPrefixes.join('|')})\\s*[：:]\\s*([^。；;\\n]+)`);
        const match = normalizedText.match(pattern);
        if (!match) return [];
        return this._splitBusinessLabels(match[1]);
    }

    _splitBusinessLabels(text = '') {
        return this._uniqueStrings(String(text || '')
            .split(/[、,，/／]/)
            .map(item => String(item || '')
                .replace(/[（(].*?[）)]/g, '')
                .replace(/^(如|例如)\s*/, '')
                .trim())
            .filter(Boolean));
    }

    _resolveJavaPackage(projectPath = '', sourcePath = '') {
        const absolute = this._resolveProjectFile(projectPath, sourcePath);
        if (absolute && fs.existsSync(absolute)) {
            try {
                const packageName = this._extractPackageName(fs.readFileSync(absolute, 'utf-8'));
                if (packageName) return packageName;
            } catch (_) {
                // fallback to path-derived package
            }
        }
        const normalized = String(sourcePath || '').replace(/\\/g, '/');
        const marker = '/src/main/java/';
        let idx = normalized.indexOf(marker);
        let start = marker.length;
        if (idx === -1 && normalized.startsWith('src/main/java/')) {
            idx = 0;
            start = 'src/main/java/'.length;
        }
        if (idx === -1) return '';
        return normalized.slice(idx + start).replace(/\/[^/]+\.java$/i, '').replace(/\//g, '.');
    }

    _extractPackageName(text = '') {
        const match = String(text || '').match(/\bpackage\s+([A-Za-z0-9_.]+)\s*;/);
        return match ? match[1] : '';
    }

    _classNameFromSource(sourcePath = '') {
        const base = path.basename(String(sourcePath || '').replace(/\\/g, '/'));
        return base.replace(/\.java$/i, '');
    }

    _wrapGxhName(name = '') {
        const value = String(name || '').trim();
        if (!value) return '';
        return value.startsWith('Gxh') ? value : `Gxh${value}`;
    }

    _normalizeProjectRelativePath(projectPath = '', sourcePath = '') {
        const raw = String(sourcePath || '').trim();
        if (!raw) return '';
        if (!path.isAbsolute(raw)) return raw.replace(/\\/g, '/');
        try {
            return path.relative(path.resolve(projectPath), path.resolve(raw)).replace(/\\/g, '/');
        } catch (_) {
            return raw.replace(/\\/g, '/');
        }
    }

    _resolveProjectFile(projectPath = '', sourcePath = '') {
        const raw = String(sourcePath || '').trim();
        if (!raw) return '';
        return path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(String(projectPath || ''), raw);
    }

    _deriveFieldName(interfaceName = '') {
        const name = String(interfaceName || '').trim();
        if (!name) return 'service';
        return name.slice(0, 1).toLowerCase() + name.slice(1);
    }

    _uniqueStrings(items = []) {
        const out = [];
        const seen = new Set();
        for (const item of (Array.isArray(items) ? items : [])) {
            const value = String(item || '').trim();
            if (!value || seen.has(value)) continue;
            seen.add(value);
            out.push(value);
        }
        return out;
    }
}

module.exports = DesignTddDataAccessPlanService;
