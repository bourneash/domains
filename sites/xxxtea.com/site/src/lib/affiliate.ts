// Amazon Associates registry. One-line edits update site-wide.
// Search URLs by default (zero 404 risk). Upgrade to /dp/<asin>
// after a Playwright smoke test confirms the SKU.

export const AMAZON_TAG =
  (import.meta.env.PUBLIC_AMAZON_TAG as string | undefined) || 'xxxtea-20';

export function amazon(searchOrAsin: string, sub: string = ''): string {
  const tag = `tag=${AMAZON_TAG}`;
  const ascsub = sub ? `&ascsubtag=${encodeURIComponent(sub)}` : '';
  if (/^[A-Z0-9]{10}$/.test(searchOrAsin) && searchOrAsin.startsWith('B')) {
    return `https://www.amazon.com/dp/${searchOrAsin}?${tag}${ascsub}`;
  }
  const q = encodeURIComponent(searchOrAsin);
  return `https://www.amazon.com/s?k=${q}&${tag}${ascsub}`;
}

export type Form =
  | 'loose'      // loose-leaf tea (tin / bag / pouch)
  | 'pyramid'    // silk / nylon pyramid bags
  | 'paper'      // classic paper teabags
  | 'powder'     // matcha, hojicha powders
  | 'kettle'     // electric / gooseneck / stovetop
  | 'teapot'     // cast iron / glass / clay
  | 'infuser'    // mesh ball / basket / silicone
  | 'set'        // matcha sets, sampler boxes, kits
  | 'accessory'; // tin, scoop, timer, towel

export type Varietal =
  | 'black'
  | 'green'
  | 'oolong'
  | 'white'
  | 'pu-erh'
  | 'matcha'
  | 'herbal'
  | 'rooibos'
  | 'chai'
  | 'mixed'      // assorted samplers
  | 'none';      // for wares with no varietal

export type Caffeine = 'high' | 'medium' | 'low' | 'none';

export interface Sku {
  id: string;
  name: string;
  blurb: string;             // long description used on review page
  searchQuery: string;
  asin?: string;             // verified via Associates SiteStripe. Empty = /s?k= fallback
  form: Form;
  varietal: Varietal;
  caffeine?: Caffeine;
  brewTemp?: string;         // e.g. '212°F' or '175°F' — used on review page
  brewTime?: string;         // e.g. '3-5 min'
  bestFor: string[];         // ['morning', 'evening', 'after dinner', ...]
  priceTier: 'budget' | 'mid' | 'pro';
  pitch: string;             // single-line on-brand teaser
  image: string;             // slug under /public/gallery/<image>.webp
}

// Launch SKU registry — 24 starter products covering the most-searched
// loose leaf, bagged tea, and brewing wares on Amazon. ASINs left empty
// so links use /s?k= search (zero 404 risk); upgrade to /dp/<asin>
// after individual Playwright verification.
export const SKUS: Sku[] = [
  // ───── Black tea (the workhorses) ─────────────────────────────────────
  {
    id: 'vahdam-imperial-earl-grey',
    name: 'Vahdam Imperial Earl Grey Loose Leaf',
    blurb: 'High-grown Assam and Darjeeling black tea, dosed generously with cold-pressed bergamot oil. Bergamot is the kind of perfume note that lingers in the room after the cup is empty. Vahdam grinds it fresh and packs it dense.',
    searchQuery: 'vahdam imperial earl grey loose leaf tea',
    form: 'loose',
    varietal: 'black',
    caffeine: 'high',
    brewTemp: '212°F',
    brewTime: '3-5 min',
    bestFor: ['morning', 'office', 'cold-day work'],
    priceTier: 'mid',
    pitch: 'Bergamot deep enough to fill the room. The kind of note that lingers.',
    image: 'bound-pyramid',
  },
  {
    id: 'harney-hot-cinnamon-spice',
    name: 'Harney & Sons Hot Cinnamon Spice — 50 Sachets',
    blurb: 'Black tea, three kinds of cinnamon, orange peel, sweet clove. No sugar added — it just tastes like it has some. The cult bag. People keep a tin at the office and refuse to share.',
    searchQuery: 'harney sons hot cinnamon spice sachets 50',
    form: 'pyramid',
    varietal: 'black',
    caffeine: 'high',
    brewTemp: '212°F',
    brewTime: '4-5 min',
    bestFor: ['afternoon', 'no-sugar diet', 'crowd-pleaser'],
    priceTier: 'mid',
    pitch: 'No sugar in the tin. Tastes like there is. People hoard it.',
    image: 'squeezed-silk',
  },
  {
    id: 'twinings-lady-grey',
    name: 'Twinings Lady Grey Black Tea (100 ct)',
    blurb: 'Earl Grey reformulated by Twinings in 1994 for people who found the original too aggressive. Bergamot held back, lemon and orange peel brought forward. Softer. More floral. Still finds your morning.',
    searchQuery: 'twinings lady grey black tea 100 count',
    form: 'paper',
    varietal: 'black',
    caffeine: 'high',
    brewTemp: '212°F',
    brewTime: '3-4 min',
    bestFor: ['mid-morning', 'lighter Earl Grey'],
    priceTier: 'budget',
    pitch: 'Earl Grey, softened. Easier to live with.',
    image: 'frayed-ladder-tear',
  },
  {
    id: 'tazo-awake-english-breakfast',
    name: 'Tazo Awake English Breakfast Black Tea',
    blurb: 'Bold malty Assam-led blend. Built to be drunk with milk. The kind of cup you make without thinking — and finish without thinking either.',
    searchQuery: 'tazo awake english breakfast black tea',
    form: 'paper',
    varietal: 'black',
    caffeine: 'high',
    brewTemp: '212°F',
    brewTime: '4 min',
    bestFor: ['morning', 'commuter', 'milk + sugar'],
    priceTier: 'budget',
    pitch: 'Malt, milk, finished. The mug doesn\'t ask for a second thought.',
    image: 'collar-and-chain',
  },

  // ───── Green tea (the daily) ──────────────────────────────────────────
  {
    id: 'numi-gunpowder-green',
    name: 'Numi Organic Gunpowder Green',
    blurb: 'Rolled tight into dark green pellets. Drop them in hot water and they unfurl — slow, deliberate, releasing smoke and pine into the cup over the course of a minute or two. Watching it bloom is half the point.',
    searchQuery: 'numi organic gunpowder green tea',
    form: 'loose',
    varietal: 'green',
    caffeine: 'medium',
    brewTemp: '175°F',
    brewTime: '3 min',
    bestFor: ['afternoon', 'slow-watch brew', 'pellet unfurl'],
    priceTier: 'mid',
    pitch: 'Tight little pellets. Hot water finds them. They unfurl.',
    image: 'shibari-steep',
  },
  {
    id: 'rishi-jade-cloud',
    name: 'Rishi Jade Cloud Organic Loose Leaf',
    blurb: 'Spring-picked sencha-style green from Hunan. Vegetal, slightly creamy, just a hint of seaweed. The water has to be cooled below boiling or the leaves protest by going bitter.',
    searchQuery: 'rishi jade cloud organic loose leaf green tea',
    form: 'loose',
    varietal: 'green',
    caffeine: 'medium',
    brewTemp: '175°F',
    brewTime: '2-3 min',
    bestFor: ['afternoon', 'mid-day reset'],
    priceTier: 'mid',
    pitch: 'Cool the water first. The leaves don\'t respond well to pressure.',
    image: 'slumping-strainer',
  },

  // ───── Oolong (the slow burn) ─────────────────────────────────────────
  {
    id: 'tealyra-milk-oolong',
    name: 'Tealyra Milk Oolong (Jin Xuan)',
    blurb: 'Naturally creamy Taiwanese cultivar — no actual milk involved. Long curled leaves that you can re-steep three or four times and still get something out of. Each pass tells a different story.',
    searchQuery: 'tealyra milk oolong jin xuan loose leaf',
    form: 'loose',
    varietal: 'oolong',
    caffeine: 'medium',
    brewTemp: '195°F',
    brewTime: '3-5 min',
    bestFor: ['multi-steep', 'evening', 'slow afternoon'],
    priceTier: 'mid',
    pitch: 'Re-steep it three times. Each one tells a different story.',
    image: 'suspended-strainer',
  },
  {
    id: 'foojoy-pu-erh-mini',
    name: 'Foojoy Pu-erh Mini Tuocha Cakes',
    blurb: 'Aged, fermented Yunnan tea pressed into single-serving discs. Deep, earthy, almost like wet stone after rain. The first cup is a shock. The third is when you understand.',
    searchQuery: 'foojoy pu-erh mini tuocha tea',
    form: 'loose',
    varietal: 'pu-erh',
    caffeine: 'medium',
    brewTemp: '212°F',
    brewTime: '4-6 min',
    bestFor: ['post-meal', 'digestion', 'cold weather'],
    priceTier: 'mid',
    pitch: 'Pressed dark and aged slow. First sip is a shock. Third is where it lives.',
    image: 'bound-pyramid',
  },

  // ───── White tea (the delicate) ───────────────────────────────────────
  {
    id: 'vahdam-silver-needle',
    name: 'Vahdam Silver Needle White Tea',
    blurb: 'Hand-plucked buds covered in fine white down. The most delicate tea on the menu — silken, slightly sweet, barely any astringency. Reward for restraint: under-brew it on purpose.',
    searchQuery: 'vahdam silver needle white tea loose leaf',
    form: 'loose',
    varietal: 'white',
    caffeine: 'low',
    brewTemp: '175°F',
    brewTime: '2-4 min',
    bestFor: ['evening', 'low-caffeine', 'delicate palette'],
    priceTier: 'pro',
    pitch: 'Hand-plucked buds. Almost no caffeine. Under-brew it on purpose.',
    image: 'squeezed-silk',
  },

  // ───── Matcha (the ceremony) ──────────────────────────────────────────
  {
    id: 'jade-leaf-ceremonial-matcha',
    name: 'Jade Leaf Ceremonial Grade Matcha Powder',
    blurb: 'Stone-ground first-harvest matcha from Uji. Bright jade-green, smooth and slightly sweet — no chalk, no grass. A scoop, hot water just under a boil, and a bamboo whisk does the rest.',
    searchQuery: 'jade leaf ceremonial grade matcha powder',
    form: 'powder',
    varietal: 'matcha',
    caffeine: 'high',
    brewTemp: '175°F',
    brewTime: '30 sec whisk',
    bestFor: ['morning', 'pre-workout', 'ritual'],
    priceTier: 'pro',
    pitch: 'A scoop. Hot water. Forty seconds with a bamboo whisk. That\'s it.',
    image: 'shibari-steep',
  },
  {
    id: 'ippodo-sayaka-matcha',
    name: 'Ippodo Sayaka Matcha — 40g Tin',
    blurb: 'Ippodo has been doing this in Kyoto since 1717. Sayaka is the everyday tin — premium without ceremonial-grade pricing. Vivid green, no astringent edge, the umami sits right on the tongue.',
    searchQuery: 'ippodo sayaka matcha 40g tin',
    form: 'powder',
    varietal: 'matcha',
    caffeine: 'high',
    brewTemp: '175°F',
    brewTime: '30 sec whisk',
    bestFor: ['daily ritual', 'lattes', 'morning'],
    priceTier: 'pro',
    pitch: 'Kyoto, 1717. The everyday tin from a house that doesn\'t do everyday.',
    image: 'slumping-strainer',
  },

  // ───── Herbal & tisanes ───────────────────────────────────────────────
  {
    id: 'yogi-bedtime',
    name: 'Yogi Bedtime Herbal Tea',
    blurb: 'Chamomile, valerian, lavender. Built to sit down with — not to fight. Drink one cup forty-five minutes before sleep and the math usually works.',
    searchQuery: 'yogi bedtime herbal tea',
    form: 'paper',
    varietal: 'herbal',
    caffeine: 'none',
    brewTemp: '212°F',
    brewTime: '7 min',
    bestFor: ['evening', 'pre-sleep', 'wind-down'],
    priceTier: 'budget',
    pitch: 'Chamomile, valerian, lavender. Forty-five minutes before bed. The math works.',
    image: 'collar-and-chain',
  },
  {
    id: 'twinings-peppermint',
    name: 'Twinings Pure Peppermint Herbal Tea (100 ct)',
    blurb: 'Just peppermint. Nothing else. A cup of this after dinner is the most efficient digestif in any cupboard, and it costs less than the wine you had with the meal.',
    searchQuery: 'twinings pure peppermint herbal tea 100 count',
    form: 'paper',
    varietal: 'herbal',
    caffeine: 'none',
    brewTemp: '212°F',
    brewTime: '4-5 min',
    bestFor: ['after dinner', 'digestion', 'caffeine-free office'],
    priceTier: 'budget',
    pitch: 'Just peppermint. Just enough.',
    image: 'frayed-ladder-tear',
  },
  {
    id: 'celestial-sleepytime',
    name: 'Celestial Seasonings Sleepytime Herbal Tea',
    blurb: 'The American original. Chamomile-forward with spearmint, tilia, and a hint of orange. The mug everyone\'s mother kept in the cabinet — and there\'s a reason it\'s still there.',
    searchQuery: 'celestial seasonings sleepytime herbal tea',
    form: 'paper',
    varietal: 'herbal',
    caffeine: 'none',
    brewTemp: '212°F',
    brewTime: '6 min',
    bestFor: ['evening', 'family kitchen staple'],
    priceTier: 'budget',
    pitch: 'The blue box in everyone\'s mother\'s cabinet. There\'s a reason it\'s still there.',
    image: 'suspended-strainer',
  },

  // ───── Rooibos / chai ─────────────────────────────────────────────────
  {
    id: 'numi-rooibos-chai',
    name: 'Numi Organic Rooibos Chai',
    blurb: 'South African red bush base, no caffeine. Cardamom, cinnamon, clove and pepper carry the spice without the kick. Steep it long — rooibos doesn\'t go bitter.',
    searchQuery: 'numi organic rooibos chai tea',
    form: 'paper',
    varietal: 'rooibos',
    caffeine: 'none',
    brewTemp: '212°F',
    brewTime: '5-7 min',
    bestFor: ['evening chai craving', 'no-caffeine spice'],
    priceTier: 'mid',
    pitch: 'All of the spice. None of the buzz. Steep it as long as you want.',
    image: 'bound-pyramid',
  },
  {
    id: 'tazo-classic-chai',
    name: 'Tazo Classic Chai Black Tea',
    blurb: 'Black tea, cinnamon, cardamom, ginger, anise, black pepper. The blend that built the modern American chai latte. Brew double-strength, add steamed milk, walk away.',
    searchQuery: 'tazo classic chai black tea',
    form: 'paper',
    varietal: 'chai',
    caffeine: 'high',
    brewTemp: '212°F',
    brewTime: '5 min',
    bestFor: ['lattes', 'morning chai', 'cold mornings'],
    priceTier: 'budget',
    pitch: 'Double-strength brew. Steamed milk. Walk away.',
    image: 'collar-and-chain',
  },

  // ───── Samplers ───────────────────────────────────────────────────────
  {
    id: 'vahdam-tea-sampler',
    name: 'Vahdam India Tea Sampler — 8 Varieties Loose Leaf',
    blurb: 'Eight tins, eight different leaves. The way most people figure out what they actually want — by drinking through every black, green, white, and oolong on the wall once.',
    searchQuery: 'vahdam india tea sampler 8 variety loose leaf',
    form: 'set',
    varietal: 'mixed',
    caffeine: 'medium',
    brewTemp: 'varies',
    brewTime: 'varies',
    bestFor: ['gifts', 'figuring out what you like', 'tea curious'],
    priceTier: 'mid',
    pitch: 'Eight tins. Drink through every wall once. Find the one you keep coming back to.',
    image: 'shibari-steep',
  },

  // ───── Kettles (gateway gear) ─────────────────────────────────────────
  {
    id: 'fellow-stagg-ekg',
    name: 'Fellow Stagg EKG Electric Pour-Over Kettle',
    blurb: 'Variable temperature control to the degree. Long gooseneck spout for measured pour. Built like an instrument — it looks at home next to a turntable. The kettle most coffee snobs eventually buy for tea too.',
    searchQuery: 'fellow stagg ekg electric pour over kettle',
    form: 'kettle',
    varietal: 'none',
    bestFor: ['precise temperature', 'pour-over', 'green/white tea'],
    priceTier: 'pro',
    pitch: 'Temperature to the degree. Gooseneck for control. Looks like an instrument because it is.',
    image: 'frayed-ladder-tear',
  },
  {
    id: 'bonavita-gooseneck-kettle',
    name: 'Bonavita 1.0L Variable-Temp Gooseneck Kettle',
    blurb: 'The everyday version of the Stagg. Five fixed temperatures, a thirty-minute hold, and a spout precise enough to pour into a tea bag rather than around it.',
    searchQuery: 'bonavita 1.0 liter gooseneck variable temperature kettle',
    form: 'kettle',
    varietal: 'none',
    bestFor: ['daily driver', 'pour-over', 'gentle starter'],
    priceTier: 'mid',
    pitch: 'Five temperatures. A precise spout. Pours into the bag — not around it.',
    image: 'squeezed-silk',
  },

  // ───── Teapots ────────────────────────────────────────────────────────
  {
    id: 'hario-glass-teapot',
    name: 'Hario Cha Cha Kyusu Maru Glass Teapot — 700ml',
    blurb: 'Borosilicate glass with a stainless steel infuser sleeve. Watch the leaves bloom and the water turn amber in real time. Refractive light through wet leaves is the entire point.',
    searchQuery: 'hario cha cha kyusu glass teapot 700ml',
    form: 'teapot',
    varietal: 'none',
    bestFor: ['watching the brew', 'showing off the leaves', 'glass-tabletop kitchens'],
    priceTier: 'mid',
    pitch: 'Glass walls. Watch the water turn. The whole point is seeing it happen.',
    image: 'slumping-strainer',
  },
  {
    id: 'forlife-stump-teapot',
    name: 'FORLIFE Stump Teapot with Basket — 18oz',
    blurb: 'Stoneware body, wide-bore basket infuser, drip-free spout. The pot people own for a decade and never replace. Comes in twelve glaze colors; the matte black is the one to get.',
    searchQuery: 'forlife stump teapot 18 oz infuser stoneware',
    form: 'teapot',
    varietal: 'none',
    bestFor: ['daily use', 'one-cup brew', 'stoneware lovers'],
    priceTier: 'mid',
    pitch: 'The pot people keep for a decade. The matte black is the one to get.',
    image: 'suspended-strainer',
  },
  {
    id: 'lecreuset-cast-iron-teapot',
    name: 'Le Creuset Cast Iron Teapot — 0.6L',
    blurb: 'Enameled cast iron, stainless infuser, glossy lid. Holds heat the way cast iron always has. Heavy enough that pouring is a deliberate two-handed event. That deliberation is the whole point.',
    searchQuery: 'le creuset cast iron teapot 0.6 liter enameled',
    form: 'teapot',
    varietal: 'none',
    bestFor: ['cold mornings', 'gift-giving', 'long sit-downs'],
    priceTier: 'pro',
    pitch: 'Heavy enough to make pouring deliberate. That deliberation is the point.',
    image: 'collar-and-chain',
  },

  // ───── Infusers ───────────────────────────────────────────────────────
  {
    id: 'forlife-brew-in-mug-basket',
    name: 'FORLIFE Brew-in-Mug Extra-Fine Mesh Infuser Basket',
    blurb: 'Drops directly into any mug or pot. Extra-fine mesh catches the dust that ball-style infusers let through. Comes with its own ceramic lid that doubles as a saucer for the wet basket.',
    searchQuery: 'forlife brew in mug extra fine mesh infuser basket',
    form: 'infuser',
    varietal: 'none',
    bestFor: ['single mug', 'loose leaf without a teapot', 'dorm + office'],
    priceTier: 'budget',
    pitch: 'Drops into the mug. Catches the dust. The lid doubles as a saucer.',
    image: 'shibari-steep',
  },
  {
    id: 'oxo-twisting-tea-ball',
    name: 'OXO Good Grips Twisting Tea Ball Infuser',
    blurb: 'Twist-to-close mesh ball. Leaves go in easy, water gets in easier. Cheap, dishwasher-safe, lives in the drawer for a decade. No frills — sometimes that\'s the right answer.',
    searchQuery: 'oxo good grips twisting tea ball infuser',
    form: 'infuser',
    varietal: 'none',
    bestFor: ['budget loose leaf', 'travel', 'no-fuss steeping'],
    priceTier: 'budget',
    pitch: 'Twist. Drop in. Pull out. Drawer staple for a decade.',
    image: 'slumping-strainer',
  },

  // ───── Matcha set ─────────────────────────────────────────────────────
  {
    id: 'bamboo-matcha-whisk-set',
    name: 'Bamboo Matcha Whisk + Chashaku Scoop Set',
    blurb: 'Hand-carved 100-prong chasen whisk and matching bamboo scoop. The set you need before the powder is worth buying. Both pieces are designed to last about a year of daily use — like sandpaper, they wear in, then out.',
    searchQuery: 'bamboo matcha whisk chashaku scoop chasen set',
    form: 'set',
    varietal: 'matcha',
    bestFor: ['matcha first-timers', 'ceremony', 'matcha at home'],
    priceTier: 'budget',
    pitch: 'Hundred-prong whisk. Bamboo scoop. The tools the powder requires.',
    image: 'frayed-ladder-tear',
  },
];

export const SKU_BY_ID: Record<string, Sku> =
  Object.fromEntries(SKUS.map((s) => [s.id, s]));

// Curated bundles for inline placements on home + category pages.
export const BUNDLES = {
  ritual:    ['fellow-stagg-ekg', 'hario-glass-teapot', 'vahdam-imperial-earl-grey'],
  starter:   ['forlife-brew-in-mug-basket', 'vahdam-tea-sampler', 'bonavita-gooseneck-kettle'],
  evening:   ['yogi-bedtime', 'twinings-peppermint', 'forlife-stump-teapot'],
  matcha:    ['ippodo-sayaka-matcha', 'bamboo-matcha-whisk-set', 'jade-leaf-ceremonial-matcha'],
} as const;

// Form-factor metadata (used for the /vessels and /forms pages)
export const FORMS: Record<Form, { label: string; tagline: string }> = {
  loose:     { label: 'Loose leaf',  tagline: 'The leaves alone. Tin, tongs, time.' },
  pyramid:   { label: 'Pyramid bags', tagline: 'Silk or nylon. Bound at the waist. Premium convenience.' },
  paper:     { label: 'Paper bags',  tagline: 'The classic flat sachet. Drop in, two minutes, done.' },
  powder:    { label: 'Powders',     tagline: 'Matcha and hojicha. Whisked, not steeped.' },
  kettle:    { label: 'Kettles',     tagline: 'The water decides the cup. The kettle decides the water.' },
  teapot:    { label: 'Teapots',     tagline: 'Glass, stoneware, cast iron, clay. Pick your ritual.' },
  infuser:   { label: 'Infusers',    tagline: 'Mesh, basket, ball. Hold the leaves. Let the water through.' },
  set:       { label: 'Sets',        tagline: 'Samplers, ceremony kits, gift boxes.' },
  accessory: { label: 'Accessories', tagline: 'Scoops, timers, caddies, towels.' },
};

// Forms surfaced on /vessels/ (consumables hidden — they live under /varietals/)
export const VESSEL_FORMS: Form[] = ['kettle', 'teapot', 'infuser', 'set', 'accessory'];

// Forms surfaced on the consumables index (loose leaf, bags, powders)
export const TEA_FORMS: Form[] = ['loose', 'pyramid', 'paper', 'powder'];

// Varietal metadata for /varietals/[slug]
export const VARIETALS: Record<Exclude<Varietal, 'none'>, { label: string; tagline: string; brewTemp: string; brewTime: string; caffeine: Caffeine }> = {
  black:     { label: 'Black',       tagline: 'Full-bodied. Boldly brewed. Built for the morning mug.',          brewTemp: '212°F',  brewTime: '3-5 min', caffeine: 'high' },
  green:     { label: 'Green',       tagline: 'Vegetal, grassy, occasionally a little sweet. Don\'t boil it.',  brewTemp: '175°F',  brewTime: '2-3 min', caffeine: 'medium' },
  oolong:    { label: 'Oolong',      tagline: 'The middle ground. Half-oxidized. Built for re-steeping.',        brewTemp: '195°F',  brewTime: '3-5 min', caffeine: 'medium' },
  white:     { label: 'White',       tagline: 'The most delicate of all. Hand-plucked buds. Under-brew on purpose.', brewTemp: '175°F', brewTime: '2-4 min', caffeine: 'low' },
  'pu-erh':  { label: 'Pu-erh',      tagline: 'Aged, fermented, earthy. The bottle of wine of the tea world.',   brewTemp: '212°F',  brewTime: '4-6 min', caffeine: 'medium' },
  matcha:    { label: 'Matcha',      tagline: 'Stone-ground green tea powder. Whisked, not steeped.',            brewTemp: '175°F',  brewTime: '30s whisk', caffeine: 'high' },
  herbal:    { label: 'Herbal',      tagline: 'No camellia sinensis. No caffeine. All ritual.',                   brewTemp: '212°F',  brewTime: '5-7 min', caffeine: 'none' },
  rooibos:   { label: 'Rooibos',     tagline: 'South African red bush. Never bitter, no matter how long.',        brewTemp: '212°F',  brewTime: '5-7 min', caffeine: 'none' },
  chai:      { label: 'Chai',        tagline: 'Black tea armored with cinnamon, cardamom, ginger, pepper.',       brewTemp: '212°F',  brewTime: '5 min', caffeine: 'high' },
  mixed:     { label: 'Samplers',    tagline: 'Drink through the wall once. Find the one you keep.',              brewTemp: 'varies', brewTime: 'varies', caffeine: 'medium' },
};

export const BROWSABLE_VARIETALS: Exclude<Varietal, 'none'>[] = [
  'black', 'green', 'oolong', 'white', 'pu-erh', 'matcha', 'herbal', 'rooibos', 'chai', 'mixed',
];
