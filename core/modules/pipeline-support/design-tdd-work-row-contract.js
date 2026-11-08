/* eslint-disable */

function encodeCell(value) {
    return String(value === undefined || value === null ? '' : value)
        .replace(/\\/g, '\\\\')
        .replace(/\|/g, '\\|')
        .replace(/\r?\n/g, '\\n');
}

function encodeWorkRow(...cells) {
    return cells.map(encodeCell).join('|');
}

function parseWorkRow(value = '') {
    const text = String(value || '');
    const cells = [];
    let current = '';
    let escaped = false;
    for (const char of text) {
        if (escaped) {
            current += char === 'n' ? '\n' : char;
            escaped = false;
            continue;
        }
        if (char === '\\') {
            escaped = true;
            continue;
        }
        if (char === '|') {
            cells.push(current);
            current = '';
            continue;
        }
        current += char;
    }
    if (escaped) current += '\\';
    cells.push(current);
    return cells;
}

module.exports = {
    encodeWorkRow,
    parseWorkRow
};
