const SEARCH_TOOL_NAMES = Object.freeze([
    'search_codebase',
    'search_by_regex',
    'search_by_keyword',
    'grep_search',
    'file_search',
    'list_directory',
    'view_folder',
    'rg',
    'grep',
    'find',
    'where',
    'tree'
]);

const READ_TOOL_NAMES = Object.freeze([
    'view_files',
    'view_file',
    'read_file',
    'read_files',
    'open_file'
]);

const WRITE_TOOL_NAMES = Object.freeze([
    'write',
    'edit_file',
    'edit_file_search_replace',
    'design_tdd_build_plan',
    'design_tdd_skeleton_materialize'
]);

const COMMAND_TOOL_NAMES = Object.freeze([
    'run_command',
    'shell_command'
]);

const RULE_EXPERT_READ_ONLY_ACTIONS = Object.freeze([
    'read',
    'search'
]);

const searchToolSet = new Set(SEARCH_TOOL_NAMES);
const readToolSet = new Set(READ_TOOL_NAMES);
const writeToolSet = new Set(WRITE_TOOL_NAMES);
const commandToolSet = new Set(COMMAND_TOOL_NAMES);
const highRiskToolSet = new Set([
    ...SEARCH_TOOL_NAMES,
    ...READ_TOOL_NAMES,
    ...WRITE_TOOL_NAMES,
    ...COMMAND_TOOL_NAMES
]);

function normalizeToolName(value) {
    return String(value || '').trim().toLowerCase();
}

function isSearchToolName(toolName) {
    return searchToolSet.has(normalizeToolName(toolName));
}

function isReadToolName(toolName) {
    return readToolSet.has(normalizeToolName(toolName));
}

function isWriteToolName(toolName) {
    return writeToolSet.has(normalizeToolName(toolName));
}

function isCommandToolName(toolName) {
    return commandToolSet.has(normalizeToolName(toolName));
}

function isRuleExpertReadOnlyAction(action) {
    return RULE_EXPERT_READ_ONLY_ACTIONS.includes(String(action || '').trim().toLowerCase());
}

function isHighRiskToolName(toolName) {
    return highRiskToolSet.has(normalizeToolName(toolName));
}

function isWildcardProjectSearch(pattern) {
    const text = String(pattern || '').trim();
    return text === '*' ||
        text.includes('**') ||
        /(^|[\\/])\*(?:[\\/]|$)/iu.test(text) ||
        /\*\.(java|html|js|xml|json|md)\b/iu.test(text);
}

function isDirectoryEnumerationToolName(toolName) {
    const normalized = normalizeToolName(toolName);
    return normalized === 'view_folder' || normalized === 'list_directory';
}

function isSkillReferenceSearch(pattern) {
    const text = String(pattern || '').trim().replace(/\\/gu, '/').toLowerCase();
    if (!text) {
        return false;
    }
    return /(^|\/)references\/[^/]+\.md$/u.test(text) ||
        /(^|\/)references\/.*\*.*\.md/u.test(text);
}

function isWorkspaceArtifactGlobSearch(pattern) {
    const text = String(pattern || '').trim().replace(/\\/gu, '/').toLowerCase();
    if (!text) {
        return false;
    }
    return text.includes('.ai-workspace') && /[*?]/u.test(text);
}

function isSearchCommand(command) {
    const text = String(command || '').trim();
    return /(^|[\s;&|])(rg|grep|find|where|tree|dir\s+\/s|Get-ChildItem|Select-String)\b/iu.test(text);
}

module.exports = {
    SEARCH_TOOL_NAMES,
    READ_TOOL_NAMES,
    WRITE_TOOL_NAMES,
    COMMAND_TOOL_NAMES,
    RULE_EXPERT_READ_ONLY_ACTIONS,
    normalizeToolName,
    isSearchToolName,
    isReadToolName,
    isWriteToolName,
    isCommandToolName,
    isRuleExpertReadOnlyAction,
    isHighRiskToolName,
    isWildcardProjectSearch,
    isDirectoryEnumerationToolName,
    isSkillReferenceSearch,
    isWorkspaceArtifactGlobSearch,
    isSearchCommand
};
