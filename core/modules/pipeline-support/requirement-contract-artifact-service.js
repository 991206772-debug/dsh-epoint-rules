/* eslint-disable */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CONTRACT_SCHEMA_VERSION = 'requirement-contract/v1';
const CONTRACT_MANAGED_BY = 'requirement_contract_builder';

class RequirementContractArtifactService {
    readContract(contractPath = '') {
        const filePath = String(contractPath || '').trim();
        if (!filePath || !fs.existsSync(filePath)) {
            return { ok: false, code: 'REQUIREMENT_CONTRACT_MISSING', message: `缺少 requirement-contract.json：${filePath}` };
        }
        try {
            const value = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
            if (!value || typeof value !== 'object' || Array.isArray(value)) {
                return { ok: false, code: 'REQUIREMENT_CONTRACT_INVALID', message: `requirement-contract.json 不是 JSON object：${filePath}` };
            }
            if (value.managedBy !== CONTRACT_MANAGED_BY) {
                return { ok: false, code: 'REQUIREMENT_CONTRACT_BUILDER_REQUIRED', message: `requirement-contract.json 不是 Builder 落盘（缺少 managedBy=${CONTRACT_MANAGED_BY}）：${filePath}` };
            }
            return { ok: true, value, path: filePath };
        } catch (error) {
            return { ok: false, code: 'REQUIREMENT_CONTRACT_INVALID_JSON', message: `requirement-contract.json 解析失败：${filePath}；${error.message}` };
        }
    }

    readOrCreateContract(contractPath = '', seed = {}) {
        const read = this.readContract(contractPath);
        if (read.ok) return read.value;
        return {
            schemaVersion: CONTRACT_SCHEMA_VERSION,
            managedBy: CONTRACT_MANAGED_BY,
            demandName: String(seed.demandName || '').trim(),
            createdAt: new Date().toISOString(),
            updatedAt: '',
            stories: null,
            rulePool: null,
            integrity: {},
            rulePoolWorkflow: {}
        };
    }

    upsertStories(contractPath = '', storiesDoc = {}, receiptSeed = {}, seed = {}) {
        const contract = this.readOrCreateContract(contractPath, seed);
        const writtenAt = String(receiptSeed.submittedAt || storiesDoc.writtenAt || new Date().toISOString());
        const storyHash = this.hashJson(storiesDoc);
        const receipt = {
            schemaVersion: 'requirement-stories-submit-receipt/v1',
            status: 'submitted',
            ok: true,
            storyHash,
            storyCount: Array.isArray(storiesDoc.storyIds) ? storiesDoc.storyIds.length : 0,
            storyIds: Array.isArray(storiesDoc.storyIds) ? storiesDoc.storyIds.slice() : [],
            submittedAt: writtenAt
        };
        contract.demandName = String(seed.demandName || contract.demandName || '').trim();
        contract.stories = storiesDoc;
        contract.integrity = contract.integrity && typeof contract.integrity === 'object' && !Array.isArray(contract.integrity)
            ? contract.integrity
            : {};
        contract.integrity.stories = receipt;
        contract.updatedAt = writtenAt;
        this.writeContract(contractPath, contract);
        return { contract, receipt, storyHash };
    }

    validateStories(contractPath = '') {
        const read = this.readContract(contractPath);
        if (!read.ok) {
            return { ok: false, code: read.code, message: read.message };
        }
        const contract = read.value || {};
        const stories = contract.stories;
        if (!stories || typeof stories !== 'object' || Array.isArray(stories)) {
            return { ok: false, code: 'REQUIREMENT_STORIES_MISSING_IN_CONTRACT', message: `requirement-contract.json 缺少 stories 合同：${contractPath}` };
        }
        if (stories.managedBy !== 'requirement_stories_builder') {
            return { ok: false, code: 'REQUIREMENT_STORIES_BUILDER_RECEIPT_REQUIRED', message: 'requirement-contract.json.stories 不是 req_stories_submit Builder 落盘，请重新调用 req_stories_submit。' };
        }
        const receipt = contract.integrity && contract.integrity.stories;
        if (!receipt || receipt.ok !== true || String(receipt.status || '') !== 'submitted') {
            return { ok: false, code: 'REQUIREMENT_STORIES_SUBMIT_RECEIPT_MISSING', message: 'requirement-contract.json.integrity.stories 缺少 submitted 凭证。' };
        }
        const currentHash = this.hashJson(stories);
        if (String(receipt.storyHash || '') !== currentHash) {
            return {
                ok: false,
                code: 'REQUIREMENT_STORIES_SUBMIT_RECEIPT_HASH_MISMATCH',
                message: 'requirement-contract.json.stories 与内嵌 Builder 凭证 hash 不一致，请重新调用 req_stories_submit。',
                currentHash,
                receiptHash: receipt.storyHash || ''
            };
        }
        return { ok: true, receipt, currentHash, stories, contract };
    }

    readStories(contractPath = '') {
        const validation = this.validateStories(contractPath);
        return validation.ok ? validation.stories : null;
    }

    upsertRuleDraft(contractPath = '', draftReceipt = {}, seed = {}) {
        const contract = this.readOrCreateContract(contractPath, seed);
        contract.demandName = String(seed.demandName || contract.demandName || '').trim();
        contract.rulePoolWorkflow = contract.rulePoolWorkflow && typeof contract.rulePoolWorkflow === 'object' && !Array.isArray(contract.rulePoolWorkflow)
            ? contract.rulePoolWorkflow
            : {};
        contract.rulePoolWorkflow.draft = draftReceipt;
        contract.rulePoolWorkflow.ruleStage = null;
        contract.updatedAt = String(draftReceipt.createdAt || new Date().toISOString());
        this.writeContract(contractPath, contract);
        return contract;
    }

    readRuleDraft(contractPath = '', decisionDraftId = '') {
        const read = this.readContract(contractPath);
        if (!read.ok) return read;
        const draftReceipt = read.value && read.value.rulePoolWorkflow && read.value.rulePoolWorkflow.draft;
        if (!draftReceipt || typeof draftReceipt !== 'object' || Array.isArray(draftReceipt)) {
            return { ok: false, code: 'REQUIREMENT_RULE_POOL_DRAFT_RECEIPT_MISSING', message: `requirement-contract.json 缺少规则池草案：${contractPath}` };
        }
        if (String(draftReceipt.decisionDraftId || '').trim() !== String(decisionDraftId || '').trim()) {
            return { ok: false, code: 'REQUIREMENT_RULE_POOL_DRAFT_ID_MISMATCH', message: '提交的 decisionDraftId 与最新草案不一致，请重新生成规则池草案。' };
        }
        const draft = draftReceipt.draft || {};
        if (!draft || typeof draft !== 'object' || Array.isArray(draft)) {
            return { ok: false, code: 'REQUIREMENT_RULE_POOL_DRAFT_INVALID', message: '规则池草案缺少 draft，无法提交。' };
        }
        return { ok: true, contract: read.value, draftReceipt, draft, path: contractPath };
    }

    upsertRuleStage(contractPath = '', receipt = {}, seed = {}) {
        const contract = this.readOrCreateContract(contractPath, seed);
        contract.rulePoolWorkflow = contract.rulePoolWorkflow && typeof contract.rulePoolWorkflow === 'object' && !Array.isArray(contract.rulePoolWorkflow)
            ? contract.rulePoolWorkflow
            : {};
        contract.rulePoolWorkflow.ruleStage = receipt;
        contract.updatedAt = String(receipt.submittedAt || new Date().toISOString());
        this.writeContract(contractPath, contract);
        return contract;
    }

    readRuleStage(contractPath = '', decisionDraftId = '') {
        const read = this.readContract(contractPath);
        if (!read.ok) return read;
        const receipt = read.value && read.value.rulePoolWorkflow && read.value.rulePoolWorkflow.ruleStage;
        if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) {
            return { ok: false, code: 'REQUIREMENT_RULE_POOL_RULE_STAGE_RECEIPT_MISSING', message: `requirement-contract.json 缺少规则阶段提交凭证：${contractPath}` };
        }
        if (String(receipt.decisionDraftId || '').trim() !== String(decisionDraftId || '').trim()) {
            return { ok: false, code: 'REQUIREMENT_RULE_POOL_RULE_STAGE_DRAFT_ID_MISMATCH', message: '表候选阶段 decisionDraftId 与规则阶段凭证不一致。' };
        }
        return { ok: true, receipt, contract: read.value, path: contractPath };
    }

    upsertRulePool(contractPath = '', rulePool = {}, submitReceiptSeed = {}, audit = {}, seed = {}) {
        const contract = this.readOrCreateContract(contractPath, seed);
        const submittedAt = String(submitReceiptSeed.submittedAt || new Date().toISOString());
        const rulePoolHash = this.hashJson(rulePool);
        const submitReceipt = {
            schemaVersion: 'requirement-rule-pool-submit-receipt/v1',
            status: 'submitted',
            ok: true,
            decisionDraftId: submitReceiptSeed.decisionDraftId || '',
            draftHash: submitReceiptSeed.draftHash || '',
            rulePoolHash,
            userInputForGlobalPool: submitReceiptSeed.userInputForGlobalPool || '',
            userInputForTableCandidatePool: submitReceiptSeed.userInputForTableCandidatePool || '',
            submittedAt,
            contractPath
        };
        contract.demandName = String(seed.demandName || contract.demandName || '').trim();
        contract.rulePool = rulePool;
        contract.integrity = contract.integrity && typeof contract.integrity === 'object' && !Array.isArray(contract.integrity)
            ? contract.integrity
            : {};
        contract.integrity.rulePool = submitReceipt;
        contract.ruleRecallRaw = String(audit.ruleRecallRaw || '');
        contract.rulePoolWorkflow = contract.rulePoolWorkflow && typeof contract.rulePoolWorkflow === 'object' && !Array.isArray(contract.rulePoolWorkflow)
            ? contract.rulePoolWorkflow
            : {};
        contract.rulePoolWorkflow.decisionLedger = audit.decisionLedger || null;
        contract.updatedAt = submittedAt;
        this.writeContract(contractPath, contract);
        return { contract, submitReceipt, rulePoolHash };
    }

    validateRulePool(contractPath = '') {
        const read = this.readContract(contractPath);
        if (!read.ok) {
            return { ok: false, code: read.code, message: read.message };
        }
        const contract = read.value || {};
        const rulePool = contract.rulePool;
        if (!rulePool || typeof rulePool !== 'object' || Array.isArray(rulePool)) {
            return { ok: false, code: 'REQUIREMENT_RULE_POOL_FILE_MISSING', message: `requirement-contract.json 缺少 rulePool 合同：${contractPath}` };
        }
        if (rulePool.managedBy !== 'requirement_rule_pool_builder') {
            return { ok: false, code: 'REQUIREMENT_RULE_POOL_BUILDER_RECEIPT_REQUIRED', message: 'requirement-contract.json.rulePool 不是 Builder 落盘（缺少 managedBy=requirement_rule_pool_builder）。请重新走规则池确认流程。' };
        }
        const receipt = contract.integrity && contract.integrity.rulePool;
        if (!receipt || receipt.ok !== true || String(receipt.status || '') !== 'submitted') {
            return { ok: false, code: 'REQUIREMENT_RULE_POOL_SUBMIT_RECEIPT_MISSING', message: 'requirement-contract.json.integrity.rulePool 缺少 submitted 凭证。' };
        }
        const currentHash = this.hashJson(rulePool);
        if (String(receipt.rulePoolHash || '') !== currentHash) {
            return {
                ok: false,
                code: 'REQUIREMENT_RULE_POOL_SUBMIT_RECEIPT_HASH_MISMATCH',
                message: 'requirement-contract.json.rulePool 与内嵌 Builder 凭证 hash 不一致，请重新提交规则池决策。',
                currentHash,
                receiptHash: receipt.rulePoolHash || ''
            };
        }
        return { ok: true, receipt, currentHash, rulePool, contract };
    }

    readRulePool(contractPath = '') {
        const validation = this.validateRulePool(contractPath);
        return validation.ok ? validation.rulePool : null;
    }

    writeContract(contractPath = '', contract = {}) {
        const filePath = String(contractPath || '').trim();
        if (!filePath) throw new Error('contractPath is required');
        const next = {
            schemaVersion: CONTRACT_SCHEMA_VERSION,
            managedBy: CONTRACT_MANAGED_BY,
            ...contract
        };
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, `${JSON.stringify(next, null, 2)}\n`, 'utf-8');
    }

    hashJson(value = {}) {
        return `sha256:${crypto.createHash('sha256').update(JSON.stringify(value, null, 2), 'utf-8').digest('hex')}`;
    }

    hashText(value = '') {
        return `sha256:${crypto.createHash('sha256').update(String(value || ''), 'utf-8').digest('hex')}`;
    }
}

RequirementContractArtifactService.SCHEMA_VERSION = CONTRACT_SCHEMA_VERSION;
RequirementContractArtifactService.MANAGED_BY = CONTRACT_MANAGED_BY;

module.exports = RequirementContractArtifactService;
