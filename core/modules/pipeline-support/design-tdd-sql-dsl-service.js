const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const COMMON_COLUMN_NAMES = new Set([
    'rowguid', 'row_id', 'operatedate', 'operateusername', 'operateuserguid',
    'operateuserouguid', 'operateuserbaseouguid', 'yearflag', 'belongxiaqucode',
    'pviguid', 'tenantguid'
]);

function normalizeType(type = '') {
    const normalized = String(type || '').trim().toLowerCase();
    if (['varchar', 'nvarchar', 'char', 'nchar'].includes(normalized)) return 'nvarchar';
    if (['text', 'longtext', 'ntext'].includes(normalized)) return 'ntext';
    if (['int', 'integer', 'smallint', 'tinyint'].includes(normalized)) return 'integer';
    if (normalized === 'bigint') return 'bigint';
    if (['decimal', 'double', 'float', 'numeric'].includes(normalized)) return 'numeric';
    if (normalized === 'timestamp') return 'timestamp';
    if (normalized === 'date') return 'date';
    if (normalized === 'datetime') return 'datetime';
    if (normalized === 'blob') return 'blob';
    return 'nvarchar';
}

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

function buildDsl(designJson = {}) {
    const tables = Array.isArray(designJson && designJson.databaseDesign && designJson.databaseDesign.tables)
        ? designJson.databaseDesign.tables
        : [];
    const codeGroups = new Map();
    const result = tables
        .filter(table => table && table.reuse !== true)
        .map(table => {
            const fields = [];
            (Array.isArray(table.columns) ? table.columns : []).forEach(column => {
                const fieldId = String(column && column.name || '').trim();
                if (!fieldId || COMMON_COLUMN_NAMES.has(fieldId.toLowerCase())) return;
                const definition = column && column.codeItemDefinition;
                const field = {
                    fieldId,
                    fieldName: String(column && column.comment || fieldId).trim() || fieldId,
                    fieldType: normalizeType(column && column.type),
                    ...(column && column.length !== undefined && column.length !== null && String(column.length) !== '-' ? { length: Number(column.length) } : {}),
                    // DSL 的 required 表示数据库非空；formRequired 是页面填写要求，不能混用。
                    required: column && column.required === true,
                    ...(column && column.defaultValue !== undefined ? { defaultValue: column.defaultValue } : {}),
                    ...(String(column && column.codeItem || '').trim() ? { codeGroupName: String(column.codeItem).trim() } : {})
                };
                fields.push(field);
                if (definition && definition.mode === 'new' && Array.isArray(definition.codes)) {
                    const codeGroupName = String(column.codeItem || '').trim();
                    if (codeGroupName && !codeGroups.has(codeGroupName)) {
                        codeGroups.set(codeGroupName, {
                            codeGroupName,
                            codes: definition.codes.map(code => ({
                                codeValue: code.codeValue,
                                codeLabel: code.codeLabel,
                                order: code.order
                            }))
                        });
                    }
                }
            });
            const tableDsl = {
                tableId: String(table.tableName || table.objectKey || '').trim(),
                description: String(table.tableComment || table.displayName || table.objectKey || '').trim(),
                tableName: String(table.tableComment || table.displayName || table.objectKey || '').trim(),
                fields
            };
            return tableDsl;
        });
    if (codeGroups.size > 0) {
        const emittedGroups = new Set();
        result.forEach(table => {
            const groups = table.fields
                .map(field => field.codeGroupName)
                .filter(name => codeGroups.has(name))
                .filter((name, index, names) => names.indexOf(name) === index)
                .filter(name => !emittedGroups.has(name))
                .map(name => {
                    emittedGroups.add(name);
                    return clone(codeGroups.get(name));
                });
            if (groups.length > 0) table.codeGroups = groups;
        });
    }
    return result;
}

class DesignTddSqlDslService {
    build(designJson = {}) {
        return buildDsl(designJson);
    }

    materialize({ designJson = {}, designDir = '' } = {}) {
        const targetDir = String(designDir || '').trim();
        if (!targetDir) return { ok: false, errorCode: 'DESIGN_SQL_DSL_OUTPUT_DIR_MISSING' };
        const dslPath = path.join(targetDir, 'dsl.json');
        const dsl = this.build(designJson);
        const expected = `${JSON.stringify(dsl, null, 2)}\n`;
        let existing = '';
        try { existing = fs.readFileSync(dslPath, 'utf8'); } catch (_) {}
        if (existing !== expected) {
            fs.mkdirSync(targetDir, { recursive: true });
            fs.writeFileSync(dslPath, expected, 'utf8');
        }
        const sourceHash = `sha256:${crypto.createHash('sha256').update(JSON.stringify(designJson), 'utf8').digest('hex')}`;
        return { ok: true, dslPath, tableCount: dsl.length, sourceHash, changed: existing !== expected };
    }
}

DesignTddSqlDslService.buildDsl = buildDsl;
DesignTddSqlDslService.normalizeType = normalizeType;

module.exports = DesignTddSqlDslService;
