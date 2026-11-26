#!/usr/bin/env python3
"""Restore the exact reviewed NuGet candidate in a fresh external project."""
import json
from pathlib import Path
import subprocess
import sys
import tempfile


def main():
    candidate = Path(sys.argv[1]).resolve()
    manifest = json.loads((candidate / 'candidate.json').read_bytes())
    package = next(p for p in manifest['packages'] if p['name'] == 'GPULink.Client')
    version = package['version']
    # This step follows release-candidate.py verify; a fixed identity and version come from it.
    with tempfile.TemporaryDirectory(prefix='gpl-dotnet-') as temp:
        root = Path(temp)
        (root / 'Consumer.csproj').write_text(f'''<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net10.0</TargetFramework></PropertyGroup>
  <ItemGroup><PackageReference Include="GPULink.Client" Version="[{version}]" /></ItemGroup>
</Project>\n''', encoding='utf-8')
        (root / 'Program.cs').write_text('''using GPULink.Client;
System.Console.WriteLine(typeof(GPULinkClient).FullName);
''', encoding='utf-8')
        subprocess.run(['dotnet', 'restore', 'Consumer.csproj', '--source', str(candidate),
                        '--packages', str(root / 'packages'), '--no-http-cache', '-p:NuGetAudit=false'], cwd=root, check=True)
        subprocess.run(['dotnet', 'run', '--project', 'Consumer.csproj', '--no-restore'], cwd=root, check=True)
        installed = root / 'packages/gpulink.client' / version / f'gpulink.client.{version}.nupkg'
        if installed.read_bytes() != (candidate / package['artifact']).read_bytes():
            raise ValueError('Restored NuGet artifact differs from verified candidate')
    print('PASS: exact NuGet candidate restored from local feed and consumed by external .NET application')


if __name__ == '__main__':
    main()
