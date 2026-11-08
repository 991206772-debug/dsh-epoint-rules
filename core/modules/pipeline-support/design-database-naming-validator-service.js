/* eslint-disable */

class DesignDatabaseNamingValidatorService {
    validateDatabaseNaming(designJson = {}, navigationContract = {}) {
        const contract = this._extractDatabaseNamingContract(navigationContract);
        const pattern = String(contract && contract.tableNamePattern || '').trim();
        if (!pattern) {
            return this._ok();
        }
        const expectedPrefix = this._extractStaticPrefix(pattern);
        if (!expectedPrefix) {
            return this._ok();
        }

        const tables = Array.isArray(designJson.databaseDesign && designJson.databaseDesign.tables)
            ? designJson.databaseDesign.tables
            : [];
        const issues = [];
        tables.forEach((table, index) => {
            if (!table || typeof table !== 'object' || Array.isArray(table)) return;
            if (this._isReuseTable(table)) return;

            const tableName = String(table.tableName || '').trim();
            if (!tableName) {
                issues.push(this._issue({
                    code: 'DATABASE_TABLE_NAME_MISSING',
                    index,
                    tableName,
                    expected: expectedPrefix,
                    message: `databaseDesign.tables[${index}].tableName 缺失；新增表名必须以 scan 数据库命名契约前缀 "${expectedPrefix}" 开头。`
                }));
                return;
            }

            if (!tableName.startsWith(expectedPrefix)) {
                issues.push(this._issue({
                    code: 'DATABASE_TABLE_NAME_PREFIX_MISMATCH',
                    index,
                    tableName,
                    expected: expectedPrefix,
                    message: `databaseDesign.tables[${index}].tableName="${tableName}" 未以 scan 数据库命名契约前缀 "${expectedPrefix}" 开头。`
                }));
            }
        });

        const ok = issues.length === 0;
        return {
            ok,
            status: ok ? 'database_naming_valid' : 'database_naming_invalid',
            databaseNamingLayer: {
                ok,
                contract: {
                    tableNamePattern: pattern,
                    expectedPrefix,
                    requiredVariables: Array.isArray(contract.requiredVariables) ? contract.requiredVariables : this._extractTemplateVariables(pattern),
                    caseStyle: String(contract.caseStyle || '').trim(),
                    sourceRule: String(contract.sourceRule || '').trim()
                },
                issues,
                repairCards: ok ? [] : this._buildRepairCards(issues, contract)
            }
        };
    }

    _ok() {
        return {
            ok: true,
            status: 'database_naming_valid',
            databaseNamingLayer: {
                ok: true,
                contract: null,
                issues: [],
                repairCards: []
            }
        };
    }

    _extractDatabaseNamingContract(navigationContract = {}) {
        const candidates = [
            navigationContract && navigationContract.databaseNamingContract,
            navigationContract && navigationContract.rulePlacementContract && navigationContract.rulePlacementContract.databaseNamingContract,
            navigationContract && navigationContract.placementContractDraft && navigationContract.placementContractDraft.databaseNamingContract
        ];
        return candidates.find(item => item && typeof item === 'object' && !Array.isArray(item)) || {};
    }

    _isReuseTable(table = {}) {
        if (table.reuse === true) return true;
        const mode = String(table.mode || table.operation || table.sourceType || '').trim().toLowerCase();
        return ['reuse', 'existing', 'modify_existing'].includes(mode);
    }

    _extractStaticPrefix(pattern = '') {
        const text = String(pattern || '').trim();
        const index = text.indexOf('{');
        return (index >= 0 ? text.slice(0, index) : text).trim();
    }

    _extractTemplateVariables(pattern = '') {
        return Array.from(new Set([...String(pattern || '').matchAll(/\{([^}]+)\}/g)]
            .map(match => String(match[1] || '').trim())
            .filter(Boolean)));
    }

    _issue({ code, index, tableName, expected, message }) {
        return {
            code,
            path: `$.databaseDesign.tables[${index}].tableName`,
            field: `databaseDesign.tables[${index}].tableName`,
            expected,
            actual: tableName || 'missing',
            message,
            layer: 'databaseNaming',
            tableIndex: index
        };
    }

    _buildRepairCards(issues = [], contract = {}) {
        const pattern = String(contract.tableNamePattern || '').trim();
        const expectedPrefix = this._extractStaticPrefix(pattern);
        const requiredVariables = Array.isArray(contract.requiredVariables) && contract.requiredVariables.length > 0
            ? contract.requiredVariables
            : this._extractTemplateVariables(pattern);
        return issues.map(issue => ({
            cardId: `database-naming-repair-card:table-${issue.tableIndex}`,
            targetField: issue.path,
            issues: [{
                code: issue.code,
                path: issue.path,
                message: issue.message,
                expected: issue.expected,
                actual: issue.actual
            }],
            repairTemplate: {
                tableName: expectedPrefix ? `${expectedPrefix}TEMPLATE_FILL_REQUIRED` : 'TEMPLATE_FILL_REQUIRED'
            },
            instruction: [
                '请修复Builder对工程导航契约databaseNamingContract的机械投影；禁止要求LLM手填表名前缀。',
                pattern ? `tableNamePattern=${pattern}` : '',
                expectedPrefix ? `expectedPrefix=${expectedPrefix}` : '',
                requiredVariables.length > 0 ? `后续命名变量由设计/命名合同补足：${requiredVariables.join(',')}` : '',
                '不要复制项目样例前缀；复用既有表时请显式标记 reuse=true。'
            ].filter(Boolean).join('；')
        }));
    }
}

module.exports = DesignDatabaseNamingValidatorService;
