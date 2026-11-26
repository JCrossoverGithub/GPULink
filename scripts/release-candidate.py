#!/usr/bin/env python3
"""Assemble and verify existing release builders' outputs. Never publishes."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import xml.etree.ElementTree as ET
import zipfile

ROOT = Path(__file__).resolve().parents[1]
MANIFEST = 'candidate.json'
SUMS = 'SHA256SUMS'
SDK_FILES = {
    'client': {'package.json', 'README.md', 'dist/index.js', 'dist/index.d.ts',
               'dist/data-plane.js', 'dist/data-plane.d.ts', 'dist/session.js', 'dist/session.d.ts'},
    'adapter-sdk': {'package.json', 'README.md', 'bin/conformance.mjs', 'bin/package.mjs',
                    'src/batch-starter.py', 'src/contract.mjs', 'src/echo-conformance.mjs',
                    'src/package-workflow.mjs'},
}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def git(*args):
    return subprocess.check_output(['git', *args], cwd=ROOT)


def json_file(path):
    return json.loads(path.read_bytes())


def digest(data):
    return hashlib.sha256(data).hexdigest()


def describe(path):
    require(path.is_file() and not path.is_symlink(), f'Not a regular artifact: {path}')
    data = path.read_bytes()
    return {'sha256': digest(data), 'bytes': len(data)}


def contract():
    root = json_file(ROOT / 'package.json')
    client = json_file(ROOT / 'packages/gpulink-sdk/package.json')
    adapter = json_file(ROOT / 'packages/gpulink-adapter-sdk/package.json')
    require(root['private'] and client['private'] and adapter['private'], 'Private npm boundary changed')
    require(root['version'] == client['version'] == adapter['version'], 'npm candidate version mismatch')
    require(client['name'] == '@gpulink/client' and adapter['name'] == '@gpulink/adapter-sdk', 'SDK identity mismatch')
    project = ET.parse(ROOT / 'packages/gpulink-dotnet/GPULink.Client/GPULink.Client.csproj')
    dotnet = project.findtext('./PropertyGroup/Version')
    require(project.findtext('./PropertyGroup/PackageId') == 'GPULink.Client' and
            dotnet.startswith(root['version'] + '-preview.'), 'NuGet preview version mismatch')
    return root['version'], dotnet, client, adapter


def validate_sdk(path, kind, expected):
    with tarfile.open(path, 'r:gz') as archive:
        members = archive.getmembers()
        names = {m.name for m in members}
        require(len(names) == len(members) and all(m.isfile() for m in members), 'Unexpected SDK archive member type or duplicate')
        require(names == {'package/' + name for name in SDK_FILES[kind]}, f'Unexpected {kind} package contents')
        metadata = json.load(archive.extractfile('package/package.json'))
        require(metadata == expected and metadata['private'] is True, f'{kind} package metadata mismatch')
        require(not metadata.get('dependencies'), f'{kind} now requires dependencies; review offline install contract')
        require(all(m.size > 0 for m in members), f'Empty {kind} package member')


def paths(version, dotnet):
    return [f'cli/gpulink-cli-{version}.tgz', 'cli/release.json', 'cli/SHA256SUMS',
            f'gpulink-client-{version}.tgz', f'gpulink-adapter-sdk-{version}.tgz',
            f'GPULink.Client.{dotnet}.nupkg']


def inspect(directory, revision):
    version, dotnet, client, adapter = contract()
    names = paths(version, dotnet)
    records = {name: describe(directory / name) for name in names}
    cli = json_file(directory / 'cli/release.json')
    require(cli['schemaVersion'] == 1 and cli['package'] == '@gpulink/cli' and
            cli['version'] == version and cli['artifact'] == Path(names[0]).name and
            cli['sourceRevision'] == revision and cli['baseRevision'] == revision and
            cli['workingTreeClean'] is True and cli['status'] == 'candidate-not-published' and
            cli['dependencyLockSha256'] == digest(git('show', 'HEAD:package-lock.json')) and
            cli['sha256'] == records[names[0]]['sha256'] and cli['bytes'] == records[names[0]]['bytes'],
            'CLI candidate provenance or content mismatch')
    require((directory / 'cli/SHA256SUMS').read_text() ==
            f"{cli['sha256']}  {cli['artifact']}\n", 'CLI checksum record mismatch')
    validate_sdk(directory / names[3], 'client', client)
    validate_sdk(directory / names[4], 'adapter-sdk', adapter)
    subprocess.run([sys.executable, str(ROOT / 'packages/gpulink-dotnet/verify-package.py'),
                    str(directory / names[5])], check=True)
    return {'schemaVersion': 1, 'status': 'candidate-not-published', 'sourceRevision': revision,
            'packages': [{'name': name, 'version': ver, 'artifact': filename, **records[filename]}
                         for name, ver, filename in [('@gpulink/cli', version, names[0]),
                                                     ('@gpulink/client', version, names[3]),
                                                     ('@gpulink/adapter-sdk', version, names[4]),
                                                     ('GPULink.Client', dotnet, names[5])]],
            'dependencyLocks': {name: digest(git('show', f'HEAD:{name}')) for name in
                                ['package-lock.json', 'packages/gpulink-sdk/package-lock.json']},
            'files': records}


def checksum_text(directory, manifest):
    return ''.join(f"{describe(directory / name)['sha256']}  {name}\n" for name in sorted([*manifest['files'], MANIFEST]))


def verify(directory, revision):
    require(directory.is_dir() and not directory.is_symlink(), 'Candidate directory missing or symlinked')
    entries = list(directory.rglob('*'))
    require(not any(p.is_symlink() for p in entries), 'Symlink in candidate')
    expected = inspect(directory, revision)
    require({p.relative_to(directory).as_posix() for p in entries if p.is_dir()} == {'cli'}, 'Unexpected candidate directories')
    require({p.relative_to(directory).as_posix() for p in entries if p.is_file()} ==
            {*expected['files'], MANIFEST, SUMS}, 'Unexpected candidate files')
    require(json_file(directory / MANIFEST) == expected, 'Candidate manifest mismatch')
    require((directory / SUMS).read_text() == checksum_text(directory, expected), 'Candidate checksum mismatch')
    print(f'PASS: coordinated four-package candidate verified for {revision}')


def assemble(cli, sdk, output, revision):
    require(not git('status', '--porcelain', '--untracked-files=all').strip(), 'Clean checkout required for coordinated candidate')
    require(not output.exists() and not output.is_symlink(), 'Candidate destination already exists')
    version, dotnet, _, _ = contract()
    output.parent.mkdir(parents=True, exist_ok=True)
    # Reserve a new directory; never replace an existing candidate.
    output.mkdir(mode=0o700)
    try:
        (output / 'cli').mkdir()
        for name in paths(version, dotnet):
            source = (cli if name.startswith('cli/') else sdk) / Path(name).name
            describe(source)
            shutil.copyfile(source, output / name)
        manifest = inspect(output, revision)
        (output / MANIFEST).write_text(json.dumps(manifest, indent=2) + '\n', encoding='utf-8', newline='\n')
        (output / SUMS).write_text(checksum_text(output, manifest), encoding='utf-8', newline='\n')
        verify(output, revision)
    except BaseException:
        shutil.rmtree(output)
        raise


def stage_delivery(directory, output, revision):
    """Archive already-built, verified candidate bytes; never publish or rebuild."""
    require(revision == git('rev-parse', 'HEAD').decode().strip(), 'Expected revision does not match checkout')
    require(not git('status', '--porcelain', '--untracked-files=all').strip(), 'Clean checkout required for release delivery')
    verify(directory, revision)
    require(not output.exists() and not output.is_symlink(), 'Delivery destination already exists')
    require(not output.resolve().is_relative_to(directory.resolve()), 'Delivery must be outside candidate')
    version, _, _, _ = contract()
    name = f'gpulink-distribution-v{version}-{revision}.zip'
    files = sorted([*json_file(directory / MANIFEST)['files'], MANIFEST, SUMS])
    output.parent.mkdir(parents=True, exist_ok=True)
    output.mkdir(mode=0o700)
    try:
        archive = output / name
        with zipfile.ZipFile(archive, 'x', compression=zipfile.ZIP_STORED) as z:
            for filename in files:
                z.write(directory / filename, arcname=filename)
        with zipfile.ZipFile(archive) as z:
            require(z.namelist() == files and z.testzip() is None, 'Delivery archive members or CRC mismatch')
            for filename in files:
                require(digest(z.read(filename)) == describe(directory / filename)['sha256'],
                        f'Delivery archive content mismatch: {filename}')
        (output / f'{name}.sha256').write_text(f"{describe(archive)['sha256']}  {name}\n", encoding='utf-8', newline='\n')
    except BaseException:
        shutil.rmtree(output)
        raise
    print(f'PASS: release delivery staged for {revision}; no publication: {archive}')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    verbs = parser.add_subparsers(dest='verb', required=True)
    build = verbs.add_parser('assemble')
    build.add_argument('cli', type=Path)
    build.add_argument('sdk', type=Path)
    build.add_argument('output', type=Path)
    check = verbs.add_parser('verify')
    check.add_argument('directory', type=Path)
    stage = verbs.add_parser('stage')
    stage.add_argument('directory', type=Path)
    stage.add_argument('output', type=Path)
    for verb in (build, check, stage):
        verb.add_argument('--revision', required=True)
    args = parser.parse_args()
    require(args.revision == git('rev-parse', 'HEAD').decode().strip(), 'Expected revision does not match checkout')
    if args.verb == 'assemble':
        assemble(args.cli, args.sdk, args.output, args.revision)
    elif args.verb == 'verify':
        verify(args.directory, args.revision)
    else:
        stage_delivery(args.directory, args.output, args.revision)


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, KeyError, TypeError, tarfile.TarError, zipfile.BadZipFile, subprocess.CalledProcessError) as exc:
        raise SystemExit(f'STOP: {exc}') from exc
