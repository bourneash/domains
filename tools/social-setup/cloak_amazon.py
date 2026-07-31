import sys, time, re
from cloakbrowser import launch_persistent_context

url = sys.argv[1]
outfile = sys.argv[2]

ctx = launch_persistent_context("/tmp/cloak-driver/profile", headless=False, humanize=True,
                                 viewport={"width": 1280, "height": 1400})
page = ctx.pages[-1] if ctx.pages else ctx.new_page()
page.goto(url, wait_until="domcontentloaded", timeout=60000)
time.sleep(3)
page.screenshot(path=outfile, full_page=False)
print("URL:", page.url)
ctx.close()
