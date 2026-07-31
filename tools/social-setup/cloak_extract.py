import sys, time, json
from cloakbrowser import launch_persistent_context

url = sys.argv[1]

ctx = launch_persistent_context("/tmp/cloak-driver/profile", headless=False, humanize=True,
                                 viewport={"width": 1280, "height": 1400})
page = ctx.pages[-1] if ctx.pages else ctx.new_page()
page.goto(url, wait_until="domcontentloaded", timeout=60000)
time.sleep(3)

data = page.evaluate("""
() => {
  const results = [];
  document.querySelectorAll('div[data-asin]').forEach(el => {
    const asin = el.getAttribute('data-asin');
    if (!asin) return;
    const titleEl = el.querySelector('h2 span, h2 a span');
    const priceEl = el.querySelector('.a-price .a-offscreen');
    const primeEl = el.querySelector('[aria-label*="Prime"], .s-prime, i.a-icon-prime');
    const sponsored = el.textContent.includes('Sponsored');
    if (titleEl) {
      results.push({
        asin,
        title: titleEl.textContent.trim(),
        price: priceEl ? priceEl.textContent.trim() : null,
        prime: !!primeEl,
        sponsored
      });
    }
  });
  return results;
}
""")
print(json.dumps(data, indent=2))
ctx.close()
