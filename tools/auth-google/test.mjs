#!/usr/bin/env node
// Quick connectivity test for GSC + GA4 via Application Default Credentials
import { GoogleAuth } from 'google-auth-library'

const auth = new GoogleAuth({
  scopes: [
    'https://www.googleapis.com/auth/webmasters.readonly',
    'https://www.googleapis.com/auth/analytics.readonly',
  ],
})

const client = await auth.getClient()
const token = await client.getAccessToken()

async function get(url) {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token.token}` },
  })
  return { status: res.status, body: await res.json() }
}

// Test 1: GSC — list all verified sites
console.log('\n=== GSC: Verified sites ===')
const gsc = await get('https://www.googleapis.com/webmasters/v3/sites')
if (gsc.status === 200) {
  const sites = gsc.body.siteEntry || []
  if (sites.length === 0) {
    console.log('(no verified sites found — check GSC verification)')
  } else {
    sites.forEach(s => console.log(`  ${s.permissionLevel.padEnd(12)} ${s.siteUrl}`))
  }
} else {
  console.log('FAILED', gsc.status, JSON.stringify(gsc.body))
}

// Test 2: GA4 — list accessible accounts
console.log('\n=== GA4: Accessible accounts ===')
const ga4 = await get('https://analyticsadmin.googleapis.com/v1beta/accounts')
if (ga4.status === 200) {
  const accounts = ga4.body.accounts || []
  if (accounts.length === 0) {
    console.log('(no GA4 accounts found)')
  } else {
    accounts.forEach(a => console.log(`  ${a.name}  ${a.displayName}`))
  }
} else {
  console.log('FAILED', ga4.status, JSON.stringify(ga4.body))
}

console.log()
