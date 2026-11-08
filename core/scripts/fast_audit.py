import os
import re
import json
import argparse
from datetime import datetime
from concurrent.futures import ThreadPoolExecutor

class GenericAuditor:
    def __init__(self, project_path, config_data):
        self.project_path = project_path
        self.config = config_data
        self.results = []
        
        # L1: 排除已标记的文件（从配置或命令行传入）
        self.exclude_files = set(config_data.get('exclude_files', []))
        
        # L3: 严重度过滤
        self.min_severity = config_data.get('min_severity', 'medium')
        severity_order = {'critical': 0, 'high': 1, 'medium': 2, 'low': 3}
        self.min_severity_level = severity_order.get(self.min_severity, 2)
        
        # 处理嵌套规则结构: rules -> list of categories -> rules
        flattened_rules = []
        raw_rules = self.config.get('rules', [])
        for item in raw_rules:
            if 'rules' in item and isinstance(item['rules'], list):
                # 这是一个分类对象
                category = item.get('category', 'General')
                category_severity = item.get('severity', 'medium')
                for sub_rule in item['rules']:
                    sub_rule['category'] = category
                    if 'severity' not in sub_rule:
                        sub_rule['severity'] = category_severity
                    flattened_rules.append(sub_rule)
            else:
                # 这是一个直接规则对象
                flattened_rules.append(item)
        
        # L3: 按严重度过滤规则
        filtered_rules = []
        for rule in flattened_rules:
            rule_severity = rule.get('severity', 'medium')
            rule_level = severity_order.get(rule_severity, 2)
            if rule_level <= self.min_severity_level:
                filtered_rules.append(rule)
        
        self.all_rules = filtered_rules
        
        # 预编译全局正则
        self.standards = {k: re.compile(v, re.IGNORECASE) for k, v in self.config.get('standards', {}).items()}

    def audit_file(self, file_path):
        try:
            abs_path = os.path.abspath(file_path).replace("\\", "/")
            rel_path = os.path.relpath(file_path, self.project_path).replace("\\", "/")
            ext = os.path.splitext(file_path)[1].lower()
            filename = os.path.basename(file_path)
            
            # L1: 排除已标记的文件
            if filename in self.exclude_files:
                return None
            
            # 1. 扩展名匹配
            scope = self.config.get('scope', {})
            extensions = scope.get('extensions') if scope else None
            if not extensions:
                extensions = [".java"]
            if ext not in extensions:
                return None
            
            with open(file_path, 'r', encoding='utf-8', errors='ignore') as f:
                content = f.read()

            # 2. 内容预过滤器
            if scope.get('content_required') and not re.search(scope['content_required'], content):
                return None
            
            # 3. 执行审计逻辑 (文件级 vs 方法级)
            if scope.get('granularity') == 'method' and ext == '.java':
                res = self._audit_by_method(rel_path, content)
            else:
                res = self._audit_by_file(rel_path, content)
            
            if res:
                res['abs_path'] = abs_path
            return res
                
        except Exception as e:
            print(f"DEBUG: Error auditing {file_path}: {e}")
            return None

    def _audit_by_file(self, rel_path, content):
        issues = []
        is_fixed = False
        
        # 简单检查全局固定标识 (如国产化适配的 baseDao)
        if self.config.get('fix_indicator') and re.search(self.config['fix_indicator'], content):
            is_fixed = True

        for rule in self.all_rules:
            pattern = rule.get('pattern')
            if not pattern: continue
            
            if re.search(pattern, content, re.IGNORECASE):
                # 如果全局标记已修复，且该规则支持验证跳过
                if is_fixed and self.config.get('is_verify'):
                    continue
                
                issues.append({
                    "id": rule.get('id', 'unknown'),
                    "pattern": pattern,
                    "desc": rule.get('description') or rule.get('desc') or rule.get('name', 'Rule Match'),
                    "suggestion": rule.get('replacement') or rule.get('suggestion', '')
                })
        
        if issues:
            return {
                "path": rel_path,
                "issues": issues,
                "status": "❌ 待整改" if not self.config.get('is_verify') else "⚠️ 验证未通过"
            }
        return None

    def _audit_by_method(self, rel_path, content):
        # 针对 Java 的方法切分逻辑
        methods = re.split(r'(?=\n\s*(?:public|private|protected|static)\s+[\w<>]+\s+\w+\s*\()', content)
        file_findings = []
        
        fix_indicator = self.config.get('fix_indicator')
        is_verify = self.config.get('is_verify')

        for method_content in methods:
            method_name_match = re.search(r'(?:public|private|protected|static)\s+[\w<>]+\s+(\w+)\s*\(', method_content)
            method_name = method_name_match.group(1) if method_name_match else "Unknown"
            
            # L2: 不论 audit/verify 模式，含修复标识的方法均跳过
            if fix_indicator and re.search(fix_indicator, method_content):
                continue

            method_issues = []
            for rule in self.all_rules:
                pattern = rule.get('pattern')
                if not pattern: continue
                
                if re.search(pattern, method_content, re.IGNORECASE):
                    # 假阳性检查
                    if self._is_false_positive(method_content, pattern):
                        continue
                        
                    method_issues.append({
                        "id": rule.get('id', 'rule'),
                        "desc": rule.get('description') or rule.get('desc') or rule.get('name', 'Rule Match'),
                        "suggestion": rule.get('replacement') or rule.get('suggestion', ''),
                        "testQuery": rule.get('testQuery', ''),
                        "examples": rule.get('examples', [])
                    })
            
            if method_issues:
                # 去重并保留元数据
                unique_map = {}
                for i in method_issues:
                    if i['id'] not in unique_map:
                        unique_map[i['id']] = i
                
                file_findings.append({
                    "method": method_name,
                    "issues": list(unique_map.values())
                })

        if file_findings:
            return {
                "path": rel_path,
                "method_details": file_findings,
                "status": "❌ 待整改" if not is_verify else "⚠️ 验证未通过"
            }
        return None

    def _is_false_positive(self, content, pattern):
        safe_prefixes = self.config.get('safe_prefixes', [])
        # 简单实现：如果命中行前面有注释，暂不实现复杂的逻辑，保留原样
        return False

    def run(self):
        all_files = []
        for root, dirs, files in os.walk(self.project_path):
            dirs[:] = [d for d in dirs if d not in ['node_modules', 'target', '.git', '.vscode', 'bin']]
            for file in files:
                all_files.append(os.path.join(root, file))

        with ThreadPoolExecutor(max_workers=8) as executor:
            reports = list(executor.map(self.audit_file, all_files))
        
        self.results = [r for r in reports if r]
        return self.results

    def generate_report(self, output_path):
        is_verify = self.config.get('is_verify', False)
        title = self.config.get('report_title', '国产化适配审计报表')
        source_db = self.config.get('sourceDB', 'Oracle')
        target_db = self.config.get('targetDB', 'PostgreSQL')
        
        # --- 状态保持逻辑 (Preserve Status) ---
        preserved_status = {}
        if os.path.exists(output_path):
            with open(output_path, 'r', encoding='utf-8') as old_f:
                old_content = old_f.read()
                # 匹配 [ ]、[√]、[X] 并提取文件名
                # 简单实现：查找总览索引区的行
                matches = re.findall(r'\[(.)\](\S+\.java)', old_content)
                for status, filename in matches:
                    if status != ' ':
                        preserved_status[filename] = status
        # ------------------------------------

        # 按类型分组
        categories = {
            "后端开发 (Java)": [],
            "前端开发 (Web)": [],
            "其他文件": []
        }
        
        for r in self.results:
            ext = os.path.splitext(r['path'])[1].lower()
            if ext == '.java':
                categories["后端开发 (Java)"].append(r)
            elif ext in ['.html', '.vue', '.js']:
                categories["前端开发 (Web)"].append(r)
            else:
                categories["其他文件"].append(r)

        with open(output_path, 'w', encoding='utf-8') as f:
            f.write(f"# {title}\n\n")
            f.write(f"> 基于模式: `{source_db} -> {target_db}`\n")
            f.write(f"> 生成时间: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}\n\n")
            
            if not self.results:
                f.write("✅ 验证通过或未发现已知风险。\n")
                return

            # 首先生成总览索引区 (Summary Index)
            f.write("## 📝 待办任务总览 (可直接复制文件名发给 AI)\n\n")
            for cat_name, file_results in categories.items():
                if not file_results: continue
                f.write(f"### 📋 {cat_name}\n")
                for r in file_results:
                    display_name = os.path.basename(r.get('abs_path', r['path']) if cat_name == "前端开发 (Web)" else r['path'])
                    status = preserved_status.get(display_name, ' ')
                    f.write(f"[{status}]{display_name}\n")
                f.write("\n")
            
            f.write("---\n")
            f.write("## 🔍 详细排查清单\n\n")

            for cat_name, file_results in categories.items():
                if not file_results: continue
                
                f.write(f"### 📂 {cat_name}\n\n")
                
                # 按目录分组
                dir_groups = {}
                for r in file_results:
                    path_val = r.get('abs_path', r['path']) if cat_name == "前端开发 (Web)" else r['path']
                    directory = os.path.dirname(path_val).replace("\\", "/")
                    if directory not in dir_groups:
                        dir_groups[directory] = []
                    dir_groups[directory].append(r)
                
                # 按目录排序输出
                for directory in sorted(dir_groups.keys()):
                    f.write(f"#### 📁 目录: `{directory}`\n\n")
                    for r in dir_groups[directory]:
                        display_name = os.path.basename(r.get('abs_path', r['path']) if cat_name == "前端开发 (Web)" else r['path'])
                        full_path = r.get('abs_path', r['path']) if cat_name == "前端开发 (Web)" else r['path']
                        status = preserved_status.get(display_name, ' ')
                        
                        f.write(f"##### - [{status}] 📄 文件: `{display_name}`\n")
                        f.write(f"  - **完整路径**: `{full_path}`\n")
                        
                        if 'method_details' in r:
                            for m in r['method_details']:
                                f.write(f"  - 🔹 方法: `{m['method']}`\n")
                                issue_descs = [f"{i['desc']}" for i in m['issues']]
                                f.write(f"    - **命中风险**: {', '.join(issue_descs)}\n")
                                
                                test_queries = [i['testQuery'] for i in m['issues'] if i.get('testQuery')]
                                if not test_queries:
                                    for i in m['issues']:
                                        if i.get('examples'):
                                            ex = i['examples'][0] if isinstance(i['examples'], list) else i['examples']
                                            if isinstance(ex, dict) and ex.get('after'):
                                                test_queries.append(f"-- 基于示例: {ex['after']}")

                                if test_queries:
                                    f.write("    > [!TIP]\n")
                                    f.write("    > **SQL 验证沙箱**\n")
                                    f.write("    ```sql\n")
                                    for q in test_queries:
                                        clean_q = q.replace('?', "'DUMMY'")
                                        f.write(f"    {clean_q};\n")
                                    f.write("    ```\n")
                        else:
                            for i in r['issues']:
                                f.write(f"  - **风险点**: `{i['pattern']}` ({i['desc']})\n")
                        f.write("\n")
                    f.write("---\n")

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--project", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--config", required=True)
    parser.add_argument("--verify", action="store_true")
    parser.add_argument("--min-severity", default="medium",
                        choices=["critical", "high", "medium", "low"],
                        help="Minimum severity level to report (default: medium)")
    parser.add_argument("--exclude-done", default="",
                        help="Comma-separated list of filenames to exclude")
    args = parser.parse_args()

    if os.path.exists(args.config):
        with open(args.config, 'r', encoding='utf-8') as f:
            if args.config.endswith('.yaml') or args.config.endswith('.yml'):
                try:
                    import yaml
                    config_data = yaml.safe_load(f)
                except ImportError:
                    print("Error: PyYAML is required for .yaml config files. Please install it via 'pip install pyyaml'.")
                    return
            else:
                config_data = json.load(f)
    else:
        config_data = json.loads(args.config)
        
    config_data['is_verify'] = args.verify
    config_data['min_severity'] = args.min_severity
    
    # 合并命令行排除列表
    if args.exclude_done:
        existing = set(config_data.get('exclude_files', []))
        existing.update(f.strip() for f in args.exclude_done.split(',') if f.strip())
        config_data['exclude_files'] = list(existing)

    auditor = GenericAuditor(args.project, config_data)
    auditor.run()
    auditor.generate_report(args.output)

if __name__ == "__main__":
    main()
