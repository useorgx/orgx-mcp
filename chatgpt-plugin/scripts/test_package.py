"""Regression checks for package admission failures and the shipped ZIP boundary."""
from __future__ import annotations

import io
import json
import shutil
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch

import build_package
import verify_package


class PackageContractTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name) / "plugin"
        self.root.mkdir()
        for source in verify_package.package_files():
            target = self.root / source.relative_to(verify_package.ROOT)
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source, target)
        self.addCleanup(patch.stopall)
        patch.object(verify_package, "ROOT", self.root).start()
        patch.object(build_package, "ROOT", self.root).start()

    def change_manifest(self, change) -> None:
        path = self.root / "plugin.json"
        manifest = json.loads(path.read_text())
        change(manifest)
        path.write_text(json.dumps(manifest))

    def listing(self, manifest: dict) -> dict:
        return manifest["extensions"]["com.openai"]["interface"]

    def test_portable_package_keeps_all_three_skills_and_remote_server(self) -> None:
        result = verify_package.verify()
        self.assertEqual((result["files"], result["skills"], result["core_tool_references"]), (8, 3, 40))

    def test_former_hybrid_manifest_is_rejected(self) -> None:
        def hybrid(manifest):
            manifest["interface"] = self.listing(manifest)
            manifest.pop("$schema")
            manifest.pop("extensions")
            manifest["skills"] = "./skills/"
            manifest["mcpServers"] = "./.mcp.json"
        self.change_manifest(hybrid)
        with self.assertRaisesRegex(ValueError, "manifest fields"):
            verify_package.verify()

    def test_portable_schema_is_required(self) -> None:
        self.change_manifest(lambda manifest: manifest.__setitem__("$schema", "https://example.com/schema.json"))
        with self.assertRaisesRegex(ValueError, "Portable plugin schema"):
            verify_package.verify()

    def test_codex_component_declarations_cannot_shadow_portable_discovery(self) -> None:
        self.change_manifest(lambda manifest: manifest.__setitem__("mcpServers", "./.mcp.json"))
        with self.assertRaisesRegex(ValueError, "manifest fields"):
            verify_package.verify()

    def test_codex_files_cannot_shadow_portable_components(self) -> None:
        for name in (".mcp.json", ".codex-plugin"):
            with self.subTest(name=name):
                shadow = self.root / name
                shadow.write_text("{}")
                with self.assertRaisesRegex(ValueError, "shadow Codex"):
                    verify_package.verify()
                shadow.unlink()

    def test_overlong_subtitle_fails_even_if_draft_upload_might_accept_it(self) -> None:
        self.change_manifest(lambda manifest: self.listing(manifest).__setitem__("shortDescription", "x" * 31))
        with self.assertRaisesRegex(ValueError, "shortDescription.*30"):
            verify_package.verify()

    def test_support_page_is_required_for_mcp_review(self) -> None:
        self.change_manifest(lambda manifest: self.listing(manifest).pop("supportURL"))
        with self.assertRaisesRegex(ValueError, "interface fields"):
            verify_package.verify()

    def test_old_remote_transport_and_schema_are_rejected(self) -> None:
        path = self.root / "mcp.json"
        path.write_text(json.dumps({"mcpServers": {"orgx": {"type": "http", "url": verify_package.MCP_URL}}}))
        with self.assertRaisesRegex(ValueError, "Portable MCP configuration"):
            verify_package.verify()

    def test_package_update_cannot_change_published_endpoint(self) -> None:
        path = self.root / "mcp.json"
        configuration = json.loads(path.read_text())
        configuration["mcpServers"]["orgx"]["url"] += "?profile=chatgpt"
        path.write_text(json.dumps(configuration))
        with self.assertRaisesRegex(ValueError, "preserve the published remote endpoint"):
            verify_package.verify()

    def test_component_paths_cannot_escape_the_zip(self) -> None:
        self.change_manifest(lambda manifest: self.listing(manifest).__setitem__("logo", "./../outside.png"))
        with self.assertRaisesRegex(ValueError, "Unsafe component path"):
            verify_package.verify()

    def test_submission_color_needs_minimum_contrast(self) -> None:
        self.change_manifest(lambda manifest: self.listing(manifest).__setitem__("brandColor", "#FFFFFF"))
        with self.assertRaisesRegex(ValueError, "contrast"):
            verify_package.verify()

    def test_source_tooling_and_app_descriptors_do_not_enter_zip(self) -> None:
        (self.root / "scripts").mkdir()
        (self.root / "scripts" / "local.py").write_text("print('local tooling')")
        (self.root / ".app.json").write_text("{}")
        (self.root / "hooks.json").write_text("{}")
        verify_package.verify()
        first = build_package.archive()
        self.assertEqual(first, build_package.archive())
        with zipfile.ZipFile(io.BytesIO(first)) as bundle:
            expected = [path.relative_to(self.root).as_posix() for path in verify_package.package_files()]
            self.assertEqual(bundle.namelist(), expected)
            self.assertEqual(len(expected), 8)
            for entry in bundle.infolist():
                self.assertEqual(entry.date_time, (1980, 1, 1, 0, 0, 0))
                self.assertEqual(entry.external_attr, 0o100644 << 16)
                self.assertEqual(bundle.read(entry.filename), (self.root / entry.filename).read_bytes())


if __name__ == "__main__":
    unittest.main()
