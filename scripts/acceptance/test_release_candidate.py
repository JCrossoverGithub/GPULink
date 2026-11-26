"""Synthetic package fixtures test the coordinator; actual packages are exercised separately in CI."""
import importlib.util
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch
import zipfile

spec = importlib.util.spec_from_file_location('release_candidate', Path(__file__).resolve().parents[1] / 'release-candidate.py')
r = importlib.util.module_from_spec(spec)
spec.loader.exec_module(r)


class CandidateTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.cli = self.root / 'cli-source'
        self.sdk = self.root / 'sdk-source'
        self.output = self.root / 'candidate'
        self.cli.mkdir()
        self.sdk.mkdir()
        self.revision = r.git('rev-parse', 'HEAD').decode().strip()
        self.version, self.dotnet, self.client, self.adapter = r.contract()
        self.cli_name = f'gpulink-cli-{self.version}.tgz'
        (self.cli / self.cli_name).write_bytes(b'fixture CLI bytes, not an executable package')
        data = r.describe(self.cli / self.cli_name)
        meta = {'schemaVersion': 1, 'package': '@gpulink/cli', 'version': self.version, 'artifact': self.cli_name,
                'sourceRevision': self.revision, 'baseRevision': self.revision, 'workingTreeClean': True,
                'status': 'candidate-not-published', 'dependencyLockSha256': r.digest(r.git('show', 'HEAD:package-lock.json')), **data}
        (self.cli / 'release.json').write_text(json.dumps(meta))
        (self.cli / 'SHA256SUMS').write_text(f"{data['sha256']}  {self.cli_name}\n")
        self.make_sdk('client', self.client)
        self.make_sdk('adapter-sdk', self.adapter)
        with zipfile.ZipFile(self.sdk / f'GPULink.Client.{self.dotnet}.nupkg', 'w') as z:
            z.writestr('GPULink.Client.nuspec', f'''<package><metadata><id>GPULink.Client</id><version>{self.dotnet}</version><readme>README.md</readme><license type="file">LICENSE</license><repository url="https://github.com/JCrossoverGithub/GPULink" type="git"/><description>Fixture</description><authors>Fixture</authors></metadata></package>''')
            for name in ['lib/net10.0/GPULink.Client.dll', 'README.md', 'LICENSE']:
                z.writestr(name, 'synthetic fixture only')

    def make_sdk(self, kind, meta, extra=None):
        with tarfile.open(self.sdk / f'gpulink-{kind}-{self.version}.tgz', 'w:gz') as archive:
            for name in sorted(r.SDK_FILES[kind] | ({extra} if extra else set())):
                data = json.dumps(meta).encode() if name == 'package.json' else b'fixture'
                member = tarfile.TarInfo('package/' + name)
                member.size = len(data)
                archive.addfile(member, io.BytesIO(data))

    def assemble(self):
        git = r.git
        # Allow a dirty developer test checkout, not a dirty real candidate build.
        with patch.object(r, 'git', side_effect=lambda *args: b'' if args[0] == 'status' else git(*args)):
            r.assemble(self.cli, self.sdk, self.output, self.revision)

    def test_roundtrip(self):
        self.assemble()
        r.verify(self.output, self.revision)
        manifest = r.json_file(self.output / r.MANIFEST)
        self.assertEqual(len(manifest['packages']), 4)
        self.assertEqual(manifest['sourceRevision'], self.revision)
        self.assertEqual(manifest['status'], 'candidate-not-published')

    def test_tampered_artifact(self):
        self.assemble()
        with (self.output / 'cli' / self.cli_name).open('ab') as f:
            f.write(b'changed')
        with self.assertRaisesRegex(ValueError, 'provenance or content mismatch'):
            r.verify(self.output, self.revision)

    def test_wrong_revision(self):
        self.assemble()
        with self.assertRaisesRegex(ValueError, 'provenance or content mismatch'):
            r.verify(self.output, '0' * 40)

    def test_extra_sdk_member_rejected_and_no_partial_candidate(self):
        self.make_sdk('client', self.client, 'unexpected.txt')
        with self.assertRaisesRegex(ValueError, 'Unexpected client package contents'):
            self.assemble()
        self.assertFalse(self.output.exists())

    def test_public_sdk_metadata_rejected(self):
        self.make_sdk('adapter-sdk', {**self.adapter, 'private': False})
        with self.assertRaisesRegex(ValueError, 'metadata mismatch'):
            self.assemble()
        self.assertFalse(self.output.exists())

    def test_existing_destination_preserved(self):
        self.output.mkdir()
        sentinel = self.output / 'keep'
        sentinel.write_text('do not overwrite')
        with self.assertRaisesRegex(ValueError, 'already exists'):
            self.assemble()
        self.assertEqual(sentinel.read_text(), 'do not overwrite')

    def test_dirty_checkout_rejected(self):
        with patch.object(r, 'git', return_value=b' M package.json\n'):
            with self.assertRaisesRegex(ValueError, 'Clean checkout required'):
                r.assemble(self.cli, self.sdk, self.output, self.revision)
        self.assertFalse(self.output.exists())

    def test_extra_bundle_file_rejected(self):
        self.assemble()
        (self.output / 'unexpected.txt').write_text('extra')
        with self.assertRaisesRegex(ValueError, 'Unexpected candidate files'):
            r.verify(self.output, self.revision)

    def test_manifest_tamper_rejected(self):
        self.assemble()
        p = self.output / r.MANIFEST
        m = r.json_file(p)
        m['status'] = 'published'
        p.write_text(json.dumps(m))
        with self.assertRaisesRegex(ValueError, 'manifest mismatch'):
            r.verify(self.output, self.revision)

    def test_checksum_tamper_rejected(self):
        self.assemble()
        (self.output / r.SUMS).write_text('incorrect')
        with self.assertRaisesRegex(ValueError, 'checksum mismatch'):
            r.verify(self.output, self.revision)

    def stage(self, output=None, revision=None):
        git = r.git
        with patch.object(r, 'git', side_effect=lambda *args: b'' if args[0] == 'status' else git(*args)):
            r.stage_delivery(self.output, output or self.root / 'delivery', revision or self.revision)

    def test_delivery_preserves_exact_candidate_bytes(self):
        self.assemble()
        self.stage()
        delivery = self.root / 'delivery'
        name = f'gpulink-distribution-v{self.version}-{self.revision}.zip'
        archive = delivery / name
        self.assertEqual({p.name for p in delivery.iterdir()}, {name, f'{name}.sha256'})
        self.assertEqual((delivery / f'{name}.sha256').read_text(), f"{r.describe(archive)['sha256']}  {name}\n")
        with zipfile.ZipFile(archive) as z:
            expected = {p.relative_to(self.output).as_posix(): p.read_bytes() for p in self.output.rglob('*') if p.is_file()}
            self.assertEqual(set(z.namelist()), set(expected))
            self.assertEqual(len(z.namelist()), len(expected))
            for filename, data in expected.items():
                self.assertEqual(z.read(filename), data)

    def test_delivery_rejects_wrong_revision(self):
        self.assemble()
        with self.assertRaisesRegex(ValueError, 'revision does not match checkout'):
            self.stage(revision='0' * 40)
        self.assertFalse((self.root / 'delivery').exists())

    def test_delivery_rejects_dirty_checkout(self):
        self.assemble()
        git = r.git
        with patch.object(r, 'git', side_effect=lambda *args: b' M package.json\n' if args[0] == 'status' else git(*args)):
            with self.assertRaisesRegex(ValueError, 'Clean checkout required'):
                r.stage_delivery(self.output, self.root / 'delivery', self.revision)
        self.assertFalse((self.root / 'delivery').exists())

    def test_delivery_rejects_tampered_candidate(self):
        self.assemble()
        (self.output / r.SUMS).write_text('tampered')
        with self.assertRaisesRegex(ValueError, 'checksum mismatch'):
            self.stage()
        self.assertFalse((self.root / 'delivery').exists())

    def test_delivery_refuses_existing_and_nested_output(self):
        self.assemble()
        delivery = self.root / 'delivery'
        delivery.mkdir()
        (delivery / 'keep').write_text('preserve')
        with self.assertRaisesRegex(ValueError, 'already exists'):
            self.stage()
        self.assertEqual((delivery / 'keep').read_text(), 'preserve')
        with self.assertRaisesRegex(ValueError, 'outside candidate'):
            self.stage(output=self.output / 'nested')
        self.assertFalse((self.output / 'nested').exists())


if __name__ == '__main__':
    unittest.main()
