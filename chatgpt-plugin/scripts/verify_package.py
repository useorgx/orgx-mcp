#!/usr/bin/env python3
"""Validate the local candidate's known manifest contract; never call a portal."""
from __future__ import annotations

import json
import hashlib
import re
import struct
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parents[1]
REPO = ROOT.parent
MANIFEST_SCHEMA = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json"
MCP_SCHEMA = "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json"
MCP_URL = "https://mcp.useorgx.com/mcp"
SKILLS = ("orgx-deviation-reporting", "orgx-initiative-ops", "orgx-runtime-reporting")
CORE_TOOLS = frozenset("""
orgx_get_workspace_context orgx_search orgx_inspect orgx_get_operator_brief
orgx_get_next_actions orgx_get_agent_status orgx_get_initiative_progress
orgx_get_operation_status orgx_check_execution_readiness orgx_start_plan
orgx_read_plan orgx_save_plan orgx_complete_plan orgx_validate_initiative_plan
orgx_create_initiative_hierarchy orgx_create_initiative orgx_create_workstream
orgx_create_milestone orgx_create_task orgx_update_work orgx_estimate_agent_task
orgx_start_agent_task orgx_handoff_task orgx_launch_initiative orgx_pause_work
orgx_resume_work orgx_retry_work orgx_cancel_work orgx_capture_decision
orgx_list_pending_decisions orgx_open_decision_review orgx_attach_artifact
orgx_open_artifact_review orgx_request_independent_artifact_review
orgx_complete_work_with_proof orgx_submit_work_receipt orgx_validate_work_receipt
orgx_get_work_receipt orgx_list_work_receipts orgx_get_receipt_review_queue
""".split())


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)


def read_json(path: Path) -> dict:
    def pairs(items):
        result = {}
        for key, value in items:
            require(key not in result, f"Duplicate JSON member in {path.name}: {key}")
            result[key] = value
        return result
    value = json.loads(path.read_text(), object_pairs_hook=pairs)
    require(isinstance(value, dict), f"{path.name} must be an object")
    return value


def package_files() -> list[Path]:
    fixed = [ROOT / "plugin.json", ROOT / "mcp.json", ROOT / "README.md",
             ROOT / "assets/icon.png", ROOT / "assets/logo.png"]
    return sorted(fixed + [ROOT / "skills" / name / "SKILL.md" for name in SKILLS],
                  key=lambda path: path.relative_to(ROOT).as_posix())


def package_path(value: object, *, directory: bool = False) -> Path:
    require(isinstance(value, str) and value.startswith("./"), "Component paths must start with ./")
    require("\\" not in value and ".." not in Path(value).parts, "Unsafe component path")
    path = ROOT / value[2:]
    require(path.resolve().is_relative_to(ROOT.resolve()), "Component escapes package root")
    require(path.is_dir() if directory else path.is_file(), f"Missing component: {value}")
    require(not path.is_symlink(), f"Symlink component: {value}")
    return path


def https_url(value: object) -> bool:
    if not isinstance(value, str):
        return False
    url = urlparse(value)
    return url.scheme == "https" and bool(url.hostname) and not url.username and not url.password


def text_field(value: object, label: str, maximum: int, *, single_line: bool = False) -> None:
    require(isinstance(value, str) and bool(value.strip()) and len(value) <= maximum,
            f"{label} must contain 1 to {maximum} characters")
    require(not any(ord(char) < 32 and char != "\n" for char in value), f"Unsupported control character in {label}")
    require(not single_line or "\n" not in value, f"{label} must be a single line")


def contrast_with_white(color: str) -> float:
    rgb = [int(color[index:index + 2], 16) / 255 for index in (1, 3, 5)]
    linear = [part / 12.92 if part <= 0.04045 else ((part + 0.055) / 1.055) ** 2.4 for part in rgb]
    luminance = sum(part * weight for part, weight in zip(linear, (0.2126, 0.7152, 0.0722)))
    return 1.05 / (luminance + 0.05)


def verify() -> dict:
    manifest = read_json(ROOT / "plugin.json")
    # Portable Agent Plugins manifests discover skills/ and mcp.json themselves.
    # Codex-only root interface/skills/mcpServers fields are not part of this format.
    allowed = {"$schema", "name", "version", "description", "author", "homepage", "repository",
               "license", "keywords", "extensions"}
    require(set(manifest) == allowed, "Missing or unsupported candidate manifest fields")
    require(manifest["$schema"] == MANIFEST_SCHEMA, "Portable plugin schema is required")
    require(manifest["name"] == "orgx", "Candidate package identity changed")
    require(manifest["version"] == "1.1.0", "Candidate minor version must be 1.1.0")
    require(re.fullmatch(r"[a-z][a-z0-9]*(?:-[a-z0-9]+)*", manifest["name"]) is not None, "Invalid plugin name")
    require(re.fullmatch(r"\d+\.\d+\.\d+", manifest["version"]) is not None, "Invalid semantic version")
    text_field(manifest["description"], "description", 4000)
    text_field(manifest["license"], "license", 120)
    require(set(manifest["author"]) == {"name", "url"}, "Unexpected author fields")
    require(manifest["author"]["name"] == "OrgX Team" and https_url(manifest["author"]["url"]), "Invalid author")
    text_field(manifest["author"]["name"], "author.name", 120)
    require(len(manifest["author"]["url"]) <= 2048, "Author URL exceeds 2048 characters")
    require(https_url(manifest["homepage"]) and https_url(manifest["repository"]), "Invalid listing URL")
    require(len(manifest["homepage"]) <= 2048, "Homepage exceeds 2048 characters")
    require(isinstance(manifest["keywords"], list) and all(isinstance(item, str) and item for item in manifest["keywords"]), "Invalid keywords")
    package_path("./skills/", directory=True)
    require(not (ROOT / ".mcp.json").exists() and not (ROOT / ".codex-plugin").exists(),
            "Portable package must not contain shadow Codex components")
    config = read_json(package_path("./mcp.json"))
    require(config == {"$schema": MCP_SCHEMA, "mcpServers": {"orgx": {"type": "streamable-http", "url": MCP_URL}}},
            "Portable MCP configuration must preserve the published remote endpoint without credentials")
    extensions = manifest["extensions"]
    require(isinstance(extensions, dict) and set(extensions) == {"com.openai"}, "Expected the OpenAI extension namespace")
    openai = extensions["com.openai"]
    require(isinstance(openai, dict) and set(openai) == {"interface"}, "Unexpected OpenAI extension fields")
    interface = openai["interface"]
    required_interface = {"displayName", "shortDescription", "longDescription", "developerName", "category",
                          "capabilities", "websiteURL", "supportURL", "privacyPolicyURL", "termsOfServiceURL", "defaultPrompt",
                          "brandColor", "composerIcon", "logo"}
    require(isinstance(interface, dict) and set(interface) == required_interface, "Missing or unsupported interface fields")
    for field, maximum in {"displayName": 30, "shortDescription": 30, "longDescription": 4000,
                           "developerName": 80, "category": 120}.items():
        text_field(interface[field], f"interface.{field}", maximum, single_line=field != "longDescription")
    require(interface["capabilities"] == ["Interactive", "Read", "Write"], "Unexpected capabilities")
    for field in ("websiteURL", "supportURL", "privacyPolicyURL", "termsOfServiceURL"):
        require(https_url(interface[field]) and len(interface[field]) <= 1024, f"Invalid {field}")
    prompts = interface["defaultPrompt"]
    require(isinstance(prompts, list) and 1 <= len(prompts) <= 3, "Expected one to three default prompts")
    require(all(isinstance(prompt, str) and 1 <= len(prompt) <= 128 for prompt in prompts), "Default prompt exceeds 128 characters")
    require(len(set(prompts)) == len(prompts), "Default prompts must be unique")
    require(re.fullmatch(r"#[0-9A-Fa-f]{6}", interface["brandColor"]) is not None, "Invalid brand color")
    require(contrast_with_white(interface["brandColor"]) >= 2, "Brand color needs at least 2:1 contrast against white")
    for field in ("composerIcon", "logo"):
        data = package_path(interface[field]).read_bytes()
        require(data[:8] == b"\x89PNG\r\n\x1a\n" and data[12:16] == b"IHDR", "Artwork must be PNG")
        width, height = struct.unpack(">II", data[16:24])
        require(width == height and 48 <= width <= 4096, "Artwork must be square, 48 to 4096 pixels")
        require(len(data) <= 5 * 1024 * 1024, "Artwork exceeds 5 MiB")
        blob = hashlib.sha1(f"blob {len(data)}\0".encode() + data).hexdigest()
        require(blob == "ed6d538f471158b4aadb76754a3a75c59caa34a0", "Artwork differs from verified source lineage")
    require(len(CORE_TOOLS) == 40, "Core inventory drift")
    workflow = (REPO / "src/workflowTools.ts").read_text()
    defaults = workflow.split("export const WORKFLOW_TOOL_ADAPTERS:", 1)[1].split("function exactWorkAction", 1)[0]
    declared = set(re.findall(r"operation\('([a-z_]+)'", defaults))
    generated = re.search(r"\.\.\.\(\[([^]]+)\] as const\)\.map\(\(action\) => operation\(\s*`orgx_\$\{action\}_work`", defaults)
    require(generated is not None, "Cannot resolve lifecycle operation names")
    declared.update(f"orgx_{action}_work" for action in re.findall(r"'([a-z]+)'", generated.group(1)))
    receipts = (REPO / "src/receiptOperationTools.ts").read_text()
    receipt_defaults = receipts.split("export const RECEIPT_OPERATION_TOOLS:", 1)[1].split("export interface ReceiptOperationContext", 1)[0]
    declared.update(re.findall(r"id: '([a-z_]+)'", receipt_defaults))
    require(declared == CORE_TOOLS, f"Current core source differs from skill contract: {sorted(declared ^ CORE_TOOLS)}")
    require(sorted(path.name for path in (ROOT / "skills").iterdir()) == sorted(SKILLS), "Unexpected skill component")
    tool_references = set()
    for name in SKILLS:
        body = (ROOT / "skills" / name / "SKILL.md").read_text()
        require(body.startswith(f"---\nname: {name}\ndescription: "), f"Invalid frontmatter for {name}")
        require(len(body.split("---", 2)) == 3, f"Missing frontmatter boundary for {name}")
        references = set(re.findall(r"\borgx_[a-z_]+\b", body))
        require(references <= CORE_TOOLS, f"Unknown or private skill tools in {name}: {sorted(references - CORE_TOOLS)}")
        tool_references.update(references)
    forbidden = re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}|\bgh[opsu]_[A-Za-z0-9]{20,}|Bearer\s+[A-Za-z0-9._-]{20,}|\b(?:Authorization|x-api-key)\s*[:=]\s*[\"']?[^\s\"']{10,}", re.I)
    for path in package_files():
        require(path.is_file() and not path.is_symlink(), f"Missing or linked package file: {path.name}")
        require(path.resolve().is_relative_to(ROOT.resolve()), "Package file escapes root")
        parent = path.parent
        while parent != ROOT:
            require(not parent.is_symlink(), "Symlink ancestor in package")
            parent = parent.parent
        if path.suffix != ".png":
            require(not forbidden.search(path.read_text()), f"Potential credential in {path.relative_to(ROOT)}")
    return {"ok": True, "version": manifest["version"], "files": len(package_files()),
            "skills": len(SKILLS), "core_tool_references": len(tool_references),
            "validation": "local known-contract checks; provider scan pending"}


if __name__ == "__main__":
    print(json.dumps(verify(), sort_keys=True))
