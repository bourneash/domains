// tools/affiliate-audit/tests/fixtures/affiliate.fixture.ts

export const AMAZON_TAG = 'fixture-20';

export type CategorySlug = 'hard-jerks' | 'soft-jerks';
export type Ribbon = 'EDITORS_PICK';

export interface AffiliateProduct {
  id: string;
  name: string;
  brand: string;
  category: CategorySlug;
  price: string;
  asin?: string;
  amazonImageId?: string;
  searchQuery: string;
  image: `/products/${string}`;
  blurb: string;
  ribbon?: Ribbon;
  hasImage?: boolean;
  campaignOnly?: boolean;
}

export const PRODUCTS: AffiliateProduct[] = [
  {
    id: 'fixture-one',
    name: 'Fixture One',
    brand: 'FixtureCo',
    category: 'hard-jerks',
    price: '$9.99',
    asin: 'B00FIXTURE1',
    searchQuery: 'fixture one jerkbait',
    image: '/products/fixture-one.jpg',
    blurb: 'A fixture product for testing.',
    ribbon: 'EDITORS_PICK',
  },
  {
    id: 'fixture-two',
    name: 'Fixture Two',
    brand: 'FixtureCo',
    category: 'soft-jerks',
    price: '$4.99',
    searchQuery: 'fixture two soft jerkbait',
    image: '/products/fixture-two.jpg',
    blurb: 'A second fixture product, no ASIN, campaign-only.',
    campaignOnly: true,
  },
];
