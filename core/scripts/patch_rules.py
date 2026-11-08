import argparse
import os
import re


def resolve_directory(cli_directory=None):
    directory = (cli_directory or os.environ.get('PATCH_RULES_DIR') or '').strip()
    if not directory:
        raise SystemExit('请通过命令行参数传入目录，或设置环境变量 PATCH_RULES_DIR。')
    if not os.path.isdir(directory):
        raise SystemExit(f'目录不存在或不可访问: {directory}')
    return directory


def patch_rules(directory):
    files = [f for f in os.listdir(directory) if f.endswith('.yaml')]
    
    for file in files:
        path = os.path.join(directory, file)
        with open(path, 'r', encoding='utf-8') as f:
            content = f.read()
            
        lines = content.split('\n')
        new_lines = []
        changed_count = 0
        
        for line in lines:
            if re.search(r'^\s*pattern:\s*"', line):
                if '(?<!\\\\.)' not in line:
                    if '\\(' in line or 'regexp' in line.lower() or 'dual' in line.lower() or 'user' in line.lower() or 'trim' in line.lower():
                        # We inject (?<!\\.) right after the quote
                        line = re.sub(r'(pattern:\s*")', r'\1(?<!\\\\.)', line)
                        changed_count += 1
            new_lines.append(line)
            
        if changed_count > 0:
            with open(path, 'w', encoding='utf-8') as f:
                f.write('\n'.join(new_lines))
            print(f"Updated {file}: {changed_count} patterns patched.")
        else:
            print(f"Skipped {file}: No patterns needed patching.")

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='批量修补规则库中的 pattern 正则写法。')
    parser.add_argument('directory', nargs='?', help='待处理的规则目录；也可通过环境变量 PATCH_RULES_DIR 提供。')
    args = parser.parse_args()
    patch_rules(resolve_directory(args.directory))
