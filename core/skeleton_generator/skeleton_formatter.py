#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""Lightweight deterministic formatting for generated skeleton files.

The formatter is intentionally conservative: it normalizes whitespace and
beautifies inline JavaScript without parsing or rewriting MiniUI/FUI markup.
"""

import os
import re
import subprocess


def format_skeleton_content(content, target_file="", file_kind=""):
    text = _normalize_text(content)
    ext = os.path.splitext(str(target_file or ""))[1].lower()
    kind = str(file_kind or "").strip()
    formatted = _format_with_central_formatter(text, target_file, file_kind)
    if formatted is not None:
        if ext in (".java",):
            formatted = _format_java(formatted)
        return _finalize_text(formatted)
    if ext in (".html", ".htm", ".xhtml") or kind == "HtmlPage":
        text = _format_html(text)
    elif ext in (".java",):
        text = _format_java(text)
    elif ext in (".sql", ".ddl"):
        text = _format_sql(text)
    return _finalize_text(text)


def _format_with_central_formatter(text, target_file="", file_kind=""):
    if not _central_formatter_supported(target_file, file_kind):
        return None
    script_path = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "formatters", "format-content.js"))
    if not os.path.isfile(script_path):
        return None
    try:
        result = subprocess.run(
            ["node", script_path, "--file", str(target_file or "")],
            input=str(text or ""),
            text=True,
            encoding="utf-8",
            errors="replace",
            capture_output=True,
            timeout=20
        )
    except Exception:
        return None
    if result.returncode != 0:
        return None
    output = result.stdout
    return output if output is not None else None


def _central_formatter_supported(target_file="", file_kind=""):
    ext = os.path.splitext(str(target_file or ""))[1].lower()
    kind = str(file_kind or "").strip()
    return (
        ext in (".java", ".html", ".htm", ".xhtml", ".js", ".css", ".json")
        or kind == "HtmlPage"
    )


def _normalize_text(content):
    text = str(content or "")
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    lines = [line.rstrip() for line in text.split("\n")]
    return "\n".join(lines)


def _finalize_text(text):
    lines = str(text or "").replace("\r\n", "\n").replace("\r", "\n").split("\n")
    out = []
    blank_count = 0
    for line in lines:
        stripped_right = line.rstrip()
        if stripped_right == "":
            blank_count += 1
            if blank_count <= 2:
                out.append("")
            continue
        blank_count = 0
        out.append(stripped_right)
    while out and out[-1] == "":
        out.pop()
    return "\n".join(out) + "\n"


def _format_java(text):
    text = _normalize_java_imports(text)
    text = _expand_java_empty_methods(text)
    text = _expand_java_single_line_blocks(text)
    text = _break_java_skeleton_long_calls(text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    text = re.sub(r"(?m)^\s+$", "", text)
    return text


def _normalize_java_imports(text):
    lines = _normalize_text(text).split("\n")
    first_import = None
    last_import = None
    imports = []
    seen = set()
    for index, line in enumerate(lines):
        stripped = line.strip()
        if stripped.startswith("import ") and stripped.endswith(";"):
            if first_import is None:
                first_import = index
            last_import = index
            if stripped not in seen:
                seen.add(stripped)
                imports.append(stripped)
            continue
        if first_import is not None and last_import is not None and stripped and not stripped.startswith("import "):
            break
    if first_import is None or last_import is None:
        return "\n".join(lines)

    groups = [
        sorted([item for item in imports if item.startswith("import java.") or item.startswith("import javax.")]),
        sorted([item for item in imports if item.startswith("import org.")]),
        sorted([item for item in imports if item.startswith("import com.")]),
        sorted([item for item in imports if not (
            item.startswith("import java.")
            or item.startswith("import javax.")
            or item.startswith("import org.")
            or item.startswith("import com.")
        )])
    ]
    rendered = []
    for group in groups:
        if not group:
            continue
        if rendered:
            rendered.append("")
        rendered.extend(group)
    return "\n".join(lines[:first_import] + rendered + lines[last_import + 1:])


def _expand_java_empty_methods(text):
    out = []
    pattern = re.compile(
        r"^(\s*)((?:public|protected|private)\s+[^{};]+?\([^{};]*\)(?:\s+throws\s+[^{;]+)?)\s*\{\s*\}\s*$"
    )
    for line in _normalize_text(text).split("\n"):
        match = pattern.match(line)
        if match:
            indent = match.group(1)
            signature = match.group(2).strip()
            out.append(indent + signature + " {")
            out.append(indent + "}")
            continue
        out.append(line)
    return "\n".join(out)


def _expand_java_single_line_blocks(text):
    out = []
    for line in _normalize_text(text).split("\n"):
        split_else = _split_java_inline_else_block(line)
        if split_else:
            out.extend(split_else)
            continue
        expanded = _expand_java_single_line_if(line)
        if expanded:
            out.extend(expanded)
            continue
        expanded_else = _expand_java_single_line_else(line)
        if expanded_else:
            out.extend(expanded_else)
            continue
        out.append(line)
    return "\n".join(out)


def _split_java_inline_else_block(line):
    match = re.match(r"^(\s*)}\s+(else(?:\s+if\s*\(.+\))?\s*\{)\s*$", line)
    if not match:
        return None
    indent = match.group(1)
    return [indent + "}", indent + match.group(2)]


def _expand_java_single_line_if(line):
    indent, stripped = _leading_indent_and_text(line)
    prefix = ""
    target = stripped
    if target.startswith("else if"):
        prefix = "else "
        target = target[len("else "):]
    if not target.startswith("if"):
        return None
    parsed = _parse_java_control_condition(target, "if")
    if not parsed:
        return None
    condition, rest = parsed
    if rest.startswith("{") or not rest.endswith(";") or "{" in rest or "}" in rest:
        return None
    return [
        indent + prefix + "if (" + condition + ") {",
        indent + "    " + rest,
        indent + "}"
    ]


def _expand_java_single_line_else(line):
    indent, stripped = _leading_indent_and_text(line)
    if not stripped.startswith("else "):
        return None
    rest = stripped[len("else "):].strip()
    if rest.startswith("{") or rest.startswith("if") or not rest.endswith(";") or "{" in rest or "}" in rest:
        return None
    return [
        indent + "else {",
        indent + "    " + rest,
        indent + "}"
    ]


def _parse_java_control_condition(text, keyword):
    source = str(text or "").strip()
    if not source.startswith(keyword):
        return None
    pos = len(keyword)
    while pos < len(source) and source[pos].isspace():
        pos += 1
    if pos >= len(source) or source[pos] != "(":
        return None
    depth = 0
    quote = ""
    start = pos + 1
    i = pos
    while i < len(source):
        ch = source[i]
        if quote:
            if ch == quote:
                quote = ""
            elif ch == "\\":
                i += 1
        else:
            if ch in ("'", '"'):
                quote = ch
            elif ch == "(":
                depth += 1
            elif ch == ")":
                depth -= 1
                if depth == 0:
                    return source[start:i].strip(), source[i + 1:].strip()
        i += 1
    return None


def _break_java_skeleton_long_calls(text):
    out = []
    for line in _normalize_text(text).split("\n"):
        broken = _break_java_paginator_call(line)
        if broken:
            out.extend(broken)
            continue
        broken = _break_java_export_model_call(line)
        if broken:
            out.extend(broken)
            continue
        out.append(line)
    return "\n".join(out)


def _break_java_paginator_call(line):
    if ".paginatorList(" not in line:
        return None
    match = re.match(r"^(\s*)(.+?=\s*[\w.]+\.paginatorList)\((.*)\);\s*$", line)
    if not match:
        return None
    indent, call_head, args_text = match.group(1), match.group(2), match.group(3)
    args = _split_top_level_commas(args_text)
    if len(args) < 3:
        return None
    lines = [indent + call_head.strip() + "("]
    for index, arg in enumerate(args):
        suffix = "," if index < len(args) - 1 else ""
        lines.append(indent + "    " + arg.strip() + suffix)
    lines.append(indent + ");")
    return lines


def _break_java_export_model_call(line):
    if "new ExportModel(" not in line:
        return None
    match = re.match(r"^(\s*)(.+?new\s+ExportModel)\((\"(?:\\.|[^\"])*\")\s*,\s*(\"(?:\\.|[^\"])*\")\);\s*$", line)
    if not match:
        return None
    if len(line) < 100 and "," not in match.group(3):
        return None
    indent, call_head, fields, headers = match.group(1), match.group(2), match.group(3), match.group(4)
    return [
        indent + call_head.strip() + "(",
        indent + "    " + fields + ",",
        indent + "    " + headers,
        indent + ");"
    ]


def _split_top_level_commas(text):
    parts = []
    current = []
    depth = 0
    quote = ""
    source = str(text or "")
    i = 0
    while i < len(source):
        ch = source[i]
        if quote:
            current.append(ch)
            if ch == quote:
                quote = ""
            elif ch == "\\" and i + 1 < len(source):
                i += 1
                current.append(source[i])
        else:
            if ch in ("'", '"'):
                quote = ch
                current.append(ch)
            elif ch in "([{<":
                depth += 1
                current.append(ch)
            elif ch in ")]}>":
                depth = max(0, depth - 1)
                current.append(ch)
            elif ch == "," and depth == 0:
                parts.append("".join(current).strip())
                current = []
            else:
                current.append(ch)
        i += 1
    if "".join(current).strip():
        parts.append("".join(current).strip())
    return parts


def _leading_indent_and_text(line):
    match = re.match(r"^(\s*)(.*)$", str(line or ""))
    return match.group(1), match.group(2).strip()


def _format_sql(text):
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text


def _format_html(text):
    text = _format_script_blocks(text)
    text = _expand_inline_html_tags(text)
    text = _indent_html(text)
    return text


def _expand_inline_html_tags(text):
    """Put adjacent HTML tags on separate lines before indentation.

    Rule templates sometimes keep short HTML skeletons on one line. Splitting
    tag boundaries here lets the raw-block handling below see <script> and
    </script> as their own lines, so formatted JavaScript keeps its indentation.
    """
    raw_tags = {"script", "style", "pre", "textarea"}
    source = str(text or "")
    lower = source.lower()
    lines = []
    current = []
    raw_block = ""
    i = 0

    def flush_current():
        if not current:
            return
        line = "".join(current).strip()
        current[:] = []
        if line:
            lines.append(line)

    def append_raw_body(body):
        for raw_line in str(body or "").splitlines():
            if raw_line.strip():
                lines.append(raw_line.rstrip())

    while i < len(source):
        if raw_block:
            close_start = lower.find("</" + raw_block, i)
            if close_start == -1:
                append_raw_body(source[i:])
                i = len(source)
                break
            append_raw_body(source[i:close_start])
            i = close_start
            raw_block = ""
            continue

        ch = source[i]
        if ch == "<":
            end = _find_html_tag_end(source, i)
            if end == -1:
                current.append(source[i:])
                break
            flush_current()
            tag_text = source[i:end + 1].strip()
            if tag_text:
                lines.append(tag_text)
                tag_name = _html_tag_name(tag_text)
                if tag_name in raw_tags and not tag_text.startswith("</"):
                    raw_block = tag_name
            i = end + 1
            continue
        if ch == "\n":
            flush_current()
            i += 1
            continue
        current.append(ch)
        i += 1

    flush_current()
    return "\n".join(lines)


def _find_html_tag_end(source, start):
    quote = ""
    i = start + 1
    while i < len(source):
        ch = source[i]
        if quote:
            if ch == quote:
                quote = ""
            elif ch == "\\":
                i += 1
        else:
            if ch in ("'", '"'):
                quote = ch
            elif ch == ">":
                return i
        i += 1
    return -1


def _format_script_blocks(text):
    pattern = re.compile(r"(<script\b(?![^>]*\bsrc\s*=)[^>]*>)(.*?)(</script>)", re.IGNORECASE | re.DOTALL)

    def repl(match):
        open_tag = match.group(1).rstrip()
        body = match.group(2)
        close_tag = match.group(3)
        formatted = _format_javascript(body)
        if not formatted.strip():
            return open_tag + "\n" + close_tag
        return open_tag + "\n" + formatted + "\n" + close_tag

    return pattern.sub(repl, text)


def _format_javascript(source):
    source = _normalize_text(source).strip()
    if not source:
        return ""
    tokens = _js_tokens(source)
    lines = []
    current = ""
    indent = 0
    pending_space = False

    def emit():
        nonlocal current, pending_space
        line = current.strip()
        if line:
            lines.append("    " * max(indent, 0) + line)
        current = ""
        pending_space = False

    def append(value):
        nonlocal current, pending_space
        if pending_space and current and not current.endswith((" ", "(", "[", "{", ".")):
            current += " "
        current += value
        pending_space = False

    for token in tokens:
        if token.isspace():
            pending_space = True
            continue
        if current.strip() == "}" and token not in (";", ")", "]", ",", "else", "catch", "finally"):
            emit()
        if token == "(" and current.strip() in ("if", "for", "while", "switch", "catch"):
            pending_space = True
        if token == "{":
            if current and not current.endswith((" ", "(", "[")):
                current += " "
            append("{")
            emit()
            indent += 1
            continue
        if token == "}":
            emit()
            indent = max(indent - 1, 0)
            append("}")
            continue
        if token == ";":
            append(";")
            emit()
            continue
        if token == ",":
            append(",")
            pending_space = True
            continue
        if token in ("else", "catch", "finally"):
            if current.strip() == "}":
                current += " " + token
                pending_space = True
            else:
                emit()
                append(token)
            continue
        if token.startswith("//"):
            append(token)
            emit()
            continue
        if token.startswith("/*"):
            emit()
            lines.append("    " * max(indent, 0) + token.strip())
            continue
        append(token)

    emit()
    return "\n".join(lines)


def _js_tokens(source):
    tokens = []
    i = 0
    length = len(source)
    while i < length:
        ch = source[i]
        if ch in ("'", '"'):
            quote = ch
            start = i
            i += 1
            escaped = False
            while i < length:
                cur = source[i]
                if escaped:
                    escaped = False
                elif cur == "\\":
                    escaped = True
                elif cur == quote:
                    i += 1
                    break
                i += 1
            tokens.append(source[start:i])
            continue
        if ch == "/" and i + 1 < length and source[i + 1] == "/":
            start = i
            i = source.find("\n", i)
            if i == -1:
                i = length
            tokens.append(source[start:i])
            continue
        if ch == "/" and i + 1 < length and source[i + 1] == "*":
            start = i
            end = source.find("*/", i + 2)
            i = length if end == -1 else end + 2
            tokens.append(source[start:i])
            continue
        if ch.isspace():
            start = i
            while i < length and source[i].isspace():
                i += 1
            tokens.append(" ")
            continue
        if ch in "{}();,[]":
            tokens.append(ch)
            i += 1
            continue
        start = i
        while i < length:
            cur = source[i]
            if cur.isspace() or cur in "{}();,[]'\"":
                break
            if cur == "/" and i + 1 < length and source[i + 1] in ("/", "*"):
                break
            i += 1
        word = source[start:i]
        if word:
            tokens.append(word)
    return _merge_word_tokens(tokens)


def _merge_word_tokens(tokens):
    merged = []
    for token in tokens:
        if token == "else":
            merged.append(token)
            continue
        merged.append(token)
    return merged


def _indent_block(text, indent):
    return "\n".join(indent + line if line.strip() else "" for line in text.splitlines())


def _indent_html(text):
    lines = _normalize_text(text).split("\n")
    out = []
    indent = 0
    raw_block = None
    for raw in lines:
        stripped = raw.strip()
        if not stripped:
            out.append("")
            continue
        lower = stripped.lower()
        if raw_block:
            if lower.startswith("</" + raw_block):
                indent = max(indent - 1, 0)
                raw_block = None
                out.append("    " * indent + stripped)
            else:
                out.append("    " * indent + raw.rstrip())
            continue
        if lower.startswith("</"):
            indent = max(indent - 1, 0)
        out.append("    " * indent + stripped)
        if _opens_html_block(stripped):
            tag = _html_tag_name(stripped)
            if tag in ("script", "style", "pre", "textarea"):
                raw_block = tag
            indent += 1
    return "\n".join(out)


def _opens_html_block(line):
    if line.startswith("<!--"):
        return False
    match = re.match(r"<([A-Za-z][A-Za-z0-9:-]*)(?:\s|>|/)", line)
    if not match:
        return False
    tag = match.group(1).lower()
    if tag in {"meta", "link", "input", "br", "hr", "img", "base", "area", "param", "source"}:
        return False
    if line.endswith("/>"):
        return False
    if re.search(r"</" + re.escape(tag) + r">\s*$", line, re.IGNORECASE):
        return False
    return True


def _html_tag_name(line):
    match = re.match(r"</?([A-Za-z][A-Za-z0-9:-]*)", line)
    return match.group(1).lower() if match else ""
