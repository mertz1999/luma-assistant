#!/usr/bin/env python3
"""Inventory primary PI checkouts without modifying them or reading credentials/data."""
import json, pathlib, re, subprocess, sys

root = pathlib.Path('/home/pi')
output = pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 else pathlib.Path('data/pi-repositories.json')
entries, seen = [], set()
for folder in sorted(root.iterdir()):
    if not folder.is_dir() or not (folder / '.git').is_dir():
        continue
    if not (folder.name.startswith('PI_') or folder.name == 'portal'):
        continue
    def git(*args):
        return subprocess.check_output(['git', '-c', 'core.hooksPath=/dev/null', '-C', str(folder), *args], text=True, stderr=subprocess.DEVNULL).strip()
    remote = git('config', '--get', 'remote.origin.url').removesuffix('.git')
    match = re.fullmatch(r'(?:https://github.com/|git@github.com:)([\w.-]+/[\w.-]+)', remote)
    if not match or not match[1].lower().startswith('deepspringai/') or match[1].lower() in seen:
        continue
    seen.add(match[1].lower())
    # Preserve administrator-configured validation profiles across rescans.
    validation = []
    for tests in ['tests', 'backend/tests']:
        if (folder / tests).is_dir():
            validation.append(['python3', '-m', 'pytest', '-q', '-p', 'no:cacheprovider', tests])
            break
    entries.append({'id': match[1], 'path': str(folder.resolve()), 'baseBranch': 'main', 'implementationAllowed': 'infra' not in folder.name.lower(), 'validation': validation})
previous = {r['id'].lower(): r for r in json.loads(output.read_text())} if output.exists() else {}
for entry in entries:
    saved = previous.get(entry['id'].lower(), {})
    for key in ['baseBranch', 'implementationAllowed', 'validation']:
        if key in saved and (key != 'validation' or saved[key]):
            entry[key] = saved[key]
output.parent.mkdir(parents=True, exist_ok=True)
output.write_text(json.dumps(entries, indent=2) + '\n')
output.chmod(0o600)
print(f'Registered {len(entries)} PI repositories. Detected Python test directories; dependencies/checks must pass in isolation before PR publication. No code, email or deployments executed.')
