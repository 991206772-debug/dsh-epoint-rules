#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');

const PageCompositionExtractor = require('../modules/page-composition-extractor');

function printUsage() {
    console.log([
        'Usage:',
        '  node mcp_tools/scripts/page-composition-analyze.js --project <projectPath> [--format json|md] [--out <file>] <page.html> [page.js] [page.css...]',
        '',
        'Examples:',
        '  node mcp_tools/scripts/page-composition-analyze.js --project D:/project --format md D:/project/webapp/pages/demo/list.html D:/project/webapp/pages/demo/js/list.js',
        '  node mcp_tools/scripts/page-composition-analyze.js --project D:/project --format json --out D:/tmp/pageComposition.json D:/project/webapp/pages/demo/list.html',
        '',
        'Notes:',
        '  - 默认只读：不写项目目录；只有显式传 --out 时才写指定输出文件。',
        '  - 输出按页面组成部分提取，不按项目名/地区名分类。'
    ].join('\n'));
}

function parseArgs(argv) {
    const args = {
        projectPath: '',
        format: 'json',
        out: '',
        files: []
    };
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        if (arg === '--help' || arg === '-h') {
            args.help = true;
            continue;
        }
        if (arg === '--project' || arg === '-p') {
            args.projectPath = argv[++i] || '';
            continue;
        }
        if (arg === '--format' || arg === '-f') {
            args.format = String(argv[++i] || '').trim().toLowerCase();
            continue;
        }
        if (arg === '--out' || arg === '-o') {
            args.out = argv[++i] || '';
            continue;
        }
        args.files.push(arg);
    }
    return args;
}

function main() {
    const args = parseArgs(process.argv.slice(2));
    if (args.help || args.files.length === 0) {
        printUsage();
        process.exit(args.help ? 0 : 1);
    }
    if (!['json', 'md', 'markdown'].includes(args.format)) {
        console.error(`Unsupported --format: ${args.format}`);
        printUsage();
        process.exit(1);
    }
    const files = args.files.map(filePath => path.resolve(filePath));
    const missing = files.filter(filePath => !fs.existsSync(filePath) || !fs.statSync(filePath).isFile());
    if (missing.length > 0) {
        console.error(`Input file missing:\n${missing.map(item => `- ${item}`).join('\n')}`);
        process.exit(1);
    }
    const projectPath = args.projectPath ? path.resolve(args.projectPath) : '';
    const payload = PageCompositionExtractor.extract(files, projectPath);
    const output = args.format === 'json'
        ? `${JSON.stringify(payload, null, 2)}\n`
        : `${PageCompositionExtractor.toMarkdown(payload)}\n`;

    if (args.out) {
        const outPath = path.resolve(args.out);
        fs.mkdirSync(path.dirname(outPath), { recursive: true });
        fs.writeFileSync(outPath, output, 'utf-8');
        console.log(`page composition written: ${outPath}`);
        return;
    }
    process.stdout.write(output);
}

if (require.main === module) {
    main();
}
