"""docs/agents/code-flow.md names every server/ and scripts/ module and every web/src/ folder,
and both code-flow docs keep their Mermaid diagrams. No network."""
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DOC = ROOT / "docs" / "agents" / "code-flow.md"
HUMAN_DOC = ROOT / "docs" / "humans" / "code-flow.md"


def python_modules():
    files = list((ROOT / "server").rglob("*.py")) + list((ROOT / "scripts").glob("*.py"))
    return sorted(path.relative_to(ROOT).as_posix() for path in files
                  if path.name != "__init__.py" and "__pycache__" not in path.parts)


def web_folders():
    return sorted(path.name for path in (ROOT / "web" / "src").iterdir()
                  if path.is_dir() and path.name != "__pycache__" and not path.name.startswith("."))


def test_code_flow_names_every_module_and_web_folder():
    text = DOC.read_text()
    missing = [path for path in python_modules() if path not in text]
    # `web/src/api/` and `web/src/api` both count; `web/src/apiX` does not.
    missing += [f"web/src/{name}/" for name in web_folders()
                if not re.search(re.escape(f"web/src/{name}") + r"(?![\w.-])", text)]
    assert not missing, "docs/agents/code-flow.md does not mention: " + ", ".join(missing)


def mermaid_blocks(path):
    return len(re.findall(r"^```mermaid$", path.read_text(), flags=re.MULTILINE))


def test_code_flow_docs_keep_their_mermaid_diagrams():
    # At a glance flowchart, one-tick sequence, full flow. The CLI diagram is extra.
    assert mermaid_blocks(DOC) >= 3, "docs/agents/code-flow.md lost a Mermaid diagram"
    assert mermaid_blocks(HUMAN_DOC) >= 1, "docs/humans/code-flow.md lost its Mermaid diagram"
