#!/usr/bin/env node
// One-time Google OAuth setup — gets a refresh token for GSC + GA4 API access.
// Run once: node tools/auth-google/setup.mjs
// Writes GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN to domains/.env

import http from 'node:http'
import { readFileSync, existsSync, writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dir = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(__dir, '../..')
const ENV_FILE = resolve(REPO_ROOT, '.env')
const CREDS_FILE = resolve(REPO_ROOT, '.gcp/oauth-client.json')

const { installed: { client_id, client_secret } } = JSON.parse(readFileSync(CREDS_FILE, 'utf8'))

const PORT = 8080
const REDIRECT_URI = `http://localhost:${PORT}`
const SCOPES = [
  'https://www.googleapis.com/auth/webmasters.readonly',
  'https://www.googleapis.com/auth/analytics.readonly',
].join(' ')

const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth')
authUrl.searchParams.set('client_id', client_id)
authUrl.searchParams.set('redirect_uri', REDIRECT_URI)
authUrl.searchParams.set('response_type', 'code')
authUrl.searchParams.set('scope', SCOPES)
authUrl.searchParams.set('access_type', 'offline')
authUrl.searchParams.set('prompt', 'consent')

console.log('\n--- Google OAuth Setup ---\n')
console.log('Open this URL in your browser:\n')
console.log(authUrl.toString())
console.log('\nWaiting for redirect on http://localhost:8080 ...\n')

const code = await new Promise((resolve, reject) => {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://localhost:${PORT}`)
    const code = url.searchParams.get('code')
    const error = url.searchParams.get('error')
    res.writeHead(200, { 'Content-Type': 'text/html' })
    if (code) {
      res.end('<h2>Auth complete — you can close this tab.</h2>')
      server.close()
      resolve(code)
    } else {
      res.end(`<h2>Error: ${error}</h2>`)
      server.close()
      reject(new Error(error))
    }
  })
  server.listen(PORT)
})

console.log('Auth code received. Exchanging for tokens...')

const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({
    code,
    client_id,
    client_secret,
    redirect_uri: REDIRECT_URI,
    grant_type: 'authorization_code',
  }),
})

const tokens = await tokenRes.json()
if (!tokens.refresh_token) {
  console.error('No refresh_token in response:', tokens)
  process.exit(1)
}

console.log('Tokens received. Writing to .env...')

// Read existing .env or start fresh
let env = existsSync(ENV_FILE) ? readFileSync(ENV_FILE, 'utf8') : ''

function setEnvVar(content, key, value) {
  const line = `${key}=${value}`
  const regex = new RegExp(`^${key}=.*$`, 'm')
  return regex.test(content) ? content.replace(regex, line) : content + (content.endsWith('\n') ? '' : '\n') + line + '\n'
}

env = setEnvVar(env, 'GOOGLE_CLIENT_ID', client_id)
env = setEnvVar(env, 'GOOGLE_CLIENT_SECRET', client_secret)
env = setEnvVar(env, 'GOOGLE_REFRESH_TOKEN', tokens.refresh_token)

writeFileSync(ENV_FILE, env)
console.log('\n✓ Written to .env:')
console.log('  GOOGLE_CLIENT_ID')
console.log('  GOOGLE_CLIENT_SECRET')
console.log('  GOOGLE_REFRESH_TOKEN')
console.log('\nSetup complete. You can now run the gsc-fetch and ga4-fetch tools.\n')
