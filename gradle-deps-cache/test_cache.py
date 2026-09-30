"""Exercise the real shell, tar, and zstd pipeline against a local S3 CLI stub.

Run with: python3 -m unittest discover -s gradle-deps-cache -p 'test_*.py'
Requires bash, tar, and zstd; does not access AWS or need credentials.
"""

import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile
import unittest


AWS_STUB = r'''#!/usr/bin/env python3
import json
import os
from pathlib import Path
import sys

args = sys.argv[1:]
root = Path(os.environ["TEST_S3"])
with open(os.environ["TEST_AWS_LOG"], "a") as log:
    log.write(json.dumps({"args": args, "region": os.environ.get("AWS_REGION")}) + "\n")

def option(name):
    return args[args.index(name) + 1]

if args[:2] == ["s3api", "head-object"]:
    if os.environ.get("TEST_HEAD_FAILURE"):
        print("An error occurred (403): Forbidden", file=sys.stderr)
        sys.exit(1)
    path = root / option("--bucket") / option("--key")
    if path.is_file():
        sys.exit(0)
    print("An error occurred (404): Not Found", file=sys.stderr)
    sys.exit(1)
elif args[:2] == ["s3api", "list-objects-v2"]:
    if os.environ.get("TEST_LIST_FAILURE"):
        sys.exit(1)
    bucket = root / option("--bucket")
    prefix = option("--prefix")
    entries = [p for p in bucket.rglob("*.tar.zst")
               if p.relative_to(bucket).as_posix().startswith(prefix)]
    latest = max(entries, key=lambda p: p.stat().st_mtime) if entries else None
    print(latest.relative_to(bucket).as_posix() if latest else "None")
elif args[:2] == ["s3", "cp"]:
    source, destination = args[2:4]
    if source == "-":
        data = sys.stdin.buffer.read()
        if os.environ.get("TEST_UPLOAD_FAILURE"):
            sys.exit(1)
        path = root / destination.removeprefix("s3://")
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
    else:
        if os.environ.get("TEST_DOWNLOAD_FAILURE"):
            sys.exit(1)
        path = root / source.removeprefix("s3://")
        sys.stdout.buffer.write(path.read_bytes())
else:
    print("Unexpected AWS command: " + repr(args), file=sys.stderr)
    sys.exit(2)
'''


@unittest.skipUnless(shutil.which("zstd"), "zstd is required")
class CacheTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.home = self.root / "custom-gradle-home"
        self.s3 = self.root / "s3"
        self.output = self.root / "output"
        self.log = self.root / "aws-log"
        (self.root / "bin").mkdir()
        aws = self.root / "bin/aws"
        aws.write_text(AWS_STUB)
        aws.chmod(0o755)
        self.env = {
            **os.environ,
            "PATH": f"{self.root / 'bin'}:{os.environ['PATH']}",
            "HOME": str(self.root / "home"),
            "RUNNER_OS": "Linux",
            "RUNNER_ARCH": "X64",
            "RUNNER_TEMP": str(self.root),
            "GITHUB_WORKSPACE": str(self.root),
            "GITHUB_OUTPUT": str(self.output),
            "GRADLE_USER_HOME": str(self.home),
            "GRADLE_BUILD_ACTION_CACHE_KEY_PREFIX": "business/",
            "CACHE_PROJECT_PREFIX": "",
            "CACHE_BUCKET": "project-bucket",
            "CACHE_REGION": "",
            "CACHE_DEPENDENCY_HASH": "abc123",
            "TEST_S3": str(self.s3),
            "TEST_AWS_LOG": str(self.log),
        }
        for name in ("TEST_LIST_FAILURE", "TEST_UPLOAD_FAILURE", "TEST_DOWNLOAD_FAILURE", "TEST_HEAD_FAILURE"):
            self.env.pop(name, None)

    def run_cache(self, mode, **overrides):
        self.output.write_text("")
        result = subprocess.run(
            ["bash", str(Path(__file__).with_name("cache.sh"))],
            env={**self.env, "CACHE_MODE": mode, **overrides},
            capture_output=True, text=True,
        )
        self.assertFalse(list(self.root.glob("gradle-deps-cache.*")), "temporary files leaked")
        return result

    def seed_home(self):
        files = {
            "caches/modules-2/files-2.1/library.jar": b"dependency",
            "caches/modules-2/metadata/data.bin": b"metadata",
            "caches/modules-2/modules-2.lock": b"lock",
            "caches/modules-2/gc.properties": b"transient",
            "wrapper/dists/gradle/bin/gradle": b"distribution",
            "caches/transforms/generated": b"do not cache",
            "gradle.properties": b"credentials=do not cache",
        }
        for name, data in files.items():
            path = self.home / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)

    def entry(self, key="abc123", prefix="business"):
        return self.s3 / "project-bucket" / prefix / "gradle-deps/v1" / f"{key}.tar.zst"

    def calls(self):
        return [json.loads(line) for line in self.log.read_text().splitlines()]

    def cache_hit(self):
        return dict(line.split("=", 1) for line in self.output.read_text().splitlines())["cache-hit"]

    def cache_exists(self):
        return dict(line.split("=", 1) for line in self.output.read_text().splitlines())["cache-exists"]

    def save_fixture(self):
        self.seed_home()
        result = self.run_cache("save")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(self.entry().is_file())

    def test_round_trip_only_contains_dependencies_and_distribution(self):
        self.save_fixture()
        data = subprocess.check_output(["zstd", "-dc", str(self.entry())])
        with tarfile.open(fileobj=io.BytesIO(data)) as archive:
            names = archive.getnames()
        self.assertIn("caches/modules-2/files-2.1/library.jar", names)
        self.assertIn("wrapper/dists/gradle/bin/gradle", names)
        self.assertFalse(any(name.endswith(".lock") or name.endswith("gc.properties") for name in names))
        self.assertNotIn("gradle.properties", names)
        self.assertNotIn("caches/transforms/generated", names)
        # Excluding metadata from the archive must not mutate the writer's home.
        self.assertTrue((self.home / "caches/modules-2/modules-2.lock").exists())
        shutil.rmtree(self.home / "caches/modules-2")
        shutil.rmtree(self.home / "wrapper")
        result = self.run_cache("restore")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.cache_hit(), "true")
        self.assertEqual((self.home / "caches/modules-2/files-2.1/library.jar").read_bytes(), b"dependency")
        self.assertEqual((self.home / "gradle.properties").read_bytes(), b"credentials=do not cache")
        self.assertTrue((self.home / "caches/transforms/generated").exists())
        self.assertFalse(any("rm" in call["args"] or "delete-object" in call["args"] for call in self.calls()))

    def test_fallback_is_newest_archive_in_project_namespace(self):
        self.save_fixture()
        old = self.entry("old")
        shutil.copyfile(self.entry(), old)
        os.utime(old, (1, 1))
        foreign = self.s3 / "project-bucket" / "business/gradle-home-v1/legacy.tar.zst"
        foreign.parent.mkdir(parents=True)
        foreign.write_bytes(b"unrelated archive")
        result = self.run_cache("restore", CACHE_DEPENDENCY_HASH="new-version")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.cache_hit(), "false")
        self.assertIn("Restored business/gradle-deps/v1/abc123.tar.zst", result.stdout)

    def test_cold_miss(self):
        result = self.run_cache("restore")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.cache_hit(), "false")
        self.assertFalse(self.home.exists())
        self.assertFalse(any(call["args"][:2] == ["s3", "cp"] for call in self.calls()))

    def test_lookup_existing_entry_without_touching_gradle_home_or_archive(self):
        self.entry().parent.mkdir(parents=True)
        self.entry().write_bytes(b"existing entry")
        self.seed_home()
        result = self.run_cache("lookup")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.cache_exists(), "true")
        self.assertEqual(self.cache_hit(), "false")
        self.assertEqual(len(self.calls()), 1)
        self.assertEqual(self.calls()[0]["args"][:2], ["s3api", "head-object"])
        self.assertTrue((self.home / "caches/modules-2/modules-2.lock").exists())
        self.assertEqual(self.entry().read_bytes(), b"existing entry")

    def test_lookup_does_not_require_archive_tools(self):
        self.entry().parent.mkdir(parents=True)
        self.entry().write_bytes(b"existing entry")
        isolated_bin = self.root / "lookup-bin"
        isolated_bin.mkdir()
        for tool in ("bash", "python3", "mktemp", "rm", "date", "grep", "cat"):
            (isolated_bin / tool).symlink_to(shutil.which(tool))
        (isolated_bin / "aws").symlink_to(self.root / "bin/aws")
        result = self.run_cache("lookup", PATH=str(isolated_bin))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.cache_exists(), "true")
        self.assertFalse(self.home.exists())

    def test_lookup_missing_exact_key_does_not_use_fallback(self):
        self.entry("previous-version").parent.mkdir(parents=True)
        self.entry("previous-version").write_bytes(b"older archive")
        result = self.run_cache("lookup")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.cache_exists(), "false")
        self.assertNotIn("::warning::", result.stderr)
        self.assertEqual(len(self.calls()), 1)
        self.assertFalse(self.home.exists())

    def test_lookup_failure_is_nonfatal_and_does_not_skip_warming(self):
        result = self.run_cache("lookup", TEST_HEAD_FAILURE="1")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.cache_exists(), "false")
        self.assertIn("::warning::", result.stderr)
        self.assertEqual(len(self.calls()), 1)
        self.assertFalse(self.home.exists())

    def test_failed_download_preserves_existing_home_and_reports_miss(self):
        self.save_fixture()
        result = self.run_cache("restore", TEST_DOWNLOAD_FAILURE="1")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.cache_hit(), "false")
        self.assertIn("::warning::", result.stderr)
        self.assertTrue((self.home / "caches/modules-2/modules-2.lock").exists())

    def test_corrupt_archive_preserves_existing_home_and_reports_miss(self):
        self.save_fixture()
        self.entry().write_bytes(b"not a zstd archive")
        result = self.run_cache("restore")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.cache_hit(), "false")
        self.assertTrue((self.home / "caches/modules-2/files-2.1/library.jar").exists())

    def test_incomplete_archive_is_not_installed(self):
        self.seed_home()
        data = io.BytesIO()
        with tarfile.open(fileobj=data, mode="w") as archive:
            archive.add(self.home / "caches/modules-2", arcname="caches/modules-2")
        self.entry().parent.mkdir(parents=True)
        self.entry().write_bytes(subprocess.check_output(["zstd", "-c"], input=data.getvalue()))
        result = self.run_cache("restore")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.cache_hit(), "false")
        self.assertIn("archive is incomplete", result.stderr)
        self.assertTrue((self.home / "caches/modules-2/modules-2.lock").exists())

    def test_list_failure_is_nonfatal(self):
        result = self.run_cache("restore", TEST_LIST_FAILURE="1")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.cache_hit(), "false")
        self.assertIn("::warning::", result.stderr)

    def test_existing_key_is_not_overwritten(self):
        self.save_fixture()
        original = self.entry().read_bytes()
        self.log.write_text("")
        (self.home / "caches/modules-2/files-2.1/library.jar").write_bytes(b"changed")
        result = self.run_cache("save")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.entry().read_bytes(), original)
        self.assertEqual(len(self.calls()), 1)

    def test_missing_directories_skip_save(self):
        result = self.run_cache("save")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("::warning::", result.stderr)
        self.assertFalse(self.entry().exists())

    def test_upload_failure_is_nonfatal(self):
        self.seed_home()
        result = self.run_cache("save", TEST_UPLOAD_FAILURE="1")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("::warning::", result.stderr)
        self.assertFalse(self.entry().exists())

    def test_explicit_prefix_custom_hash_region_and_relative_home(self):
        self.seed_home()
        result = self.run_cache(
            "save", CACHE_PROJECT_PREFIX="workers///", CACHE_DEPENDENCY_HASH="custom-hash",
            CACHE_REGION="eu-west-1", GRADLE_USER_HOME="custom-gradle-home",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(self.entry("custom-hash", "workers").exists())
        self.assertTrue(all(call["region"] == "eu-west-1" for call in self.calls()))

    def test_default_gradle_home(self):
        result = self.run_cache("restore", GRADLE_USER_HOME="")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(f"home={self.env['HOME']}/.gradle", result.stdout)

    def test_invalid_configuration_fails_before_any_s3_operation(self):
        cases = [
            {"CACHE_MODE": "typo"}, {"CACHE_BUCKET": ""},
            {"CACHE_PROJECT_PREFIX": "", "GRADLE_BUILD_ACTION_CACHE_KEY_PREFIX": ""},
            {"CACHE_PROJECT_PREFIX": "///"}, {"CACHE_DEPENDENCY_HASH": ""},
            {"CACHE_DEPENDENCY_HASH": "invalid\nhash"},
            {"RUNNER_OS": "macOS"}, {"RUNNER_ARCH": "ARM64"},
        ]
        for overrides in cases:
            with self.subTest(overrides=overrides):
                result = self.run_cache("restore", **overrides)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("::error::", result.stderr)
                self.assertFalse(self.log.exists())


if __name__ == "__main__":
    unittest.main()
