#!/usr/bin/env node
'use strict';

const path = require('path');
const prettier = require('prettier');
const javaPlugin = require('prettier-plugin-java');

function readStdin() {
    return new Promise((resolve, reject) => {
        let data = '';
        process.stdin.setEncoding('utf8');
        process.stdin.on('data', chunk => {
            data += chunk;
        });
        process.stdin.on('end', () => resolve(data));
        process.stdin.on('error', reject);
    });
}

function getArg(name) {
    const prefix = `--${name}=`;
    for (const item of process.argv.slice(2)) {
        if (item.startsWith(prefix)) {
            return item.slice(prefix.length);
        }
    }
    const idx = process.argv.indexOf(`--${name}`);
    if (idx >= 0 && idx + 1 < process.argv.length) {
        return process.argv[idx + 1];
    }
    return '';
}

function prettierOptionsForFile(filePath) {
    const ext = path.extname(String(filePath || '')).toLowerCase();
    const base = {
        endOfLine: 'lf',
        printWidth: 160,
        singleQuote: true,
        tabWidth: 4,
        useTabs: false
    };
    if (ext === '.java') {
        return { ...base, parser: 'java', plugins: [javaPlugin] };
    }
    if (ext === '.html' || ext === '.htm' || ext === '.xhtml') {
        return { ...base, parser: 'html' };
    }
    if (ext === '.js') {
        return { ...base, parser: 'babel' };
    }
    if (ext === '.css') {
        return { ...base, parser: 'css' };
    }
    if (ext === '.json') {
        return { ...base, parser: 'json' };
    }
    return null;
}

async function main() {
    const filePath = getArg('file');
    const source = await readStdin();
    const options = prettierOptionsForFile(filePath);
    if (!options) {
        process.stdout.write(source);
        return;
    }
    const formatted = await prettier.format(source, options);
    process.stdout.write(formatted);
}

main().catch(error => {
    process.stderr.write((error && error.stack) ? error.stack : String(error || 'format failed'));
    process.exit(2);
});
