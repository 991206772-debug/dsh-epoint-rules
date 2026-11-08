/* eslint-disable */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

class RuleContractHarnessService {
    constructor(options = {}) {
        this.pythonCommand = options.pythonCommand || 'python';
        this.scriptPath = this.resolveScriptPath(options.scriptPath);
    }

    resolveScriptPath(explicitPath = '') {
        const scriptName = path.join('rule_harness', 'run_rule_contract_harness.py');
        const candidates = [
            explicitPath,
            path.join(__dirname, '..', '..', scriptName),
            path.join(__dirname, '..', 'mcp_tools', scriptName),
            path.join(process.cwd(), 'mcp_tools', scriptName)
        ].map(item => String(item || '').trim()).filter(Boolean);
        return candidates.find(item => fs.existsSync(item)) || candidates[candidates.length - 1];
    }

    run(options = {}) {
        const outputDir = String(options.outputDir || fs.mkdtempSync(path.join(os.tmpdir(), 'rule-contract-harness-out-'))).trim();
        fs.mkdirSync(outputDir, { recursive: true });
        const inputPath = path.join(outputDir, 'harness-input.json');
        const payload = {
            rulesRoot: String(options.rulesRoot || '').trim(),
            profile: String(options.profile || 'expert').trim() || 'expert',
            stage: String(options.stage || 'code').trim() || 'code',
            contractTypes: Array.isArray(options.contractTypes) ? options.contractTypes : [],
            rulePaths: Array.isArray(options.rulePaths) ? options.rulePaths : [],
            targetFiles: Array.isArray(options.targetFiles) ? options.targetFiles : [],
            referencedCapabilities: Array.isArray(options.referencedCapabilities) ? options.referencedCapabilities : [],
            outputDir
        };
        fs.writeFileSync(inputPath, JSON.stringify(payload, null, 2), 'utf-8');
        const stdout = execFileSync(this.pythonCommand, [this.scriptPath, '--input', inputPath], {
            encoding: 'utf-8',
            timeout: Number(options.timeoutMs || 120000),
            env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' }
        });
        const parsed = JSON.parse(String(stdout || '{}'));
        return {
            ...parsed,
            outputDir,
            violationsPath: path.join(outputDir, 'violations.json'),
            fixPromptPath: path.join(outputDir, 'fix_prompt.md'),
            reportPath: path.join(outputDir, 'harness-report.md')
        };
    }
}

module.exports = RuleContractHarnessService;
