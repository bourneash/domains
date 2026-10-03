import re
from pathlib import Path
import unittest

class BootstrapCITests(unittest.TestCase):
    def test_verification_keeps_install_audit_and_build_without_automatic_archives(self):
        source = (Path(__file__).parents[1] / "bootstrap-domain.sh").read_text()
        workflow = source.split("<< 'CIEOF'\n",1)[1].split("\nCIEOF",1)[0]
        verify, archive = workflow.split("  archive:",1)
        self.assertIn("run: npm ci",verify)
        self.assertIn("run: npm run security:audit:prod",verify)
        self.assertIn("run: npm run build",verify)
        self.assertNotIn("upload-artifact",verify)
        self.assertIn("workflow_dispatch:",verify)
        self.assertIn("default: false",verify)
        self.assertIn("github.event_name == 'workflow_dispatch' && inputs.archive_build",archive)
        self.assertIn("needs: verify",archive)
        self.assertIn("retention-days: 1",archive)
        self.assertIn("if-no-files-found: error",archive)
        self.assertNotRegex(workflow,r"continue-on-error|wrangler deploy|npm run deploy")

if __name__ == '__main__':
    unittest.main()
