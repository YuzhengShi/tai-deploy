"""The new graph code never touches a secret. `leanrag/config.py` calls load_dotenv(<repo>/.env) when it is imported, and extract.py and bedrock.py import it (and AWS): the new modules
must import none of them, open no file whose name holds ".env", and use no pickle (a container would run what it loads). Checked three ways: by importing them in a fresh interpreter
with an audit hook that records every open(), by looking at which modules got loaded, and by reading their syntax trees (docstrings and comments, which SAY what is not done, are skipped).
Run: python leanrag/test_no_secrets.py   (standard library only)
"""
import ast
import json
import subprocess
import sys
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
sys.dont_write_bytecode = True
NEW_MODULES = ["text", "corpus", "llm", "graph_extract", "graph_build", "graph_query", "build", "fixture_artifact"]
FORBIDDEN_IMPORTS = {"dotenv", "pickle", "boto3", "botocore", "leanrag.config", "leanrag.bedrock", "leanrag.extract", "config", "bedrock", "extract"}

PROBE = r"""
import json, sys
sys.dont_write_bytecode = True
opened = []
def hook(event, args):
    if event == "open" and args and isinstance(args[0], (str, bytes)):
        p = args[0].decode() if isinstance(args[0], bytes) else args[0]
        if p.replace("\\", "/").split("/")[-1].startswith(".env") or p.replace("\\", "/").endswith(".env"):
            opened.append(p)
sys.addaudithook(hook)
sys.path.insert(0, sys.argv[1])
import importlib
for name in sys.argv[2:]:
    importlib.import_module("leanrag." + name)
bad = [m for m in ("dotenv", "boto3", "botocore", "leanrag.config", "leanrag.bedrock", "leanrag.extract", "pickle") if m in sys.modules]
print(json.dumps({"opened_env": opened, "forbidden_modules_loaded": bad}))
"""


def tree_of(name: str) -> ast.Module:
    return ast.parse((REPO / "leanrag" / f"{name}.py").read_text(encoding="utf-8"))


def imported(tree: ast.Module, package: str = "leanrag") -> set[str]:
    names: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            names.update(a.name for a in node.names)
        elif isinstance(node, ast.ImportFrom):
            base = node.module or ""
            if node.level:                                   # `from . import config` and `from .config import x`
                names.add(f"{package}.{base}" if base else package)
                names.update(f"{package}.{a.name}" for a in node.names if not base)
            else:
                names.add(base)
    return names


def strings_in_code(tree: ast.Module) -> list[str]:
    """Every string constant that is not a docstring."""
    docstrings = set()
    for node in ast.walk(tree):
        if isinstance(node, (ast.Module, ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)) and node.body:
            first = node.body[0]
            if isinstance(first, ast.Expr) and isinstance(first.value, ast.Constant) and isinstance(first.value.value, str):
                docstrings.add(id(first.value))
    return [n.value for n in ast.walk(tree) if isinstance(n, ast.Constant) and isinstance(n.value, str) and id(n) not in docstrings]


class NoSecrets(unittest.TestCase):
    def test_importing_the_new_modules_opens_no_env_file_and_loads_nothing_that_would(self):
        out = subprocess.run([sys.executable, "-W", "ignore", "-c", PROBE, str(REPO)] + NEW_MODULES, capture_output=True, text=True, timeout=120)
        self.assertEqual(out.returncode, 0, out.stderr)
        got = json.loads(out.stdout.strip().splitlines()[-1])
        self.assertEqual(got, {"opened_env": [], "forbidden_modules_loaded": []})

    def test_no_new_module_imports_dotenv_pickle_aws_or_the_old_config_extract_and_bedrock_modules(self):
        for name in NEW_MODULES:
            self.assertEqual(imported(tree_of(name)) & FORBIDDEN_IMPORTS, set(), name)

    def test_no_new_module_names_an_env_file_or_calls_pickle(self):
        for name in NEW_MODULES:
            tree = tree_of(name)
            for s in strings_in_code(tree):
                self.assertNotIn(".env", s, f"{name}.py names an env file: {s[:80]!r}")
            for node in ast.walk(tree):
                if isinstance(node, ast.Attribute):
                    self.assertNotIn(node.attr, ("load_dotenv", "loads", "dumps") if getattr(node.value, "id", "") == "pickle" else ("load_dotenv",), name)
                if isinstance(node, ast.Name):
                    self.assertNotIn(node.id, ("load_dotenv", "pickle"), name)

    def test_only_the_llm_module_knows_the_name_of_the_key_variable_and_nothing_prints_a_key(self):
        for name in NEW_MODULES:
            strings = strings_in_code(tree_of(name))
            has_key_name = any("API_KEY" in s for s in strings)
            self.assertEqual(has_key_name, name == "llm", name)
        for name in NEW_MODULES:
            for node in ast.walk(tree_of(name)):
                if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id in ("print", "say"):
                    for arg in ast.walk(node):
                        if isinstance(arg, ast.Name):
                            self.assertNotIn(arg.id, ("key", "api_key", "_key"), f"{name}.py prints {arg.id}")
        # the build's command line takes no key as an argument
        build = (REPO / "leanrag" / "build.py").read_text(encoding="utf-8")
        self.assertNotIn('"--key"', build)
        self.assertNotIn('"--api-key"', build)


if __name__ == "__main__":
    unittest.main()
