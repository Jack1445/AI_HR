"""The .bat entry point uses Windows PowerShell 5.1, not PowerShell 7."""
import os
import subprocess
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parents[2]
LAUNCHER = ROOT / 'start-ai-hr.ps1'


def test_launcher_keeps_utf8_bom_for_windows_powershell():
    source = LAUNCHER.read_bytes()
    assert source.startswith(b'\xef\xbb\xbf'), 'Preserve the UTF-8 BOM: Windows PowerShell 5.1 otherwise misreads Chinese strings.'
    source.decode('utf-8-sig', errors='strict')


@pytest.mark.skipif(os.name != 'nt', reason='Windows PowerShell entry point')
def test_launcher_parses_in_the_shell_used_by_bat():
    shell = Path(os.environ['WINDIR']) / 'System32/WindowsPowerShell/v1.0/powershell.exe'
    # Parse only. Never execute the launcher or start/stop real services in a test.
    command = '''$tokens=$null; $errors=$null;
    [void][System.Management.Automation.Language.Parser]::ParseFile(
        (Join-Path (Get-Location) 'start-ai-hr.ps1'), [ref]$tokens, [ref]$errors);
    if ($errors.Count) { $errors | ForEach-Object { $_.Message }; exit 1 }
    '''
    result = subprocess.run([str(shell), '-NoProfile', '-NonInteractive', '-Command', command], cwd=ROOT, capture_output=True, timeout=20)
    assert result.returncode == 0, result.stdout.decode(errors='replace') + result.stderr.decode(errors='replace')
