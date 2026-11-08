class RecommendationService {
    constructor(ruleService) {
        this.ruleService = ruleService;
    }

    // 智能规范推荐功能
    getRecommendedRules(taskType) {
        const ruleMappings = {
            'design': ['项目结构与命名规范', '代码生成规范', 'REST接口开发规范'],
            'coding': ['项目结构与命名规范', '代码生成规范', 'REST接口开发规范', '前端-MiniUI开发规范'],
            'debug': ['代码生成规范', 'HttpUtil使用规范'],
            'test': ['代码生成规范'],
            'refactor': ['项目结构与命名规范', '代码生成规范'],
            'database': ['项目结构与命名规范', '代码生成规范'],
            'attachment': ['附件上传开发规范', 'IAttachService接口使用规范'],
            'message': ['IMessagesCenterService接口使用规范'],
            'config': ['IConfigService接口使用规范'],
            'codeitem': ['ICodeItemsService接口使用规范']
        };

        const rules = ruleMappings[taskType] || ['项目结构与命名规范'];
        const { availableRules, missingRules } = this.ruleService.partitionExistingRules(rules);

        let summary = `针对 **${taskType}** 任务，建议参考以下规范：\n\n`;
        availableRules.forEach((rule, index) => {
            summary += `${index + 1}. **${rule}**: ${this.getRuleDescription(rule)}\n`;
        });

        if (missingRules.length > 0) {
            summary += `\n⚠️ 注意：以下建议规范未找到，请确认是否已安装：${missingRules.join(', ')}\n`;
        }

        return summary;
    }

    // 设计前检查清单
    getDesignChecklist(designType) {
        const checklists = {
            'entity': [
                '是否继承了 BaseEntity？',
                '主键是否为 String rowguid？',
                '是否包含必要的审计字段（rowguid, rowversion 等）？',
                '是否实现了 Cloneable 接口？'
            ],
            'action': [
                '是否符合 RESTful 风格？',
                '返回值是否统一使用 ResultList/ResultEntity？',
                '是否进行了必要的权限校验？',
                '异常处理是否规范？'
            ],
            'frontend': [
                'UI 控件命名是否符合规范？',
                '数据加载是否处理了 loading 状态？',
                '是否实现了列表的分页查询？',
                '弹窗父子页面传值方式是否正确？'
            ]
        };

        const list = checklists[designType] || ['请查阅相关开发规范。'];
        return `### ${designType} 设计检查清单\n\n` + list.map(item => `- [ ] ${item}`).join('\n');
    }

    // 设计验证功能
    validateDesign(designContent, designType) {
        const findings = [];
        const content = designContent.toLowerCase();

        if (designType === 'entity') {
            if (!content.includes('baseentity')) findings.push('❌ 未发现继承 BaseEntity');
            if (!content.includes('rowguid')) findings.push('❌ 未发现 rowguid 字段');
        }

        if (designType === 'action') {
            if (!content.includes('restcontroller')) findings.push('⚠️ 建议使用 @RestController 注解');
            if (!content.includes('result')) findings.push('⚠️ 建议返回值使用统一的 Result 包装类');
        }

        return findings.length > 0 ? `发现以下潜在问题：\n${findings.join('\n')}` : '✅ 设计初步检查通过！';
    }

    // 常见错误预防
    getCommonMistakes(mistakeType) {
        const mistakes = {
            'java': [
                'NPE 风险：调用对象方法前未判空',
                '事务失效：在同一个类中调用 @Transactional 方法',
                '硬编码：魔法值未定义为常量'
            ],
            'sql': [
                '性能风险：在循环中执行 SQL 查询',
                '安全风险：直接拼装 SQL 字符串',
                '规范风险：未使用 SqlConditionUtil 构建动态条件'
            ]
        };

        const list = mistakes[mistakeType] || ['暂无相关记录。'];
        return `### ${mistakeType} 开发常见错误预防\n\n` + list.map(item => `❌ ${item}`).join('\n');
    }

    // 辅助方法：获取规范描述
    getRuleDescription(ruleName) {
        const descriptions = {
            '项目结构与命名规范': '定义项目结构、包命名、类命名等基础规范',
            '代码生成规范': '定义实体类、Action类、Service类以及前端页面的完整生成模板',
            '前端-MiniUI开发规范': '定义MiniUI组件开发、数据绑定、事件处理等规范',
            'REST接口开发规范': '定义REST接口的设计和实现规范',
            '定时任务Job开发规范': '定义定时任务Job的开发规范',
            '左树右表开发规范': '定义左树右表布局的开发规范',
            '手风琴布局开发规范': '定义手风琴布局的开发规范',
            '关联配置弹窗开发规范': '定义关联配置弹窗的开发规范',
            '附件上传开发规范': '定义附件上传功能的设计和实现规范',
            'IAttachService接口使用规范': '附件服务接口使用规范',
            'ICodeItemsService接口使用规范': '代码项服务接口使用规范',
            'IConfigService接口使用规范': '系统参数服务接口使用规范',
            'IMessagesCenterService接口使用规范': '消息中心服务接口使用规范',
            'HttpUtil使用规范': 'HTTP请求工具类使用规范',
            'SqlConditionUtil使用规范': 'SQL条件构建工具使用规范'
        };
        return descriptions[ruleName] || '开发规范文档';
    }

    // 辅助方法：获取设计类型相关规范
    getDesignTypeRules(designType) {
        const typeRules = {
            'entity': ['项目结构与命名规范', '代码生成规范'],
            'action': ['项目结构与命名规范', '代码生成规范', 'REST接口开发规范'],
            'frontend': ['前端-MiniUI开发规范', '附件上传开发规范'],
            'database': ['项目结构与命名规范', '代码生成规范']
        };

        const { availableRules, missingRules } = this.ruleService.partitionExistingRules(typeRules[designType] || []);
        if (!availableRules.length) {
            return '请先查阅《规范指引》，确认适用规范。';
        }

        let summary = availableRules.map((rule, index) => `${index + 1}. ${rule}`).join('\n');
        if (missingRules.length) {
            summary += `\n⚠️ 以下规范未找到：${missingRules.join(', ')}，请确认。`;
        }
        return summary;
    }
}

module.exports = RecommendationService;
