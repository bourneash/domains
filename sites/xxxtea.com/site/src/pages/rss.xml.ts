import rss from '@astrojs/rss';
import type { APIContext } from 'astro';
import { SKUS, FORMS } from '@/lib/affiliate';

export async function GET(context: APIContext) {
  return rss({
    title: 'xxxtea — Reviews',
    description: 'Tea for adults. Honest reviews of loose leaf, pyramid bags, infusers, kettles, teapots.',
    site: context.site!.toString(),
    items: SKUS.map((s) => ({
      title: s.name,
      description: `${s.pitch} — ${s.blurb}`,
      link: `/reviews/${s.id}/`,
      pubDate: new Date(),
      categories: [FORMS[s.form].label, s.priceTier],
    })),
    customData: '<language>en-us</language>',
  });
}
