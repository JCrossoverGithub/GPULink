#!/usr/bin/env python3
"""Validate the exact contents/metadata of the current prerelease GPULink .NET package."""
import hashlib
from pathlib import Path
import sys
import xml.etree.ElementTree as ET
import zipfile

EXPECTED_ID = 'GPULink.Client'
EXPECTED_VERSION = '0.1.0-preview.1'
EXPECTED_REPO = 'https://github.com/JCrossoverGithub/GPULink'


def validate(path: Path) -> None:
    if not path.is_file():
        raise ValueError(f'Package missing: {path}')
    if path.name.lower() != f'{EXPECTED_ID}.{EXPECTED_VERSION}.nupkg'.lower():
        raise ValueError(f'Unexpected package name: {path.name}')
    with zipfile.ZipFile(path) as archive:
        bad_entry = archive.testzip()
        if bad_entry is not None:
            raise ValueError(f'Package has a corrupt member: {bad_entry}')
        names = set(archive.namelist())
        required = {
            f'{EXPECTED_ID}.nuspec',
            f'lib/net10.0/{EXPECTED_ID}.dll',
            'README.md',
            'LICENSE',
        }
        missing = required - names
        if missing:
            raise ValueError(f'Package missing entries: {sorted(missing)}')
        for entry in ('README.md', 'LICENSE'):
            if not archive.read(entry).strip():
                raise ValueError(f'Package {entry} is empty')
        nuspec = ET.fromstring(archive.read(f'{EXPECTED_ID}.nuspec'))
        metadata = nuspec.find('{*}metadata')
        if metadata is None:
            raise ValueError('Package metadata is missing')

        def field(name: str) -> str:
            el = metadata.find(f'{{*}}{name}')
            return (el.text or '').strip() if el is not None else ''

        for key, expected in {
            'id': EXPECTED_ID,
            'version': EXPECTED_VERSION,
            'readme': 'README.md',
        }.items():
            actual = field(key)
            if actual != expected:
                raise ValueError(f'Unexpected {key}: {actual!r}; expected {expected!r}')
        license_tag = metadata.find('{*}license')
        if (license_tag is None or license_tag.attrib.get('type') != 'file' or
                (license_tag.text or '').strip() != 'LICENSE'):
            raise ValueError('Package file license reference is missing')
        repo = metadata.find('{*}repository')
        if repo is None or repo.attrib.get('url') != EXPECTED_REPO or repo.attrib.get('type') != 'git':
            raise ValueError('Package repository metadata mismatch')
        if not field('description') or not field('authors'):
            raise ValueError('Package lacks description or authors')
        if any('/CaptionLink' in entry or '.ContractTests' in entry for entry in names):
            raise ValueError('Package contains unrelated application or test artifacts')
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    print(f'PASS: {EXPECTED_ID} {EXPECTED_VERSION}; net10.0 DLL, README, LICENSE, metadata')
    print(f'PACKAGE_SHA256={digest}')


if __name__ == '__main__':
    if len(sys.argv) != 2:
        raise SystemExit('Usage: python verify-package.py /path/to/GPULink.Client.<version>.nupkg')
    try:
        validate(Path(sys.argv[1]))
    except (OSError, ValueError, ET.ParseError, zipfile.BadZipFile) as exc:
        raise SystemExit(f'STOP: {exc}') from exc
