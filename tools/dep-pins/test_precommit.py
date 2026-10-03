import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

HOOK = Path(__file__).with_name('precommit_check.sh').resolve()
ENV = {k: v for k, v in os.environ.items() if not k.startswith('GIT_') and k != 'DEP_PINS_ALLOW_RANGE'}

class PinHookTests(unittest.TestCase):
    def init(self, root, common=None):
        args = ['git', 'init', '-q']
        if common:
            common.parent.mkdir(parents=True, exist_ok=True)
            args += ['--separate-git-dir', str(common)]
        subprocess.run(args + [str(root)], check=True, env=ENV, capture_output=True)
    def stage(self, root, file, version):
        p = root / file
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps({'devDependencies': {'wrangler': version}}))
        subprocess.run(['git', 'add', '--', file], cwd=root, check=True, env=ENV, capture_output=True)
        return p
    def check(self, root):
        return subprocess.run(['sh', str(HOOK)], cwd=root, env=ENV, capture_output=True, text=True)
    def test_existing_exemption_uses_submodule_identity_in_an_isolated_worktree(self):
        with tempfile.TemporaryDirectory() as d:
            base = Path(d); root = base / 'improvement-worktrees' / 'opaque-run'
            self.init(root, base / '.git' / 'modules' / 'sites' / 'rc-9.com')
            self.stage(root, 'site/package.json', '^4.92.0')
            r = self.check(root)
            self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
    def test_non_exempt_site_still_requires_exact_pin(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d) / 'example.com'; self.init(root)
            self.stage(root, 'site/package.json', '^4.128.0')
            r = self.check(root)
            self.assertEqual(r.returncode, 1)
            self.assertIn('fleet pin is exactly 4.128.0', r.stdout)
    def test_matching_exact_pin_passes(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d) / 'example.com'; self.init(root)
            self.stage(root, 'site/package.json', '4.128.0')
            self.assertEqual(self.check(root).returncode, 0)
    def test_working_copy_cannot_override_staged_dependency(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d) / 'example.com'; self.init(root)
            p = self.stage(root, 'site/package.json', '^4.128.0')
            p.write_text(json.dumps({'devDependencies': {'wrangler': '4.128.0'}}))
            self.assertEqual(self.check(root).returncode, 1)
    def test_monorepo_exemption_does_not_exempt_other_sites(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d) / 'fleet'; self.init(root)
            self.stage(root, 'sites/rc-9.com/site/package.json', '^4.92.0')
            self.assertEqual(self.check(root).returncode, 0)
            self.stage(root, 'sites/seedstosauce.com/site/package.json', '^4.128.0')
            r = self.check(root)
            self.assertEqual(r.returncode, 1)
            self.assertNotIn('dep-pins: sites/rc-9.com', r.stdout)
            self.assertIn('dep-pins: sites/seedstosauce.com', r.stdout)

if __name__ == '__main__':
    unittest.main()
