"""docs/agents/system-design.md names every setting, dependency, contract shape, and Render
service, and both system-design docs keep their Mermaid diagrams. No network."""
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DOC = ROOT / "docs" / "agents" / "system-design.md"
HUMAN_DOC = ROOT / "docs" / "humans" / "system-design.md"


def env_settings():
    lines = (ROOT / ".env.example").read_text().splitlines()
    return [line.split("=", 1)[0].lstrip("# ").strip() for line in lines
            if re.match(r"^#?\s*[A-Z][A-Z0-9_]*=", line)]


def python_dependencies():
    lines = (ROOT / "requirements.txt").read_text().splitlines()
    return [re.split(r"[=<>~!\[]", line, maxsplit=1)[0].strip() for line in lines
            if line.strip() and not line.startswith("#")]


def web_dependencies():
    # Runtime packages only; build and test tools are named by role (Vite, Vitest).
    return sorted(json.loads((ROOT / "web" / "package.json").read_text())["dependencies"])


def contract_shapes():
    text = (ROOT / "server" / "engine" / "contracts.py").read_text()
    return re.findall(r"^class (\w+)", text, flags=re.MULTILINE)


def render_services():
    return re.findall(r"^\s+name:\s*(\S+)", (ROOT / "render.yaml").read_text(), flags=re.MULTILINE)


def test_system_design_names_every_setting_dependency_shape_and_service():
    text = DOC.read_text()
    missing = [f"setting {name}" for name in env_settings() if f"`{name}`" not in text]
    missing += [f"dependency {name}" for name in python_dependencies() + web_dependencies()
                if f"`{name}`" not in text]
    missing += [f"contract {name}" for name in contract_shapes() if f"`{name}`" not in text]
    missing += [f"render service {name}" for name in render_services() if name not in text]
    assert not missing, "docs/agents/system-design.md does not mention: " + ", ".join(missing)


def mermaid_blocks(path):
    return len(re.findall(r"^```mermaid$", path.read_text(), flags=re.MULTILINE))


def test_system_design_docs_keep_their_mermaid_diagrams():
    # Context, parts, and deploy diagrams.
    assert mermaid_blocks(DOC) >= 3, "docs/agents/system-design.md lost a Mermaid diagram"
    assert mermaid_blocks(HUMAN_DOC) >= 1, "docs/humans/system-design.md lost its Mermaid diagram"
